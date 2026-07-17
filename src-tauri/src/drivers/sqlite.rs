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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn mem_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE t (
                id    INTEGER PRIMARY KEY,
                name  TEXT,
                score REAL,
                data  BLOB,
                flag  BOOLEAN
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO t (id, name, score, data, flag) VALUES (1, 'alice', 3.5, X'DEADBEEF', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO t (id, name, score, data, flag) VALUES (2, NULL, NULL, NULL, 0)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn execute_returns_columns_and_decodes_each_type() {
        let pool = mem_pool().await;
        let out = execute(
            &pool,
            "SELECT id, name, score, data, flag FROM t ORDER BY id",
        )
        .await
        .unwrap();

        let names: Vec<&str> = out.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "name", "score", "data", "flag"]);
        assert_eq!(out.rows.len(), 2);

        // Row 1: integer, text, real, blob-as-hex, boolean-as-integer.
        assert_eq!(out.rows[0][0], json!(1));
        assert_eq!(out.rows[0][1], json!("alice"));
        assert_eq!(out.rows[0][2], json!(3.5));
        assert_eq!(out.rows[0][3], json!("0xDEADBEEF"));
        assert_eq!(out.rows[0][4], json!(1));

        // Row 2: NULLs decode to JSON null across text / real / blob arms.
        assert_eq!(out.rows[1][0], json!(2));
        assert_eq!(out.rows[1][1], Value::Null);
        assert_eq!(out.rows[1][2], Value::Null);
        assert_eq!(out.rows[1][3], Value::Null);
        assert_eq!(out.rows[1][4], json!(0));
    }

    #[tokio::test]
    async fn execute_decodes_untyped_expression_columns_via_fallback() {
        let pool = mem_pool().await;
        // Expression columns have no declared affinity, so they exercise the
        // generic integer→float→text fallback chain rather than a typed arm.
        let out = execute(&pool, "SELECT abs(-7) AS n, 'hi' AS s")
            .await
            .unwrap();
        assert_eq!(out.rows[0][0], json!(7));
        assert_eq!(out.rows[0][1], json!("hi"));
    }

    #[tokio::test]
    async fn execute_reports_columns_for_an_empty_result_set() {
        let pool = mem_pool().await;
        // No rows match, so columns must come from `describe`, not the first row.
        let out = execute(&pool, "SELECT id, name FROM t WHERE id = 999")
            .await
            .unwrap();
        assert!(out.rows.is_empty());
        let names: Vec<&str> = out.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "name"]);
    }

    #[tokio::test]
    async fn execute_script_runs_every_statement_and_tags_dml_vs_rows() {
        let pool = mem_pool().await;
        let script = "CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT); \
                      INSERT INTO s (id, v) VALUES (1, 'a'), (2, 'b'); \
                      SELECT COUNT(*) AS c FROM s;";
        let out = execute_script(&pool, script).await.unwrap();

        assert_eq!(out.statements.len(), 3);
        // DDL / DML report rows_affected and carry no result set.
        assert!(out.statements[0].result.is_none());
        assert_eq!(out.statements[1].rows_affected, Some(2));
        assert!(out.statements[1].result.is_none());
        // The trailing SELECT carries a result set and no rows_affected.
        assert_eq!(out.statements[2].rows_affected, None);
        let result = out.statements[2].result.as_ref().unwrap();
        assert_eq!(result.rows, vec![vec![json!(2)]]);
        assert!(out.statements.iter().all(|s| s.error.is_none()));
    }

    #[tokio::test]
    async fn execute_script_stops_at_the_first_failing_statement() {
        let pool = mem_pool().await;
        let script = "CREATE TABLE e (id INTEGER); \
                      INSERT INTO does_not_exist VALUES (1); \
                      SELECT 1;";
        let out = execute_script(&pool, script).await.unwrap();

        // Statement 0 succeeds, statement 1 fails, statement 2 never runs.
        assert_eq!(out.statements.len(), 2);
        assert!(out.statements[0].error.is_none());
        assert!(out.statements[1].error.is_some());
    }

    #[tokio::test]
    async fn connect_opens_an_existing_file_but_refuses_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("real.db");

        // `connect` uses create_if_missing(false), so the file must exist first.
        let seeded = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        seeded.close().await;

        assert!(connect(path.to_str().unwrap()).await.is_ok());

        let missing = dir.path().join("nope.db");
        assert!(connect(missing.to_str().unwrap()).await.is_err());
    }
}
