use serde::Deserialize;
use tauri::State;

use crate::commands::folders::{creates_cycle, FolderInput};
use crate::error::{AppError, AppResult};
use crate::storage::{new_id, Folder, FolderPosition, Snippet, SnippetPosition};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct SnippetInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub bytea_modes_json: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[tauri::command]
pub async fn list_snippets(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<Vec<Snippet>> {
    state.storage.list_snippets(connection_id.as_deref()).await
}

#[tauri::command]
pub async fn save_snippet(state: State<'_, AppState>, input: SnippetInput) -> AppResult<Snippet> {
    let id = input.id.unwrap_or_else(new_id);
    // `upsert_snippet` never writes `position` (owned by `reorder_snippets`),
    // so echo the stored value back instead of resetting it on every save.
    let position = state.storage.snippet_position(&id).await?;
    let s = Snippet {
        id,
        connection_id: input.connection_id,
        name: input.name,
        sql: input.sql,
        created_at: String::new(),
        bytea_modes_json: input.bytea_modes_json,
        folder_id: input.folder_id,
        position,
    };
    state.storage.upsert_snippet(&s).await?;
    Ok(s)
}

/// Persist a snippet-panel drag-and-drop. Mirrors `reorder_connections`: the
/// frontend sends the full ordered sibling list of every affected container.
#[tauri::command]
pub async fn reorder_snippets(
    state: State<'_, AppState>,
    items: Vec<SnippetPosition>,
) -> AppResult<()> {
    state.storage.set_snippet_positions(&items).await
}

#[tauri::command]
pub async fn list_snippet_folders(state: State<'_, AppState>) -> AppResult<Vec<Folder>> {
    state.storage.list_snippet_folders().await
}

#[tauri::command]
pub async fn save_snippet_folder(
    state: State<'_, AppState>,
    input: FolderInput,
) -> AppResult<Folder> {
    let id = input.id.unwrap_or_else(new_id);
    let position = state.storage.snippet_folder_position(&id).await?;
    let folder = Folder {
        id,
        name: input.name,
        parent_id: input.parent_id,
        position,
    };
    state.storage.upsert_snippet_folder(&folder).await?;
    Ok(folder)
}

/// Folder counterpart of `reorder_snippets`. Rejected if the update would make
/// a folder its own ancestor — the frontend blocks the drop, but a stale tree
/// on its side must not be able to corrupt the hierarchy.
#[tauri::command]
pub async fn reorder_snippet_folders(
    state: State<'_, AppState>,
    items: Vec<FolderPosition>,
) -> AppResult<()> {
    let folders = state.storage.list_snippet_folders().await?;
    if creates_cycle(&folders, &items) {
        return Err(AppError::Other(
            "cannot move a folder into its own descendant".into(),
        ));
    }
    state.storage.set_snippet_folder_positions(&items).await
}

#[tauri::command]
pub async fn delete_snippet_folder(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.storage.delete_snippet_folder(&id).await
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.storage.delete_snippet(&id).await
}

#[tauri::command]
pub async fn update_snippet_bytea_modes(
    state: State<'_, AppState>,
    id: String,
    bytea_modes_json: Option<String>,
) -> AppResult<()> {
    state
        .storage
        .update_snippet_bytea_modes(&id, bytea_modes_json.as_deref())
        .await
}
