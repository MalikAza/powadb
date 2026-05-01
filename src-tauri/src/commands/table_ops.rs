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
    let mysql_sql = sql.replace("$1", "?").replace("$2", "?");

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
            let rows = sqlx::query(&mysql_sql)
                .bind(&schema)
                .bind(&table)
                .fetch_all(&pool)
                .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("column_name").ok())
                .collect())
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
    }
}
