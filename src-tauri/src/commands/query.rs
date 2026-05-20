use tauri::State;

use crate::drivers::{QueryResult, ScriptResult};
use crate::error::{AppError, AppResult};
use crate::pool_registry::{run_script_with_cancel, run_with_cancel};
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
pub async fn run_script(
    state: State<'_, AppState>,
    connection_id: String,
    query_id: String,
    sql: String,
) -> AppResult<ScriptResult> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let result = run_script_with_cancel(&state.pools, handle, &query_id, &sql).await;

    // Log each statement separately so the history view shows the actual
    // statements the user ran, not the concatenated source.
    match &result {
        Ok(r) => {
            for s in &r.statements {
                let rows = s.result.as_ref().map(|q| q.rows.len() as i64).or_else(|| {
                    s.rows_affected
                        .map(|n| i64::try_from(n).unwrap_or(i64::MAX))
                });
                let _ = state
                    .storage
                    .log_history(
                        &connection_id,
                        &s.sql_excerpt,
                        Some(s.elapsed_ms as i64),
                        rows,
                        s.error.as_deref(),
                    )
                    .await;
            }
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
