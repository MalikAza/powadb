use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex, Notify};

use crate::commands::connections::resolve_connection;
use crate::drivers::{
    mysql as mysql_drv, postgres as pg_drv, sqlite as sqlite_drv, QueryResult, ScriptResult,
};
use crate::engine::{EngineHandle, MysqlEngine, PostgresEngine, SqliteEngine};
use crate::error::{AppError, AppResult};
use crate::ssh::{self, SshConfig, SshTunnelHandle};
use crate::storage::{DbKind, SavedConnection};
use crate::wireguard::{self, TunnelHandle as WgTunnelHandle, WgConfig};
use crate::AppState;

pub const POOLS_CHANGED_EVENT: &str = "pools-changed";
pub const CONN_STATE_EVENT: &str = "connection-state-changed";

/// Hard cap on how long a single `get_or_open` may spend trying to bring a
/// connection up. Past this point, the state flips to `Error` so the UI never
/// sits in `Connecting` forever.
const CONNECT_WATCHDOG: Duration = Duration::from_secs(20);

/// Backwards-compatible alias. New code should prefer `EngineHandle` directly.
pub type PoolHandle = EngineHandle;

enum Tunnel {
    Wg(WgTunnelHandle),
    Ssh(SshTunnelHandle),
}

impl Tunnel {
    async fn shutdown(self) {
        match self {
            Self::Wg(t) => t.shutdown().await,
            Self::Ssh(t) => t.shutdown().await,
        }
    }
}

/// Identity of a tunnel for cache lookup. Two connections that produce the same
/// key can share one underlying tunnel (one SSH session, one WG peer state).
#[derive(Hash, Eq, PartialEq, Clone, Debug)]
enum TunnelKey {
    Ssh {
        host: String,
        port: u16,
        username: String,
        fingerprint: Option<String>,
    },
    Wg {
        peer_public_key: [u8; 32],
        endpoint: SocketAddr,
    },
}

/// One live tunnel, possibly shared by multiple `PoolEntry`s.
struct TunnelEntry {
    /// `None` once the tunnel has been taken out for shutdown.
    tunnel: Mutex<Option<Tunnel>>,
    local_addr: SocketAddr,
    key: TunnelKey,
}

struct PoolEntry {
    handle: PoolHandle,
    /// Reference into `PoolRegistry::tunnels`. The same `Arc` lives in the
    /// tunnels map so we can find shareable tunnels by key; the entry here
    /// keeps the tunnel alive for as long as this pool needs it.
    tunnel: Option<Arc<TunnelEntry>>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnState {
    Connecting,
    Ready,
    Error { message: String },
}

#[derive(Clone, Serialize, Debug)]
struct ConnStatePayload {
    connection_id: String,
    state: ConnState,
}

#[derive(Default)]
pub struct PoolRegistry {
    pools: Mutex<HashMap<String, PoolEntry>>,
    tunnels: Mutex<HashMap<TunnelKey, Arc<TunnelEntry>>>,
    states: Mutex<HashMap<String, ConnState>>,
    /// Single-flight gate per `connection_id`. Concurrent `get_or_open`
    /// callers wait on the same `Notify` so we only pay the open cost once.
    inflight: Mutex<HashMap<String, Arc<Notify>>>,
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
    app: OnceLock<AppHandle>,
}

impl PoolRegistry {
    pub fn set_app_handle(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub async fn active_ids(&self) -> Vec<String> {
        self.pools.lock().await.keys().cloned().collect()
    }

    async fn emit_changed(&self) {
        if let Some(app) = self.app.get() {
            let ids = self.active_ids().await;
            let _ = app.emit(POOLS_CHANGED_EVENT, ids);
        }
    }

    async fn set_state(&self, connection_id: &str, state: ConnState) {
        self.states
            .lock()
            .await
            .insert(connection_id.to_string(), state.clone());
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                CONN_STATE_EVENT,
                ConnStatePayload {
                    connection_id: connection_id.to_string(),
                    state,
                },
            );
        }
    }

    async fn clear_state(&self, connection_id: &str) {
        // Removing the state == "idle". Frontend treats absence as idle.
        self.states.lock().await.remove(connection_id);
        if let Some(app) = self.app.get() {
            // Emit a synthetic "idle" so the UI can distinguish a clean
            // disconnect from a transient gap.
            let _ = app.emit(
                CONN_STATE_EVENT,
                serde_json::json!({
                    "connection_id": connection_id,
                    "state": { "kind": "idle" }
                }),
            );
        }
    }

    /// Public state lookup for IPC.
    pub async fn current_state(&self, connection_id: &str) -> Option<ConnState> {
        self.states.lock().await.get(connection_id).cloned()
    }

    pub async fn get_or_open(
        &self,
        state: &AppState,
        connection_id: &str,
    ) -> AppResult<PoolHandle> {
        // Fast path: already open.
        if let Some(p) = self.pools.lock().await.get(connection_id) {
            return Ok(p.handle.clone());
        }

        // Single-flight: if someone else is already opening this connection,
        // wait on their Notify and then re-check the pools map.
        loop {
            let notify = {
                let mut inflight = self.inflight.lock().await;
                if let Some(n) = inflight.get(connection_id).cloned() {
                    Some(n)
                } else {
                    let n = Arc::new(Notify::new());
                    inflight.insert(connection_id.to_string(), n.clone());
                    None
                }
            };
            if let Some(notify) = notify {
                notify.notified().await;
                // Re-check: another caller may have populated `pools`.
                if let Some(p) = self.pools.lock().await.get(connection_id) {
                    return Ok(p.handle.clone());
                }
                // Or it may have failed; re-enter the loop to try ourselves.
                continue;
            }
            break;
        }

        // We hold the in-flight slot. From here on, every exit path must
        // remove the slot and notify waiters.
        self.set_state(connection_id, ConnState::Connecting).await;
        let open_fut = self.open_impl(state, connection_id);
        let result = match tokio::time::timeout(CONNECT_WATCHDOG, open_fut).await {
            Ok(r) => r,
            Err(_) => Err(AppError::Other(format!(
                "connection timed out after {}s while opening tunnel/pool",
                CONNECT_WATCHDOG.as_secs()
            ))),
        };

        // Drop the in-flight slot and wake all waiters.
        if let Some(notify) = self.inflight.lock().await.remove(connection_id) {
            notify.notify_waiters();
        }

        match &result {
            Ok(_) => {
                self.set_state(connection_id, ConnState::Ready).await;
                self.emit_changed().await;
            }
            Err(e) => {
                self.set_state(
                    connection_id,
                    ConnState::Error {
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        result
    }

    /// Open a tunnel + pool for a connection, reusing any existing tunnel
    /// whose `TunnelKey` matches. Caller is responsible for state tracking.
    async fn open_impl(&self, state: &AppState, connection_id: &str) -> AppResult<PoolHandle> {
        let (conn, password, wg_config_text, ssh_config_text) =
            resolve_connection(state, connection_id).await?;

        let (tunnel_arc, effective_host, effective_port) =
            if conn.ssh.is_some() && !matches!(conn.kind, DbKind::Sqlite) {
                let cfg_text = ssh_config_text.ok_or_else(|| {
                    AppError::SshTunnel(
                        "ssh is enabled for this connection but no config is stored".into(),
                    )
                })?;
                let cfg = SshConfig::parse(&cfg_text)?;
                let key = TunnelKey::Ssh {
                    host: cfg.host.clone(),
                    port: cfg.port,
                    username: cfg.username.clone(),
                    fingerprint: cfg.known_host_fingerprint.clone(),
                };
                let entry = self
                    .get_or_open_tunnel(key, || async {
                        let t = ssh::open_tunnel(&cfg, conn.host.clone(), conn.port).await?;
                        // TOFU writeback: persist the captured host fingerprint so
                        // future connects can verify it.
                        if cfg.known_host_fingerprint.is_none() {
                            if let Some(fp) = t.captured_fingerprint.clone() {
                                let updated = cfg.with_fingerprint(fp);
                                if let Ok(json) = serde_json::to_string(&updated) {
                                    let _ = state
                                        .storage
                                        .set_ssh_config(connection_id, Some(&json))
                                        .await;
                                }
                            }
                        }
                        let local_addr = t.local_addr;
                        Ok((Tunnel::Ssh(t), local_addr))
                    })
                    .await?;
                let host = entry.local_addr.ip().to_string();
                let port = entry.local_addr.port();
                (Some(entry), host, port)
            } else if conn.wg.is_some() && !matches!(conn.kind, DbKind::Sqlite) {
                let cfg_text = wg_config_text.ok_or_else(|| {
                    AppError::WgTunnel(
                        "wireguard is enabled for this connection but no config is stored".into(),
                    )
                })?;
                let cfg = WgConfig::parse(&cfg_text)?;
                let target_ip: IpAddr = conn.host.parse().map_err(|_| {
                    AppError::WgTunnel(format!(
                        "wireguard target host `{}` must be an IP address (not a hostname) — DNS \
                     inside the tunnel is not supported yet",
                        conn.host
                    ))
                })?;
                let target = SocketAddr::new(target_ip, conn.port);
                let key = TunnelKey::Wg {
                    peer_public_key: cfg.peer.public_key,
                    endpoint: cfg.peer.endpoint,
                };
                let entry = self
                    .get_or_open_tunnel(key, || async {
                        let t = wireguard::open_tunnel(&cfg, target).await?;
                        let local_addr = t.local_addr;
                        Ok((Tunnel::Wg(t), local_addr))
                    })
                    .await?;
                let host = entry.local_addr.ip().to_string();
                let port = entry.local_addr.port();
                (Some(entry), host, port)
            } else {
                (None, conn.host.clone(), conn.port)
            };

        let handle =
            match open_pool(&conn, password.as_deref(), &effective_host, effective_port).await {
                Ok(h) => h,
                Err(e) => {
                    // The pool failed; release our reference to the tunnel. If
                    // we were the only holder, the tunnel will shut down via
                    // `TunnelEntry::drop`.
                    drop(tunnel_arc);
                    self.gc_tunnels().await;
                    return Err(e);
                }
            };
        self.pools.lock().await.insert(
            connection_id.to_string(),
            PoolEntry {
                handle: handle.clone(),
                tunnel: tunnel_arc,
            },
        );
        Ok(handle)
    }

    /// Find an existing tunnel matching `key`, or open a new one via `make`.
    async fn get_or_open_tunnel<F, Fut>(
        &self,
        key: TunnelKey,
        make: F,
    ) -> AppResult<Arc<TunnelEntry>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = AppResult<(Tunnel, SocketAddr)>>,
    {
        if let Some(existing) = self.tunnels.lock().await.get(&key).cloned() {
            return Ok(existing);
        }
        // Open outside the lock so concurrent openers for *different* keys
        // don't serialize. A small race here could lead to two opens for the
        // same key; on the second insert we discard the loser.
        let (tunnel, local_addr) = make().await?;
        let entry = Arc::new(TunnelEntry {
            tunnel: Mutex::new(Some(tunnel)),
            local_addr,
            key: key.clone(),
        });
        let mut tunnels = self.tunnels.lock().await;
        if let Some(existing) = tunnels.get(&key).cloned() {
            // Race lost: shut our just-built tunnel down and return the
            // pre-existing one so we don't leak two tunnels for one key.
            drop(tunnels);
            if let Some(t) = entry.tunnel.lock().await.take() {
                t.shutdown().await;
            }
            return Ok(existing);
        }
        tunnels.insert(key, entry.clone());
        Ok(entry)
    }

    /// Remove tunnels that have no remaining `PoolEntry` references.
    /// Called after a pool close so unreferenced tunnels actually shut down.
    async fn gc_tunnels(&self) {
        let in_use: std::collections::HashSet<TunnelKey> = {
            let pools = self.pools.lock().await;
            pools
                .values()
                .filter_map(|e| e.tunnel.as_ref().map(|t| t.key.clone()))
                .collect()
        };
        let mut to_shutdown: Vec<Arc<TunnelEntry>> = Vec::new();
        {
            let mut tunnels = self.tunnels.lock().await;
            tunnels.retain(|k, v| {
                if in_use.contains(k) {
                    true
                } else {
                    to_shutdown.push(v.clone());
                    false
                }
            });
        }
        for entry in to_shutdown {
            if let Some(t) = entry.tunnel.lock().await.take() {
                t.shutdown().await;
            }
        }
    }

    /// Swap the DB pool for an existing connection without rebuilding its
    /// tunnel. Used by `switch_database` so changing DBs on the same host
    /// doesn't pay the SSH/WG handshake again.
    pub async fn swap_pool_for_database(
        &self,
        state: &AppState,
        connection_id: &str,
    ) -> AppResult<PoolHandle> {
        // Pull out the current PoolEntry. Keep its tunnel reference alive
        // through the rebuild so we don't trigger `gc_tunnels` against a
        // tunnel we're about to reuse.
        let prev_tunnel = {
            let mut pools = self.pools.lock().await;
            match pools.remove(connection_id) {
                Some(entry) => {
                    entry.handle.close().await;
                    entry.tunnel
                }
                None => None,
            }
        };

        self.set_state(connection_id, ConnState::Connecting).await;
        let (conn, password, _, _) = resolve_connection(state, connection_id).await?;
        let (host, port) = if let Some(ref tun) = prev_tunnel {
            (tun.local_addr.ip().to_string(), tun.local_addr.port())
        } else {
            (conn.host.clone(), conn.port)
        };
        let handle = match open_pool(&conn, password.as_deref(), &host, port).await {
            Ok(h) => h,
            Err(e) => {
                drop(prev_tunnel);
                self.gc_tunnels().await;
                self.set_state(
                    connection_id,
                    ConnState::Error {
                        message: e.to_string(),
                    },
                )
                .await;
                return Err(e);
            }
        };
        self.pools.lock().await.insert(
            connection_id.to_string(),
            PoolEntry {
                handle: handle.clone(),
                tunnel: prev_tunnel,
            },
        );
        self.set_state(connection_id, ConnState::Ready).await;
        self.emit_changed().await;
        Ok(handle)
    }

    pub async fn close(&self, connection_id: &str) {
        let removed = self.pools.lock().await.remove(connection_id);
        if let Some(entry) = removed {
            entry.handle.close().await;
            drop(entry.tunnel);
            self.gc_tunnels().await;
            self.clear_state(connection_id).await;
            self.emit_changed().await;
        }
    }

    pub async fn register_cancel(&self, query_id: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        self.cancels.lock().await.insert(query_id.to_string(), tx);
        rx
    }

    pub async fn fire_cancel(&self, query_id: &str) -> bool {
        if let Some(tx) = self.cancels.lock().await.remove(query_id) {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    pub async fn forget_cancel(&self, query_id: &str) {
        self.cancels.lock().await.remove(query_id);
    }
}

async fn open_pool(
    conn: &SavedConnection,
    password: Option<&str>,
    host: &str,
    port: u16,
) -> AppResult<EngineHandle> {
    if matches!(conn.kind, DbKind::Sqlite) {
        let pool = sqlite_drv::connect(&conn.database).await?;
        return Ok(Arc::new(SqliteEngine::new(pool)));
    }
    let url = build_url(
        &conn.kind,
        &conn.username,
        password,
        host,
        port,
        &conn.database,
        conn.ssl,
    );
    let handle: EngineHandle = match conn.kind {
        DbKind::Postgres => Arc::new(PostgresEngine::new(pg_drv::connect(&url).await?)),
        DbKind::Mysql => Arc::new(MysqlEngine::new(mysql_drv::connect(&url).await?)),
        DbKind::Sqlite => unreachable!("sqlite handled above"),
    };
    Ok(handle)
}

fn build_url(
    kind: &DbKind,
    username: &str,
    password: Option<&str>,
    host: &str,
    port: u16,
    database: &str,
    ssl: bool,
) -> String {
    let scheme = match kind {
        DbKind::Postgres => "postgres",
        DbKind::Mysql => "mysql",
        DbKind::Sqlite => unreachable!("sqlite does not use a URL"),
    };
    let userinfo = if let Some(pw) = password {
        format!("{}:{}", urlencode(username), urlencode(pw))
    } else {
        urlencode(username)
    };
    let db = if database.is_empty() {
        match kind {
            // Postgres always needs a database name in the URL (otherwise it falls
            // back to the username). Bootstrap with the default admin DB so the
            // user can list/switch from there.
            DbKind::Postgres => "/postgres".to_string(),
            _ => String::new(),
        }
    } else {
        format!("/{}", urlencode(database))
    };
    let qs = match (kind, ssl) {
        (DbKind::Postgres, true) => "?sslmode=require",
        (DbKind::Mysql, true) => "?ssl-mode=REQUIRED",
        _ => "",
    };
    format!("{scheme}://{userinfo}@{host}:{port}{db}{qs}")
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                vec![b as char]
            } else {
                format!("%{:02X}", b).chars().collect()
            }
        })
        .collect()
}

pub async fn run_with_cancel(
    registry: &PoolRegistry,
    handle: EngineHandle,
    query_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    let cancel_rx = registry.register_cancel(query_id).await;

    let sql = sql.to_string();
    let exec = async move { handle.execute(&sql).await };

    let result = tokio::select! {
        r = exec => r,
        _ = cancel_rx => Err(crate::error::AppError::Canceled),
    };

    registry.forget_cancel(query_id).await;
    result
}

pub async fn run_script_with_cancel(
    registry: &PoolRegistry,
    handle: EngineHandle,
    query_id: &str,
    sql: &str,
) -> AppResult<ScriptResult> {
    let cancel_rx = registry.register_cancel(query_id).await;

    let sql = sql.to_string();
    let exec = async move { handle.execute_script(&sql).await };

    let result = tokio::select! {
        r = exec => r,
        _ = cancel_rx => Err(crate::error::AppError::Canceled),
    };

    registry.forget_cancel(query_id).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_passes_unreserved_chars_through() {
        assert_eq!(urlencode("aZ09-_.~"), "aZ09-_.~");
    }

    #[test]
    fn urlencode_percent_encodes_special_chars() {
        assert_eq!(urlencode("p@ss word/!"), "p%40ss%20word%2F%21");
        assert_eq!(urlencode(":/?#"), "%3A%2F%3F%23");
    }

    #[test]
    fn build_url_postgres_with_password() {
        let url = build_url(
            &DbKind::Postgres,
            "user",
            Some("p@ss"),
            "localhost",
            5432,
            "app",
            false,
        );
        assert_eq!(url, "postgres://user:p%40ss@localhost:5432/app");
    }

    #[test]
    fn build_url_omits_password_when_none() {
        let url = build_url(&DbKind::Mysql, "root", None, "127.0.0.1", 3306, "db", false);
        assert_eq!(url, "mysql://root@127.0.0.1:3306/db");
    }

    #[test]
    fn build_url_omits_path_when_database_is_empty() {
        let url = build_url(&DbKind::Mysql, "root", None, "host", 3306, "", false);
        assert_eq!(url, "mysql://root@host:3306");
    }

    #[test]
    fn build_url_appends_ssl_query_string_per_kind() {
        let pg = build_url(&DbKind::Postgres, "u", None, "h", 5432, "d", true);
        assert!(pg.ends_with("?sslmode=require"), "got {pg}");

        let my = build_url(&DbKind::Mysql, "u", None, "h", 3306, "d", true);
        assert!(my.ends_with("?ssl-mode=REQUIRED"), "got {my}");
    }

    #[test]
    fn build_url_encodes_username_with_special_chars() {
        let url = build_url(
            &DbKind::Postgres,
            "ad min",
            Some("x"),
            "h",
            5432,
            "d",
            false,
        );
        assert_eq!(url, "postgres://ad%20min:x@h:5432/d");
    }
}
