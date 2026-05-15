use sqlx::Row;
use tauri::State;

use crate::error::AppResult;
use crate::pool_registry::PoolHandle;
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

    match handle {
        PoolHandle::Postgres(pool) => {
            let rows = sqlx::query(sql)
                .bind(&schema)
                .bind(&table)
                .fetch_all(&pool)
                .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("column_name").ok())
                .collect())
        }
        PoolHandle::MySql(pool) => {
            let rows = sqlx::query(mysql_sql)
                .bind(&schema)
                .bind(&table)
                .fetch_all(&pool)
                .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("column_name").ok())
                .collect())
        }
        PoolHandle::Sqlite(pool) => {
            let _ = schema;
            let pragma = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
            let rows = sqlx::query(&pragma).fetch_all(&pool).await?;
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

    match handle {
        PoolHandle::Postgres(pool) => {
            let mut q = sqlx::query(&sql);
            for p in &params {
                q = q.bind(p.as_deref());
            }
            let r = q.execute(&pool).await?;
            Ok(r.rows_affected())
        }
        PoolHandle::MySql(pool) => {
            let mut q = sqlx::query(&sql);
            for p in &params {
                q = q.bind(p.as_deref());
            }
            let r = q.execute(&pool).await?;
            Ok(r.rows_affected())
        }
        PoolHandle::Sqlite(pool) => {
            let mut q = sqlx::query(&sql);
            for p in &params {
                q = q.bind(p.as_deref());
            }
            let r = q.execute(&pool).await?;
            Ok(r.rows_affected())
        }
    }
}
