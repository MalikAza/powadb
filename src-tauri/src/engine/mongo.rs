//! MongoDB engine.
//!
//! Implements `Engine` over the `mongodb` driver. SQL methods on the trait
//! (`execute`, `execute_script`, `as_sql_pool`) return errors / `None` — Mongo
//! work goes through `execute_query` with `EngineQuery::Mongo(MongoOp)`.

use std::time::Instant;

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, FindOptions};
use mongodb::Client;
use serde_json::Value;

use super::{Capabilities, Engine, EngineQuery, EngineResult, MongoOp, QueryLanguage};
use crate::drivers::{QueryResult, ScriptResult};
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;

pub struct MongoEngine {
    client: Client,
    /// Default database (from the URI path or the `database` field of the
    /// saved connection). Used when a `MongoOp` references a collection
    /// without naming a database explicitly.
    database: String,
}

impl MongoEngine {
    pub async fn connect(uri: &str, database: &str) -> AppResult<Self> {
        let opts = ClientOptions::parse(uri)
            .await
            .map_err(|e| AppError::Other(format!("invalid mongo uri: {e}")))?;
        let client = Client::with_options(opts)
            .map_err(|e| AppError::Other(format!("mongo client init failed: {e}")))?;
        // Cheap connectivity probe so a bad URI surfaces immediately instead
        // of on first query.
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| AppError::Other(format!("mongo ping failed: {e}")))?;
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
        let db = self.client.database(&self.database);
        let start = Instant::now();
        match op {
            MongoOp::Find {
                collection,
                filter,
                projection,
                limit,
                skip,
                sort,
            } => {
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
                pipeline,
            } => {
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
                document,
            } => {
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
                documents,
            } => {
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
                filter,
                update,
            } => {
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
            MongoOp::DeleteMany { collection, filter } => {
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
            MongoOp::RunCommand(cmd) => {
                let result = db
                    .run_command(value_to_doc(cmd)?)
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
}

fn mongo_err(e: mongodb::error::Error) -> AppError {
    AppError::Other(format!("mongo error: {e}"))
}

fn value_to_doc(v: Value) -> AppResult<Document> {
    if v.is_null() {
        return Ok(Document::new());
    }
    let bson =
        mongodb::bson::to_bson(&v).map_err(|e| AppError::Other(format!("bson encode: {e}")))?;
    match bson {
        Bson::Document(d) => Ok(d),
        other => Err(AppError::Other(format!(
            "expected a JSON object, got {:?}",
            other.element_type()
        ))),
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
    // Cheap path: round-trip through bson::Bson → serde_json::Value. The bson
    // crate's Serialize impl produces serde_json-compatible output for plain
    // scalars/maps; richer BSON types (ObjectId, Date, Binary) come out as
    // their extJSON representation, which the UI can render as strings.
    serde_json::to_value(Bson::Document(d)).unwrap_or(Value::Null)
}
