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
use crate::drivers::{mysql as mysql_drv, postgres as pg_drv};
use crate::error::{AppError, AppResult};
use crate::pool_registry::PoolHandle;
use crate::storage::{AppSettings, DbKind, SavedConnection};
use crate::AppState;

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
            let (conn, password) = resolve_connection(&state, &connection_id).await?;
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
            let (conn, password) = resolve_connection(&state, &connection_id).await?;
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
    };
    if let Some(p) = override_path.filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let bin = match (kind, tool) {
        (DbKind::Postgres, ToolKind::Dump) => "pg_dump",
        (DbKind::Postgres, ToolKind::Client) => "psql",
        (DbKind::Mysql, ToolKind::Dump) => "mysqldump",
        (DbKind::Mysql, ToolKind::Client) => "mysql",
    };
    which::which(bin).ok()
}

fn path_to_string(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
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
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
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
    handle: PoolHandle,
    opts: &ExportOptions,
    output_path: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<ExportSummary> {
    let mut file = tokio::fs::File::create(output_path).await?;
    let header = format!(
        "-- PowaDB native dump\n-- engine: {}\n-- include_schema: {}\n-- include_data: {}\n-- NOTE: native engine emits CREATE TABLE + INSERTs only.\n--       Foreign keys, indexes, sequences, views, and triggers are not included.\n--       Use the Tool engine (pg_dump / mysqldump) for full-fidelity dumps.\n\n",
        match handle {
            PoolHandle::Postgres(_) => "postgres",
            PoolHandle::MySql(_) => "mysql",
        },
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

async fn list_target_tables(handle: &PoolHandle, opts: &ExportOptions) -> AppResult<Vec<TableRef>> {
    if let Some(tables) = &opts.tables {
        return Ok(tables.clone());
    }
    match handle {
        PoolHandle::Postgres(pool) => {
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
        PoolHandle::MySql(pool) => {
            let rows = sqlx::query(
                r#"
                SELECT table_schema AS schema_name, table_name AS name
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
    }
}

async fn generate_create_table(handle: &PoolHandle, t: &TableRef) -> AppResult<String> {
    match handle {
        PoolHandle::Postgres(pool) => {
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
        PoolHandle::MySql(pool) => {
            let cols = sqlx::query(
                r#"
                SELECT
                    column_name              AS name,
                    column_type              AS column_type,
                    is_nullable              AS nullable,
                    column_default           AS default_expr,
                    extra                    AS extra
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
                SELECT column_name AS name
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
    handle: &PoolHandle,
    t: &TableRef,
    file: &mut tokio::fs::File,
    app: &AppHandle,
    job_id: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let sql_pg = format!("SELECT * FROM \"{}\".\"{}\"", t.schema, t.table);
    let sql_my = format!("SELECT * FROM `{}`", t.table);

    let result = match handle {
        PoolHandle::Postgres(pool) => pg_drv::execute(pool, &sql_pg).await?,
        PoolHandle::MySql(pool) => mysql_drv::execute(pool, &sql_my).await?,
    };

    let kind = match handle {
        PoolHandle::Postgres(_) => DbKind::Postgres,
        PoolHandle::MySql(_) => DbKind::Mysql,
    };

    if result.rows.is_empty() {
        return Ok(());
    }
    let cols_quoted: Vec<String> = result
        .columns
        .iter()
        .map(|c| match kind {
            DbKind::Postgres => format!("\"{}\"", c.name),
            DbKind::Mysql => format!("`{}`", c.name),
        })
        .collect();
    let table_qualified = match kind {
        DbKind::Postgres => format!("\"{}\".\"{}\"", t.schema, t.table),
        DbKind::Mysql => format!("`{}`", t.table),
    };

    let chunk_size = 500usize;
    let mut rows_done: u64 = 0;
    for chunk in result.rows.chunks(chunk_size) {
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
            DbKind::Mysql => {
                if *b {
                    "1".into()
                } else {
                    "0".into()
                }
            }
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
    handle: PoolHandle,
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

    match handle {
        PoolHandle::Postgres(pool) => {
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
                        .execute(&pool)
                        .await
                        .map_err(|e| exec_err!(s, e))?;
                    executed += 1;
                    tick!();
                }
            }
        }
        PoolHandle::MySql(pool) => {
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
                        .execute(&pool)
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
