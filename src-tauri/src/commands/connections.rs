use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::storage::{new_id, DbKind, SavedConnection, WgTunnel};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub wg_enabled: bool,
    /// Raw `wireguard.conf` contents. `None` means "don't touch the stored conf";
    /// pass `Some("")` to clear it.
    #[serde(default)]
    pub wg_config: Option<String>,
}

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<SavedConnection>> {
    state.storage.list().await
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> AppResult<SavedConnection> {
    let id = input.id.unwrap_or_else(new_id);
    let wg = if input.wg_enabled {
        Some(WgTunnel::default())
    } else {
        None
    };
    let conn = SavedConnection {
        id: id.clone(),
        name: input.name,
        kind: input.kind,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        ssl: input.ssl,
        folder_id: input.folder_id,
        color: input.color,
        wg,
    };
    state.storage.upsert(&conn).await?;
    if let Some(pw) = input.password {
        if pw.is_empty() {
            state.storage.set_password(&id, None).await?;
        } else {
            state.storage.set_password(&id, Some(&pw)).await?;
        }
    }
    if !input.wg_enabled {
        // Disabling WG clears the stored config so we don't leak it.
        state.storage.set_wg_config(&id, None).await?;
    } else if let Some(cfg) = input.wg_config.as_deref() {
        if cfg.trim().is_empty() {
            state.storage.set_wg_config(&id, None).await?;
        } else {
            state.storage.set_wg_config(&id, Some(cfg)).await?;
        }
    }
    state.pools.close(&id).await;
    Ok(conn)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.pools.close(&id).await;
    state.storage.delete(&id).await?;
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.pools.close(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn list_active_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.pools.active_ids().await)
}

#[tauri::command]
pub async fn get_connection_password(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<String>> {
    state.storage.get_password(&id).await
}

#[tauri::command]
pub async fn get_connection_wg_config(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<String>> {
    state.storage.get_wg_config(&id).await
}

/// Read a small text file (under 1 MiB) from disk. Used by the new-connection
/// form so the user can "Load wireguard.conf" instead of pasting.
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError::Other(format!("stat {path}: {e}")))?;
    if meta.len() > 1024 * 1024 {
        return Err(AppError::Other(format!(
            "{path} is larger than 1 MiB; refusing to load"
        )));
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Other(format!("read {path}: {e}")))
}

/// Write a text payload to disk. Used by diagram export (JSON/SVG) so the
/// frontend doesn't need its own filesystem plugin.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> AppResult<()> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Other(format!("mkdir {parent:?}: {e}")))?;
        }
    }
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| AppError::Other(format!("write {path}: {e}")))
}

/// Write raw bytes (base64-encoded) to disk. Used by diagram PNG export.
#[tauri::command]
pub async fn write_binary_file(path: String, base64: String) -> AppResult<()> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| AppError::Other(format!("invalid base64 payload: {e}")))?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Other(format!("mkdir {parent:?}: {e}")))?;
        }
    }
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| AppError::Other(format!("write {path}: {e}")))
}

pub async fn resolve_connection(
    state: &AppState,
    connection_id: &str,
) -> AppResult<(SavedConnection, Option<String>, Option<String>)> {
    let all = state.storage.list().await?;
    let conn = all
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| AppError::ConnectionNotFound(connection_id.to_string()))?;
    let pw = state.storage.get_password(connection_id).await?;
    let wg = state.storage.get_wg_config(connection_id).await?;
    Ok((conn, pw, wg))
}
