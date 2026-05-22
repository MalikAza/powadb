use async_trait::async_trait;
use sqlx::postgres::PgPool;

use super::{Capabilities, Engine, SqlPoolView};
use crate::drivers::{postgres as pg_drv, QueryResult, ScriptResult};
use crate::error::AppResult;
use crate::storage::DbKind;

pub struct PostgresEngine {
    pub pool: PgPool,
}

impl PostgresEngine {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Engine for PostgresEngine {
    fn kind(&self) -> DbKind {
        DbKind::Postgres
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            supports_schemas: true,
            supports_geo: true,
            ..Capabilities::sql_default()
        }
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        pg_drv::execute(&self.pool, sql).await
    }

    async fn execute_script(&self, sql: &str) -> AppResult<ScriptResult> {
        pg_drv::execute_script(&self.pool, sql).await
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    fn as_sql_pool(&self) -> Option<SqlPoolView<'_>> {
        Some(SqlPoolView::Postgres(&self.pool))
    }
}
