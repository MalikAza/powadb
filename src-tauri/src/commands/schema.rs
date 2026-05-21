use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::engine::SqlPoolView;
use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Serialize)]
pub struct TableMeta {
    pub name: String,
    pub kind: String,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Serialize)]
pub struct SchemaMeta {
    pub name: String,
    pub tables: Vec<TableMeta>,
}

#[tauri::command]
pub async fn introspect_schema(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<SchemaMeta>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;

    // MongoDB: shoehorn databases → collections into the SchemaMeta shape so
    // the existing schema sidebar can render them with no UI changes.
    // Collections appear as "tables" with no columns (Mongo has no fixed
    // schema; a future pass could sample documents to infer field shapes).
    if let Some(mongo) = handle.as_mongo() {
        return introspect_mongo(mongo).await;
    }

    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            let rows = sqlx::query(
                r#"
                SELECT
                    c.table_schema::text   AS schema_name,
                    c.table_name::text     AS table_name,
                    c.column_name::text    AS column_name,
                    -- `data_type` returns 'USER-DEFINED' for extension types like
                    -- PostGIS `geometry`/`geography`. Fall back to `udt_name` so
                    -- those columns surface their real type names in the UI.
                    CASE
                        WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
                        ELSE c.data_type
                    END::text              AS data_type,
                    (c.is_nullable = 'YES') AS nullable,
                    t.table_type::text     AS table_type
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY c.table_schema, c.table_name, c.ordinal_position
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(group_rows(rows.into_iter().map(|r| RowOut {
                schema: r.try_get::<String, _>("schema_name").unwrap_or_default(),
                table: r.try_get::<String, _>("table_name").unwrap_or_default(),
                column: r.try_get::<String, _>("column_name").unwrap_or_default(),
                data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                nullable: r.try_get::<bool, _>("nullable").unwrap_or(true),
                table_type: r.try_get::<String, _>("table_type").unwrap_or_default(),
            })))
        }
        Some(SqlPoolView::Mysql(pool)) => {
            // MySQL/MariaDB report information_schema string columns with a
            // binary flag in many setups; without an explicit CAST sqlx decodes
            // them as `Vec<u8>` and `try_get::<String>` silently fails, leaving
            // every row with empty schema/table names. CAST AS CHAR forces a
            // real text column so the decoder picks `String`.
            let rows = sqlx::query(
                r#"
                SELECT
                    CAST(c.table_schema AS CHAR) AS schema_name,
                    CAST(c.table_name   AS CHAR) AS table_name,
                    CAST(c.column_name  AS CHAR) AS column_name,
                    CAST(c.data_type    AS CHAR) AS data_type,
                    (c.is_nullable = 'YES')      AS nullable,
                    CAST(t.table_type   AS CHAR) AS table_type
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                WHERE c.table_schema = DATABASE()
                ORDER BY c.table_schema, c.table_name, c.ordinal_position
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(group_rows(rows.into_iter().map(|r| {
                RowOut {
                    schema: r.try_get::<String, _>("schema_name").unwrap_or_default(),
                    table: r.try_get::<String, _>("table_name").unwrap_or_default(),
                    column: r.try_get::<String, _>("column_name").unwrap_or_default(),
                    data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                    nullable: r
                        .try_get::<i64, _>("nullable")
                        .map(|x| x != 0)
                        .unwrap_or(true),
                    table_type: r.try_get::<String, _>("table_type").unwrap_or_default(),
                }
            })))
        }
        Some(SqlPoolView::Sqlite(pool)) => {
            // sqlite_master lists tables/views; PRAGMA table_info gives columns.
            let tables = sqlx::query(
                r#"
                SELECT name, type FROM sqlite_master
                WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                ORDER BY type, name
                "#,
            )
            .fetch_all(pool)
            .await?;

            let mut rows_out: Vec<RowOut> = Vec::new();
            for tr in tables {
                let name: String = tr.try_get("name").unwrap_or_default();
                let ttype: String = tr.try_get("type").unwrap_or_default();
                let pragma = format!("PRAGMA table_info(\"{}\")", name.replace('"', "\"\""));
                let cols = sqlx::query(&pragma).fetch_all(pool).await?;
                for c in cols {
                    let column: String = c.try_get("name").unwrap_or_default();
                    let data_type: String = c.try_get("type").unwrap_or_default();
                    let notnull: i64 = c.try_get("notnull").unwrap_or(0);
                    rows_out.push(RowOut {
                        schema: "main".into(),
                        table: name.clone(),
                        column,
                        data_type,
                        nullable: notnull == 0,
                        table_type: if ttype == "view" {
                            "VIEW".into()
                        } else {
                            "BASE TABLE".into()
                        },
                    });
                }
            }
            Ok(group_rows(rows_out.into_iter()))
        }
        None => Err(AppError::Other(
            "introspect_schema requires a SQL engine".into(),
        )),
    }
}

struct RowOut {
    schema: String,
    table: String,
    column: String,
    data_type: String,
    nullable: bool,
    table_type: String,
}

/// Sample documents from each collection to infer field names + BSON types.
/// MongoDB has no fixed schema, so this is a best-effort snapshot: we look at
/// `SAMPLE_SIZE` documents and report every top-level field we saw, with the
/// set of BSON types observed for each. A field is marked `nullable` if at
/// least one sampled document didn't contain it (or contained an explicit
/// null).
const MONGO_SAMPLE_SIZE: i64 = 25;

async fn introspect_mongo(mongo: &crate::engine::MongoEngine) -> AppResult<Vec<SchemaMeta>> {
    use futures_util::TryStreamExt;
    use mongodb::bson::{doc, Document};
    use std::collections::BTreeMap;

    let mut schemas: Vec<SchemaMeta> = Vec::new();
    let dbs = mongo
        .client
        .list_database_names()
        .await
        .map_err(|e| AppError::Other(format!("mongo list databases: {e}")))?;
    for db_name in dbs {
        // Skip internal admin DBs so the sidebar isn't cluttered.
        if matches!(db_name.as_str(), "admin" | "config" | "local") {
            continue;
        }
        let db = mongo.client.database(&db_name);
        let coll_cursor = db
            .list_collections()
            .await
            .map_err(|e| AppError::Other(format!("mongo list collections: {e}")))?;
        let coll_specs: Vec<mongodb::results::CollectionSpecification> = coll_cursor
            .try_collect()
            .await
            .map_err(|e| AppError::Other(format!("mongo list collections: {e}")))?;

        let mut tables: Vec<TableMeta> = Vec::with_capacity(coll_specs.len());
        for spec in coll_specs {
            let kind = match spec.collection_type {
                mongodb::results::CollectionType::View => "view".into(),
                _ => "table".into(),
            };
            // BTreeMap so columns come out alphabetically — predictable for the
            // sidebar. Insert order on Mongo's side is undefined anyway.
            let mut fields: BTreeMap<String, FieldStats> = BTreeMap::new();
            let mut sampled = 0u64;
            let coll = db.collection::<Document>(&spec.name);
            // $sample is cheap on collections of any size and avoids scanning
            // the whole thing just to peek at the shape.
            if let Ok(cursor) = coll
                .aggregate(vec![doc! { "$sample": { "size": MONGO_SAMPLE_SIZE } }])
                .await
            {
                let docs: Vec<Document> = cursor.try_collect().await.unwrap_or_default();
                sampled = docs.len() as u64;
                for d in &docs {
                    for (k, v) in d {
                        let stats = fields.entry(k.clone()).or_default();
                        stats.present += 1;
                        let type_name = bson_type_name(v);
                        if !stats.types.iter().any(|t| t == type_name) {
                            stats.types.push(type_name.to_string());
                        }
                    }
                }
            }
            let columns: Vec<ColumnMeta> = fields
                .into_iter()
                .map(|(name, stats)| {
                    let data_type = if stats.types.is_empty() {
                        "unknown".into()
                    } else {
                        stats.types.join(" | ")
                    };
                    ColumnMeta {
                        name,
                        data_type,
                        // Field is nullable if any sampled doc was missing it.
                        nullable: sampled > 0 && stats.present < sampled,
                    }
                })
                .collect();
            tables.push(TableMeta {
                name: spec.name,
                kind,
                columns,
            });
        }
        schemas.push(SchemaMeta {
            name: db_name,
            tables,
        });
    }
    Ok(schemas)
}

#[derive(Default)]
struct FieldStats {
    present: u64,
    types: Vec<String>,
}

fn bson_type_name(b: &mongodb::bson::Bson) -> &'static str {
    use mongodb::bson::Bson;
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascript_scoped",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "ObjectId",
        Bson::DateTime(_) => "Date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal128",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "MaxKey",
        Bson::MinKey => "MinKey",
        Bson::DbPointer(_) => "DbPointer",
    }
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            let rows = sqlx::query(
                r#"
                SELECT datname::text AS name
                FROM pg_database
                WHERE datistemplate = false AND datallowconn = true
                ORDER BY datname
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| r.try_get::<String, _>("name").unwrap_or_default())
                .collect())
        }
        Some(SqlPoolView::Mysql(pool)) => {
            // See note in `introspect_schema`: information_schema string
            // columns can come back binary-flagged, so we CAST to CHAR.
            let rows = sqlx::query(
                r#"
                SELECT CAST(schema_name AS CHAR) AS name
                FROM information_schema.schemata
                WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
                ORDER BY schema_name
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| r.try_get::<String, _>("name").unwrap_or_default())
                .collect())
        }
        Some(SqlPoolView::Sqlite(_)) => Ok(Vec::new()),
        None => Ok(Vec::new()),
    }
}

fn group_rows<I: Iterator<Item = RowOut>>(rows: I) -> Vec<SchemaMeta> {
    let mut schemas: Vec<SchemaMeta> = Vec::new();
    for r in rows {
        let schema = match schemas.iter_mut().find(|s| s.name == r.schema) {
            Some(s) => s,
            None => {
                schemas.push(SchemaMeta {
                    name: r.schema.clone(),
                    tables: Vec::new(),
                });
                schemas.last_mut().unwrap()
            }
        };
        let table = match schema.tables.iter_mut().find(|t| t.name == r.table) {
            Some(t) => t,
            None => {
                let kind = if r.table_type.eq_ignore_ascii_case("VIEW") {
                    "view"
                } else {
                    "table"
                };
                schema.tables.push(TableMeta {
                    name: r.table.clone(),
                    kind: kind.to_string(),
                    columns: Vec::new(),
                });
                schema.tables.last_mut().unwrap()
            }
        };
        table.columns.push(ColumnMeta {
            name: r.column,
            data_type: r.data_type,
            nullable: r.nullable,
        });
    }
    schemas
}
