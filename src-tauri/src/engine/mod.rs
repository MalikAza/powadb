//! Engine abstraction.
//!
//! Today this wraps the existing sqlx-based drivers (Postgres, MySQL, SQLite)
//! behind a trait so the rest of the codebase can stop pattern-matching on a
//! `PoolHandle` enum. Future engines (MongoDB) will implement the same trait.
//!
//! - `PoolHandle` is kept as a re-export of `EngineHandle` so existing callers
//!   don't all have to rename in one go.
//! - `SqlPoolView` lets SQL-only code paths still pattern-match on the three
//!   sqlx pool types (this is the de-facto pattern across `commands/*.rs`).
//!   Non-SQL engines return `None` from `as_sql_pool`; the `require_sql_pool`
//!   helper produces a consistent error for SQL-only commands.
//! - `Capabilities` tells the frontend which features the engine supports.
//!   SQL-only IPC commands consult it at the boundary so the UI can hide
//!   unsupported features rather than letting them fail at runtime.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::mysql::MySqlPool;
use sqlx::postgres::PgPool;
use sqlx::sqlite::SqlitePool;

use crate::drivers::{QueryResult, ScriptResult};
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;

pub mod mongo;
pub mod mysql;
pub mod postgres;
pub mod sqlite;

pub use mongo::MongoEngine;
pub use mysql::MysqlEngine;
pub use postgres::PostgresEngine;
pub use sqlite::SqliteEngine;

/// Reference-counted handle to a live database connection pool.
pub type EngineHandle = Arc<dyn Engine>;

/// Borrowed view over the underlying sqlx pool, for the three current SQL
/// engines. Used by command modules that need direct sqlx access for queries
/// the trait doesn't yet abstract (introspection, DDL, etc.).
pub enum SqlPoolView<'a> {
    Postgres(&'a PgPool),
    Mysql(&'a MySqlPool),
    Sqlite(&'a SqlitePool),
}

/// What an engine supports. Returned from `Engine::capabilities` and surfaced
/// to the frontend via the `get_capabilities` IPC command so the UI can hide
/// features the engine doesn't support (Mongo: no schemas/FKs/DDL; SQLite: no
/// `CREATE DATABASE`; Postgres-only: PostGIS).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryLanguage {
    Sql,
    Mongo,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Capabilities {
    /// Can the engine enumerate databases (the unit *above* "schema/collection")?
    pub supports_databases_list: bool,
    /// `CREATE DATABASE` is meaningful.
    pub supports_database_create: bool,
    /// Engine has a real "schema" namespace under the database (Postgres only).
    /// MySQL conflates database and schema; SQLite is single-namespace; Mongo
    /// has database → collection with no schema layer.
    pub supports_schemas: bool,
    /// Foreign-key constraints are a thing.
    pub supports_foreign_keys: bool,
    /// DDL can be diffed and generated (drives the Diagram view).
    pub supports_ddl_diff: bool,
    /// Visual ER diagram is meaningful.
    pub supports_diagram: bool,
    /// PostGIS-style geometry handling.
    pub supports_geo: bool,
    /// Native-tool dump path is supported (pg_dump / mysqldump / sqlite3 .dump /
    /// mongodump).
    pub supports_native_dump: bool,
    /// The query language the editor should use.
    pub query_language: QueryLanguage,
}

impl Capabilities {
    /// Defaults that fit the three current SQL engines. Specific engines
    /// override what doesn't apply.
    pub const fn sql_default() -> Self {
        Self {
            supports_databases_list: true,
            supports_database_create: true,
            supports_schemas: false,
            supports_foreign_keys: true,
            supports_ddl_diff: true,
            supports_diagram: true,
            supports_geo: false,
            supports_native_dump: true,
            query_language: QueryLanguage::Sql,
        }
    }
}

#[async_trait]
pub trait Engine: Send + Sync {
    fn kind(&self) -> DbKind;

    fn capabilities(&self) -> Capabilities;

    async fn execute(&self, sql: &str) -> AppResult<QueryResult>;
    async fn execute_script(&self, sql: &str) -> AppResult<ScriptResult>;

    /// Engine-agnostic query path. Default impl rejects non-SQL queries and
    /// routes `EngineQuery::Sql(...)` through the existing `execute()` so
    /// SQL engines get this method for free. Mongo overrides it.
    async fn execute_query(&self, q: EngineQuery) -> AppResult<EngineResult> {
        match q {
            EngineQuery::Sql(sql) => self.execute(&sql).await.map(EngineResult::Tabular),
            EngineQuery::Mongo(_) => Err(AppError::Other(format!(
                "{:?} engine cannot execute MongoDB queries",
                self.kind()
            ))),
        }
    }

    /// Close the underlying pool. Idempotent; pools are usually `Arc`-backed
    /// so additional clones may still hold handles.
    async fn close(&self);

    /// For SQL engines, return a borrowed view of the underlying sqlx pool.
    /// Non-SQL engines return `None`.
    fn as_sql_pool(&self) -> Option<SqlPoolView<'_>> {
        None
    }

    /// Downcast to the Mongo engine for command paths that need direct
    /// `mongodb::Client` access (introspection, namespace listing, …).
    /// SQL engines return `None`.
    fn as_mongo(&self) -> Option<&crate::engine::mongo::MongoEngine> {
        None
    }
}

/// Borrow the SQL pool view from an engine handle, or return a consistent
/// error for non-SQL engines. Use this in command handlers that haven't been
/// generalized to non-SQL engines yet.
pub fn require_sql_pool<'a>(handle: &'a EngineHandle, op: &str) -> AppResult<SqlPoolView<'a>> {
    handle
        .as_sql_pool()
        .ok_or_else(|| AppError::Other(format!("{op} requires a SQL engine")))
}

// ─── Engine-agnostic query / result types ────────────────────────────────────
//
// These let non-SQL engines (Mongo) participate in the query path without
// pretending their inputs/outputs are SQL. SQL engines keep using `execute` /
// `execute_script` directly today; Phase-5+ migration will route them through
// `execute_query` so the IPC layer can be uniformly typed.

/// What the user is asking the engine to do. The variant matches the engine's
/// query language; the IPC layer parses the editor text accordingly.
///
/// Serde representation: adjacently tagged (`{ kind, value }`). Internal
/// tagging doesn't work here because `Sql(String)` is a newtype around a
/// primitive — serde's internal tag needs every variant's payload to be a
/// struct or map-like type.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum EngineQuery {
    /// Raw SQL, single statement or multi-statement script.
    Sql(String),
    /// A MongoDB operation. Parsed from the mongosh-style DSL on the frontend
    /// into this structured form so the backend doesn't have to embed a JS
    /// parser. Boxed because `MongoOp` is much larger than `String`.
    Mongo(Box<MongoOp>),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MongoOp {
    Find {
        collection: String,
        /// Database override. When `None`, the op runs against the engine's
        /// default database (taken from the connection URI). Set this when
        /// the UI is browsing a specific Mongo database — the sidebar's
        /// per-DB grouping won't otherwise be reflected in the query path.
        #[serde(default)]
        database: Option<String>,
        #[serde(default)]
        filter: Value,
        #[serde(default)]
        projection: Option<Value>,
        #[serde(default)]
        limit: Option<u32>,
        #[serde(default)]
        skip: Option<u32>,
        #[serde(default)]
        sort: Option<Value>,
    },
    Aggregate {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        /// JSON array of stages: `[{"$match": {...}}, {"$group": {...}}, ...]`.
        pipeline: Value,
    },
    InsertOne {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        document: Value,
    },
    InsertMany {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        documents: Vec<Value>,
    },
    UpdateMany {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        filter: Value,
        update: Value,
    },
    DeleteMany {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        filter: Value,
    },
    /// Escape hatch for the long tail of admin commands. Mirrors
    /// `db.runCommand(doc)`. Carries the command document as `value` so the
    /// shape matches the internally-tagged convention (`{ op: "run_command",
    /// value: { ... } }`) — serde's internal tagging needs every variant's
    /// payload to be a struct or map, not a bare `serde_json::Value`.
    RunCommand { value: Value },
}

/// Engine-agnostic query result. SQL engines return `Tabular`; Mongo returns
/// `Documents` for finds/aggregates and `Affected` for write ops.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EngineResult {
    Tabular(QueryResult),
    Documents { docs: Vec<Value>, elapsed_ms: u128 },
    Affected { rows: u64, elapsed_ms: u128 },
}

impl EngineResult {
    pub fn elapsed_ms(&self) -> u128 {
        match self {
            EngineResult::Tabular(q) => q.elapsed_ms,
            EngineResult::Documents { elapsed_ms, .. } => *elapsed_ms,
            EngineResult::Affected { elapsed_ms, .. } => *elapsed_ms,
        }
    }
}
