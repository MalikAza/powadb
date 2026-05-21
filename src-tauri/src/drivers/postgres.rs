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
    macro_rules! decode_to {
        ($ty:ty, $f:expr) => {{
            let v: Result<Option<$ty>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(($f)(x)));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }};
    }

    match type_name {
        // ─── Numeric ─────────────────────────────────────────────────────
        "BOOL" => try_decode!(bool),
        "INT2" => try_decode!(i16),
        "INT4" => try_decode!(i32),
        "INT8" => try_decode!(i64),
        "FLOAT4" => try_decode!(f32),
        "FLOAT8" => try_decode!(f64),
        "OID" => decode_to!(
            sqlx::postgres::types::Oid,
            |x: sqlx::postgres::types::Oid| x.0
        ),
        "MONEY" => decode_to!(
            sqlx::postgres::types::PgMoney,
            |m: sqlx::postgres::types::PgMoney| { m.to_bigdecimal(2).to_string() }
        ),
        "NUMERIC" => decode_to!(sqlx::types::BigDecimal, |x: sqlx::types::BigDecimal| x
            .to_string()),

        // ─── Text ────────────────────────────────────────────────────────
        "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "CITEXT" | "XML" => try_decode!(String),

        // ─── Binary ──────────────────────────────────────────────────────
        "BYTEA" => decode_to!(Vec<u8>, |b: Vec<u8>| bytes_to_hex(&b)),

        // ─── JSON ────────────────────────────────────────────────────────
        "JSON" | "JSONB" => {
            let v: Result<Option<Value>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(x);
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }

        // ─── UUID ────────────────────────────────────────────────────────
        "UUID" => decode_to!(sqlx::types::Uuid, |x: sqlx::types::Uuid| x.to_string()),

        // ─── Date / time ─────────────────────────────────────────────────
        "TIMESTAMP" => decode_to!(
            sqlx::types::chrono::NaiveDateTime,
            |x: sqlx::types::chrono::NaiveDateTime| { x.to_string() }
        ),
        "TIMESTAMPTZ" => decode_to!(
            sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>,
            |x: sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>| x.to_rfc3339()
        ),
        "DATE" => decode_to!(
            sqlx::types::chrono::NaiveDate,
            |x: sqlx::types::chrono::NaiveDate| { x.to_string() }
        ),
        "TIME" => decode_to!(
            sqlx::types::chrono::NaiveTime,
            |x: sqlx::types::chrono::NaiveTime| { x.to_string() }
        ),
        "TIMETZ" => {
            type TimeTz = sqlx::postgres::types::PgTimeTz<
                sqlx::types::chrono::NaiveTime,
                sqlx::types::chrono::FixedOffset,
            >;
            let v: Result<Option<TimeTz>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                return Ok(json!(format_pg_timetz(&x)));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        "INTERVAL" => decode_to!(
            sqlx::postgres::types::PgInterval,
            |x: sqlx::postgres::types::PgInterval| { format_pg_interval(&x) }
        ),

        // ─── Network ─────────────────────────────────────────────────────
        "INET" | "CIDR" => {
            decode_to!(
                sqlx::types::ipnetwork::IpNetwork,
                |x: sqlx::types::ipnetwork::IpNetwork| x.to_string()
            )
        }
        "MACADDR" => {
            decode_to!(
                sqlx::types::mac_address::MacAddress,
                |x: sqlx::types::mac_address::MacAddress| x.to_string()
            )
        }
        "MACADDR8" => {
            // No sqlx native type — always 8 raw bytes on the wire.
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode MACADDR8: {}", e)))?;
            if bytes.len() == 8 {
                return Ok(json!(format_macaddr8(bytes)));
            }
        }

        // ─── Bit string ──────────────────────────────────────────────────
        "BIT" | "VARBIT" => decode_to!(sqlx::types::BitVec, |b: sqlx::types::BitVec| {
            bitvec_to_string(&b)
        }),

        // ─── Geometric (built-in, not PostGIS) ───────────────────────────
        "POINT" => return decode_geometric(row, idx, "POINT", parse_point),
        "LINE" => return decode_geometric(row, idx, "LINE", parse_line),
        "LSEG" => return decode_geometric(row, idx, "LSEG", parse_lseg),
        "BOX" => return decode_geometric(row, idx, "BOX", parse_box),
        "CIRCLE" => return decode_geometric(row, idx, "CIRCLE", parse_circle),
        "PATH" => return decode_geometric(row, idx, "PATH", parse_path),
        "POLYGON" => return decode_geometric(row, idx, "POLYGON", parse_polygon),

        // ─── Full-text search ────────────────────────────────────────────
        "TSVECTOR" => {
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode TSVECTOR: {}", e)))?;
            if let Some(s) = parse_tsvector(bytes) {
                return Ok(json!(s));
            }
        }
        // TSQUERY binary format is recursive/postfix; fall through to the
        // UTF-8/hex fallback rather than ship a half-baked parser.

        // ─── PostGIS ─────────────────────────────────────────────────────
        //
        // Serialize EWKB as upper-case hex (`\x...`), mirroring BYTEA.
        // `try_get::<Vec<u8>>` would fail sqlx's type-compatibility check
        // (geometry/geography are not BYTEA), so we read raw bytes directly.
        // The frontend round-trips this through `ST_AsGeoJSON` on demand
        // via `geometry_to_geojson`.
        "geometry" | "geography" => {
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode {}: {}", type_name, e)))?;
            return Ok(json!(bytes_to_hex(bytes)));
        }

        // ─── pgvector ────────────────────────────────────────────────────
        "vector" | "VECTOR" => {
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode VECTOR: {}", e)))?;
            if let Some(v) = parse_vector(bytes) {
                return Ok(json!(v));
            }
        }

        // ─── hstore ──────────────────────────────────────────────────────
        "hstore" | "HSTORE" => {
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode hstore: {}", e)))?;
            if let Some(v) = parse_hstore(bytes) {
                return Ok(v);
            }
        }

        // ─── ltree family ────────────────────────────────────────────────
        "ltree" | "LTREE" | "lquery" | "LQUERY" | "ltxtquery" | "LTXTQUERY" => {
            let raw = row.try_get_raw(idx)?;
            if raw.is_null() {
                return Ok(Value::Null);
            }
            let bytes = raw
                .as_bytes()
                .map_err(|e| AppError::Other(format!("decode {}: {}", type_name, e)))?;
            if let Some(s) = decode_ltree_bytes(bytes) {
                return Ok(json!(s));
            }
        }

        _ => {}
    }

    // ─── Arrays (`_INT4`, `_TEXT`, …) ────────────────────────────────────
    if let Some(elem) = type_name.strip_prefix('_') {
        if let Some(v) = try_decode_array(row, idx, elem) {
            return Ok(v);
        }
    }

    // ─── Range types ────────────────────────────────────────────────────
    if let Some(v) = try_decode_range(row, idx, type_name) {
        return Ok(v);
    }

    // ─── Fallback ───────────────────────────────────────────────────────
    let s: Result<Option<String>, _> = row.try_get(idx);
    match s {
        Ok(Some(x)) => return Ok(Value::String(x)),
        Ok(None) => return Ok(Value::Null),
        Err(_) => {}
    }

    // Last-resort: read raw bytes. UTF-8 → string (handles enums/domains
    // sent as their text label, plus any extension type whose binary
    // encoding is just UTF-8 text). Otherwise → hex literal (`\x...`)
    // so the user at least sees the value instead of an opaque error.
    let raw = row.try_get_raw(idx)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let bytes = raw
        .as_bytes()
        .map_err(|_| AppError::UnsupportedType(type_name.to_string()))?;
    match std::str::from_utf8(bytes) {
        Ok(s) if !s.contains('\0') => Ok(Value::String(s.to_string())),
        _ => Ok(json!(bytes_to_hex(bytes))),
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("\\x");
    for b in bytes {
        s.push_str(&format!("{:02X}", b));
    }
    s
}

fn format_macaddr8(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(":")
}

fn bitvec_to_string(b: &sqlx::types::BitVec) -> String {
    let mut s = String::with_capacity(b.len());
    for bit in b.iter() {
        s.push(if bit { '1' } else { '0' });
    }
    s
}

fn format_pg_timetz(
    t: &sqlx::postgres::types::PgTimeTz<
        sqlx::types::chrono::NaiveTime,
        sqlx::types::chrono::FixedOffset,
    >,
) -> String {
    let offset_secs = t.offset.local_minus_utc();
    let sign = if offset_secs >= 0 { '+' } else { '-' };
    let abs = offset_secs.unsigned_abs();
    let hh = abs / 3600;
    let mm = (abs % 3600) / 60;
    let time_part = t.time.format("%H:%M:%S%.f").to_string();
    if mm == 0 {
        format!("{}{}{:02}", time_part, sign, hh)
    } else {
        format!("{}{}{:02}:{:02}", time_part, sign, hh, mm)
    }
}

/// hstore binary wire format: `int32 count`, then for each entry
/// `int32 key_len + key_bytes + int32 val_len (-1 = NULL) + val_bytes`.
fn parse_hstore(bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 4 {
        return None;
    }
    let count = i32::from_be_bytes(bytes[0..4].try_into().ok()?);
    if count < 0 {
        return None;
    }
    let mut p = 4usize;
    let mut o = serde_json::Map::with_capacity(count as usize);
    for _ in 0..count {
        if p + 4 > bytes.len() {
            return None;
        }
        let klen = i32::from_be_bytes(bytes[p..p + 4].try_into().ok()?);
        p += 4;
        if klen < 0 || p + klen as usize > bytes.len() {
            return None;
        }
        let key = std::str::from_utf8(&bytes[p..p + klen as usize])
            .ok()?
            .to_string();
        p += klen as usize;
        if p + 4 > bytes.len() {
            return None;
        }
        let vlen = i32::from_be_bytes(bytes[p..p + 4].try_into().ok()?);
        p += 4;
        let value = if vlen < 0 {
            Value::Null
        } else {
            let v = bytes.get(p..p + vlen as usize)?;
            p += vlen as usize;
            Value::String(std::str::from_utf8(v).ok()?.to_string())
        };
        o.insert(key, value);
    }
    Some(Value::Object(o))
}

fn decode_ltree_bytes(bytes: &[u8]) -> Option<String> {
    // PG ltree/lquery/ltxtquery binary format prepends a 1-byte protocol
    // version (currently 1). Strip it and read the rest as UTF-8.
    if bytes.is_empty() {
        return None;
    }
    std::str::from_utf8(&bytes[1..]).ok().map(|s| s.to_string())
}

/// pgvector binary wire format: `u16 dim, u16 unused, dim * f32` (big-endian).
fn parse_vector(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() < 4 {
        return None;
    }
    let dim = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    let expected = 4 + dim * 4;
    if bytes.len() != expected {
        return None;
    }
    let mut v = Vec::with_capacity(dim);
    for i in 0..dim {
        let off = 4 + i * 4;
        let f = f32::from_be_bytes(bytes[off..off + 4].try_into().ok()?);
        v.push(f);
    }
    Some(v)
}

fn read_f64_be(bytes: &[u8], off: usize) -> Option<f64> {
    bytes
        .get(off..off + 8)
        .and_then(|s| s.try_into().ok())
        .map(f64::from_be_bytes)
}

/// Strip trailing zeros / fraction the way PG's geometric-type output does.
fn fmt_pg_num(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

fn parse_point(b: &[u8]) -> Option<Value> {
    if b.len() != 16 {
        return None;
    }
    let x = read_f64_be(b, 0)?;
    let y = read_f64_be(b, 8)?;
    Some(json!(format!("({},{})", fmt_pg_num(x), fmt_pg_num(y))))
}

fn parse_line(b: &[u8]) -> Option<Value> {
    // `{A,B,C}` representing A*x + B*y + C = 0
    if b.len() != 24 {
        return None;
    }
    let a = read_f64_be(b, 0)?;
    let bb = read_f64_be(b, 8)?;
    let c = read_f64_be(b, 16)?;
    Some(json!(format!(
        "{{{},{},{}}}",
        fmt_pg_num(a),
        fmt_pg_num(bb),
        fmt_pg_num(c)
    )))
}

fn parse_lseg(b: &[u8]) -> Option<Value> {
    if b.len() != 32 {
        return None;
    }
    let x1 = read_f64_be(b, 0)?;
    let y1 = read_f64_be(b, 8)?;
    let x2 = read_f64_be(b, 16)?;
    let y2 = read_f64_be(b, 24)?;
    Some(json!(format!(
        "[({},{}),({},{})]",
        fmt_pg_num(x1),
        fmt_pg_num(y1),
        fmt_pg_num(x2),
        fmt_pg_num(y2)
    )))
}

fn parse_box(b: &[u8]) -> Option<Value> {
    if b.len() != 32 {
        return None;
    }
    let x1 = read_f64_be(b, 0)?;
    let y1 = read_f64_be(b, 8)?;
    let x2 = read_f64_be(b, 16)?;
    let y2 = read_f64_be(b, 24)?;
    Some(json!(format!(
        "({},{}),({},{})",
        fmt_pg_num(x1),
        fmt_pg_num(y1),
        fmt_pg_num(x2),
        fmt_pg_num(y2)
    )))
}

fn parse_circle(b: &[u8]) -> Option<Value> {
    if b.len() != 24 {
        return None;
    }
    let x = read_f64_be(b, 0)?;
    let y = read_f64_be(b, 8)?;
    let r = read_f64_be(b, 16)?;
    Some(json!(format!(
        "<({},{}),{}>",
        fmt_pg_num(x),
        fmt_pg_num(y),
        fmt_pg_num(r)
    )))
}

fn parse_path(b: &[u8]) -> Option<Value> {
    // 1 byte: closed flag · 4 bytes: int32 npts · npts × (2 × float8)
    if b.len() < 5 {
        return None;
    }
    let closed = b[0] != 0;
    let npts = i32::from_be_bytes(b[1..5].try_into().ok()?) as usize;
    let expected = 5 + npts * 16;
    if b.len() != expected {
        return None;
    }
    let mut pts = Vec::with_capacity(npts);
    for i in 0..npts {
        let off = 5 + i * 16;
        let x = read_f64_be(b, off)?;
        let y = read_f64_be(b, off + 8)?;
        pts.push(format!("({},{})", fmt_pg_num(x), fmt_pg_num(y)));
    }
    let joined = pts.join(",");
    Some(json!(if closed {
        format!("({})", joined)
    } else {
        format!("[{}]", joined)
    }))
}

fn parse_polygon(b: &[u8]) -> Option<Value> {
    if b.len() < 4 {
        return None;
    }
    let npts = i32::from_be_bytes(b[0..4].try_into().ok()?) as usize;
    let expected = 4 + npts * 16;
    if b.len() != expected {
        return None;
    }
    let mut pts = Vec::with_capacity(npts);
    for i in 0..npts {
        let off = 4 + i * 16;
        let x = read_f64_be(b, off)?;
        let y = read_f64_be(b, off + 8)?;
        pts.push(format!("({},{})", fmt_pg_num(x), fmt_pg_num(y)));
    }
    Some(json!(format!("({})", pts.join(","))))
}

fn decode_geometric(
    row: &PgRow,
    idx: usize,
    type_name: &str,
    parser: fn(&[u8]) -> Option<Value>,
) -> AppResult<Value> {
    let raw = row.try_get_raw(idx)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let bytes = raw
        .as_bytes()
        .map_err(|e| AppError::Other(format!("decode {}: {}", type_name, e)))?;
    if let Some(v) = parser(bytes) {
        return Ok(v);
    }
    Ok(json!(bytes_to_hex(bytes)))
}

/// TSVECTOR binary format: `int32 nlex`, then for each lexeme `cstring + u16
/// npos + npos × u16` (top 2 bits = weight, low 14 = position).
fn parse_tsvector(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    let nlex = i32::from_be_bytes(bytes[0..4].try_into().ok()?) as usize;
    let mut p = 4usize;
    let mut out = Vec::with_capacity(nlex);
    for _ in 0..nlex {
        let end = bytes.get(p..)?.iter().position(|&b| b == 0)?;
        let lex = std::str::from_utf8(&bytes[p..p + end]).ok()?;
        p += end + 1;
        if p + 2 > bytes.len() {
            return None;
        }
        let npos = u16::from_be_bytes([bytes[p], bytes[p + 1]]) as usize;
        p += 2;
        if p + npos * 2 > bytes.len() {
            return None;
        }
        let mut positions: Vec<String> = Vec::with_capacity(npos);
        for i in 0..npos {
            let pos = u16::from_be_bytes([bytes[p + i * 2], bytes[p + i * 2 + 1]]);
            let position = pos & 0x3FFF;
            let weight = (pos >> 14) & 0x3;
            let w = match weight {
                3 => "A",
                2 => "B",
                1 => "C",
                _ => "",
            };
            positions.push(format!("{}{}", position, w));
        }
        p += npos * 2;
        let esc = lex.replace('\'', "''");
        if positions.is_empty() {
            out.push(format!("'{}'", esc));
        } else {
            out.push(format!("'{}':{}", esc, positions.join(",")));
        }
    }
    Some(out.join(" "))
}

fn try_decode_array(row: &PgRow, idx: usize, elem_type: &str) -> Option<Value> {
    // sqlx `Vec<Option<T>>` handles nullable elements; we map each through a
    // formatter to keep the wire-side textual representation consistent with
    // the scalar branches above.
    macro_rules! arr {
        ($ty:ty, $map:expr) => {{
            let v: Result<Option<Vec<Option<$ty>>>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v {
                let mapped: Vec<Value> = x
                    .into_iter()
                    .map(|o| match o {
                        Some(v) => ($map)(v),
                        None => Value::Null,
                    })
                    .collect();
                return Some(json!(mapped));
            }
            if let Ok(None) = v {
                return Some(Value::Null);
            }
        }};
    }
    match elem_type {
        "BOOL" => arr!(bool, |x: bool| json!(x)),
        "INT2" => arr!(i16, |x: i16| json!(x)),
        "INT4" => arr!(i32, |x: i32| json!(x)),
        "INT8" => arr!(i64, |x: i64| json!(x)),
        "FLOAT4" => arr!(f32, |x: f32| json!(x)),
        "FLOAT8" => arr!(f64, |x: f64| json!(x)),
        "OID" => arr!(
            sqlx::postgres::types::Oid,
            |x: sqlx::postgres::types::Oid| json!(x.0)
        ),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CITEXT" | "CHAR" | "XML" => {
            arr!(String, |x: String| json!(x))
        }
        "UUID" => arr!(sqlx::types::Uuid, |x: sqlx::types::Uuid| json!(
            x.to_string()
        )),
        "JSON" | "JSONB" => arr!(Value, |x: Value| x),
        "NUMERIC" => arr!(sqlx::types::BigDecimal, |x: sqlx::types::BigDecimal| {
            json!(x.to_string())
        }),
        "BYTEA" => arr!(Vec<u8>, |x: Vec<u8>| json!(bytes_to_hex(&x))),
        "DATE" => arr!(
            sqlx::types::chrono::NaiveDate,
            |x: sqlx::types::chrono::NaiveDate| { json!(x.to_string()) }
        ),
        "TIME" => arr!(
            sqlx::types::chrono::NaiveTime,
            |x: sqlx::types::chrono::NaiveTime| { json!(x.to_string()) }
        ),
        "TIMESTAMP" => arr!(
            sqlx::types::chrono::NaiveDateTime,
            |x: sqlx::types::chrono::NaiveDateTime| { json!(x.to_string()) }
        ),
        "TIMESTAMPTZ" => arr!(
            sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>,
            |x: sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>| json!(x.to_rfc3339())
        ),
        "INTERVAL" => arr!(
            sqlx::postgres::types::PgInterval,
            |x: sqlx::postgres::types::PgInterval| { json!(format_pg_interval(&x)) }
        ),
        "INET" | "CIDR" => arr!(
            sqlx::types::ipnetwork::IpNetwork,
            |x: sqlx::types::ipnetwork::IpNetwork| json!(x.to_string())
        ),
        "MACADDR" => arr!(
            sqlx::types::mac_address::MacAddress,
            |x: sqlx::types::mac_address::MacAddress| json!(x.to_string())
        ),
        "MONEY" => arr!(
            sqlx::postgres::types::PgMoney,
            |x: sqlx::postgres::types::PgMoney| json!(x.to_bigdecimal(2).to_string())
        ),
        _ => {}
    }
    None
}

fn try_decode_range(row: &PgRow, idx: usize, type_name: &str) -> Option<Value> {
    macro_rules! rng {
        ($ty:ty, $fmt:expr) => {{
            let v: Result<Option<sqlx::postgres::types::PgRange<$ty>>, _> = row.try_get(idx);
            if let Ok(Some(r)) = v {
                let f: fn(&$ty) -> String = $fmt;
                return Some(json!(format_pg_range(&r, f)));
            }
            if let Ok(None) = v {
                return Some(Value::Null);
            }
        }};
    }
    match type_name {
        "INT4RANGE" => rng!(i32, |v: &i32| v.to_string()),
        "INT8RANGE" => rng!(i64, |v: &i64| v.to_string()),
        "NUMRANGE" => rng!(sqlx::types::BigDecimal, |v: &sqlx::types::BigDecimal| v
            .to_string()),
        "TSRANGE" => rng!(
            sqlx::types::chrono::NaiveDateTime,
            |v: &sqlx::types::chrono::NaiveDateTime| v.to_string()
        ),
        "TSTZRANGE" => rng!(
            sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>,
            |v: &sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>| v.to_rfc3339()
        ),
        "DATERANGE" => rng!(
            sqlx::types::chrono::NaiveDate,
            |v: &sqlx::types::chrono::NaiveDate| v.to_string()
        ),
        _ => {}
    }
    None
}

fn format_pg_range<T>(r: &sqlx::postgres::types::PgRange<T>, fmt: fn(&T) -> String) -> String {
    use std::ops::Bound::*;
    let (lo_open, lo_str) = match &r.start {
        Included(v) => ('[', fmt(v)),
        Excluded(v) => ('(', fmt(v)),
        Unbounded => ('(', String::new()),
    };
    let (hi_open, hi_str) = match &r.end {
        Included(v) => (']', fmt(v)),
        Excluded(v) => (')', fmt(v)),
        Unbounded => (')', String::new()),
    };
    format!("{}{},{}{}", lo_open, lo_str, hi_str, hi_open)
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

    // ─── Hex / MAC / ltree / bitvec ──────────────────────────────────────

    #[test]
    fn hex_formatter_uppercase() {
        assert_eq!(bytes_to_hex(&[]), "\\x");
        assert_eq!(bytes_to_hex(&[0xde, 0xad, 0xbe, 0xef]), "\\xDEADBEEF");
        assert_eq!(bytes_to_hex(&[0x00, 0x01, 0xff]), "\\x0001FF");
    }

    #[test]
    fn macaddr8_formats_as_eight_octets() {
        let bytes = [0x08, 0x00, 0x2b, 0x01, 0x02, 0x03, 0x04, 0x05];
        assert_eq!(format_macaddr8(&bytes), "08:00:2b:01:02:03:04:05");
    }

    #[test]
    fn hstore_decodes_keys_values_and_nulls() {
        // {"k1" => "v1", "k2" => NULL}
        let mut b = Vec::new();
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(b"k1");
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(b"v1");
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(b"k2");
        b.extend_from_slice(&(-1i32).to_be_bytes());
        let v = parse_hstore(&b).unwrap();
        assert_eq!(v["k1"], json!("v1"));
        assert_eq!(v["k2"], Value::Null);
    }

    #[test]
    fn hstore_empty_map() {
        let b = 0i32.to_be_bytes();
        assert_eq!(parse_hstore(&b).unwrap(), json!({}));
    }

    #[test]
    fn hstore_rejects_truncated_buffer() {
        // count=2 but only one entry's worth of bytes
        let mut b = Vec::new();
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(&1i32.to_be_bytes());
        b.extend_from_slice(b"k");
        b.extend_from_slice(&1i32.to_be_bytes());
        b.extend_from_slice(b"v");
        assert!(parse_hstore(&b).is_none());
    }

    #[test]
    fn ltree_strips_version_byte() {
        // version 1 + "a.b.c"
        let bytes = [0x01, b'a', b'.', b'b', b'.', b'c'];
        assert_eq!(decode_ltree_bytes(&bytes).as_deref(), Some("a.b.c"));
        assert_eq!(decode_ltree_bytes(&[]), None);
    }

    #[test]
    fn bitvec_renders_as_zeros_and_ones() {
        let mut bv = sqlx::types::BitVec::from_elem(5, false);
        bv.set(0, true);
        bv.set(2, true);
        bv.set(4, true);
        assert_eq!(bitvec_to_string(&bv), "10101");
    }

    // ─── pgvector ────────────────────────────────────────────────────────

    #[test]
    fn vector_decodes_dim_and_values() {
        // dim=2, unused=0, [1.0, 2.5]
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u16.to_be_bytes());
        bytes.extend_from_slice(&0u16.to_be_bytes());
        bytes.extend_from_slice(&1.0f32.to_be_bytes());
        bytes.extend_from_slice(&2.5f32.to_be_bytes());
        let v = parse_vector(&bytes).expect("parse");
        assert_eq!(v.len(), 2);
        assert!((v[0] - 1.0).abs() < f32::EPSILON);
        assert!((v[1] - 2.5).abs() < f32::EPSILON);
    }

    #[test]
    fn vector_rejects_truncated_buffer() {
        // dim=4 but body only carries 1 f32
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&4u16.to_be_bytes());
        bytes.extend_from_slice(&0u16.to_be_bytes());
        bytes.extend_from_slice(&1.0f32.to_be_bytes());
        assert!(parse_vector(&bytes).is_none());
    }

    #[test]
    fn vector_handles_empty_dim() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u16.to_be_bytes());
        bytes.extend_from_slice(&0u16.to_be_bytes());
        let v = parse_vector(&bytes).expect("parse");
        assert!(v.is_empty());
    }

    // ─── Geometric ───────────────────────────────────────────────────────

    fn pt(x: f64, y: f64) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&x.to_be_bytes());
        b.extend_from_slice(&y.to_be_bytes());
        b
    }

    #[test]
    fn point_renders_pg_text_form() {
        assert_eq!(parse_point(&pt(1.0, 2.5)).unwrap(), json!("(1,2.5)"));
    }

    #[test]
    fn line_renders_three_coefficients() {
        let mut b = Vec::new();
        b.extend_from_slice(&1.0f64.to_be_bytes());
        b.extend_from_slice(&(-2.0f64).to_be_bytes());
        b.extend_from_slice(&3.0f64.to_be_bytes());
        assert_eq!(parse_line(&b).unwrap(), json!("{1,-2,3}"));
    }

    #[test]
    fn lseg_renders_two_points_in_brackets() {
        let mut b = Vec::new();
        b.extend(pt(0.0, 0.0));
        b.extend(pt(1.0, 1.0));
        assert_eq!(parse_lseg(&b).unwrap(), json!("[(0,0),(1,1)]"));
    }

    #[test]
    fn box_renders_two_points_no_brackets() {
        let mut b = Vec::new();
        b.extend(pt(2.0, 3.0));
        b.extend(pt(0.0, 0.0));
        assert_eq!(parse_box(&b).unwrap(), json!("(2,3),(0,0)"));
    }

    #[test]
    fn circle_renders_center_and_radius() {
        let mut b = Vec::new();
        b.extend(pt(1.5, 2.5));
        b.extend_from_slice(&3.0f64.to_be_bytes());
        assert_eq!(parse_circle(&b).unwrap(), json!("<(1.5,2.5),3>"));
    }

    #[test]
    fn open_path_uses_square_brackets() {
        let mut b = Vec::new();
        b.push(0); // open
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend(pt(0.0, 0.0));
        b.extend(pt(1.0, 1.0));
        assert_eq!(parse_path(&b).unwrap(), json!("[(0,0),(1,1)]"));
    }

    #[test]
    fn closed_path_uses_parentheses() {
        let mut b = Vec::new();
        b.push(1); // closed
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend(pt(0.0, 0.0));
        b.extend(pt(1.0, 1.0));
        assert_eq!(parse_path(&b).unwrap(), json!("((0,0),(1,1))"));
    }

    #[test]
    fn polygon_renders_as_parenthesized_points() {
        let mut b = Vec::new();
        b.extend_from_slice(&3i32.to_be_bytes());
        b.extend(pt(0.0, 0.0));
        b.extend(pt(1.0, 0.0));
        b.extend(pt(0.5, 1.0));
        assert_eq!(parse_polygon(&b).unwrap(), json!("((0,0),(1,0),(0.5,1))"));
    }

    // ─── TSVECTOR ────────────────────────────────────────────────────────

    #[test]
    fn tsvector_renders_lexemes_with_weighted_positions() {
        // 2 lexemes:
        //   "cat"  with 1 unweighted position 2
        //   "dog" with 2 positions: 1A, 3
        let mut b = Vec::new();
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(b"cat\0");
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&2u16.to_be_bytes()); // weight 0, pos 2
        b.extend_from_slice(b"dog\0");
        b.extend_from_slice(&2u16.to_be_bytes());
        b.extend_from_slice(&((3u16 << 14) | 1u16).to_be_bytes()); // A, pos 1
        b.extend_from_slice(&3u16.to_be_bytes()); // unweighted, pos 3
        assert_eq!(parse_tsvector(&b).unwrap(), "'cat':2 'dog':1A,3");
    }

    #[test]
    fn tsvector_handles_no_positions() {
        let mut b = Vec::new();
        b.extend_from_slice(&1i32.to_be_bytes());
        b.extend_from_slice(b"foo\0");
        b.extend_from_slice(&0u16.to_be_bytes());
        assert_eq!(parse_tsvector(&b).unwrap(), "'foo'");
    }

    // ─── PgRange formatting ──────────────────────────────────────────────

    #[test]
    fn range_renders_inclusive_exclusive_pairs() {
        use sqlx::postgres::types::PgRange;
        use std::ops::Bound::*;
        let r = PgRange::<i32> {
            start: Included(1),
            end: Excluded(5),
        };
        assert_eq!(format_pg_range(&r, |v: &i32| v.to_string()), "[1,5)");
    }

    #[test]
    fn range_renders_unbounded() {
        use sqlx::postgres::types::PgRange;
        use std::ops::Bound::*;
        let r = PgRange::<i32> {
            start: Unbounded,
            end: Excluded(10),
        };
        assert_eq!(format_pg_range(&r, |v: &i32| v.to_string()), "(,10)");
    }

    // ─── PgTimeTz formatting ─────────────────────────────────────────────

    #[test]
    fn timetz_renders_with_signed_offset() {
        use sqlx::postgres::types::PgTimeTz;
        use sqlx::types::chrono::{FixedOffset, NaiveTime};
        let t = PgTimeTz {
            time: NaiveTime::from_hms_opt(12, 30, 0).unwrap(),
            offset: FixedOffset::east_opt(2 * 3600).unwrap(),
        };
        assert_eq!(format_pg_timetz(&t), "12:30:00+02");
        let t = PgTimeTz {
            time: NaiveTime::from_hms_opt(8, 0, 0).unwrap(),
            offset: FixedOffset::west_opt(5 * 3600 + 30 * 60).unwrap(),
        };
        assert_eq!(format_pg_timetz(&t), "08:00:00-05:30");
    }
}
