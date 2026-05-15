use serde::Deserialize;
use tauri::State;

use crate::error::AppResult;
use crate::storage::{new_id, CustomTheme};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ThemeInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub base: String,
    pub radius: String,
    pub colors_json: String,
}

#[tauri::command]
pub async fn list_themes(state: State<'_, AppState>) -> AppResult<Vec<CustomTheme>> {
    state.storage.list_themes().await
}

#[tauri::command]
pub async fn save_theme(state: State<'_, AppState>, input: ThemeInput) -> AppResult<CustomTheme> {
    let t = CustomTheme {
        id: input.id.unwrap_or_else(new_id),
        name: input.name,
        base: input.base,
        radius: input.radius,
        colors_json: input.colors_json,
        created_at: String::new(),
        updated_at: String::new(),
    };
    state.storage.upsert_theme(&t).await
}

#[tauri::command]
pub async fn delete_theme(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.storage.delete_theme(&id).await
}
