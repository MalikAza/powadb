use tauri::State;

use crate::drivers::QueryResult;
use crate::error::{AppError, AppResult};
use crate::pool_registry::run_with_cancel;
use crate::AppState;

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    connection_id: String,
    query_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let result = run_with_cancel(&state.pools, handle, &query_id, &sql).await;

    match &result {
        Ok(r) => {
            let _ = state
                .storage
                .log_history(
                    &connection_id,
                    &sql,
                    Some(r.elapsed_ms as i64),
                    Some(r.rows.len() as i64),
                    None,
                )
                .await;
        }
        Err(AppError::Canceled) => {
            let _ = state
                .storage
                .log_history(&connection_id, &sql, None, None, Some("canceled"))
                .await;
        }
        Err(e) => {
            let _ = state
                .storage
                .log_history(&connection_id, &sql, None, None, Some(&e.to_string()))
                .await;
        }
    }

    result
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, query_id: String) -> AppResult<bool> {
    Ok(state.pools.fire_cancel(&query_id).await)
}
