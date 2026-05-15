use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Persisted SSH-tunnel config. Stored as a JSON blob in `connections.ssh_config`
/// (alongside `ssh_enabled`). Mirrors how the WireGuard tunnel keeps its full
/// secret payload out of the listing returned by `Storage::list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// `SHA256:<base64>` of the SSH server's host key. `None` means "trust on
    /// first use" — the first successful connect writes the captured value back
    /// to storage.
    #[serde(default)]
    pub known_host_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuth {
    Password {
        password: String,
    },
    PrivateKey {
        path: PathBuf,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl SshConfig {
    pub fn parse(json: &str) -> AppResult<Self> {
        let cfg: SshConfig = serde_json::from_str(json)
            .map_err(|e| AppError::SshTunnel(format!("invalid ssh config json: {e}")))?;
        if cfg.host.trim().is_empty() {
            return Err(AppError::SshTunnel("ssh host is empty".into()));
        }
        if cfg.username.trim().is_empty() {
            return Err(AppError::SshTunnel("ssh username is empty".into()));
        }
        if cfg.port == 0 {
            return Err(AppError::SshTunnel("ssh port must be > 0".into()));
        }
        match &cfg.auth {
            SshAuth::Password { password } if password.is_empty() => {
                return Err(AppError::SshTunnel("ssh password is empty".into()));
            }
            SshAuth::PrivateKey { path, .. } if path.as_os_str().is_empty() => {
                return Err(AppError::SshTunnel("ssh private-key path is empty".into()));
            }
            _ => {}
        }
        Ok(cfg)
    }

    pub fn with_fingerprint(&self, fp: String) -> Self {
        let mut copy = self.clone();
        copy.known_host_fingerprint = Some(fp);
        copy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trips_password_auth() {
        let json = r#"{
            "host": "vps.example.com",
            "port": 22,
            "username": "deploy",
            "auth": { "kind": "password", "password": "hunter2" }
        }"#;
        let cfg = SshConfig::parse(json).unwrap();
        assert_eq!(cfg.host, "vps.example.com");
        assert_eq!(cfg.port, 22);
        assert!(matches!(cfg.auth, SshAuth::Password { .. }));
        assert!(cfg.known_host_fingerprint.is_none());
    }

    #[test]
    fn parse_round_trips_key_auth() {
        let json = r#"{
            "host": "host",
            "port": 22,
            "username": "u",
            "auth": { "kind": "private_key", "path": "/tmp/id_ed25519", "passphrase": "x" }
        }"#;
        let cfg = SshConfig::parse(json).unwrap();
        match cfg.auth {
            SshAuth::PrivateKey { path, passphrase } => {
                assert_eq!(path.to_string_lossy(), "/tmp/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some("x"));
            }
            _ => panic!("expected key auth"),
        }
    }

    #[test]
    fn parse_rejects_empty_host() {
        let json = r#"{
            "host": "",
            "port": 22,
            "username": "u",
            "auth": { "kind": "password", "password": "p" }
        }"#;
        assert!(SshConfig::parse(json).is_err());
    }

    #[test]
    fn parse_rejects_zero_port() {
        let json = r#"{
            "host": "h",
            "port": 0,
            "username": "u",
            "auth": { "kind": "password", "password": "p" }
        }"#;
        assert!(SshConfig::parse(json).is_err());
    }

    #[test]
    fn with_fingerprint_overwrites_field() {
        let cfg = SshConfig {
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth: SshAuth::Password {
                password: "p".into(),
            },
            known_host_fingerprint: None,
        };
        let updated = cfg.with_fingerprint("SHA256:abcdef".into());
        assert_eq!(
            updated.known_host_fingerprint.as_deref(),
            Some("SHA256:abcdef")
        );
    }
}
