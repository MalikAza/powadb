use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;

use sqlx::mysql::MySqlPool;
use sqlx::postgres::PgPool;
use sqlx::sqlite::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use crate::commands::connections::resolve_connection;
use crate::drivers::{mysql as mysql_drv, postgres as pg_drv, sqlite as sqlite_drv, QueryResult};
use crate::error::{AppError, AppResult};
use crate::storage::{DbKind, SavedConnection};
use crate::wireguard::{self, TunnelHandle as WgTunnelHandle, WgConfig};
use crate::AppState;

pub const POOLS_CHANGED_EVENT: &str = "pools-changed";

#[derive(Clone)]
pub enum PoolHandle {
    Postgres(PgPool),
    MySql(MySqlPool),
    Sqlite(SqlitePool),
}

struct PoolEntry {
    handle: PoolHandle,
    tunnel: Option<WgTunnelHandle>,
}

#[derive(Default)]
pub struct PoolRegistry {
    pools: Mutex<HashMap<String, PoolEntry>>,
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

    pub async fn get_or_open(
        &self,
        state: &AppState,
        connection_id: &str,
    ) -> AppResult<PoolHandle> {
        if let Some(p) = self.pools.lock().await.get(connection_id) {
            return Ok(p.handle.clone());
        }
        let (conn, password, wg_config_text) = resolve_connection(state, connection_id).await?;

        // If WG is enabled, open the tunnel first and redirect the DB pool at
        // the local listener it spawned.
        let (tunnel, effective_host, effective_port) =
            if conn.wg.is_some() && !matches!(conn.kind, DbKind::Sqlite) {
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
                let t = wireguard::open_tunnel(&cfg, target).await?;
                let host = t.local_addr.ip().to_string();
                let port = t.local_addr.port();
                (Some(t), host, port)
            } else {
                (None, conn.host.clone(), conn.port)
            };

        let handle =
            match open_pool(&conn, password.as_deref(), &effective_host, effective_port).await {
                Ok(h) => h,
                Err(e) => {
                    if let Some(t) = tunnel {
                        t.shutdown().await;
                    }
                    return Err(e);
                }
            };
        self.pools.lock().await.insert(
            connection_id.to_string(),
            PoolEntry {
                handle: handle.clone(),
                tunnel,
            },
        );
        self.emit_changed().await;
        Ok(handle)
    }

    pub async fn close(&self, connection_id: &str) {
        let removed = self.pools.lock().await.remove(connection_id);
        if let Some(entry) = removed {
            match entry.handle {
                PoolHandle::Postgres(p) => p.close().await,
                PoolHandle::MySql(p) => p.close().await,
                PoolHandle::Sqlite(p) => p.close().await,
            }
            if let Some(t) = entry.tunnel {
                t.shutdown().await;
            }
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
) -> AppResult<PoolHandle> {
    if matches!(conn.kind, DbKind::Sqlite) {
        return Ok(PoolHandle::Sqlite(
            sqlite_drv::connect(&conn.database).await?,
        ));
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
    Ok(match conn.kind {
        DbKind::Postgres => PoolHandle::Postgres(pg_drv::connect(&url).await?),
        DbKind::Mysql => PoolHandle::MySql(mysql_drv::connect(&url).await?),
        DbKind::Sqlite => unreachable!("sqlite handled above"),
    })
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
    handle: PoolHandle,
    query_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    let cancel_rx = registry.register_cancel(query_id).await;

    let exec = async move {
        match handle {
            PoolHandle::Postgres(p) => pg_drv::execute(&p, sql).await,
            PoolHandle::MySql(p) => mysql_drv::execute(&p, sql).await,
            PoolHandle::Sqlite(p) => sqlite_drv::execute(&p, sql).await,
        }
    };

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
