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

/// Refuse anything that isn't a plain http/https URL. This is the guard
/// that keeps `open_external` from being abused to launch arbitrary local
/// handlers (`file://`, `vscode://`, custom URI schemes registered by other
/// apps, …) when the IPC layer is reached from a compromised frontend.
fn validate_external_url(url: &str) -> AppResult<()> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "refusing to open non-http url: {url}"
        )))
    }
}

#[tauri::command]
pub async fn open_external(url: String) -> AppResult<()> {
    validate_external_url(&url)?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_url_accepts_http_and_https() {
        assert!(validate_external_url("http://example.com").is_ok());
        assert!(validate_external_url("https://example.com/path?q=1").is_ok());
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        for bad in [
            "file:///etc/passwd",
            "vscode://open?uri=...",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ssh://user@host",
            "",
            "  http://leading-whitespace.com",
            "example.com", // no scheme at all
        ] {
            let err = validate_external_url(bad).unwrap_err();
            assert!(
                err.to_string().contains(bad) || bad.is_empty(),
                "expected the url in the error for {bad:?}, got {err}"
            );
        }
    }
}
