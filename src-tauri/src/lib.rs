mod commands;
mod drivers;
mod engine;
mod error;
mod job_registry;
mod pool_registry;
mod secret_store;
mod sql_split;
mod ssh;
mod storage;
mod storage_migrations;
mod wireguard;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};

pub struct AppState {
    pub storage: storage::Storage,
    pub pools: pool_registry::PoolRegistry,
    pub jobs: job_registry::JobRegistry,
    pub settings: storage::SettingsStore,
    pub secrets: secret_store::SecretStore,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // Debug builds (`npm run tauri:dev`) keep a separate DB file
            // and Keychain service so iterating on schema or password
            // migrations doesn't trash the installed production app's
            // state. On first launch of a debug build, seed the dev DB
            // from the prod one if it exists, so the developer doesn't
            // start with an empty connection list. Saved passwords stay
            // in the prod keychain service — dev will re-prompt on first
            // use and store the answer under the dev service name.
            let db_path = data_dir.join(storage::db_filename());
            if cfg!(debug_assertions) && !db_path.exists() {
                let prod_path = data_dir.join("powadb.db");
                if prod_path.exists() {
                    match std::fs::copy(&prod_path, &db_path) {
                        Ok(_) => eprintln!(
                            "storage: seeded {} from {} on first launch of dev build \
                             (saved passwords stay in the prod keychain — dev will re-prompt)",
                            db_path.display(),
                            prod_path.display()
                        ),
                        Err(e) => eprintln!(
                            "storage: dev DB seed copy failed: {e} (starting with an empty dev DB)"
                        ),
                    }
                }
            }
            let storage = tauri::async_runtime::block_on(storage::Storage::open(db_path))?;
            let settings = tauri::async_runtime::block_on(storage.load_settings())?;
            let secrets = secret_store::SecretStore::new();
            // Pre-existing installs have plaintext passwords in the
            // `connections.password` column. Lift each one into the OS
            // keychain on first launch; errors are logged but don't abort
            // startup (we still want the app to open, even degraded).
            if let Err(e) =
                tauri::async_runtime::block_on(secrets.migrate_legacy_plaintext(&storage))
            {
                eprintln!("secret_store: legacy migration failed: {e}");
            }
            app.manage(AppState {
                storage,
                pools: pool_registry::PoolRegistry::default(),
                jobs: job_registry::JobRegistry::default(),
                settings: storage::SettingsStore::new(settings),
                secrets,
            });
            app.state::<AppState>()
                .pools
                .set_app_handle(app.handle().clone());

            let app_submenu = Submenu::with_items(
                app,
                "PowaDB",
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some("About PowaDB"),
                        Some(AboutMetadata::default()),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            let edit_submenu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let view_submenu = Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?;

            let file_submenu = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "new-tab", "New Query Tab", true, Some("CmdOrCtrl+T"))?,
                    &MenuItem::with_id(
                        app,
                        "new-diagram-tab",
                        "New Diagram Tab",
                        true,
                        Some("CmdOrCtrl+Shift+D"),
                    )?,
                ],
            )?;

            let window_submenu = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            let menu = Menu::with_items(
                app,
                &[
                    &app_submenu,
                    &file_submenu,
                    &edit_submenu,
                    &view_submenu,
                    &window_submenu,
                ],
            )?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "settings" => {
                    let _ = app.emit("open-settings", ());
                }
                "new-tab" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("new-tab", ());
                }
                "new-diagram-tab" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("new-diagram-tab", ());
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::query::run_query,
            commands::query::run_script,
            commands::query::run_engine_query,
            commands::query::cancel_query,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::disconnect,
            commands::connections::list_active_connections,
            commands::connections::switch_database,
            commands::connections::prewarm_connection,
            commands::connections::get_connection_password,
            commands::connections::get_connection_wg_config,
            commands::connections::get_connection_ssh_config,
            commands::connections::read_text_file,
            commands::connections::write_text_file,
            commands::connections::write_binary_file,
            commands::schema::introspect_schema,
            commands::schema::list_databases,
            commands::diagram::introspect_diagram,
            commands::diagram::list_foreign_keys,
            commands::diagram::list_diagrams,
            commands::diagram::get_diagram,
            commands::diagram::save_diagram,
            commands::diagram::delete_diagram,
            commands::diagram_ddl::generate_diagram_ddl_cmd,
            commands::diagram_diff::diff_diagram,
            commands::diagram_diff::execute_ddl,
            commands::diagram_diff::generate_alter_ddl_cmd,
            commands::databases::create_database,
            commands::databases::drop_database,
            commands::history::list_history,
            commands::history::clear_history,
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::snippets::update_snippet_bytea_modes,
            commands::themes::list_themes,
            commands::themes::save_theme,
            commands::themes::delete_theme,
            commands::table_ops::get_primary_key_columns,
            commands::table_ops::execute_dml,
            commands::folders::list_folders,
            commands::folders::save_folder,
            commands::folders::delete_folder,
            commands::geo::geometry_to_geojson,
            commands::geo::geometries_to_geojson,
            commands::geo::decode_geometries,
            commands::dump::export_database,
            commands::dump::import_sql,
            commands::dump::check_dump_tools,
            commands::dump::cancel_dump,
            commands::dump::pick_save_path,
            commands::dump::pick_save_path_with_filter,
            commands::dump::pick_open_path,
            commands::dump::pick_open_path_with_filter,
            commands::dump::pick_wg_conf_path,
            commands::dump::pick_ssh_key_path,
            commands::dump::pick_sqlite_path,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::open_external,
            commands::capabilities::get_capabilities,
            commands::s3::s3_list_buckets,
            commands::s3::s3_list_objects,
            commands::s3::s3_object_meta,
            commands::s3::s3_preview_object,
            commands::s3::s3_download_object,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}
