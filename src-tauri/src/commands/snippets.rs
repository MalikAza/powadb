use serde::Deserialize;
use tauri::State;

use crate::error::AppResult;
use crate::storage::{new_id, Snippet};
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
    let s = Snippet {
        id: input.id.unwrap_or_else(new_id),
        connection_id: input.connection_id,
        name: input.name,
        sql: input.sql,
        created_at: String::new(),
        bytea_modes_json: input.bytea_modes_json,
    };
    state.storage.upsert_snippet(&s).await?;
    Ok(s)
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
