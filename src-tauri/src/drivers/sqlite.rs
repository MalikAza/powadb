use std::time::Instant;

use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Executor, Row, TypeInfo};

use super::{sql_excerpt, Column as ColMeta, QueryResult, ScriptResult, StatementResult};
use crate::error::{AppError, AppResult};
use crate::sql_split::split_statements;

pub async fn connect(path: &str) -> AppResult<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

pub async fn execute(pool: &SqlitePool, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let rows: Vec<SqliteRow> = sqlx::query(sql).fetch_all(pool).await?;

    let columns: Vec<ColMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| ColMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
                source_schema: None,
                source_table: None,
                source_column: None,
            })
            .collect()
    } else {
        match pool.describe(sql).await {
            Ok(d) => d
                .columns
                .iter()
                .map(|c| ColMeta {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                    source_schema: None,
                    source_table: None,
                    source_column: None,
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    };

    let mut json_rows: Vec<Vec<Value>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut out = Vec::with_capacity(row.columns().len());
        for (i, col) in row.columns().iter().enumerate() {
            out.push(decode_sqlite(row, i, col.type_info().name())?);
        }
        json_rows.push(out);
    }

    Ok(QueryResult {
        columns,
        rows: json_rows,
        elapsed_ms: start.elapsed().as_millis(),
    })
}

pub async fn execute_script(pool: &SqlitePool, sql: &str) -> AppResult<ScriptResult> {
    let stmts = split_statements(sql);
    let mut conn = pool.acquire().await?;
    let mut statements: Vec<StatementResult> = Vec::with_capacity(stmts.len());

    for (idx, stmt) in stmts.iter().enumerate() {
        let excerpt = sql_excerpt(stmt);
        let started = Instant::now();
        let outcome = run_one_sqlite(&mut conn, stmt).await;
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

async fn run_one_sqlite(
    conn: &mut sqlx::SqliteConnection,
    stmt: &str,
) -> AppResult<(Option<QueryResult>, Option<u64>)> {
    let started = Instant::now();
    let returns_rows = match conn.describe(stmt).await {
        Ok(d) => !d.columns.is_empty(),
        Err(_) => true,
    };

    if !returns_rows {
        let r = sqlx::query(stmt).execute(&mut *conn).await?;
        return Ok((None, Some(r.rows_affected())));
    }

    let rows: Vec<SqliteRow> = sqlx::query(stmt).fetch_all(&mut *conn).await?;
    let columns: Vec<ColMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| ColMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
                source_schema: None,
                source_table: None,
                source_column: None,
            })
            .collect()
    } else {
        match conn.describe(stmt).await {
            Ok(d) => d
                .columns
                .iter()
                .map(|c| ColMeta {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                    source_schema: None,
                    source_table: None,
                    source_column: None,
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    };
    let mut json_rows: Vec<Vec<Value>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut out = Vec::with_capacity(row.columns().len());
        for (i, col) in row.columns().iter().enumerate() {
            out.push(decode_sqlite(row, i, col.type_info().name())?);
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

fn decode_sqlite(row: &SqliteRow, idx: usize, type_name: &str) -> AppResult<Value> {
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

    // SQLite stores values dynamically; declared column type is just a hint.
    // Try integer → float → text → blob in turn, falling through on mismatch.
    let upper = type_name.to_ascii_uppercase();
    match upper.as_str() {
        "INTEGER" | "INT" | "BIGINT" | "SMALLINT" | "TINYINT" | "BOOLEAN" => {
            try_decode!(i64);
        }
        "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" | "DECIMAL" => {
            try_decode!(f64);
        }
        "TEXT" | "VARCHAR" | "CHAR" | "CLOB" | "DATETIME" | "DATE" | "TIME" => {
            try_decode!(String);
        }
        "BLOB" => {
            let v: Result<Option<Vec<u8>>, _> = row.try_get(idx);
            if let Ok(Some(b)) = v {
                let mut s = String::with_capacity(2 + b.len() * 2);
                s.push_str("0x");
                for byte in &b {
                    s.push_str(&format!("{:02X}", byte));
                }
                return Ok(json!(s));
            }
            if let Ok(None) = v {
                return Ok(Value::Null);
            }
        }
        _ => {}
    }

    // Generic fallback chain: dynamic typing means a column declared TEXT may
    // actually hold an integer, etc.
    let i: Result<Option<i64>, _> = row.try_get(idx);
    if let Ok(Some(x)) = i {
        return Ok(json!(x));
    }
    let f: Result<Option<f64>, _> = row.try_get(idx);
    if let Ok(Some(x)) = f {
        return Ok(json!(x));
    }
    let s: Result<Option<String>, _> = row.try_get(idx);
    if let Ok(Some(x)) = s {
        return Ok(Value::String(x));
    }
    let b: Result<Option<Vec<u8>>, _> = row.try_get(idx);
    if let Ok(Some(bytes)) = b {
        let mut out = String::with_capacity(2 + bytes.len() * 2);
        out.push_str("0x");
        for byte in &bytes {
            out.push_str(&format!("{:02X}", byte));
        }
        return Ok(json!(out));
    }
    if matches!(i, Ok(None))
        || matches!(f, Ok(None))
        || matches!(s, Ok(None))
        || matches!(b, Ok(None))
    {
        return Ok(Value::Null);
    }
    Err(AppError::UnsupportedType(type_name.to_string()))
}
