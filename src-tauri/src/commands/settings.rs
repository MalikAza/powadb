use tauri::State;

use crate::error::{AppError, AppResult};
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

#[tauri::command]
pub async fn open_external(url: String) -> AppResult<()> {
    // Only allow http(s) URLs — refuse anything else so this can't be abused
    // to launch arbitrary local handlers.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::Other(format!(
            "refusing to open non-http url: {url}"
        )));
    }

    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };

    cmd.arg(&url)
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to open url: {e}")))?;
    Ok(())
}
