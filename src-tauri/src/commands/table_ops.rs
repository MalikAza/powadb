use sqlx::Row;
use tauri::State;

use crate::commands::ddl_util::{quote_ident, validate_ident_chars};
use crate::engine::SqlPoolView;
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;
use crate::AppState;

#[tauri::command]
pub async fn get_primary_key_columns(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> AppResult<Vec<String>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;

    let sql = r#"
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = $1
          AND tc.table_name = $2
        ORDER BY kcu.ordinal_position
    "#;
    // MySQL: information_schema string columns are binary-flagged in many
    // setups, so we CAST AS CHAR to make sqlx decode them as `String`.
    // See schema.rs for the full note.
    let mysql_sql = r#"
        SELECT CAST(kcu.column_name AS CHAR) AS column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = ?
          AND tc.table_name = ?
        ORDER BY kcu.ordinal_position
    "#;

    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            let rows = sqlx::query(sql)
                .bind(&schema)
                .bind(&table)
                .fetch_all(pool)
                .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("column_name").ok())
                .collect())
        }
        Some(SqlPoolView::Mysql(pool)) => {
            let rows = sqlx::query(mysql_sql)
                .bind(&schema)
                .bind(&table)
                .fetch_all(pool)
                .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("column_name").ok())
                .collect())
        }
        Some(SqlPoolView::Sqlite(pool)) => {
            let _ = schema;
            pk_columns_sqlite(pool, &table).await
        }
        None => Err(AppError::unsupported(
            "get_primary_key_columns",
            handle.kind().as_str(),
        )),
    }
}

#[tauri::command]
pub async fn execute_dml(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    params: Vec<Option<String>>,
) -> AppResult<u64> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;

    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            let mut q = sqlx::query(&sql);
            for p in &params {
                q = q.bind(p.as_deref());
            }
            let r = q.execute(pool).await?;
            Ok(r.rows_affected())
        }
        Some(SqlPoolView::Mysql(pool)) => {
            let mut q = sqlx::query(&sql);
            for p in &params {
                q = q.bind(p.as_deref());
            }
            let r = q.execute(pool).await?;
            Ok(r.rows_affected())
        }
        Some(SqlPoolView::Sqlite(pool)) => {
            let mut q = sqlx::query(&sql);
            for p in &params {
                q = q.bind(p.as_deref());
            }
            let r = q.execute(pool).await?;
            Ok(r.rows_affected())
        }
        None => Err(AppError::unsupported("execute_dml", handle.kind().as_str())),
    }
}

/// SQLite-specific implementation of `get_primary_key_columns`. Lives here as
/// a free function so it can be exercised directly against an in-memory pool
/// in tests, without the Tauri `State` extractor that the command requires.
async fn pk_columns_sqlite(pool: &sqlx::SqlitePool, table: &str) -> AppResult<Vec<String>> {
    validate_ident_chars(table)?;
    let pragma = format!("PRAGMA table_info({})", quote_ident(table, DbKind::Sqlite));
    let rows = sqlx::query(&pragma).fetch_all(pool).await?;
    let mut cols: Vec<(i64, String)> = rows
        .into_iter()
        .filter_map(|r| {
            let pk: i64 = r.try_get("pk").ok()?;
            if pk == 0 {
                return None;
            }
            let name: String = r.try_get("name").ok()?;
            Some((pk, name))
        })
        .collect();
    cols.sort_by_key(|(pk, _)| *pk);
    Ok(cols.into_iter().map(|(_, n)| n).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fixture() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE authors (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE order_items (
                order_id INTEGER NOT NULL,
                line_no  INTEGER NOT NULL,
                sku      TEXT NOT NULL,
                PRIMARY KEY (order_id, line_no)
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE no_pk (x TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn returns_single_pk_column() {
        let pool = fixture().await;
        let pks = pk_columns_sqlite(&pool, "authors").await.unwrap();
        assert_eq!(pks, vec!["id".to_string()]);
    }

    #[tokio::test]
    async fn returns_composite_pk_in_definition_order() {
        let pool = fixture().await;
        let pks = pk_columns_sqlite(&pool, "order_items").await.unwrap();
        assert_eq!(pks, vec!["order_id".to_string(), "line_no".to_string()]);
    }

    #[tokio::test]
    async fn returns_empty_vec_for_table_without_pk() {
        let pool = fixture().await;
        let pks = pk_columns_sqlite(&pool, "no_pk").await.unwrap();
        assert!(pks.is_empty());
    }

    #[tokio::test]
    async fn rejects_table_name_with_control_chars() {
        let pool = fixture().await;
        let err = pk_columns_sqlite(&pool, "authors\0; DROP TABLE authors")
            .await
            .unwrap_err();
        // Validation must trip before any PRAGMA is built, so the table
        // is left intact.
        assert!(err.to_string().contains("control"), "got {err}");
        assert!(
            !pk_columns_sqlite(&pool, "authors")
                .await
                .unwrap()
                .is_empty(),
            "authors table must still exist after rejected lookup"
        );
    }

    #[tokio::test]
    async fn quotes_unusual_table_names() {
        let pool = fixture().await;
        sqlx::query("CREATE TABLE \"weird\"\"name\" (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        let pks = pk_columns_sqlite(&pool, "weird\"name").await.unwrap();
        assert_eq!(pks, vec!["id".to_string()]);
    }
}
