use serde::Deserialize;
use tauri::State;

use crate::error::AppResult;
use crate::storage::{new_id, Folder};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct FolderInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> AppResult<Vec<Folder>> {
    state.storage.list_folders().await
}

#[tauri::command]
pub async fn save_folder(state: State<'_, AppState>, input: FolderInput) -> AppResult<Folder> {
    let folder = Folder {
        id: input.id.unwrap_or_else(new_id),
        name: input.name,
        parent_id: input.parent_id,
    };
    state.storage.upsert_folder(&folder).await?;
    Ok(folder)
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.storage.delete_folder(&id).await
}
