use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::storage::{new_id, Folder, FolderPosition};
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
    let id = input.id.unwrap_or_else(new_id);
    // `upsert_folder` never writes `position` (managed by `reorder_folders`),
    // so echo the stored value back instead of resetting it on every rename.
    let position = state.storage.folder_position(&id).await?;
    let folder = Folder {
        id,
        name: input.name,
        parent_id: input.parent_id,
        position,
    };
    state.storage.upsert_folder(&folder).await?;
    Ok(folder)
}

/// Persist a sidebar drag-and-drop for folders: each item carries its new
/// `parent_id` and position within it. Rejected if the update would make a
/// folder its own ancestor.
#[tauri::command]
pub async fn reorder_folders(
    state: State<'_, AppState>,
    items: Vec<FolderPosition>,
) -> AppResult<()> {
    let folders = state.storage.list_folders().await?;
    if creates_cycle(&folders, &items) {
        return Err(AppError::Other(
            "cannot move a folder into its own descendant".into(),
        ));
    }
    state.storage.set_folder_positions(&items).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.storage.delete_folder(&id).await
}

/// True if applying `items` on top of the stored `folders` would make any
/// folder its own ancestor. The frontend prevents this drop, but a stale tree
/// on its side must not be able to corrupt the hierarchy.
fn creates_cycle(folders: &[Folder], items: &[FolderPosition]) -> bool {
    use std::collections::{HashMap, HashSet};

    let mut parent: HashMap<&str, Option<&str>> = folders
        .iter()
        .map(|f| (f.id.as_str(), f.parent_id.as_deref()))
        .collect();
    for item in items {
        parent.insert(item.id.as_str(), item.parent_id.as_deref());
    }

    for start in parent.keys() {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut cur = Some(*start);
        while let Some(id) = cur {
            if !seen.insert(id) {
                return true;
            }
            cur = parent.get(id).copied().flatten();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(id: &str, parent_id: Option<&str>) -> Folder {
        Folder {
            id: id.into(),
            name: id.into(),
            parent_id: parent_id.map(Into::into),
            position: None,
        }
    }

    fn pos(id: &str, parent_id: Option<&str>, position: i64) -> FolderPosition {
        FolderPosition {
            id: id.into(),
            parent_id: parent_id.map(Into::into),
            position,
        }
    }

    #[test]
    fn reorder_within_same_parent_is_not_a_cycle() {
        let folders = vec![folder("a", None), folder("b", None)];
        assert!(!creates_cycle(
            &folders,
            &[pos("a", None, 1), pos("b", None, 0)]
        ));
    }

    #[test]
    fn nesting_into_a_sibling_is_not_a_cycle() {
        let folders = vec![folder("a", None), folder("b", None)];
        assert!(!creates_cycle(&folders, &[pos("b", Some("a"), 0)]));
    }

    #[test]
    fn moving_a_folder_into_itself_is_a_cycle() {
        let folders = vec![folder("a", None)];
        assert!(creates_cycle(&folders, &[pos("a", Some("a"), 0)]));
    }

    #[test]
    fn moving_a_folder_into_its_descendant_is_a_cycle() {
        let folders = vec![
            folder("root", None),
            folder("mid", Some("root")),
            folder("leaf", Some("mid")),
        ];
        assert!(creates_cycle(&folders, &[pos("root", Some("leaf"), 0)]));
    }

    #[test]
    fn moving_a_folder_out_of_a_deep_chain_is_not_a_cycle() {
        let folders = vec![
            folder("root", None),
            folder("mid", Some("root")),
            folder("leaf", Some("mid")),
        ];
        assert!(!creates_cycle(&folders, &[pos("leaf", None, 0)]));
    }
}
