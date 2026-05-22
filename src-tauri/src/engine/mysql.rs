use async_trait::async_trait;
use sqlx::mysql::MySqlPool;

use super::{Capabilities, Engine, SqlPoolView};
use crate::drivers::{mysql as mysql_drv, QueryResult, ScriptResult};
use crate::error::AppResult;
use crate::storage::DbKind;

pub struct MysqlEngine {
    pub pool: MySqlPool,
}

impl MysqlEngine {
    pub fn new(pool: MySqlPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Engine for MysqlEngine {
    fn kind(&self) -> DbKind {
        DbKind::Mysql
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::sql_default()
    }

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        mysql_drv::execute(&self.pool, sql).await
    }

    async fn execute_script(&self, sql: &str) -> AppResult<ScriptResult> {
        mysql_drv::execute_script(&self.pool, sql).await
    }

    async fn close(&self) {
        self.pool.close().await;
    }

    fn as_sql_pool(&self) -> Option<SqlPoolView<'_>> {
        Some(SqlPoolView::Mysql(&self.pool))
    }
}
