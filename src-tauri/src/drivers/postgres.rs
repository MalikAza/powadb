use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde_json::{json, Value};
use sqlx::postgres::types::Oid;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};

use super::{Column as ColMeta, QueryResult};
use crate::error::{AppError, AppResult};

pub async fn connect(url: &str) -> AppResult<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(5)
        // See the matching note in drivers/mysql.rs.
        .test_before_acquire(true)
        .idle_timeout(Some(std::time::Duration::from_secs(60)))
        .max_lifetime(Some(std::time::Duration::from_secs(30 * 60)))
        .connect(url)
        .await?;
    Ok(pool)
}

struct RawCol {
    name: String,
    type_name: String,
    relation_id: Option<u32>,
    relation_attribute_no: Option<i16>,
}

pub async fn execute(pool: &PgPool, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let rows: Vec<PgRow> = sqlx::query(sql).fetch_all(pool).await?;

    let raw_cols: Vec<RawCol> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| RawCol {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
                relation_id: c.relation_id().map(|o| o.0),
                relation_attribute_no: c.relation_attribute_no(),
            })
            .collect()
    } else {
        // No rows: ask the driver to describe the statement so the UI still has
        // column metadata (needed e.g. for the "Insert row" form on empty tables).
        match pool.describe(sql).await {
            Ok(d) => d
                .columns
                .iter()
                .map(|c| RawCol {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                    relation_id: c.relation_id().map(|o| o.0),
                    relation_attribute_no: c.relation_attribute_no(),
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    };

    let columns = resolve_pg_origins(pool, raw_cols).await;

    let mut json_rows: Vec<Vec<Value>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut out = Vec::with_capacity(row.columns().len());
        for (i, col) in row.columns().iter().enumerate() {
            out.push(decode_pg(row, i, col.type_info().name())?);
        }
        json_rows.push(out);
    }

    Ok(QueryResult {
        columns,
        rows: json_rows,
        elapsed_ms: start.elapsed().as_millis(),
    })
}

fn decode_pg(row: &PgRow, idx: usize, type_name: &str) -> AppResult<Value> {
    macro_rules! try_decode {
        ($ty:ty) => {{
            let v: Result<Option<$ty>, _> = row.try_get(idx);
            match v {
                Ok(Some(x)) => return Ok(json!(x)),
                Ok(None) => return Ok(Value::Null),
                Err(_) => {}
            }
        }};
    }

    match type_name {
        "BOOL" => try_decode!(bool),
        "INT2" => try_decode!(i16),
        "INT4" => try_decode!(i32),
        "INT8" => try_decode!(i64),
        "FLOAT4" => try_decode!(f32),
        "FLOAT8" => try_decode!(f64),
        "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "CITEXT" => try_decode!(String),
        "BYTEA" => {
            let v: Result<Option<Vec<u8>>, _> = row.try_get(idx);
            if let Ok(Some(b)) = v {
                let mut s = String::with_capacity(2 + b.len() * 2);
                s.push_str("\\x");
                for byte in &b {
                    s.push_str(&format!("{:02X}", byte));
                }
                return Ok(json!(s));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "JSON" | "JSONB" => {
            let v: Result<Option<Value>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(x);
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "UUID" => {
            let v: Result<Option<sqlx::types::Uuid>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(x.to_string()));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "TIMESTAMP" => {
            let v: Result<Option<sqlx::types::chrono::NaiveDateTime>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(x.to_string()));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "TIMESTAMPTZ" => {
            let v: Result<Option<sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>>, _> =
                row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(x.to_rfc3339()));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "DATE" => {
            let v: Result<Option<sqlx::types::chrono::NaiveDate>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(x.to_string()));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "TIME" => {
            let v: Result<Option<sqlx::types::chrono::NaiveTime>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(x.to_string()));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "NUMERIC" => {
            let v: Result<Option<sqlx::types::BigDecimal>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(x.to_string()));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        // PostGIS columns: serialize EWKB as upper-case hex string (`\x...`),
        // mirroring how BYTEA is represented. `try_get::<Vec<u8>>` would fail
        // sqlx's type-compatibility check (geometry/geography are not BYTEA),
        // so we read the raw value and grab its bytes directly. The frontend
        // round-trips this through `ST_AsGeoJSON` on demand via
        // `geometry_to_geojson`.
        "geometry" | "geography" => {
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode {}: {}", type_name, e)))?;
            let mut s = String::with_capacity(2 + bytes.len() * 2);
            s.push_str("\\x");
            for byte in bytes {
                s.push_str(&format!("{:02X}", byte));
            }
            return Ok(json!(s));
        }
        _ => {}
    }

    let s: Result<Option<String>, _> = row.try_get(idx);
    match s {
        Ok(Some(x)) => Ok(Value::String(x)),
        Ok(None) => Ok(Value::Null),
        Err(_) => Err(AppError::UnsupportedType(type_name.to_string())),
    }
}

/// Resolve each result column's `relation_id` + `relation_attribute_no` (set
/// by sqlx from the PG row description) to a concrete `(schema, table,
/// column)` triple via a single `pg_catalog` lookup. Columns produced by
/// expressions, joins of subqueries, etc. have `relation_id = None` and are
/// returned with empty source fields. Failures are non-fatal — we just drop
/// to `None` so the rest of the result still renders.
async fn resolve_pg_origins(pool: &PgPool, raw_cols: Vec<RawCol>) -> Vec<ColMeta> {
    let mut distinct: HashSet<u32> = HashSet::new();
    for c in &raw_cols {
        if let Some(oid) = c.relation_id {
            distinct.insert(oid);
        }
    }

    let mut origin: HashMap<(u32, i16), (String, String, String)> = HashMap::new();
    if !distinct.is_empty() {
        let oids: Vec<Oid> = distinct.iter().copied().map(Oid).collect();
        let q = "SELECT a.attrelid AS relid, a.attnum AS attnum, \
                        n.nspname AS schema, c.relname AS table_name, a.attname AS column_name \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE a.attrelid = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped";
        if let Ok(rows) = sqlx::query(q).bind(&oids).fetch_all(pool).await {
            for r in rows {
                let relid: Oid = match r.try_get("relid") {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let attnum: i16 = match r.try_get("attnum") {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let schema: String = match r.try_get("schema") {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let table_name: String = match r.try_get("table_name") {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let column_name: String = match r.try_get("column_name") {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                origin.insert((relid.0, attnum), (schema, table_name, column_name));
            }
        }
    }

    raw_cols
        .into_iter()
        .map(|c| {
            let (source_schema, source_table, source_column) =
                match (c.relation_id, c.relation_attribute_no) {
                    (Some(oid), Some(an)) => origin
                        .get(&(oid, an))
                        .cloned()
                        .map(|(s, t, col)| (Some(s), Some(t), Some(col)))
                        .unwrap_or((None, None, None)),
                    _ => (None, None, None),
                };
            ColMeta {
                name: c.name,
                type_name: c.type_name,
                source_schema,
                source_table,
                source_column,
            }
        })
        .collect()
}
