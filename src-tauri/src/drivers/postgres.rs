use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde_json::{json, Value};
use sqlx::postgres::types::Oid;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};

use super::{sql_excerpt, Column as ColMeta, QueryResult, ScriptResult, StatementResult};
use crate::error::{AppError, AppResult};
use crate::sql_split::split_statements;

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

/// Execute a multi-statement SQL script on a single pooled connection.
///
/// Each statement is run in order. Row-returning and non-row-returning
/// statements are handled uniformly via `fetch_many`, which yields the row
/// stream interleaved with the driver's per-statement `QueryResult` (carrying
/// `rows_affected`). When a statement errors we stop and return everything
/// accumulated so far with the error on the failing statement.
pub async fn execute_script(pool: &PgPool, sql: &str) -> AppResult<ScriptResult> {
    let stmts = split_statements(sql);
    let mut conn = pool.acquire().await?;
    let mut statements: Vec<StatementResult> = Vec::with_capacity(stmts.len());

    for (idx, stmt) in stmts.iter().enumerate() {
        let excerpt = sql_excerpt(stmt);
        let started = Instant::now();
        let outcome = run_one_pg(&mut conn, pool, stmt).await;
        let elapsed_ms = started.elapsed().as_millis();
        match outcome {
            Ok((result, rows_affected)) => {
                statements.push(StatementResult {
                    index: idx,
                    sql_excerpt: excerpt,
                    elapsed_ms,
                    rows_affected,
                    result,
                    error: None,
                });
            }
            Err(e) => {
                statements.push(StatementResult {
                    index: idx,
                    sql_excerpt: excerpt,
                    elapsed_ms,
                    rows_affected: None,
                    result: None,
                    error: Some(e.to_string()),
                });
                break;
            }
        }
    }

    Ok(ScriptResult { statements })
}

async fn run_one_pg(
    conn: &mut sqlx::PgConnection,
    pool: &PgPool,
    stmt: &str,
) -> AppResult<(Option<QueryResult>, Option<u64>)> {
    let started = Instant::now();
    // Ask the driver to describe the statement first so we can pick the right
    // execution path. `describe` errors are non-fatal — we just assume the
    // statement returns rows and let `fetch_all` decide.
    let returns_rows = match conn.describe(stmt).await {
        Ok(d) => !d.columns.is_empty(),
        Err(_) => true,
    };

    if !returns_rows {
        let r = sqlx::query(stmt).execute(&mut *conn).await?;
        return Ok((None, Some(r.rows_affected())));
    }

    let rows: Vec<PgRow> = sqlx::query(stmt).fetch_all(&mut *conn).await?;
    let first = match rows.first() {
        Some(r) => r,
        // Describe said the statement returns rows but the result was empty.
        // We still want column metadata for the UI grid. Re-describe and use
        // its columns; ignore errors and fall back to an empty column list.
        None => {
            let raw_cols: Vec<RawCol> = match conn.describe(stmt).await {
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
            };
            let columns = resolve_pg_origins(pool, raw_cols).await;
            return Ok((
                Some(QueryResult {
                    columns,
                    rows: Vec::new(),
                    elapsed_ms: started.elapsed().as_millis(),
                }),
                None,
            ));
        }
    };

    let raw_cols: Vec<RawCol> = first
        .columns()
        .iter()
        .map(|c| RawCol {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
            relation_id: c.relation_id().map(|o| o.0),
            relation_attribute_no: c.relation_attribute_no(),
        })
        .collect();
    let columns = resolve_pg_origins(pool, raw_cols).await;
    let mut json_rows: Vec<Vec<Value>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut out = Vec::with_capacity(row.columns().len());
        for (i, col) in row.columns().iter().enumerate() {
            out.push(decode_pg(row, i, col.type_info().name())?);
        }
        json_rows.push(out);
    }
    Ok((
        Some(QueryResult {
            columns,
            rows: json_rows,
            elapsed_ms: started.elapsed().as_millis(),
        }),
        None,
    ))
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
        "INTERVAL" => {
            let v: Result<Option<sqlx::postgres::types::PgInterval>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(format_pg_interval(&x)));
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

// Format a PgInterval the way psql's default `IntervalStyle = postgres` does.
// Year/month/day parts are pluralised on `n != 1`; the time component carries
// its own sign so a negative-microseconds interval renders as `-HH:MM:SS`.
fn format_pg_interval(iv: &sqlx::postgres::types::PgInterval) -> String {
    let years = iv.months / 12;
    let mons = iv.months % 12;
    let days = iv.days;
    let micros = iv.microseconds;

    let mut parts: Vec<String> = Vec::new();
    if years != 0 {
        parts.push(format!(
            "{} {}",
            years,
            if years == 1 { "year" } else { "years" }
        ));
    }
    if mons != 0 {
        parts.push(format!(
            "{} {}",
            mons,
            if mons == 1 { "mon" } else { "mons" }
        ));
    }
    if days != 0 {
        parts.push(format!(
            "{} {}",
            days,
            if days == 1 { "day" } else { "days" }
        ));
    }

    if micros != 0 || parts.is_empty() {
        let negative = micros < 0;
        let abs_micros = micros.unsigned_abs();
        let total_secs = abs_micros / 1_000_000;
        let frac = abs_micros % 1_000_000;
        let hours = total_secs / 3600;
        let minutes = (total_secs % 3600) / 60;
        let seconds = total_secs % 60;
        let sign = if negative { "-" } else { "" };
        let time_str = if frac == 0 {
            format!("{}{:02}:{:02}:{:02}", sign, hours, minutes, seconds)
        } else {
            let mut frac_str = format!("{:06}", frac);
            while frac_str.ends_with('0') {
                frac_str.pop();
            }
            format!(
                "{}{:02}:{:02}:{:02}.{}",
                sign, hours, minutes, seconds, frac_str
            )
        };
        parts.push(time_str);
    }

    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::types::PgInterval;

    fn iv(months: i32, days: i32, microseconds: i64) -> PgInterval {
        PgInterval {
            months,
            days,
            microseconds,
        }
    }

    #[test]
    fn zero_interval() {
        assert_eq!(format_pg_interval(&iv(0, 0, 0)), "00:00:00");
    }

    #[test]
    fn full_interval_with_fraction() {
        // 1 year 2 months 3 days 4h 5m 6.789s
        let micros = (4 * 3600 + 5 * 60 + 6) * 1_000_000 + 789_000;
        assert_eq!(
            format_pg_interval(&iv(14, 3, micros)),
            "1 year 2 mons 3 days 04:05:06.789"
        );
    }

    #[test]
    fn negative_time_and_days() {
        let micros = -2i64 * 3600 * 1_000_000;
        assert_eq!(format_pg_interval(&iv(0, -1, micros)), "-1 days -02:00:00");
    }

    #[test]
    fn minutes_only() {
        let micros = 90i64 * 60 * 1_000_000;
        assert_eq!(format_pg_interval(&iv(0, 0, micros)), "01:30:00");
    }

    #[test]
    fn singular_units() {
        assert_eq!(format_pg_interval(&iv(13, 1, 0)), "1 year 1 mon 1 day");
    }
}
