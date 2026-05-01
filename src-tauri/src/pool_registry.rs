use std::collections::HashMap;

use sqlx::mysql::MySqlPool;
use sqlx::postgres::PgPool;
use tokio::sync::{oneshot, Mutex};

use crate::commands::connections::resolve_connection;
use crate::drivers::{mysql as mysql_drv, postgres as pg_drv, QueryResult};
use crate::error::AppResult;
use crate::storage::{DbKind, SavedConnection};
use crate::AppState;

#[derive(Clone)]
pub enum PoolHandle {
    Postgres(PgPool),
    MySql(MySqlPool),
}

#[derive(Default)]
pub struct PoolRegistry {
    pools: Mutex<HashMap<String, PoolHandle>>,
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl PoolRegistry {
    pub async fn get_or_open(&self, state: &AppState, connection_id: &str) -> AppResult<PoolHandle> {
        if let Some(p) = self.pools.lock().await.get(connection_id).cloned() {
            return Ok(p);
        }
        let (conn, password) = resolve_connection(state, connection_id).await?;
        let handle = open_pool(&conn, password.as_deref()).await?;
        self.pools.lock().await.insert(connection_id.to_string(), handle.clone());
        Ok(handle)
    }

    pub async fn close(&self, connection_id: &str) {
        if let Some(handle) = self.pools.lock().await.remove(connection_id) {
            match handle {
                PoolHandle::Postgres(p) => p.close().await,
                PoolHandle::MySql(p) => p.close().await,
            }
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

async fn open_pool(conn: &SavedConnection, password: Option<&str>) -> AppResult<PoolHandle> {
    let url = build_url(
        &conn.kind,
        &conn.username,
        password,
        &conn.host,
        conn.port,
        &conn.database,
        conn.ssl,
    );
    Ok(match conn.kind {
        DbKind::Postgres => PoolHandle::Postgres(pg_drv::connect(&url).await?),
        DbKind::Mysql => PoolHandle::MySql(mysql_drv::connect(&url).await?),
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
    };
    let userinfo = if let Some(pw) = password {
        format!("{}:{}", urlencode(username), urlencode(pw))
    } else {
        urlencode(username)
    };
    let db = if database.is_empty() {
        String::new()
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
        }
    };

    let result = tokio::select! {
        r = exec => r,
        _ = cancel_rx => Err(crate::error::AppError::Canceled),
    };

    registry.forget_cancel(query_id).await;
    result
}
