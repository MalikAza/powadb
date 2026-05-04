use tauri::State;

use crate::error::AppResult;
use crate::storage::AppSettings;
use crate::AppState;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    Ok(state.settings.get())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> AppResult<AppSettings> {
    state.storage.save_settings(&settings).await?;
    state.settings.set(settings.clone());
    Ok(settings)
}
