//! MongoDB engine.
//!
//! Implements `Engine` over the `mongodb` driver. SQL methods on the trait
//! (`execute`, `execute_script`, `as_sql_pool`) return errors / `None` — Mongo
//! work goes through `execute_query` with `EngineQuery::Mongo(MongoOp)`.

use std::time::Instant;

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime as BsonDateTime, Document};
use mongodb::options::{ClientOptions, FindOptions};
use mongodb::Client;
use serde_json::Value;

use super::{Capabilities, Engine, EngineQuery, EngineResult, MongoOp, QueryLanguage};
use crate::drivers::{QueryResult, ScriptResult};
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;

pub struct MongoEngine {
    pub(crate) client: Client,
    /// Default database (from the URI path or the `database` field of the
    /// saved connection). Used when a `MongoOp` references a collection
    /// without naming a database explicitly.
    pub(crate) database: String,
}

impl MongoEngine {
    pub async fn connect(uri: &str, database: &str) -> AppResult<Self> {
        let opts = ClientOptions::parse(uri)
            .await
            .map_err(|e| AppError::Other(format!("invalid mongo uri: {e}")))?;
        let client = Client::with_options(opts)
            .map_err(|e| AppError::Other(format!("mongo client init failed: {e}")))?;
        // Cheap connectivity probe so a bad URI surfaces immediately instead
        // of on first query. Ping the user's actual database (or whatever the
        // URI's default database is) — pinging `admin` would fail for users
        // who only have access to a specific database, which is the common
        // production setup.
        let probe_db = client
            .default_database()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|| database.to_string());
        client
            .database(&probe_db)
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("Authentication failed") || msg.contains("AuthenticationFailed") {
                    AppError::Other(format!(
                        "mongo authentication failed against database '{probe_db}'. \
                         Your MongoDB user is likely registered against a different database \
                         (its auth source). Set PowaDB's 'Database' field to that database name, \
                         or paste a full mongodb:// URI with an explicit ?authSource=… parameter. \
                         (Raw error: {msg})"
                    ))
                } else {
                    AppError::Other(format!("mongo ping failed: {msg}"))
                }
            })?;
        Ok(Self {
            client,
            database: database.to_string(),
        })
    }
}

#[async_trait]
impl Engine for MongoEngine {
    fn kind(&self) -> DbKind {
        DbKind::Mongo
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            supports_databases_list: true,
            // CREATE DATABASE is implicit in Mongo (write to it and it exists);
            // hide the UI affordance to avoid confusion.
            supports_database_create: false,
            // …but dropping a database is a real, useful affordance.
            supports_database_drop: true,
            supports_schemas: false,
            supports_foreign_keys: false,
            supports_ddl_diff: false,
            supports_diagram: false,
            supports_geo: false,
            // `mongodump` integration is Phase-7; flag is true so the UI lists
            // export as available once that lands.
            supports_native_dump: true,
            query_language: QueryLanguage::Mongo,
        }
    }

    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::Other(
            "MongoDB engine cannot execute raw SQL — use the query editor in Mongo mode".into(),
        ))
    }

    async fn execute_script(&self, _sql: &str) -> AppResult<ScriptResult> {
        Err(AppError::Other(
            "MongoDB engine cannot execute SQL scripts".into(),
        ))
    }

    async fn execute_query(&self, q: EngineQuery) -> AppResult<EngineResult> {
        let op = match q {
            EngineQuery::Mongo(op) => *op,
            EngineQuery::Sql(_) => {
                return Err(AppError::Other(
                    "MongoDB engine cannot execute SQL queries".into(),
                ));
            }
        };
        let start = Instant::now();
        // Resolve the target database from the op (if it overrides) or fall
        // back to the engine's default. Keeps the per-op API explicit while
        // preserving the "just use the connection's DB" convenience.
        let pick_db = |override_db: &Option<String>| -> mongodb::Database {
            let name = override_db.as_deref().unwrap_or(&self.database);
            self.client.database(name)
        };
        match op {
            MongoOp::Find {
                collection,
                database,
                filter,
                projection,
                limit,
                skip,
                sort,
            } => {
                let db = pick_db(&database);
                let coll = db.collection::<Document>(&collection);
                let opts = FindOptions::builder()
                    .projection(projection.map(value_to_doc).transpose()?)
                    .limit(limit.map(|n| n as i64))
                    .skip(skip.map(|n| n as u64))
                    .sort(sort.map(value_to_doc).transpose()?)
                    .build();
                let cursor = coll
                    .find(value_to_doc(filter)?)
                    .with_options(opts)
                    .await
                    .map_err(mongo_err)?;
                let docs: Vec<Document> = cursor.try_collect().await.map_err(mongo_err)?;
                Ok(EngineResult::Documents {
                    docs: docs.into_iter().map(doc_to_value).collect(),
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
            MongoOp::Aggregate {
                collection,
                database,
                pipeline,
            } => {
                let db = pick_db(&database);
                let coll = db.collection::<Document>(&collection);
                let stages = value_to_pipeline(pipeline)?;
                let cursor = coll.aggregate(stages).await.map_err(mongo_err)?;
                let docs: Vec<Document> = cursor.try_collect().await.map_err(mongo_err)?;
                Ok(EngineResult::Documents {
                    docs: docs.into_iter().map(doc_to_value).collect(),
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
            MongoOp::InsertOne {
                collection,
                database,
                document,
            } => {
                let db = pick_db(&database);
                let coll = db.collection::<Document>(&collection);
                coll.insert_one(value_to_doc(document)?)
                    .await
                    .map_err(mongo_err)?;
                Ok(EngineResult::Affected {
                    rows: 1,
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
            MongoOp::InsertMany {
                collection,
                database,
                documents,
            } => {
                let db = pick_db(&database);
                let coll = db.collection::<Document>(&collection);
                let docs: Vec<Document> = documents
                    .into_iter()
                    .map(value_to_doc)
                    .collect::<AppResult<_>>()?;
                let n = docs.len() as u64;
                coll.insert_many(docs).await.map_err(mongo_err)?;
                Ok(EngineResult::Affected {
                    rows: n,
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
            MongoOp::UpdateMany {
                collection,
                database,
                filter,
                update,
            } => {
                let db = pick_db(&database);
                let coll = db.collection::<Document>(&collection);
                let res = coll
                    .update_many(value_to_doc(filter)?, value_to_doc(update)?)
                    .await
                    .map_err(mongo_err)?;
                Ok(EngineResult::Affected {
                    rows: res.modified_count,
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
            MongoOp::DeleteMany {
                collection,
                database,
                filter,
            } => {
                let db = pick_db(&database);
                let coll = db.collection::<Document>(&collection);
                let res = coll
                    .delete_many(value_to_doc(filter)?)
                    .await
                    .map_err(mongo_err)?;
                Ok(EngineResult::Affected {
                    rows: res.deleted_count,
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
            MongoOp::RunCommand { value } => {
                let db = pick_db(&None);
                let result = db
                    .run_command(value_to_doc(value)?)
                    .await
                    .map_err(mongo_err)?;
                Ok(EngineResult::Documents {
                    docs: vec![doc_to_value(result)],
                    elapsed_ms: start.elapsed().as_millis(),
                })
            }
        }
    }

    async fn close(&self) {
        // The mongodb Client owns its connection pool internally and tears it
        // down on Drop. No explicit shutdown call is required (and the Client
        // doesn't expose one in the current driver).
    }

    fn as_mongo(&self) -> Option<&MongoEngine> {
        Some(self)
    }
}

fn mongo_err(e: mongodb::error::Error) -> AppError {
    AppError::Other(format!("mongo error: {e}"))
}

fn value_to_doc(v: Value) -> AppResult<Document> {
    if v.is_null() {
        return Ok(Document::new());
    }
    match value_to_bson(v)? {
        Bson::Document(d) => Ok(d),
        other => Err(AppError::Other(format!(
            "expected a JSON object, got {:?}",
            other.element_type()
        ))),
    }
}

/// JSON → BSON with extJSON-shorthand recognition. The standard
/// `mongodb::bson::to_bson` serializer doesn't introspect `{"$oid": "..."}` /
/// `{"$date": "..."}` wrappers, so a frontend that sends `{ _id: { "$oid":
/// "<hex>" } }` would otherwise round-trip through BSON as a sub-document
/// with a literal `$oid` key — which Mongo treats as garbage and which never
/// matches an actual `ObjectId` PK. We pre-walk the value to lift those
/// well-known wrappers into their typed BSON forms before falling back to
/// serde for the long tail.
fn value_to_bson(v: Value) -> AppResult<Bson> {
    match v {
        Value::Object(map) => {
            // Single-key { "$oid": "..." } → ObjectId
            if map.len() == 1 {
                if let Some(Value::String(s)) = map.get("$oid") {
                    return ObjectId::parse_str(s)
                        .map(Bson::ObjectId)
                        .map_err(|e| AppError::Other(format!("invalid $oid: {e}")));
                }
                if let Some(Value::String(s)) = map.get("$date") {
                    return BsonDateTime::parse_rfc3339_str(s)
                        .map(Bson::DateTime)
                        .map_err(|e| AppError::Other(format!("invalid $date: {e}")));
                }
            }
            let mut doc = Document::new();
            for (k, val) in map {
                doc.insert(k, value_to_bson(val)?);
            }
            Ok(Bson::Document(doc))
        }
        Value::Array(arr) => arr
            .into_iter()
            .map(value_to_bson)
            .collect::<AppResult<Vec<_>>>()
            .map(Bson::Array),
        other => {
            mongodb::bson::to_bson(&other).map_err(|e| AppError::Other(format!("bson encode: {e}")))
        }
    }
}

fn value_to_pipeline(v: Value) -> AppResult<Vec<Document>> {
    let Value::Array(stages) = v else {
        return Err(AppError::Other(
            "aggregation pipeline must be a JSON array of stage objects".into(),
        ));
    };
    stages.into_iter().map(value_to_doc).collect()
}

fn doc_to_value(d: Document) -> Value {
    // Hand-rolled conversion so the frontend sees clean values instead of
    // the extJSON wrappers serde produces by default (`{"$oid": "..."}`,
    // `{"$date": ...}`, etc.). ObjectIds become hex strings, dates become
    // RFC3339, decimals become their string form — all directly renderable
    // in the existing tabular grid.
    let mut obj = serde_json::Map::with_capacity(d.len());
    for (k, v) in d {
        obj.insert(k, bson_to_json(v));
    }
    Value::Object(obj)
}

fn bson_to_json(b: Bson) -> Value {
    use serde_json::Number;
    match b {
        Bson::Double(n) => Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(s) => Value::String(s),
        Bson::Array(arr) => Value::Array(arr.into_iter().map(bson_to_json).collect()),
        Bson::Document(d) => doc_to_value(d),
        Bson::Boolean(b) => Value::Bool(b),
        Bson::Null => Value::Null,
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::Int32(n) => Value::Number(n.into()),
        Bson::Int64(n) => Value::Number(n.into()),
        Bson::DateTime(dt) => Value::String(
            dt.try_to_rfc3339_string()
                .unwrap_or_else(|_| format!("{dt}")),
        ),
        Bson::Binary(bin) => Value::String(format!("<{} bytes>", bin.bytes.len())),
        Bson::Decimal128(d) => Value::String(d.to_string()),
        Bson::RegularExpression(r) => Value::String(format!("/{}/{}", r.pattern, r.options)),
        Bson::Symbol(s) => Value::String(s),
        Bson::Timestamp(ts) => Value::String(format!("Timestamp({}, {})", ts.time, ts.increment)),
        // These are obscure / deprecated BSON types. Render as null rather
        // than try to invent a string form.
        Bson::Undefined
        | Bson::MaxKey
        | Bson::MinKey
        | Bson::DbPointer(_)
        | Bson::JavaScriptCode(_)
        | Bson::JavaScriptCodeWithScope(_) => Value::Null,
    }
}
