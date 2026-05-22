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
    /// `DROP DATABASE` is meaningful. Split from `supports_database_create`
    /// because Mongo can drop but doesn't have an explicit `CREATE DATABASE`
    /// (databases come into being on first write).
    pub supports_database_drop: bool,
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
            supports_database_drop: true,
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
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum EngineQuery {
    /// Raw SQL, single statement or multi-statement script.
    Sql(String),
    /// A MongoDB operation. Parsed from the mongosh-style DSL on the frontend
    /// into this structured form so the backend doesn't have to embed a JS
    /// parser. Boxed because `MongoOp` is much larger than `String`.
    Mongo(Box<MongoOp>),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    /// Like `Find` but stops at the first matching document and returns it
    /// (or an empty set). Mirrors `db.coll.findOne(...)` — the DSL has it
    /// and silently downgrading to `find().limit(1)` would lose the
    /// "return one document or null" semantic the user expects.
    FindOne {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        #[serde(default)]
        filter: Value,
        #[serde(default)]
        projection: Option<Value>,
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
    UpdateOne {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        filter: Value,
        update: Value,
    },
    UpdateMany {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        filter: Value,
        update: Value,
    },
    DeleteOne {
        collection: String,
        #[serde(default)]
        database: Option<String>,
        filter: Value,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn elapsed_ms_reads_from_each_variant() {
        let tabular = EngineResult::Tabular(QueryResult {
            columns: vec![],
            rows: vec![],
            elapsed_ms: 17,
        });
        let docs = EngineResult::Documents {
            docs: vec![],
            elapsed_ms: 42,
        };
        let affected = EngineResult::Affected {
            rows: 3,
            elapsed_ms: 99,
        };
        assert_eq!(tabular.elapsed_ms(), 17);
        assert_eq!(docs.elapsed_ms(), 42);
        assert_eq!(affected.elapsed_ms(), 99);
    }

    #[test]
    fn engine_query_sql_round_trips_as_adjacently_tagged_json() {
        let q = EngineQuery::Sql("SELECT 1".into());
        let serialized = serde_json::to_value(&q).unwrap();
        assert_eq!(serialized, json!({ "kind": "sql", "value": "SELECT 1" }));
        let back: EngineQuery = serde_json::from_value(serialized).unwrap();
        match back {
            EngineQuery::Sql(s) => assert_eq!(s, "SELECT 1"),
            _ => panic!("expected Sql variant"),
        }
    }

    #[test]
    fn engine_query_mongo_round_trips_as_adjacently_tagged_json() {
        let op = MongoOp::Find {
            collection: "users".into(),
            database: Some("app".into()),
            filter: json!({ "active": true }),
            projection: None,
            limit: Some(25),
            skip: None,
            sort: None,
        };
        let q = EngineQuery::Mongo(Box::new(op));
        let serialized = serde_json::to_value(&q).unwrap();
        assert_eq!(serialized["kind"], "mongo");
        assert_eq!(serialized["value"]["op"], "find");
        assert_eq!(serialized["value"]["collection"], "users");
        assert_eq!(serialized["value"]["limit"], 25);
        let back: EngineQuery = serde_json::from_value(serialized).unwrap();
        match back {
            EngineQuery::Mongo(boxed) => match *boxed {
                MongoOp::Find {
                    collection, limit, ..
                } => {
                    assert_eq!(collection, "users");
                    assert_eq!(limit, Some(25));
                }
                _ => panic!("expected Find variant"),
            },
            _ => panic!("expected Mongo variant"),
        }
    }

    #[test]
    fn mongo_op_aggregate_round_trips() {
        let op = MongoOp::Aggregate {
            collection: "orders".into(),
            database: None,
            pipeline: json!([{"$match": {"status": "paid"}}]),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["op"], "aggregate");
        assert_eq!(v["collection"], "orders");
        let back: MongoOp = serde_json::from_value(v).unwrap();
        assert!(matches!(back, MongoOp::Aggregate { .. }));
    }

    #[test]
    fn mongo_op_run_command_round_trips() {
        let op = MongoOp::RunCommand {
            value: json!({ "ping": 1 }),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["op"], "run_command");
        assert_eq!(v["value"], json!({ "ping": 1 }));
        let back: MongoOp = serde_json::from_value(v).unwrap();
        assert!(matches!(back, MongoOp::RunCommand { .. }));
    }

    #[test]
    fn mongo_op_insert_one_round_trips() {
        let op = MongoOp::InsertOne {
            collection: "events".into(),
            database: None,
            document: json!({ "type": "click" }),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["op"], "insert_one");
        let back: MongoOp = serde_json::from_value(v).unwrap();
        assert!(matches!(back, MongoOp::InsertOne { .. }));
    }

    #[test]
    fn mongo_op_update_one_and_delete_one_round_trip() {
        let upd = MongoOp::UpdateOne {
            collection: "u".into(),
            database: None,
            filter: json!({ "_id": "x" }),
            update: json!({ "$set": { "n": 1 } }),
        };
        let v = serde_json::to_value(&upd).unwrap();
        assert_eq!(v["op"], "update_one");

        let del = MongoOp::DeleteMany {
            collection: "u".into(),
            database: Some("app".into()),
            filter: json!({}),
        };
        let v = serde_json::to_value(&del).unwrap();
        assert_eq!(v["op"], "delete_many");
        assert_eq!(v["database"], "app");
    }

    #[test]
    fn capabilities_sql_default_enables_the_expected_features() {
        let c = Capabilities::sql_default();
        assert!(c.supports_databases_list);
        assert!(c.supports_database_create);
        assert!(c.supports_database_drop);
        assert!(c.supports_foreign_keys);
        assert!(c.supports_ddl_diff);
        assert!(c.supports_diagram);
        assert!(c.supports_native_dump);
        assert!(!c.supports_schemas);
        assert!(!c.supports_geo);
        assert!(matches!(c.query_language, QueryLanguage::Sql));
    }

    /// Fake engine that returns `None` from `as_sql_pool`, used to exercise
    /// the `require_sql_pool` error path without standing up a real driver.
    struct NoPoolEngine;

    #[async_trait]
    impl Engine for NoPoolEngine {
        fn kind(&self) -> DbKind {
            DbKind::Mongo
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::sql_default()
        }
        async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
            unreachable!()
        }
        async fn execute_script(&self, _sql: &str) -> AppResult<ScriptResult> {
            unreachable!()
        }
        async fn close(&self) {}
    }

    #[test]
    fn require_sql_pool_errors_for_non_sql_engines() {
        let handle: EngineHandle = Arc::new(NoPoolEngine);
        match require_sql_pool(&handle, "introspect") {
            Ok(_) => panic!("expected an error from require_sql_pool on a non-SQL engine"),
            Err(e) => {
                let msg = format!("{e:?}");
                assert!(msg.contains("introspect"));
                assert!(msg.contains("SQL engine"));
            }
        }
    }

    #[tokio::test]
    async fn default_execute_query_rejects_mongo_on_sql_engines() {
        let engine = NoPoolEngine;
        let q = EngineQuery::Mongo(Box::new(MongoOp::RunCommand { value: json!({}) }));
        let err = engine.execute_query(q).await.unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("cannot execute MongoDB"));
    }
}
