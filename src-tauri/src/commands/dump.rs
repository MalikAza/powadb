use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::commands::connections::resolve_connection;
use crate::drivers::{mysql as mysql_drv, postgres as pg_drv, sqlite as sqlite_drv};
use crate::engine::{require_sql_pool, EngineHandle, SqlPoolView};
use crate::error::{AppError, AppResult};
use crate::storage::{AppSettings, DbKind, SavedConnection};
use crate::AppState;

/// Rows per multi-row `INSERT INTO ... VALUES (...), (...)` statement emitted by
/// the native dumper. Trades memory pressure (per-chunk string + bind buffer)
/// against round-trip overhead. 500 keeps a single chunk well under common
/// `max_allowed_packet` / proto limits while still amortising the per-statement
/// cost; tune here if you hit OOM on very wide tables.
const DUMP_CHUNK_SIZE: usize = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Tool,
    Native,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TableRef {
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Deserialize)]
pub struct ExportOptions {
    pub engine: Engine,
    pub include_schema: bool,
    pub include_data: bool,
    #[serde(default)]
    pub tables: Option<Vec<TableRef>>,
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportOptions {
    pub engine: Engine,
    #[serde(default = "default_true")]
    pub single_transaction: bool,
    pub job_id: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ExportSummary {
    pub bytes_written: u64,
    pub tables_dumped: usize,
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub statements_executed: usize,
}

#[derive(Debug, Serialize)]
pub struct ToolStatus {
    pub dump: Option<String>,
    pub client: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ProgressEvent {
    job_id: String,
    phase: String,
    table: Option<String>,
    rows_done: Option<u64>,
    statements_done: Option<u64>,
    message: Option<String>,
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    default_filename: Option<String>,
) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().add_filter("SQL", &["sql"]);
    if let Some(name) = default_filename {
        dialog = dialog.set_file_name(&name);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

/// Generic save-file picker the frontend can call when it needs to control the
/// filter label and accepted extensions (diagram exports, etc.).
#[tauri::command]
pub async fn pick_save_path_with_filter(
    app: AppHandle,
    default_filename: Option<String>,
    filter_label: String,
    extensions: Vec<String>,
) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let mut dialog = app.dialog().file().add_filter(&filter_label, &ext_refs);
    if let Some(name) = default_filename {
        dialog = dialog.set_file_name(&name);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn pick_open_path(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("SQL", &["sql"])
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

/// Generic open-file picker the frontend can call when it needs to control
/// the filter label and accepted extensions (diagram import, etc.).
#[tauri::command]
pub async fn pick_open_path_with_filter(
    app: AppHandle,
    filter_label: String,
    extensions: Vec<String>,
) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    app.dialog()
        .file()
        .add_filter(&filter_label, &ext_refs)
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn pick_wg_conf_path(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("WireGuard config", &["conf"])
        .add_filter("All files", &["*"])
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn pick_ssh_key_path(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // No `add_filter`: SSH key files have inconsistent extensions (none,
    // `.pem`, `.key`, `id_*`…) and any filter on macOS would grey out everything
    // that doesn't match. Letting all files through is the right default here.
    let mut builder = app.dialog().file();
    if let Some(home) = std::env::var_os("HOME") {
        let ssh_dir = std::path::PathBuf::from(home).join(".ssh");
        if ssh_dir.is_dir() {
            builder = builder.set_directory(&ssh_dir);
        }
    }
    builder.pick_file(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn pick_sqlite_path(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("SQLite database", &["db", "sqlite", "sqlite3"])
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn check_dump_tools(state: State<'_, AppState>, kind: DbKind) -> AppResult<ToolStatus> {
    let s = state.settings.get();
    Ok(ToolStatus {
        dump: resolve_tool(&s, kind, ToolKind::Dump).map(path_to_string),
        client: resolve_tool(&s, kind, ToolKind::Client).map(path_to_string),
    })
}

#[tauri::command]
pub async fn cancel_dump(state: State<'_, AppState>, job_id: String) -> AppResult<bool> {
    Ok(state.jobs.cancel(&job_id).await)
}

#[tauri::command]
pub async fn export_database(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    options: ExportOptions,
    output_path: String,
) -> AppResult<ExportSummary> {
    let cancel_flag = state.jobs.register(&options.job_id).await;
    let result = match options.engine {
        Engine::Tool => {
            let (conn, password, _, _) = resolve_connection(&state, &connection_id).await?;
            let settings = state.settings.get();
            export_with_tool(
                &app,
                &settings,
                &conn,
                password,
                &options,
                &output_path,
                cancel_flag.clone(),
            )
            .await
        }
        Engine::Native => {
            let handle = state.pools.get_or_open(&state, &connection_id).await?;
            export_native(&app, handle, &options, &output_path, cancel_flag.clone()).await
        }
    };
    state.jobs.forget(&options.job_id).await;
    if cancel_flag.load(Ordering::SeqCst) {
        // best-effort cleanup of partial file
        let _ = tokio::fs::remove_file(&output_path).await;
        return Err(AppError::Canceled);
    }
    result
}

#[tauri::command]
pub async fn import_sql(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    input_path: String,
    options: ImportOptions,
) -> AppResult<ImportSummary> {
    let cancel_flag = state.jobs.register(&options.job_id).await;
    let result = match options.engine {
        Engine::Tool => {
            let (conn, password, _, _) = resolve_connection(&state, &connection_id).await?;
            let settings = state.settings.get();
            import_with_tool(
                &app,
                &settings,
                &conn,
                password,
                &options,
                &input_path,
                cancel_flag.clone(),
            )
            .await
        }
        Engine::Native => {
            let handle = state.pools.get_or_open(&state, &connection_id).await?;
            import_native(&app, handle, &options, &input_path, cancel_flag.clone()).await
        }
    };
    state.jobs.forget(&options.job_id).await;
    if cancel_flag.load(Ordering::SeqCst) && result.is_err() {
        return Err(AppError::Canceled);
    }
    result
}

// ─── Tool resolution ──────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum ToolKind {
    Dump,
    Client,
}

fn resolve_tool(s: &AppSettings, kind: DbKind, tool: ToolKind) -> Option<PathBuf> {
    let override_path = match (kind, tool) {
        (DbKind::Postgres, ToolKind::Dump) => s.pg_dump_path.as_deref(),
        (DbKind::Postgres, ToolKind::Client) => s.psql_path.as_deref(),
        (DbKind::Mysql, ToolKind::Dump) => s.mysqldump_path.as_deref(),
        (DbKind::Mysql, ToolKind::Client) => s.mysql_path.as_deref(),
        // sqlite3 binary handles both dump (`.dump`) and client (`.read`) modes.
        (DbKind::Sqlite, _) => s.sqlite3_path.as_deref(),
        (DbKind::Mongo, ToolKind::Dump) => s.mongodump_path.as_deref(),
        (DbKind::Mongo, ToolKind::Client) => s.mongorestore_path.as_deref(),
    };
    if let Some(p) = override_path.filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let bin = match (kind, tool) {
        (DbKind::Postgres, ToolKind::Dump) => "pg_dump",
        (DbKind::Postgres, ToolKind::Client) => "psql",
        (DbKind::Mysql, ToolKind::Dump) => "mysqldump",
        (DbKind::Mysql, ToolKind::Client) => "mysql",
        (DbKind::Sqlite, _) => "sqlite3",
        (DbKind::Mongo, ToolKind::Dump) => "mongodump",
        (DbKind::Mongo, ToolKind::Client) => "mongorestore",
    };
    which::which(bin).ok()
}

fn path_to_string(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Build a mongodb:// URI for use with `mongodump` / `mongorestore`. When the
/// `database` field already looks like a full URI, return it verbatim.
fn build_mongo_uri(conn: &SavedConnection, password: Option<&str>) -> String {
    if conn.database.starts_with("mongodb://") || conn.database.starts_with("mongodb+srv://") {
        return conn.database.clone();
    }
    let userinfo = match (conn.username.as_str(), password) {
        ("", _) | (_, None) => String::new(),
        (user, Some(pw)) => format!("{}:{}@", url_encode_minimal(user), url_encode_minimal(pw)),
    };
    format!("mongodb://{userinfo}{}:{}", conn.host, conn.port)
}

fn url_encode_minimal(s: &str) -> String {
    s.bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                vec![b as char]
            } else {
                format!("%{:02X}", b).chars().collect()
            }
        })
        .collect()
}

// ─── Tool engine: export ──────────────────────────────────────────────────────

async fn export_with_tool(
    app: &AppHandle,
    settings: &AppSettings,
    conn: &SavedConnection,
    password: Option<String>,
    opts: &ExportOptions,
    output_path: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ExportSummary> {
    let bin = resolve_tool(settings, conn.kind, ToolKind::Dump)
        .ok_or_else(|| AppError::Other(format!("dump tool not found for {:?}", conn.kind)))?;
    let mut cmd = Command::new(&bin);
    match conn.kind {
        DbKind::Postgres => {
            cmd.arg(format!("--host={}", conn.host))
                .arg(format!("--port={}", conn.port))
                .arg(format!("--username={}", conn.username))
                .arg(format!("--dbname={}", conn.database))
                .arg(format!("--file={}", output_path))
                .arg("--no-password");
            if !opts.include_data {
                cmd.arg("--schema-only");
            }
            if !opts.include_schema {
                cmd.arg("--data-only");
            }
            if let Some(tables) = &opts.tables {
                for t in tables {
                    cmd.arg(format!("--table={}.{}", t.schema, t.table));
                }
            }
            if let Some(pw) = password.as_deref() {
                cmd.env("PGPASSWORD", pw);
            }
        }
        DbKind::Mysql => {
            cmd.arg("-h")
                .arg(&conn.host)
                .arg("-P")
                .arg(conn.port.to_string())
                .arg("-u")
                .arg(&conn.username)
                .arg(format!("--result-file={}", output_path));
            if !opts.include_data {
                cmd.arg("--no-data");
            }
            if !opts.include_schema {
                cmd.arg("--no-create-info");
            }
            cmd.arg(&conn.database);
            if let Some(tables) = &opts.tables {
                for t in tables {
                    cmd.arg(&t.table);
                }
            }
            if let Some(pw) = password.as_deref() {
                cmd.env("MYSQL_PWD", pw);
            }
        }
        DbKind::Sqlite => {
            // The sqlite3 CLI picks one of `.dump` / `.schema` based on options.
            // Output is written to stdout, which we redirect to the target file.
            cmd.arg(&conn.database);
            let dotcmd = if opts.include_schema && !opts.include_data {
                let mut s = String::from(".schema");
                if let Some(tables) = &opts.tables {
                    for t in tables {
                        s.push(' ');
                        s.push_str(&t.table);
                    }
                }
                s
            } else {
                let mut s = String::from(".dump");
                if let Some(tables) = &opts.tables {
                    for t in tables {
                        s.push(' ');
                        s.push_str(&t.table);
                    }
                }
                s
            };
            cmd.arg(dotcmd);
        }
        DbKind::Mongo => {
            // mongodump writes to a directory of BSON files, not a single SQL
            // file. We point it at the output path treated as a directory.
            cmd.arg(format!(
                "--uri={}",
                build_mongo_uri(conn, password.as_deref())
            ))
            .arg(format!("--out={}", output_path));
            if let Some(tables) = &opts.tables {
                for t in tables {
                    cmd.arg(format!("--collection={}", t.table));
                }
            }
        }
    }

    if matches!(conn.kind, DbKind::Sqlite) {
        cmd.stdout(Stdio::from(std::fs::File::create(output_path)?));
    } else {
        cmd.stdout(Stdio::piped());
    }
    cmd.stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn()?;

    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let job_id = opts.job_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(
                    &app,
                    &ProgressEvent {
                        job_id: job_id.clone(),
                        phase: "export".into(),
                        table: None,
                        rows_done: None,
                        statements_done: None,
                        message: Some(line),
                    },
                );
            }
        });
    }

    let status = wait_with_cancel(&mut child, cancel.clone()).await?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "{} exited with status {}",
            bin.display(),
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        )));
    }
    let bytes = tokio::fs::metadata(output_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(ExportSummary {
        bytes_written: bytes,
        tables_dumped: opts.tables.as_ref().map(|t| t.len()).unwrap_or(0),
    })
}

// ─── Tool engine: import ──────────────────────────────────────────────────────

async fn import_with_tool(
    app: &AppHandle,
    settings: &AppSettings,
    conn: &SavedConnection,
    password: Option<String>,
    opts: &ImportOptions,
    input_path: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ImportSummary> {
    let bin = resolve_tool(settings, conn.kind, ToolKind::Client)
        .ok_or_else(|| AppError::Other(format!("client tool not found for {:?}", conn.kind)))?;
    let mut cmd = Command::new(&bin);
    let mut feed_via_stdin = false;
    match conn.kind {
        DbKind::Postgres => {
            cmd.arg(format!("--host={}", conn.host))
                .arg(format!("--port={}", conn.port))
                .arg(format!("--username={}", conn.username))
                .arg(format!("--dbname={}", conn.database))
                .arg("-f")
                .arg(input_path)
                .arg("--no-password");
            if let Some(pw) = password.as_deref() {
                cmd.env("PGPASSWORD", pw);
            }
        }
        DbKind::Mysql => {
            cmd.arg("-h")
                .arg(&conn.host)
                .arg("-P")
                .arg(conn.port.to_string())
                .arg("-u")
                .arg(&conn.username)
                .arg(&conn.database);
            if let Some(pw) = password.as_deref() {
                cmd.env("MYSQL_PWD", pw);
            }
            feed_via_stdin = true;
        }
        DbKind::Mongo => {
            // mongorestore consumes the dump directory produced by mongodump.
            cmd.arg(format!(
                "--uri={}",
                build_mongo_uri(conn, password.as_deref())
            ))
            .arg(input_path);
        }
        DbKind::Sqlite => {
            // `sqlite3 <file>` reads SQL from stdin.
            cmd.arg(&conn.database);
            feed_via_stdin = true;
        }
    }

    if feed_via_stdin {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    if feed_via_stdin {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Other("no stdin".into()))?;
        let mut file = tokio::fs::File::open(input_path).await?;
        tokio::io::copy(&mut file, &mut stdin).await?;
        stdin.shutdown().await.ok();
    }

    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let job_id = opts.job_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(
                    &app,
                    &ProgressEvent {
                        job_id: job_id.clone(),
                        phase: "import".into(),
                        table: None,
                        rows_done: None,
                        statements_done: None,
                        message: Some(line),
                    },
                );
            }
        });
    }

    let status = wait_with_cancel(&mut child, cancel).await?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "{} exited with status {}",
            bin.display(),
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        )));
    }
    Ok(ImportSummary {
        statements_executed: 0,
    })
}

async fn wait_with_cancel(
    child: &mut tokio::process::Child,
    cancel: Arc<AtomicBool>,
) -> AppResult<std::process::ExitStatus> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(AppError::Canceled);
        }
        match tokio::time::timeout(std::time::Duration::from_millis(200), child.wait()).await {
            Ok(res) => return Ok(res?),
            Err(_) => continue,
        }
    }
}

// ─── Native engine: export ────────────────────────────────────────────────────

async fn export_native(
    app: &AppHandle,
    handle: EngineHandle,
    opts: &ExportOptions,
    output_path: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ExportSummary> {
    let mut file = tokio::fs::File::create(output_path).await?;
    let header = format!(
        "-- PowaDB native dump\n-- engine: {}\n-- include_schema: {}\n-- include_data: {}\n-- NOTE: native engine emits CREATE TABLE + INSERTs only.\n--       Foreign keys, indexes, sequences, views, and triggers are not included.\n--       Use the Tool engine (pg_dump / mysqldump) for full-fidelity dumps.\n\n",
        handle.kind().as_str(),
        opts.include_schema,
        opts.include_data,
    );
    file.write_all(header.as_bytes()).await?;

    let tables = list_target_tables(&handle, opts).await?;
    let total = tables.len();
    let mut dumped = 0usize;

    for (idx, table) in tables.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Canceled);
        }
        emit_progress(
            app,
            &ProgressEvent {
                job_id: opts.job_id.clone(),
                phase: "table-start".into(),
                table: Some(format!("{}.{}", table.schema, table.table)),
                rows_done: None,
                statements_done: Some(idx as u64),
                message: Some(format!(
                    "({}/{}) {}.{}",
                    idx + 1,
                    total,
                    table.schema,
                    table.table
                )),
            },
        );

        if opts.include_schema {
            let ddl = generate_create_table(&handle, table).await?;
            file.write_all(ddl.as_bytes()).await?;
            file.write_all(b"\n").await?;
        }
        if opts.include_data {
            dump_table_data(&handle, table, &mut file, app, &opts.job_id, cancel.clone()).await?;
        }
        dumped += 1;
    }

    file.flush().await?;
    let bytes = tokio::fs::metadata(output_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(ExportSummary {
        bytes_written: bytes,
        tables_dumped: dumped,
    })
}

async fn list_target_tables(
    handle: &EngineHandle,
    opts: &ExportOptions,
) -> AppResult<Vec<TableRef>> {
    if let Some(tables) = &opts.tables {
        return Ok(tables.clone());
    }
    match require_sql_pool(handle, "list_target_tables")? {
        SqlPoolView::Postgres(pool) => {
            let rows = sqlx::query(
                r#"
                SELECT table_schema::text AS schema, table_name::text AS name
                FROM information_schema.tables
                WHERE table_type = 'BASE TABLE'
                  AND table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| {
                    Some(TableRef {
                        schema: r.try_get("schema").ok()?,
                        table: r.try_get("name").ok()?,
                    })
                })
                .collect())
        }
        SqlPoolView::Mysql(pool) => {
            // CAST AS CHAR — see schema.rs note about information_schema text
            // columns coming back binary-flagged.
            let rows = sqlx::query(
                r#"
                SELECT
                    CAST(table_schema AS CHAR) AS schema_name,
                    CAST(table_name   AS CHAR) AS name
                FROM information_schema.tables
                WHERE table_type = 'BASE TABLE'
                  AND table_schema = DATABASE()
                ORDER BY table_name
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| {
                    Some(TableRef {
                        schema: r.try_get("schema_name").ok()?,
                        table: r.try_get("name").ok()?,
                    })
                })
                .collect())
        }
        SqlPoolView::Sqlite(pool) => {
            let rows = sqlx::query(
                r#"
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                "#,
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .filter_map(|r| {
                    Some(TableRef {
                        schema: "main".into(),
                        table: r.try_get("name").ok()?,
                    })
                })
                .collect())
        }
    }
}

async fn generate_create_table(handle: &EngineHandle, t: &TableRef) -> AppResult<String> {
    match require_sql_pool(handle, "generate_create_table")? {
        SqlPoolView::Postgres(pool) => {
            let cols = sqlx::query(
                r#"
                SELECT
                    column_name::text                  AS name,
                    data_type::text                    AS data_type,
                    is_nullable                        AS nullable,
                    column_default                     AS default_expr,
                    character_maximum_length           AS char_max,
                    numeric_precision                  AS num_prec,
                    numeric_scale                      AS num_scale,
                    udt_name::text                     AS udt
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
                "#,
            )
            .bind(&t.schema)
            .bind(&t.table)
            .fetch_all(pool)
            .await?;

            let pk_cols = sqlx::query(
                r#"
                SELECT kcu.column_name::text AS name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = $1
                  AND tc.table_name = $2
                ORDER BY kcu.ordinal_position
                "#,
            )
            .bind(&t.schema)
            .bind(&t.table)
            .fetch_all(pool)
            .await?;

            let mut lines: Vec<String> = Vec::new();
            for r in cols {
                let name: String = r.try_get("name").unwrap_or_default();
                let data_type: String = r.try_get("data_type").unwrap_or_default();
                let nullable: String = r.try_get("nullable").unwrap_or_else(|_| "YES".into());
                let default_expr: Option<String> = r.try_get("default_expr").ok().flatten();
                let char_max: Option<i32> = r.try_get("char_max").ok().flatten();
                let num_prec: Option<i32> = r.try_get("num_prec").ok().flatten();
                let num_scale: Option<i32> = r.try_get("num_scale").ok().flatten();
                let udt: String = r.try_get("udt").unwrap_or_default();

                let ty = pg_render_type(&data_type, &udt, char_max, num_prec, num_scale);
                let mut line = format!("    \"{}\" {}", name, ty);
                if nullable != "YES" {
                    line.push_str(" NOT NULL");
                }
                if let Some(d) = default_expr {
                    line.push_str(&format!(" DEFAULT {}", d));
                }
                lines.push(line);
            }

            let pk_names: Vec<String> = pk_cols
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("name").ok())
                .collect();
            if !pk_names.is_empty() {
                let cols_q: Vec<String> = pk_names.iter().map(|n| format!("\"{}\"", n)).collect();
                lines.push(format!("    PRIMARY KEY ({})", cols_q.join(", ")));
            }

            Ok(format!(
                "CREATE TABLE \"{}\".\"{}\" (\n{}\n);\n",
                t.schema,
                t.table,
                lines.join(",\n"),
            ))
        }
        SqlPoolView::Mysql(pool) => {
            // CAST AS CHAR — see schema.rs note about information_schema text
            // columns coming back binary-flagged.
            let cols = sqlx::query(
                r#"
                SELECT
                    CAST(column_name    AS CHAR) AS name,
                    CAST(column_type    AS CHAR) AS column_type,
                    CAST(is_nullable    AS CHAR) AS nullable,
                    CAST(column_default AS CHAR) AS default_expr,
                    CAST(extra          AS CHAR) AS extra
                FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = ?
                ORDER BY ordinal_position
                "#,
            )
            .bind(&t.table)
            .fetch_all(pool)
            .await?;

            let pk_cols = sqlx::query(
                r#"
                SELECT CAST(column_name AS CHAR) AS name
                FROM information_schema.key_column_usage
                WHERE constraint_name = 'PRIMARY'
                  AND table_schema = DATABASE()
                  AND table_name = ?
                ORDER BY ordinal_position
                "#,
            )
            .bind(&t.table)
            .fetch_all(pool)
            .await?;

            let mut lines: Vec<String> = Vec::new();
            for r in cols {
                let name: String = r.try_get("name").unwrap_or_default();
                let column_type: String = r.try_get("column_type").unwrap_or_default();
                let nullable: String = r.try_get("nullable").unwrap_or_else(|_| "YES".into());
                let default_expr: Option<String> = r.try_get("default_expr").ok().flatten();
                let extra: String = r.try_get("extra").unwrap_or_default();

                let mut line = format!("    `{}` {}", name, column_type);
                if nullable != "YES" {
                    line.push_str(" NOT NULL");
                }
                if let Some(d) = default_expr {
                    line.push_str(&format!(" DEFAULT {}", d));
                }
                if !extra.is_empty() {
                    line.push(' ');
                    line.push_str(&extra);
                }
                lines.push(line);
            }

            let pk_names: Vec<String> = pk_cols
                .into_iter()
                .filter_map(|r| r.try_get::<String, _>("name").ok())
                .collect();
            if !pk_names.is_empty() {
                let cols_q: Vec<String> = pk_names.iter().map(|n| format!("`{}`", n)).collect();
                lines.push(format!("    PRIMARY KEY ({})", cols_q.join(", ")));
            }

            Ok(format!(
                "CREATE TABLE `{}` (\n{}\n);\n",
                t.table,
                lines.join(",\n"),
            ))
        }
        SqlPoolView::Sqlite(pool) => {
            // SQLite stores the exact CREATE statement; reuse it verbatim.
            let row =
                sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .bind(&t.table)
                    .fetch_optional(pool)
                    .await?;
            let ddl: Option<String> = row.and_then(|r| r.try_get("sql").ok());
            match ddl {
                Some(s) if !s.is_empty() => Ok(format!("{};\n", s)),
                _ => Ok(format!("-- table {} not found\n", t.table)),
            }
        }
    }
}

fn pg_render_type(
    data_type: &str,
    udt: &str,
    char_max: Option<i32>,
    num_prec: Option<i32>,
    num_scale: Option<i32>,
) -> String {
    match data_type {
        "character varying" => match char_max {
            Some(n) => format!("varchar({})", n),
            None => "varchar".into(),
        },
        "character" => match char_max {
            Some(n) => format!("char({})", n),
            None => "char".into(),
        },
        "numeric" => match (num_prec, num_scale) {
            (Some(p), Some(s)) => format!("numeric({},{})", p, s),
            (Some(p), None) => format!("numeric({})", p),
            _ => "numeric".into(),
        },
        "USER-DEFINED" | "ARRAY" => udt.to_string(),
        other => other.to_string(),
    }
}

async fn dump_table_data(
    handle: &EngineHandle,
    t: &TableRef,
    file: &mut tokio::fs::File,
    app: &AppHandle,
    job_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let sql_pg = format!("SELECT * FROM \"{}\".\"{}\"", t.schema, t.table);
    let sql_my = format!("SELECT * FROM `{}`", t.table);
    let sql_lite = format!("SELECT * FROM \"{}\"", t.table.replace('"', "\"\""));

    let result = match require_sql_pool(handle, "dump_table_data")? {
        SqlPoolView::Postgres(pool) => pg_drv::execute(pool, &sql_pg).await?,
        SqlPoolView::Mysql(pool) => mysql_drv::execute(pool, &sql_my).await?,
        SqlPoolView::Sqlite(pool) => sqlite_drv::execute(pool, &sql_lite).await?,
    };

    let kind = handle.kind();

    if result.rows.is_empty() {
        return Ok(());
    }
    let cols_quoted: Vec<String> = result
        .columns
        .iter()
        .map(|c| match kind {
            DbKind::Postgres | DbKind::Sqlite => format!("\"{}\"", c.name),
            DbKind::Mysql => format!("`{}`", c.name),
            DbKind::Mongo => unreachable!("dump_table_data only runs for SQL engines"),
        })
        .collect();
    let table_qualified = match kind {
        DbKind::Postgres => format!("\"{}\".\"{}\"", t.schema, t.table),
        DbKind::Mysql => format!("`{}`", t.table),
        DbKind::Sqlite => format!("\"{}\"", t.table.replace('"', "\"\"")),
        DbKind::Mongo => unreachable!("dump_table_data only runs for SQL engines"),
    };

    let mut rows_done: u64 = 0;
    for chunk in result.rows.chunks(DUMP_CHUNK_SIZE) {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Canceled);
        }
        let mut sql = format!(
            "INSERT INTO {} ({}) VALUES\n",
            table_qualified,
            cols_quoted.join(", ")
        );
        for (i, row) in chunk.iter().enumerate() {
            sql.push_str("    (");
            for (j, value) in row.iter().enumerate() {
                if j > 0 {
                    sql.push_str(", ");
                }
                sql.push_str(&format_sql_literal(
                    value,
                    &result.columns[j].type_name,
                    kind,
                ));
            }
            sql.push(')');
            if i + 1 < chunk.len() {
                sql.push_str(",\n");
            }
        }
        sql.push_str(";\n");
        file.write_all(sql.as_bytes()).await?;

        rows_done += chunk.len() as u64;
        emit_progress(
            app,
            &ProgressEvent {
                job_id: job_id.to_string(),
                phase: "rows".into(),
                table: Some(format!("{}.{}", t.schema, t.table)),
                rows_done: Some(rows_done),
                statements_done: None,
                message: None,
            },
        );
    }
    Ok(())
}

fn format_sql_literal(v: &Value, type_name: &str, kind: DbKind) -> String {
    if v.is_null() {
        return "NULL".into();
    }
    let upper = type_name.to_ascii_uppercase();
    match v {
        Value::Bool(b) => match kind {
            DbKind::Postgres => {
                if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
            DbKind::Mysql | DbKind::Sqlite => {
                if *b {
                    "1".into()
                } else {
                    "0".into()
                }
            }
            DbKind::Mongo => unreachable!("format_sql_literal only runs for SQL engines"),
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            // Bytea/blobs were already encoded as hex literals upstream.
            match (kind, upper.as_str()) {
                (DbKind::Postgres, "BYTEA") => format!("'{}'::bytea", s.replace('\'', "''")),
                (
                    DbKind::Mysql,
                    "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY",
                ) => s.clone(),
                _ => format!("'{}'", s.replace('\'', "''")),
            }
        }
        other => {
            let json = other.to_string();
            let escaped = json.replace('\'', "''");
            match (kind, upper.as_str()) {
                (DbKind::Postgres, "JSONB") => format!("'{}'::jsonb", escaped),
                (DbKind::Postgres, "JSON") => format!("'{}'::json", escaped),
                _ => format!("'{}'", escaped),
            }
        }
    }
}

// ─── Native engine: import ────────────────────────────────────────────────────

async fn import_native(
    app: &AppHandle,
    handle: EngineHandle,
    opts: &ImportOptions,
    input_path: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ImportSummary> {
    let contents = tokio::fs::read_to_string(input_path).await?;
    let statements = split_statements(&contents);

    if statements.iter().any(|s| is_copy_from_stdin(s)) {
        return Err(AppError::Other(
            "this dump uses COPY ... FROM stdin which the native engine cannot replay; \
             use the Tool engine (psql) to import instead"
                .into(),
        ));
    }

    let total = statements.len();
    let mut executed = 0usize;

    macro_rules! check_cancel {
        () => {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Canceled);
            }
        };
    }
    macro_rules! tick {
        () => {
            if executed % 50 == 0 || executed == total {
                emit_progress(
                    app,
                    &ProgressEvent {
                        job_id: opts.job_id.clone(),
                        phase: "import".into(),
                        table: None,
                        rows_done: None,
                        statements_done: Some(executed as u64),
                        message: Some(format!("{}/{} statements", executed, total)),
                    },
                );
            }
        };
    }
    macro_rules! exec_err {
        ($s:expr, $e:expr) => {
            AppError::Other(format!("error in statement:\n{}\n→ {}", $s, $e))
        };
    }

    match require_sql_pool(&handle, "import_native")? {
        SqlPoolView::Postgres(pool) => {
            if opts.single_transaction {
                let mut tx = pool.begin().await?;
                for s in &statements {
                    check_cancel!();
                    sqlx::query(s)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
                tx.commit().await?;
            } else {
                for s in &statements {
                    check_cancel!();
                    sqlx::query(s)
                        .execute(pool)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
            }
        }
        SqlPoolView::Mysql(pool) => {
            if opts.single_transaction {
                let mut tx = pool.begin().await?;
                for s in &statements {
                    check_cancel!();
                    sqlx::query(s)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
                tx.commit().await?;
            } else {
                for s in &statements {
                    check_cancel!();
                    sqlx::query(s)
                        .execute(pool)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
            }
        }
        SqlPoolView::Sqlite(pool) => {
            if opts.single_transaction {
                let mut tx = pool.begin().await?;
                for s in &statements {
                    check_cancel!();
                    sqlx::query(s)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
                tx.commit().await?;
            } else {
                for s in &statements {
                    check_cancel!();
                    sqlx::query(s)
                        .execute(pool)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
            }
        }
    }

    Ok(ImportSummary {
        statements_executed: executed,
    })
}

fn is_copy_from_stdin(stmt: &str) -> bool {
    let s = stmt.to_ascii_uppercase();
    s.trim_start().starts_with("COPY") && s.contains(" FROM ") && s.contains("STDIN")
}

fn split_statements(input: &str) -> Vec<String> {
    enum St {
        Default,
        SingleQ,
        DoubleQ,
        LineComment,
        BlockComment,
        Dollar(String),
    }
    let bytes = input.as_bytes();
    let n = bytes.len();
    let mut out: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    let mut state = St::Default;

    while i < n {
        let c = bytes[i];
        match &state {
            St::Default => match c {
                b'\'' => {
                    state = St::SingleQ;
                    i += 1;
                }
                b'"' => {
                    state = St::DoubleQ;
                    i += 1;
                }
                b'-' if i + 1 < n && bytes[i + 1] == b'-' => {
                    state = St::LineComment;
                    i += 2;
                }
                b'/' if i + 1 < n && bytes[i + 1] == b'*' => {
                    state = St::BlockComment;
                    i += 2;
                }
                b'$' => {
                    if let Some(end) = find_dollar_tag_end(bytes, i) {
                        let tag = std::str::from_utf8(&bytes[i..=end])
                            .unwrap_or("")
                            .to_string();
                        state = St::Dollar(tag);
                        i = end + 1;
                    } else {
                        i += 1;
                    }
                }
                b';' => {
                    let stmt = std::str::from_utf8(&bytes[start..i])
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !stmt.is_empty() {
                        out.push(stmt);
                    }
                    i += 1;
                    start = i;
                }
                _ => i += 1,
            },
            St::SingleQ => {
                if c == b'\'' {
                    if i + 1 < n && bytes[i + 1] == b'\'' {
                        i += 2;
                    } else {
                        state = St::Default;
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            St::DoubleQ => {
                if c == b'"' {
                    if i + 1 < n && bytes[i + 1] == b'"' {
                        i += 2;
                    } else {
                        state = St::Default;
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            St::LineComment => {
                if c == b'\n' {
                    state = St::Default;
                }
                i += 1;
            }
            St::BlockComment => {
                if c == b'*' && i + 1 < n && bytes[i + 1] == b'/' {
                    state = St::Default;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            St::Dollar(tag) => {
                let tag_bytes = tag.as_bytes();
                if c == b'$'
                    && i + tag_bytes.len() <= n
                    && &bytes[i..i + tag_bytes.len()] == tag_bytes
                {
                    i += tag_bytes.len();
                    state = St::Default;
                } else {
                    i += 1;
                }
            }
        }
    }
    let rest = std::str::from_utf8(&bytes[start..n])
        .unwrap_or("")
        .trim()
        .to_string();
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

fn find_dollar_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut j = start + 1;
    while j < bytes.len() {
        let b = bytes[j];
        if b == b'$' {
            return Some(j);
        }
        if !b.is_ascii_alphanumeric() && b != b'_' {
            return None;
        }
        j += 1;
    }
    None
}

fn emit_progress(app: &AppHandle, evt: &ProgressEvent) {
    let _ = app.emit("dump-progress", evt);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ─── is_copy_from_stdin ───────────────────────────────────────────────

    #[test]
    fn copy_from_stdin_matches_canonical_statement() {
        assert!(is_copy_from_stdin("COPY public.t (id, name) FROM stdin;"));
        assert!(is_copy_from_stdin("  copy t from STDIN with (format csv)"));
    }

    #[test]
    fn copy_from_stdin_rejects_unrelated_statements() {
        assert!(!is_copy_from_stdin("INSERT INTO t VALUES (1)"));
        assert!(!is_copy_from_stdin("COPY t TO stdout"));
        assert!(!is_copy_from_stdin("-- COPY t FROM stdin"));
    }

    // ─── split_statements ─────────────────────────────────────────────────

    #[test]
    fn split_returns_empty_for_empty_input() {
        assert!(split_statements("").is_empty());
        assert!(split_statements("   \n  \t  ").is_empty());
    }

    #[test]
    fn split_separates_simple_statements_on_semicolons() {
        let stmts = split_statements("SELECT 1; SELECT 2; SELECT 3;");
        assert_eq!(stmts, vec!["SELECT 1", "SELECT 2", "SELECT 3"]);
    }

    #[test]
    fn split_keeps_trailing_statement_without_semicolon() {
        let stmts = split_statements("SELECT 1; SELECT 2");
        assert_eq!(stmts, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn split_ignores_semicolons_inside_single_quotes() {
        let stmts = split_statements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
        assert_eq!(stmts, vec!["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
    }

    #[test]
    fn split_treats_doubled_single_quote_as_escape() {
        let stmts = split_statements("SELECT 'it''s ok; really'; SELECT 2");
        assert_eq!(stmts, vec!["SELECT 'it''s ok; really'", "SELECT 2"]);
    }

    #[test]
    fn split_ignores_semicolons_inside_double_quoted_identifiers() {
        let stmts = split_statements("SELECT \"col;with;semis\" FROM t; SELECT 2");
        assert_eq!(stmts, vec!["SELECT \"col;with;semis\" FROM t", "SELECT 2"]);
    }

    #[test]
    fn split_treats_doubled_double_quote_as_escape() {
        let stmts = split_statements("SELECT \"a\"\"b;c\" FROM t; SELECT 2");
        assert_eq!(stmts, vec!["SELECT \"a\"\"b;c\" FROM t", "SELECT 2"]);
    }

    #[test]
    fn split_ignores_semicolons_in_line_comments() {
        let stmts = split_statements("SELECT 1; -- a; b;\nSELECT 2;");
        assert_eq!(stmts, vec!["SELECT 1", "-- a; b;\nSELECT 2"]);
    }

    #[test]
    fn split_ignores_semicolons_in_block_comments() {
        let stmts = split_statements("SELECT 1 /* a; b; c */ FROM t; SELECT 2;");
        assert_eq!(stmts, vec!["SELECT 1 /* a; b; c */ FROM t", "SELECT 2"]);
    }

    #[test]
    fn split_respects_dollar_quoted_bodies() {
        let stmts = split_statements(
            "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN; END; $body$ LANGUAGE plpgsql; SELECT 1;",
        );
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].contains("$body$"));
        assert!(stmts[0].contains("BEGIN; END;"));
        assert_eq!(stmts[1], "SELECT 1");
    }

    #[test]
    fn split_supports_unlabeled_dollar_quotes() {
        let stmts = split_statements("DO $$ BEGIN PERFORM 1; END $$; SELECT 2;");
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].contains("PERFORM 1;"));
        assert_eq!(stmts[1], "SELECT 2");
    }

    #[test]
    fn split_treats_bare_dollar_without_closing_tag_as_literal() {
        // `$1 + $2` is a numeric placeholder; not a dollar tag.
        let stmts = split_statements("SELECT $1 + $2 FROM t; SELECT 2");
        assert_eq!(stmts, vec!["SELECT $1 + $2 FROM t", "SELECT 2"]);
    }

    // ─── find_dollar_tag_end ──────────────────────────────────────────────

    #[test]
    fn dollar_tag_end_locates_closing_dollar_for_named_tag() {
        let s = b"$body$ rest";
        assert_eq!(find_dollar_tag_end(s, 0), Some(5));
    }

    #[test]
    fn dollar_tag_end_locates_for_anonymous_tag() {
        let s = b"$$";
        assert_eq!(find_dollar_tag_end(s, 0), Some(1));
    }

    #[test]
    fn dollar_tag_end_returns_none_when_punctuation_breaks_tag() {
        let s = b"$1 + $2";
        assert_eq!(find_dollar_tag_end(s, 0), None);
    }

    #[test]
    fn dollar_tag_end_returns_none_when_tag_never_closes() {
        let s = b"$abc";
        assert_eq!(find_dollar_tag_end(s, 0), None);
    }

    #[test]
    fn dollar_tag_end_accepts_underscores_and_alphanumerics_in_tag() {
        let s = b"$tag_1$";
        assert_eq!(find_dollar_tag_end(s, 0), Some(6));
    }

    // ─── format_sql_literal ───────────────────────────────────────────────

    #[test]
    fn literal_renders_null_for_any_engine() {
        assert_eq!(
            format_sql_literal(&Value::Null, "text", DbKind::Postgres),
            "NULL"
        );
        assert_eq!(
            format_sql_literal(&Value::Null, "INT", DbKind::Mysql),
            "NULL"
        );
        assert_eq!(
            format_sql_literal(&Value::Null, "TEXT", DbKind::Sqlite),
            "NULL"
        );
    }

    #[test]
    fn literal_renders_bool_per_engine() {
        assert_eq!(
            format_sql_literal(&json!(true), "bool", DbKind::Postgres),
            "TRUE"
        );
        assert_eq!(
            format_sql_literal(&json!(false), "bool", DbKind::Postgres),
            "FALSE"
        );
        assert_eq!(
            format_sql_literal(&json!(true), "tinyint", DbKind::Mysql),
            "1"
        );
        assert_eq!(
            format_sql_literal(&json!(false), "tinyint", DbKind::Mysql),
            "0"
        );
        assert_eq!(
            format_sql_literal(&json!(true), "boolean", DbKind::Sqlite),
            "1"
        );
    }

    #[test]
    fn literal_renders_numbers_without_quotes() {
        assert_eq!(
            format_sql_literal(&json!(42), "int", DbKind::Postgres),
            "42"
        );
        assert_eq!(
            format_sql_literal(&json!(-1.5), "numeric", DbKind::Mysql),
            "-1.5"
        );
    }

    #[test]
    fn literal_quotes_strings_and_escapes_single_quote() {
        assert_eq!(
            format_sql_literal(&json!("it's"), "text", DbKind::Postgres),
            "'it''s'"
        );
    }

    #[test]
    fn literal_casts_postgres_bytea_strings() {
        assert_eq!(
            format_sql_literal(&json!("\\x00ff"), "bytea", DbKind::Postgres),
            "'\\x00ff'::bytea"
        );
    }

    #[test]
    fn literal_passes_mysql_blob_strings_through_unchanged() {
        // The driver layer already encodes BLOB values as `X'…'` literals.
        let prebaked = json!("X'00ff'");
        for ty in [
            "BLOB",
            "TINYBLOB",
            "MEDIUMBLOB",
            "LONGBLOB",
            "BINARY",
            "VARBINARY",
        ] {
            assert_eq!(format_sql_literal(&prebaked, ty, DbKind::Mysql), "X'00ff'");
        }
    }

    #[test]
    fn literal_casts_postgres_json_and_jsonb() {
        let v = json!({"a": 1, "b": [2, 3]});
        let pg_json = format_sql_literal(&v, "JSON", DbKind::Postgres);
        let pg_jsonb = format_sql_literal(&v, "jsonb", DbKind::Postgres);
        assert!(pg_json.ends_with("::json"));
        assert!(pg_jsonb.ends_with("::jsonb"));
        // Outer wrapping is single-quoted JSON text.
        assert!(pg_json.starts_with("'{"));
    }

    #[test]
    fn literal_falls_back_to_quoted_json_for_unknown_types() {
        let v = json!([1, 2, 3]);
        let s = format_sql_literal(&v, "unknown_type", DbKind::Sqlite);
        assert_eq!(s, "'[1,2,3]'");
    }

    // ─── pg_render_type ───────────────────────────────────────────────────

    #[test]
    fn pg_type_varchar_uses_char_max_when_present() {
        assert_eq!(
            pg_render_type("character varying", "varchar", Some(255), None, None),
            "varchar(255)"
        );
        assert_eq!(
            pg_render_type("character varying", "varchar", None, None, None),
            "varchar"
        );
    }

    #[test]
    fn pg_type_char_uses_char_max_when_present() {
        assert_eq!(
            pg_render_type("character", "bpchar", Some(10), None, None),
            "char(10)"
        );
        assert_eq!(
            pg_render_type("character", "bpchar", None, None, None),
            "char"
        );
    }

    #[test]
    fn pg_type_numeric_renders_precision_and_scale_variants() {
        assert_eq!(
            pg_render_type("numeric", "numeric", None, Some(10), Some(2)),
            "numeric(10,2)"
        );
        assert_eq!(
            pg_render_type("numeric", "numeric", None, Some(10), None),
            "numeric(10)"
        );
        assert_eq!(
            pg_render_type("numeric", "numeric", None, None, None),
            "numeric"
        );
    }

    #[test]
    fn pg_type_user_defined_and_array_return_the_udt_name() {
        assert_eq!(
            pg_render_type("USER-DEFINED", "my_enum", None, None, None),
            "my_enum"
        );
        assert_eq!(pg_render_type("ARRAY", "_int4", None, None, None), "_int4");
    }

    #[test]
    fn pg_type_passthrough_for_built_in_scalar_types() {
        assert_eq!(
            pg_render_type("integer", "int4", None, None, None),
            "integer"
        );
        assert_eq!(
            pg_render_type("timestamp without time zone", "timestamp", None, None, None),
            "timestamp without time zone"
        );
    }

    // ─── path_to_string ───────────────────────────────────────────────────

    #[test]
    fn path_to_string_round_trips_a_utf8_path() {
        assert_eq!(
            path_to_string(PathBuf::from("/tmp/foo.sql")),
            "/tmp/foo.sql"
        );
    }

    // ─── default_true ─────────────────────────────────────────────────────

    #[test]
    fn default_true_returns_true() {
        assert!(default_true());
    }
}
