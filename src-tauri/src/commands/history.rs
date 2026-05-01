use tauri::State;

use crate::error::AppResult;
use crate::storage::HistoryEntry;
use crate::AppState;

#[tauri::command]
pub async fn list_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<HistoryEntry>> {
    state
        .storage
        .list_history(connection_id.as_deref(), limit.unwrap_or(200))
        .await
}

#[tauri::command]
pub async fn clear_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<()> {
    state.storage.clear_history(connection_id.as_deref()).await
}
