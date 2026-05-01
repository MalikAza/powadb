use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::storage::{new_id, DbKind, SavedConnection};
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
    };
    state.storage.upsert(&conn).await?;
    if let Some(pw) = input.password {
        if pw.is_empty() {
            state.storage.set_password(&id, None).await?;
        } else {
            state.storage.set_password(&id, Some(&pw)).await?;
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

pub async fn resolve_connection(
    state: &AppState,
    connection_id: &str,
) -> AppResult<(SavedConnection, Option<String>)> {
    let all = state.storage.list().await?;
    let conn = all
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| AppError::ConnectionNotFound(connection_id.to_string()))?;
    let pw = state.storage.get_password(connection_id).await?;
    Ok((conn, pw))
}
