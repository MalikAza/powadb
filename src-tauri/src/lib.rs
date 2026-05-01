mod commands;
mod drivers;
mod error;
mod pool_registry;
mod storage;

use tauri::Manager;

pub struct AppState {
    pub storage: storage::Storage,
    pub pools: pool_registry::PoolRegistry,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("powadb.db");
            let storage = tauri::async_runtime::block_on(storage::Storage::open(db_path))?;
            app.manage(AppState {
                storage,
                pools: pool_registry::PoolRegistry::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::query::run_query,
            commands::query::cancel_query,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::disconnect,
            commands::schema::introspect_schema,
            commands::history::list_history,
            commands::history::clear_history,
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::table_ops::get_primary_key_columns,
            commands::table_ops::execute_dml,
            commands::folders::list_folders,
            commands::folders::save_folder,
            commands::folders::delete_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
