use tauri::State;

use crate::engine::Capabilities;
use crate::error::AppResult;
use crate::AppState;

#[tauri::command]
pub async fn get_capabilities(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Capabilities> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    Ok(handle.capabilities())
}
