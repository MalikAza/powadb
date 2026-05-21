use async_trait::async_trait;
use sqlx::sqlite::SqlitePool;

use super::{Capabilities, Engine, SqlPoolView};
use crate::drivers::{sqlite as sqlite_drv, QueryResult, ScriptResult};
use crate::error::AppResult;
use crate::storage::DbKind;

pub struct SqliteEngine {
    pub pool: SqlitePool,
}

impl SqliteEngine {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Engine for SqliteEngine {
    fn kind(&self) -> DbKind {
        DbKind::Sqlite
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // SQLite is a single file: no databases to list, no CREATE DATABASE.
            supports_databases_list: false,
            supports_database_create: false,
            ..Capabilities::sql_default()
        }
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        sqlite_drv::execute(&self.pool, sql).await
    }

    async fn execute_script(&self, sql: &str) -> AppResult<ScriptResult> {
        sqlite_drv::execute_script(&self.pool, sql).await
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    fn as_sql_pool(&self) -> Option<SqlPoolView<'_>> {
        Some(SqlPoolView::Sqlite(&self.pool))
    }
}
