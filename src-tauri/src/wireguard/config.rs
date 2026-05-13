//! Parser for the WireGuard `.conf` file format produced by `wg-quick`.
//!
//! We only support the subset PowaDB needs: one `[Interface]` block (PrivateKey,
//! Address) and one `[Peer]` block (PublicKey, Endpoint, AllowedIPs, optional
//! PresharedKey, optional PersistentKeepalive). Unknown keys are ignored, not
//! rejected — real `.conf` files often include `DNS = …`, `MTU = …`, `Table = …`
//! and `PostUp/PostDown` hooks we have no use for in userspace.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::str::FromStr;

use base64::{engine::general_purpose, Engine as _};
use ipnet::IpNet;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct WgConfig {
    pub private_key: [u8; 32],
    pub address: IpNet,
    pub peer: WgPeer,
}

#[derive(Debug, Clone)]
pub struct WgPeer {
    pub public_key: [u8; 32],
    pub endpoint: SocketAddr,
    pub allowed_ips: Vec<IpNet>,
    pub preshared_key: Option<[u8; 32]>,
    pub persistent_keepalive: Option<u16>,
}

impl WgConfig {
    pub fn parse(text: &str) -> AppResult<Self> {
        let mut section: Option<&str> = None;

        let mut private_key: Option<[u8; 32]> = None;
        let mut address: Option<IpNet> = None;

        let mut peer_public_key: Option<[u8; 32]> = None;
        let mut peer_endpoint_raw: Option<String> = None;
        let mut peer_allowed_ips: Vec<IpNet> = Vec::new();
        let mut peer_preshared_key: Option<[u8; 32]> = None;
        let mut peer_persistent_keepalive: Option<u16> = None;

        for (line_no, raw_line) in text.lines().enumerate() {
            let line_no = line_no + 1;
            let line = strip_comment(raw_line).trim();
            if line.is_empty() {
                continue;
            }

            if let Some(rest) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                let name = rest.trim();
                section = match name {
                    "Interface" => Some("Interface"),
                    "Peer" => Some("Peer"),
                    other => {
                        return Err(parse_err(
                            line_no,
                            format!("unknown section [{other}] — expected [Interface] or [Peer]"),
                        ));
                    }
                };
                continue;
            }

            let (key, value) = line
                .split_once('=')
                .map(|(k, v)| (k.trim(), v.trim()))
                .ok_or_else(|| parse_err(line_no, "expected `Key = Value`"))?;

            match (section, key) {
                (Some("Interface"), "PrivateKey") => {
                    private_key = Some(decode_key(value, line_no, "PrivateKey")?);
                }
                (Some("Interface"), "Address") => {
                    // `Address` accepts a comma-separated list (IPv4 + IPv6). We
                    // only support IPv4 in the userspace tunnel, so pick the
                    // first IPv4 entry. If none exist, fail later.
                    if address.is_none() {
                        for piece in value.split(',') {
                            let piece = piece.trim();
                            if piece.is_empty() {
                                continue;
                            }
                            let net = parse_first_cidr(piece, line_no, "Address")?;
                            if matches!(net.addr(), IpAddr::V4(_)) {
                                address = Some(net);
                                break;
                            }
                        }
                    }
                }
                (Some("Interface"), "DNS")
                | (Some("Interface"), "MTU")
                | (Some("Interface"), "Table")
                | (Some("Interface"), "PreUp")
                | (Some("Interface"), "PostUp")
                | (Some("Interface"), "PreDown")
                | (Some("Interface"), "PostDown")
                | (Some("Interface"), "ListenPort")
                | (Some("Interface"), "FwMark") => {
                    // Accepted but ignored: no use in userspace TCP tunneling.
                }
                (Some("Peer"), "PublicKey") => {
                    peer_public_key = Some(decode_key(value, line_no, "PublicKey")?);
                }
                (Some("Peer"), "Endpoint") => {
                    peer_endpoint_raw = Some(value.to_string());
                }
                (Some("Peer"), "AllowedIPs") => {
                    for piece in value.split(',') {
                        let piece = piece.trim();
                        if piece.is_empty() {
                            continue;
                        }
                        peer_allowed_ips.push(parse_first_cidr(piece, line_no, "AllowedIPs")?);
                    }
                }
                (Some("Peer"), "PresharedKey") => {
                    peer_preshared_key = Some(decode_key(value, line_no, "PresharedKey")?);
                }
                (Some("Peer"), "PersistentKeepalive") => {
                    let s = value.parse::<u16>().map_err(|_| {
                        parse_err(
                            line_no,
                            format!("PersistentKeepalive must be a number, got `{value}`"),
                        )
                    })?;
                    if s > 0 {
                        peer_persistent_keepalive = Some(s);
                    }
                }
                (Some(_), _) => {
                    // Unknown key inside a known section — tolerate it.
                }
                (None, _) => {
                    return Err(parse_err(
                        line_no,
                        format!("key `{key}` appears before any [Interface]/[Peer] section"),
                    ));
                }
            }
        }

        let private_key =
            private_key.ok_or_else(|| missing("[Interface] PrivateKey is required"))?;
        let address = address.ok_or_else(|| {
            missing(
                "[Interface] Address is required (and must include an IPv4 entry — the userspace \
                 tunnel does not support IPv6 yet)",
            )
        })?;
        let peer_public_key =
            peer_public_key.ok_or_else(|| missing("[Peer] PublicKey is required"))?;
        let endpoint_raw =
            peer_endpoint_raw.ok_or_else(|| missing("[Peer] Endpoint is required"))?;
        if peer_allowed_ips.is_empty() {
            return Err(missing("[Peer] AllowedIPs is required"));
        }

        let endpoint = resolve_endpoint(&endpoint_raw)?;

        Ok(WgConfig {
            private_key,
            address,
            peer: WgPeer {
                public_key: peer_public_key,
                endpoint,
                allowed_ips: peer_allowed_ips,
                preshared_key: peer_preshared_key,
                persistent_keepalive: peer_persistent_keepalive,
            },
        })
    }

    /// Whether this WG peer's allow-list covers the target host (i.e. the DB IP).
    pub fn allows(&self, ip: IpAddr) -> bool {
        self.peer.allowed_ips.iter().any(|net| net.contains(&ip))
    }
}

fn strip_comment(line: &str) -> &str {
    // wg-quick allows `#` and `;` as start-of-line comments. Inline comments
    // after a value are rare and ambiguous (`PresharedKey = …` is valid base64
    // that could include `#`), so we only strip when the marker is at the start.
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') || trimmed.starts_with(';') {
        ""
    } else {
        line
    }
}

fn decode_key(value: &str, line_no: usize, field: &str) -> AppResult<[u8; 32]> {
    let bytes = general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|e| parse_err(line_no, format!("{field} is not valid base64: {e}")))?;
    if bytes.len() != 32 {
        return Err(parse_err(
            line_no,
            format!("{field} must decode to 32 bytes, got {}", bytes.len()),
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn parse_first_cidr(value: &str, line_no: usize, field: &str) -> AppResult<IpNet> {
    // `Address = 10.0.0.2/32` or bare `10.0.0.2`. Accept both.
    let trimmed = value.trim();
    if let Ok(net) = IpNet::from_str(trimmed) {
        return Ok(net);
    }
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        let bits = match ip {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if let Ok(net) = IpNet::new(ip, bits) {
            return Ok(net);
        }
    }
    Err(parse_err(
        line_no,
        format!("{field} is not a valid CIDR or IP: `{value}`"),
    ))
}

fn resolve_endpoint(raw: &str) -> AppResult<SocketAddr> {
    if let Ok(sa) = raw.parse::<SocketAddr>() {
        return Ok(sa);
    }
    // Try DNS once at config-load time. The handshake retries via boringtun;
    // re-resolution on failures is a follow-up.
    raw.to_socket_addrs()
        .map_err(|e| AppError::Other(format!("could not resolve endpoint `{raw}`: {e}")))?
        .next()
        .ok_or_else(|| AppError::Other(format!("endpoint `{raw}` resolved to nothing")))
}

fn parse_err(line: usize, msg: impl Into<String>) -> AppError {
    AppError::Other(format!("wireguard config (line {line}): {}", msg.into()))
}

fn missing(msg: impl Into<String>) -> AppError {
    AppError::Other(format!("wireguard config: {}", msg.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Interface]\n\
        # comment\n\
        PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n\
        Address = 10.0.0.2/32\n\
        DNS = 1.1.1.1\n\
        \n\
        [Peer]\n\
        PublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n\
        Endpoint = 198.51.100.1:51820\n\
        AllowedIPs = 10.0.0.0/16, 192.168.1.5/32\n\
        PersistentKeepalive = 25\n";

    #[test]
    fn parses_a_typical_wg_quick_file() {
        let cfg = WgConfig::parse(SAMPLE).unwrap();
        assert_eq!(cfg.address.to_string(), "10.0.0.2/32");
        assert_eq!(cfg.peer.endpoint.to_string(), "198.51.100.1:51820");
        assert_eq!(cfg.peer.allowed_ips.len(), 2);
        assert_eq!(cfg.peer.persistent_keepalive, Some(25));
        assert!(cfg.peer.preshared_key.is_none());
    }

    #[test]
    fn allows_checks_against_allowed_ips() {
        let cfg = WgConfig::parse(SAMPLE).unwrap();
        assert!(cfg.allows("10.0.5.1".parse().unwrap()));
        assert!(cfg.allows("192.168.1.5".parse().unwrap()));
        assert!(!cfg.allows("192.168.1.6".parse().unwrap()));
        assert!(!cfg.allows("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn rejects_missing_private_key() {
        let txt = "[Interface]\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        assert!(WgConfig::parse(txt).is_err());
    }

    #[test]
    fn rejects_missing_peer_endpoint() {
        let txt = "[Interface]\nPrivateKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAllowedIPs=0.0.0.0/0\n";
        assert!(WgConfig::parse(txt).is_err());
    }

    #[test]
    fn rejects_bad_base64_key() {
        let txt = "[Interface]\nPrivateKey=!!!not-base64!!!\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        assert!(WgConfig::parse(txt).is_err());
    }

    #[test]
    fn rejects_key_with_wrong_length() {
        // Valid base64, decodes to 12 bytes.
        let txt = "[Interface]\nPrivateKey=aGVsbG8gd29ybGQ=\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        let err = WgConfig::parse(txt).unwrap_err();
        assert!(err.to_string().contains("32 bytes"), "got {err}");
    }

    #[test]
    fn picks_ipv4_from_dual_stack_address() {
        let txt = "[Interface]\nPrivateKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = 10.7.0.3/24, fd00:1111:2222:7::3/64\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=10.7.0.0/16\n";
        let cfg = WgConfig::parse(txt).unwrap();
        assert_eq!(cfg.address.to_string(), "10.7.0.3/24");
    }

    #[test]
    fn rejects_ipv6_only_address() {
        let txt = "[Interface]\nPrivateKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = fd00:1111:2222:7::3/64\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=10.7.0.0/16\n";
        let err = WgConfig::parse(txt).unwrap_err().to_string();
        assert!(err.contains("Address is required"), "got {err}");
    }

    #[test]
    fn accepts_bare_ip_for_address() {
        let txt = "[Interface]\nPrivateKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress=10.0.0.2\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        let cfg = WgConfig::parse(txt).unwrap();
        assert_eq!(cfg.address.to_string(), "10.0.0.2/32");
    }

    #[test]
    fn ignores_unknown_keys_within_known_sections() {
        let txt = "[Interface]\nPrivateKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress=10.0.0.2/32\nMTU=1380\nTable=off\nPostUp=echo hi\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\nWeirdKey=whatever\n";
        assert!(WgConfig::parse(txt).is_ok());
    }

    #[test]
    fn parses_preshared_key() {
        let txt = "[Interface]\nPrivateKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress=10.0.0.2/32\n[Peer]\nPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nPresharedKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nEndpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        let cfg = WgConfig::parse(txt).unwrap();
        assert!(cfg.peer.preshared_key.is_some());
    }
}
