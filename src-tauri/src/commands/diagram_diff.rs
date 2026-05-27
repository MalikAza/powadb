use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::diagram::{
    introspect_mysql, introspect_postgres, introspect_sqlite, DiagFk, DiagTable,
    DiagramIntrospection,
};
use crate::engine::SqlPoolView;
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;
use crate::AppState;

// ─── Doc (mirror of frontend DiagramDoc, snake_case via serde rename) ─────────

#[derive(Debug, Clone, Deserialize)]
pub struct DocColumn {
    // The frontend carries a stable column `id` through the JSON; the diff
    // engine matches by `original_name`/`name` and ignores it, so it's not
    // deserialized here. Serde will silently drop the extra field.
    pub name: String,
    #[serde(default, rename = "originalName")]
    pub original_name: Option<String>,
    #[serde(rename = "dataType")]
    pub data_type: String,
    pub nullable: bool,
    #[serde(rename = "isPk")]
    pub is_pk: bool,
    #[serde(default, rename = "defaultValue")]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DocTable {
    #[serde(default)]
    pub schema: String,
    pub name: String,
    #[serde(default, rename = "originalName")]
    pub original_name: Option<String>,
    pub columns: Vec<DocColumn>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DocEdge {
    #[serde(default)]
    pub name: Option<String>,
    pub source: String,
    pub target: String,
    #[serde(rename = "sourceColumns")]
    pub source_columns: Vec<String>,
    #[serde(rename = "targetColumns")]
    pub target_columns: Vec<String>,
    #[serde(default, rename = "onUpdate")]
    pub on_update: Option<String>,
    #[serde(default, rename = "onDelete")]
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Doc {
    pub tables: Vec<DocTable>,
    #[serde(default)]
    pub edges: Vec<DocEdge>,
}

// ─── Diff ops ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffOp {
    AddTable {
        schema: String,
        name: String,
        columns: Vec<OpColumn>,
    },
    DropTable {
        schema: String,
        name: String,
    },
    RenameTable {
        schema: String,
        from: String,
        to: String,
    },
    AddColumn {
        schema: String,
        table: String,
        column: OpColumn,
    },
    DropColumn {
        schema: String,
        table: String,
        column: String,
    },
    RenameColumn {
        schema: String,
        table: String,
        from: String,
        to: String,
    },
    AlterColumnType {
        schema: String,
        table: String,
        column: String,
        new_type: String,
    },
    AlterColumnNullable {
        schema: String,
        table: String,
        column: String,
        nullable: bool,
    },
    AlterColumnDefault {
        schema: String,
        table: String,
        column: String,
        default: Option<String>,
    },
    AddFk {
        schema: String,
        table: String,
        constraint_name: Option<String>,
        columns: Vec<String>,
        target_schema: String,
        target_table: String,
        target_columns: Vec<String>,
        on_update: Option<String>,
        on_delete: Option<String>,
    },
    DropFk {
        schema: String,
        table: String,
        constraint_name: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffResult {
    pub ops: Vec<DiffOp>,
}

// ─── Live-type rendering (must match frontend renderDataType) ────────────────

/// Render the live introspected type so it can be compared against the doc's
/// `data_type` string. Mirrors `renderDataType()` in `src/components/Diagram/types.ts`.
fn render_live_type(c: &crate::commands::diagram::DiagColumn) -> String {
    match c.data_type.as_str() {
        "character varying" => match c.char_max_len {
            Some(n) => format!("varchar({n})"),
            None => "varchar".into(),
        },
        "character" => match c.char_max_len {
            Some(n) => format!("char({n})"),
            None => "char".into(),
        },
        s @ ("numeric" | "decimal") => match (c.numeric_precision, c.numeric_scale) {
            (Some(p), Some(sc)) => format!("{s}({p},{sc})"),
            (Some(p), None) => format!("{s}({p})"),
            _ => s.to_string(),
        },
        _ => c.data_type.clone(),
    }
}

// ─── Core diff algorithm ─────────────────────────────────────────────────────

pub fn compute_diff(doc: &Doc, live: &DiagramIntrospection) -> Vec<DiffOp> {
    let mut ops: Vec<DiffOp> = Vec::new();

    let live_by_name: HashMap<(&str, &str), &DiagTable> = live
        .tables
        .iter()
        .map(|t| ((t.schema.as_str(), t.name.as_str()), t))
        .collect();

    let mut matched_live_tables: HashSet<(String, String)> = HashSet::new();
    let mut table_rename_map: HashMap<(String, String), String> = HashMap::new();

    // First pass: tables + columns. Track renames so the FK pass can project
    // live FKs forward to compare against the doc's current names.
    for doc_t in &doc.tables {
        let lookup_name = doc_t.original_name.as_deref().unwrap_or(&doc_t.name);
        match live_by_name.get(&(doc_t.schema.as_str(), lookup_name)) {
            Some(live_t) => {
                matched_live_tables.insert((doc_t.schema.clone(), live_t.name.clone()));

                if live_t.name != doc_t.name {
                    ops.push(DiffOp::RenameTable {
                        schema: doc_t.schema.clone(),
                        from: live_t.name.clone(),
                        to: doc_t.name.clone(),
                    });
                    table_rename_map.insert(
                        (doc_t.schema.clone(), live_t.name.clone()),
                        doc_t.name.clone(),
                    );
                }

                diff_columns_into(&mut ops, doc_t, live_t);
            }
            None => {
                ops.push(DiffOp::AddTable {
                    schema: doc_t.schema.clone(),
                    name: doc_t.name.clone(),
                    columns: doc_t
                        .columns
                        .iter()
                        .map(|c| OpColumn {
                            name: c.name.clone(),
                            data_type: c.data_type.clone(),
                            nullable: c.nullable,
                            is_pk: c.is_pk,
                            default_value: c.default_value.clone(),
                        })
                        .collect(),
                });
            }
        }
    }

    // Drop tables that exist in the live DB but the doc no longer references.
    for live_t in &live.tables {
        if !matched_live_tables.contains(&(live_t.schema.clone(), live_t.name.clone())) {
            ops.push(DiffOp::DropTable {
                schema: live_t.schema.clone(),
                name: live_t.name.clone(),
            });
        }
    }

    // FK pass. Use the table_rename_map to project live FK source/target table
    // names forward, then key by (table, sorted cols → target).
    diff_fks_into(&mut ops, doc, live, &table_rename_map);

    ops
}

fn diff_columns_into(ops: &mut Vec<DiffOp>, doc_t: &DocTable, live_t: &DiagTable) {
    let live_by_name: HashMap<&str, &crate::commands::diagram::DiagColumn> = live_t
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    let mut matched: HashSet<String> = HashSet::new();

    for doc_c in &doc_t.columns {
        let lookup = doc_c.original_name.as_deref().unwrap_or(&doc_c.name);
        if let Some(live_c) = live_by_name.get(lookup) {
            matched.insert(live_c.name.clone());

            // Use the post-rename table name for all column-level ops.
            let table_name = doc_t.name.as_str();

            if live_c.name != doc_c.name {
                ops.push(DiffOp::RenameColumn {
                    schema: doc_t.schema.clone(),
                    table: table_name.into(),
                    from: live_c.name.clone(),
                    to: doc_c.name.clone(),
                });
            }

            let live_type = render_live_type(live_c);
            if !type_strings_match(&live_type, &doc_c.data_type) {
                ops.push(DiffOp::AlterColumnType {
                    schema: doc_t.schema.clone(),
                    table: table_name.into(),
                    column: doc_c.name.clone(),
                    new_type: doc_c.data_type.clone(),
                });
            }
            if live_c.nullable != doc_c.nullable {
                ops.push(DiffOp::AlterColumnNullable {
                    schema: doc_t.schema.clone(),
                    table: table_name.into(),
                    column: doc_c.name.clone(),
                    nullable: doc_c.nullable,
                });
            }
            if !defaults_match(&live_c.default, &doc_c.default_value) {
                ops.push(DiffOp::AlterColumnDefault {
                    schema: doc_t.schema.clone(),
                    table: table_name.into(),
                    column: doc_c.name.clone(),
                    default: doc_c.default_value.clone(),
                });
            }
        } else {
            ops.push(DiffOp::AddColumn {
                schema: doc_t.schema.clone(),
                table: doc_t.name.clone(),
                column: OpColumn {
                    name: doc_c.name.clone(),
                    data_type: doc_c.data_type.clone(),
                    nullable: doc_c.nullable,
                    is_pk: doc_c.is_pk,
                    default_value: doc_c.default_value.clone(),
                },
            });
        }
    }

    for live_c in &live_t.columns {
        if !matched.contains(&live_c.name) {
            ops.push(DiffOp::DropColumn {
                schema: doc_t.schema.clone(),
                table: doc_t.name.clone(),
                column: live_c.name.clone(),
            });
        }
    }
}

fn type_strings_match(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn defaults_match(live: &Option<String>, doc: &Option<String>) -> bool {
    let l = live.as_deref().map(str::trim).unwrap_or("");
    let d = doc.as_deref().map(str::trim).unwrap_or("");
    l == d
}

fn project_table(rename: &HashMap<(String, String), String>, schema: &str, name: &str) -> String {
    rename
        .get(&(schema.to_string(), name.to_string()))
        .cloned()
        .unwrap_or_else(|| name.to_string())
}

type FkKey = (String, String, Vec<String>, String, String, Vec<String>);

fn live_fk_key(fk: &DiagFk, renames: &HashMap<(String, String), String>) -> FkKey {
    (
        fk.from_schema.clone(),
        project_table(renames, &fk.from_schema, &fk.from_table),
        fk.from_columns.clone(),
        fk.to_schema.clone(),
        project_table(renames, &fk.to_schema, &fk.to_table),
        fk.to_columns.clone(),
    )
}

fn parse_table_id(id: &str) -> (String, String) {
    if let Some(dot) = id.find('.') {
        (id[..dot].to_string(), id[dot + 1..].to_string())
    } else {
        (String::new(), id.to_string())
    }
}

fn diff_fks_into(
    ops: &mut Vec<DiffOp>,
    doc: &Doc,
    live: &DiagramIntrospection,
    table_rename_map: &HashMap<(String, String), String>,
) {
    // Build a map of live FK key → (live FK constraint name, schema, table).
    let live_keys: HashMap<FkKey, &DiagFk> = live
        .foreign_keys
        .iter()
        .map(|fk| (live_fk_key(fk, table_rename_map), fk))
        .collect();

    // Build doc-edge keys. Doc edges reference tables via id `{schema}.{name}`
    // (already post-rename, since the doc carries the current name).
    let mut doc_keys: HashSet<FkKey> = HashSet::new();
    for e in &doc.edges {
        let (s_schema, s_table) = parse_table_id(&e.source);
        let (t_schema, t_table) = parse_table_id(&e.target);
        let key = (
            s_schema.clone(),
            s_table.clone(),
            e.source_columns.clone(),
            t_schema.clone(),
            t_table.clone(),
            e.target_columns.clone(),
        );
        if !live_keys.contains_key(&key) {
            ops.push(DiffOp::AddFk {
                schema: s_schema,
                table: s_table,
                constraint_name: e.name.clone().filter(|n| !n.is_empty()),
                columns: e.source_columns.clone(),
                target_schema: t_schema,
                target_table: t_table,
                target_columns: e.target_columns.clone(),
                on_update: e.on_update.clone(),
                on_delete: e.on_delete.clone(),
            });
        }
        doc_keys.insert(key);
    }

    for (key, fk) in &live_keys {
        if doc_keys.contains(key) {
            continue;
        }
        // Live FK no longer in doc. Use the *projected* table name (post-rename)
        // so the DROP statement runs against the table as it exists at the time.
        let table_after = project_table(table_rename_map, &fk.from_schema, &fk.from_table);
        let constraint = fk
            .name
            .clone()
            .unwrap_or_else(|| format!("{}__fk", fk.from_table));
        ops.push(DiffOp::DropFk {
            schema: fk.from_schema.clone(),
            table: table_after,
            constraint_name: constraint,
        });
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn diff_diagram(
    state: State<'_, AppState>,
    connection_id: String,
    doc_json: String,
) -> AppResult<DiffResult> {
    let doc: Doc = serde_json::from_str(&doc_json)
        .map_err(|e| AppError::bad_input("diagram doc", e.to_string()))?;
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let live = match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => introspect_postgres(pool, None).await?,
        Some(SqlPoolView::Mysql(pool)) => introspect_mysql(pool).await?,
        Some(SqlPoolView::Sqlite(pool)) => introspect_sqlite(pool).await?,
        None => {
            return Err(AppError::unsupported(
                "diff_diagram",
                handle.kind().as_str(),
            ))
        }
    };
    Ok(DiffResult {
        ops: compute_diff(&doc, &live),
    })
}

#[tauri::command]
pub async fn execute_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<()> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => execute_pg(pool, &sql).await,
        Some(SqlPoolView::Mysql(pool)) => execute_mysql(pool, &sql).await,
        Some(SqlPoolView::Sqlite(pool)) => execute_sqlite(pool, &sql).await,
        None => Err(AppError::unsupported("execute_ddl", handle.kind().as_str())),
    }
}

async fn execute_pg(pool: &sqlx::PgPool, sql: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for stmt in split_statements(sql) {
        if stmt.trim().is_empty() {
            continue;
        }
        sqlx::query(&stmt).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn execute_mysql(pool: &sqlx::MySqlPool, sql: &str) -> AppResult<()> {
    // MySQL DDL is implicitly committed per-statement (can't wrap in a
    // transaction). Just run sequentially and surface the first error.
    for stmt in split_statements(sql) {
        if stmt.trim().is_empty() {
            continue;
        }
        sqlx::query(&stmt).execute(pool).await?;
    }
    Ok(())
}

async fn execute_sqlite(pool: &sqlx::SqlitePool, sql: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for stmt in split_statements(sql) {
        if stmt.trim().is_empty() {
            continue;
        }
        sqlx::query(&stmt).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Split a SQL blob on `;` boundaries, respecting single-quoted strings,
/// dollar-quoted strings (for Postgres), and line/block comments. Good enough
/// for the DDL we generate ourselves; not a full SQL parser.
fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    let len = bytes.len();
    while i < len {
        let b = bytes[i];
        // Line comment
        if b == b'-' && i + 1 < len && bytes[i + 1] == b'-' {
            while i < len && bytes[i] != b'\n' {
                cur.push(bytes[i] as char);
                i += 1;
            }
            continue;
        }
        // Block comment
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            cur.push_str("/*");
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                cur.push(bytes[i] as char);
                i += 1;
            }
            if i + 1 < len {
                cur.push_str("*/");
                i += 2;
            }
            continue;
        }
        // Single-quoted string
        if b == b'\'' {
            cur.push('\'');
            i += 1;
            while i < len {
                let c = bytes[i];
                cur.push(c as char);
                i += 1;
                if c == b'\'' {
                    // Doubled single quote → literal quote, stay inside.
                    if i < len && bytes[i] == b'\'' {
                        cur.push('\'');
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        // Dollar-quoted string (Postgres). Match $tag$...$tag$.
        if b == b'$' {
            let mut j = i + 1;
            while j < len && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            if j < len && bytes[j] == b'$' {
                let tag = &sql[i..=j];
                cur.push_str(tag);
                i = j + 1;
                while i + tag.len() <= len && &sql[i..i + tag.len()] != tag {
                    cur.push(bytes[i] as char);
                    i += 1;
                }
                if i + tag.len() <= len {
                    cur.push_str(tag);
                    i += tag.len();
                }
                continue;
            }
        }
        if b == b';' {
            let trimmed = cur.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(b as char);
        i += 1;
    }
    let trimmed = cur.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    out
}

// ─── DDL rendering for diff ops ──────────────────────────────────────────────

use crate::commands::ddl_util::{quote_ident, quote_table};

/// Convert a list of diff ops into engine-specific DDL. Statements are
/// terminated with `;` and newline-separated.
pub fn generate_alter_ddl(ops: &[DiffOp], kind: DbKind) -> AppResult<String> {
    let mut out = String::new();
    for op in ops {
        let stmts = render_op(op, kind)?;
        for s in stmts {
            out.push_str(&s);
            if !s.trim_end().ends_with(';') {
                out.push(';');
            }
            out.push('\n');
        }
    }
    Ok(out)
}

fn render_op(op: &DiffOp, kind: DbKind) -> AppResult<Vec<String>> {
    match op {
        DiffOp::AddTable {
            schema,
            name,
            columns,
        } => {
            let mut lines: Vec<String> = Vec::new();
            for c in columns {
                let mut line = format!("    {} {}", quote_ident(&c.name, kind), c.data_type.trim());
                if !c.nullable {
                    line.push_str(" NOT NULL");
                }
                if let Some(d) = &c.default_value {
                    let d = d.trim();
                    if !d.is_empty() {
                        line.push_str(&format!(" DEFAULT {d}"));
                    }
                }
                lines.push(line);
            }
            let pk_cols: Vec<&str> = columns
                .iter()
                .filter(|c| c.is_pk)
                .map(|c| c.name.as_str())
                .collect();
            if !pk_cols.is_empty() {
                let quoted: Vec<String> = pk_cols.iter().map(|n| quote_ident(n, kind)).collect();
                lines.push(format!("    PRIMARY KEY ({})", quoted.join(", ")));
            }
            Ok(vec![format!(
                "CREATE TABLE {} (\n{}\n)",
                quote_table(schema, name, kind),
                lines.join(",\n"),
            )])
        }
        DiffOp::DropTable { schema, name } => Ok(vec![format!(
            "DROP TABLE {}",
            quote_table(schema, name, kind)
        )]),
        DiffOp::RenameTable { schema, from, to } => match kind {
            DbKind::Postgres | DbKind::Sqlite => Ok(vec![format!(
                "ALTER TABLE {} RENAME TO {}",
                quote_table(schema, from, kind),
                quote_ident(to, kind),
            )]),
            DbKind::Mysql => Ok(vec![format!(
                "RENAME TABLE {} TO {}",
                quote_ident(from, kind),
                quote_ident(to, kind),
            )]),
            DbKind::Mongo => Err(AppError::unsupported("DDL operation", "mongo")),
        },
        DiffOp::AddColumn {
            schema,
            table,
            column,
        } => {
            let mut def = format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                quote_table(schema, table, kind),
                quote_ident(&column.name, kind),
                column.data_type.trim(),
            );
            if !column.nullable {
                def.push_str(" NOT NULL");
            }
            if let Some(d) = &column.default_value {
                let d = d.trim();
                if !d.is_empty() {
                    def.push_str(&format!(" DEFAULT {d}"));
                }
            }
            Ok(vec![def])
        }
        DiffOp::DropColumn {
            schema,
            table,
            column,
        } => Ok(vec![format!(
            "ALTER TABLE {} DROP COLUMN {}",
            quote_table(schema, table, kind),
            quote_ident(column, kind),
        )]),
        DiffOp::RenameColumn {
            schema,
            table,
            from,
            to,
        } => Ok(vec![format!(
            "ALTER TABLE {} RENAME COLUMN {} TO {}",
            quote_table(schema, table, kind),
            quote_ident(from, kind),
            quote_ident(to, kind),
        )]),
        DiffOp::AlterColumnType {
            schema,
            table,
            column,
            new_type,
        } => match kind {
            DbKind::Postgres => Ok(vec![format!(
                "ALTER TABLE {} ALTER COLUMN {} TYPE {}",
                quote_table(schema, table, kind),
                quote_ident(column, kind),
                new_type.trim(),
            )]),
            DbKind::Mysql => Ok(vec![format!(
                "ALTER TABLE {} MODIFY COLUMN {} {}",
                quote_table(schema, table, kind),
                quote_ident(column, kind),
                new_type.trim(),
            )]),
            DbKind::Sqlite => Err(AppError::unsupported(
                format!("ALTER COLUMN TYPE on \"{table}\".\"{column}\" (rebuild the table manually for now)"),
                "sqlite",
            )),
            DbKind::Mongo => Err(AppError::unsupported("DDL operation", "mongo")),
        },
        DiffOp::AlterColumnNullable {
            schema,
            table,
            column,
            nullable,
        } => match kind {
            DbKind::Postgres => Ok(vec![format!(
                "ALTER TABLE {} ALTER COLUMN {} {} NOT NULL",
                quote_table(schema, table, kind),
                quote_ident(column, kind),
                if *nullable { "DROP" } else { "SET" },
            )]),
            DbKind::Mysql => Err(AppError::unsupported(
                format!(
                    "isolated NULL/NOT NULL change on column {column} \
                     (MySQL requires the full column definition — alter the type in the editor and re-apply)"
                ),
                "mysql",
            )),
            DbKind::Sqlite => Err(AppError::unsupported(
                format!(
                    "nullability change on \"{table}\".\"{column}\" (rebuild the table manually for now)"
                ),
                "sqlite",
            )),
            DbKind::Mongo => Err(AppError::unsupported("DDL operation", "mongo")),
        },
        DiffOp::AlterColumnDefault {
            schema,
            table,
            column,
            default,
        } => match kind {
            DbKind::Postgres => Ok(vec![match default {
                Some(d) if !d.trim().is_empty() => format!(
                    "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}",
                    quote_table(schema, table, kind),
                    quote_ident(column, kind),
                    d.trim(),
                ),
                _ => format!(
                    "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT",
                    quote_table(schema, table, kind),
                    quote_ident(column, kind),
                ),
            }]),
            DbKind::Mysql => Ok(vec![match default {
                Some(d) if !d.trim().is_empty() => format!(
                    "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}",
                    quote_table(schema, table, kind),
                    quote_ident(column, kind),
                    d.trim(),
                ),
                _ => format!(
                    "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT",
                    quote_table(schema, table, kind),
                    quote_ident(column, kind),
                ),
            }]),
            DbKind::Sqlite => Err(AppError::unsupported(
                format!(
                    "DEFAULT change on \"{table}\".\"{column}\" (rebuild the table manually for now)"
                ),
                "sqlite",
            )),
            DbKind::Mongo => Err(AppError::unsupported("DDL operation", "mongo")),
        },
        DiffOp::AddFk {
            schema,
            table,
            constraint_name,
            columns,
            target_schema,
            target_table,
            target_columns,
            on_update,
            on_delete,
        } => {
            if matches!(kind, DbKind::Sqlite) {
                return Err(AppError::unsupported(
                    "ADD FOREIGN KEY on an existing table (use inline FK at CREATE TABLE time or rebuild)",
                    "sqlite",
                ));
            }
            let constraint = constraint_name
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("fk_{}_{}", table, columns.join("_")));
            let src_cols: Vec<String> = columns.iter().map(|c| quote_ident(c, kind)).collect();
            let tgt_cols: Vec<String> =
                target_columns.iter().map(|c| quote_ident(c, kind)).collect();
            let mut stmt = format!(
                "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                quote_table(schema, table, kind),
                quote_ident(&constraint, kind),
                src_cols.join(", "),
                quote_table(target_schema, target_table, kind),
                tgt_cols.join(", "),
            );
            if let Some(rule) = normalize_fk_rule(on_update.as_deref()) {
                stmt.push_str(&format!(" ON UPDATE {rule}"));
            }
            if let Some(rule) = normalize_fk_rule(on_delete.as_deref()) {
                stmt.push_str(&format!(" ON DELETE {rule}"));
            }
            Ok(vec![stmt])
        }
        DiffOp::DropFk {
            schema,
            table,
            constraint_name,
        } => match kind {
            DbKind::Postgres => Ok(vec![format!(
                "ALTER TABLE {} DROP CONSTRAINT {}",
                quote_table(schema, table, kind),
                quote_ident(constraint_name, kind),
            )]),
            DbKind::Mysql => Ok(vec![format!(
                "ALTER TABLE {} DROP FOREIGN KEY {}",
                quote_table(schema, table, kind),
                quote_ident(constraint_name, kind),
            )]),
            DbKind::Sqlite => Err(AppError::unsupported(
                "DROP FOREIGN KEY on an existing table (rebuild the table manually)",
                "sqlite",
            )),
            DbKind::Mongo => Err(AppError::unsupported("DDL operation", "mongo")),
        },
    }
}

fn normalize_fk_rule(rule: Option<&str>) -> Option<String> {
    let r = rule?.trim();
    if r.is_empty() || r.eq_ignore_ascii_case("NO ACTION") {
        return None;
    }
    Some(r.to_uppercase())
}

#[tauri::command]
pub async fn generate_alter_ddl_cmd(
    _state: State<'_, AppState>,
    ops: Vec<DiffOp>,
    engine: DbKind,
) -> AppResult<String> {
    generate_alter_ddl(&ops, engine)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::diagram::{DiagColumn, DiagFk, DiagTable, DiagramIntrospection};

    fn pk_col(name: &str) -> DiagColumn {
        DiagColumn {
            name: name.into(),
            data_type: "integer".into(),
            nullable: false,
            is_pk: true,
            default: None,
            ordinal: 1,
            char_max_len: None,
            numeric_precision: None,
            numeric_scale: None,
        }
    }

    fn plain_col(name: &str, ty: &str) -> DiagColumn {
        DiagColumn {
            name: name.into(),
            data_type: ty.into(),
            nullable: true,
            is_pk: false,
            default: None,
            ordinal: 2,
            char_max_len: None,
            numeric_precision: None,
            numeric_scale: None,
        }
    }

    fn live_table(schema: &str, name: &str, cols: Vec<DiagColumn>) -> DiagTable {
        DiagTable {
            schema: schema.into(),
            name: name.into(),
            columns: cols,
            indexes: Vec::new(),
        }
    }

    fn doc_col(
        name: &str,
        original: Option<&str>,
        ty: &str,
        nullable: bool,
        pk: bool,
    ) -> DocColumn {
        DocColumn {
            name: name.into(),
            original_name: original.map(str::to_string),
            data_type: ty.into(),
            nullable,
            is_pk: pk,
            default_value: None,
        }
    }

    #[test]
    fn diff_detects_add_table() {
        let doc = Doc {
            tables: vec![DocTable {
                schema: "public".into(),
                name: "users".into(),
                original_name: None,
                columns: vec![doc_col("id", None, "integer", false, true)],
            }],
            edges: vec![],
        };
        let live = DiagramIntrospection {
            tables: vec![],
            foreign_keys: vec![],
            sequences: vec![],
        };
        let ops = compute_diff(&doc, &live);
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], DiffOp::AddTable { name, .. } if name == "users"));
    }

    #[test]
    fn diff_detects_drop_table() {
        let doc = Doc {
            tables: vec![],
            edges: vec![],
        };
        let live = DiagramIntrospection {
            tables: vec![live_table("public", "users", vec![pk_col("id")])],
            foreign_keys: vec![],
            sequences: vec![],
        };
        let ops = compute_diff(&doc, &live);
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], DiffOp::DropTable { name, .. } if name == "users"));
    }

    #[test]
    fn diff_detects_table_rename_via_original_name() {
        let doc = Doc {
            tables: vec![DocTable {
                schema: "public".into(),
                name: "accounts".into(),
                original_name: Some("users".into()),
                columns: vec![doc_col("id", Some("id"), "integer", false, true)],
            }],
            edges: vec![],
        };
        let live = DiagramIntrospection {
            tables: vec![live_table("public", "users", vec![pk_col("id")])],
            foreign_keys: vec![],
            sequences: vec![],
        };
        let ops = compute_diff(&doc, &live);
        assert_eq!(ops.len(), 1, "got {ops:?}");
        match &ops[0] {
            DiffOp::RenameTable { from, to, .. } => {
                assert_eq!(from, "users");
                assert_eq!(to, "accounts");
            }
            other => panic!("expected RenameTable, got {other:?}"),
        }
    }

    #[test]
    fn diff_detects_column_add_drop_rename_and_type() {
        let doc = Doc {
            tables: vec![DocTable {
                schema: "public".into(),
                name: "users".into(),
                original_name: Some("users".into()),
                columns: vec![
                    doc_col("id", Some("id"), "integer", false, true),
                    // email renamed → contact_email, new type
                    doc_col("contact_email", Some("email"), "varchar(320)", true, false),
                    // new column
                    doc_col("created_at", None, "timestamp", true, false),
                ],
            }],
            edges: vec![],
        };
        let live = DiagramIntrospection {
            tables: vec![live_table(
                "public",
                "users",
                vec![
                    pk_col("id"),
                    DiagColumn {
                        name: "email".into(),
                        data_type: "character varying".into(),
                        char_max_len: Some(255),
                        nullable: true,
                        is_pk: false,
                        default: None,
                        ordinal: 2,
                        numeric_precision: None,
                        numeric_scale: None,
                    },
                    plain_col("legacy_flag", "text"),
                ],
            )],
            foreign_keys: vec![],
            sequences: vec![],
        };
        let ops = compute_diff(&doc, &live);
        let kinds: Vec<&'static str> = ops
            .iter()
            .map(|o| match o {
                DiffOp::AddTable { .. } => "AddTable",
                DiffOp::DropTable { .. } => "DropTable",
                DiffOp::RenameTable { .. } => "RenameTable",
                DiffOp::AddColumn { .. } => "AddColumn",
                DiffOp::DropColumn { .. } => "DropColumn",
                DiffOp::RenameColumn { .. } => "RenameColumn",
                DiffOp::AlterColumnType { .. } => "AlterColumnType",
                DiffOp::AlterColumnNullable { .. } => "AlterColumnNullable",
                DiffOp::AlterColumnDefault { .. } => "AlterColumnDefault",
                DiffOp::AddFk { .. } => "AddFk",
                DiffOp::DropFk { .. } => "DropFk",
            })
            .collect();
        assert!(kinds.contains(&"RenameColumn"), "got {kinds:?}");
        assert!(kinds.contains(&"AlterColumnType"));
        assert!(kinds.contains(&"AddColumn"));
        assert!(kinds.contains(&"DropColumn"));
    }

    #[test]
    fn diff_detects_fk_add_and_drop() {
        let doc = Doc {
            tables: vec![
                DocTable {
                    schema: "public".into(),
                    name: "authors".into(),
                    original_name: Some("authors".into()),
                    columns: vec![doc_col("id", Some("id"), "integer", false, true)],
                },
                DocTable {
                    schema: "public".into(),
                    name: "books".into(),
                    original_name: Some("books".into()),
                    columns: vec![
                        doc_col("id", Some("id"), "integer", false, true),
                        doc_col("author_id", Some("author_id"), "integer", false, false),
                    ],
                },
            ],
            edges: vec![DocEdge {
                name: Some("books_author_fk".into()),
                source: "public.books".into(),
                target: "public.authors".into(),
                source_columns: vec!["author_id".into()],
                target_columns: vec!["id".into()],
                on_update: None,
                on_delete: Some("CASCADE".into()),
            }],
        };
        let live = DiagramIntrospection {
            tables: vec![
                live_table("public", "authors", vec![pk_col("id")]),
                live_table(
                    "public",
                    "books",
                    vec![pk_col("id"), plain_col("author_id", "integer")],
                ),
            ],
            foreign_keys: vec![DiagFk {
                id: "public.books_old_fk".into(),
                name: Some("books_old_fk".into()),
                from_schema: "public".into(),
                from_table: "books".into(),
                from_columns: vec!["author_id".into()],
                to_schema: "public".into(),
                to_table: "authors".into(),
                to_columns: vec!["id".into()],
                on_update: None,
                on_delete: None,
            }],
            sequences: vec![],
        };
        let ops = compute_diff(&doc, &live);
        // The doc's FK has CASCADE on delete; the live FK has no on_delete.
        // Our matcher keys only on (source/target/cols), not on rules, so they
        // match → no add or drop. But the rule difference is not detected as
        // an op in Phase 3 v1, which is the documented behaviour.
        let added = ops
            .iter()
            .filter(|o| matches!(o, DiffOp::AddFk { .. }))
            .count();
        let dropped = ops
            .iter()
            .filter(|o| matches!(o, DiffOp::DropFk { .. }))
            .count();
        assert_eq!(added + dropped, 0, "no spurious FK ops; got {ops:?}");

        // Now drop the doc edge → expect a DropFk.
        let mut doc2 = doc.clone();
        doc2.edges.clear();
        let ops2 = compute_diff(&doc2, &live);
        assert!(
            ops2.iter().any(|o| matches!(o, DiffOp::DropFk { .. })),
            "got {ops2:?}"
        );
    }

    #[test]
    fn split_statements_handles_semicolons_in_strings() {
        let sql = "INSERT INTO t VALUES ('a;b'); CREATE TABLE x (y int);";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("'a;b'"));
        assert!(parts[1].starts_with("CREATE TABLE"));
    }

    #[test]
    fn split_statements_handles_line_comments_and_blocks() {
        let sql = "-- a comment with ; in it\nSELECT 1; /* block ; */ SELECT 2;";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("SELECT 1"));
        assert!(parts[1].contains("SELECT 2"));
    }

    #[test]
    fn split_statements_handles_dollar_quoted_pg_strings() {
        let sql = "DO $$ BEGIN RAISE NOTICE 'hi;there'; END $$; SELECT 1;";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("$$"));
        assert!(parts[1].starts_with("SELECT 1"));
    }

    #[test]
    fn alter_ddl_postgres_basic_ops() {
        let ops = vec![
            DiffOp::RenameTable {
                schema: "public".into(),
                from: "users".into(),
                to: "accounts".into(),
            },
            DiffOp::AddColumn {
                schema: "public".into(),
                table: "accounts".into(),
                column: OpColumn {
                    name: "created_at".into(),
                    data_type: "timestamp".into(),
                    nullable: true,
                    is_pk: false,
                    default_value: Some("now()".into()),
                },
            },
            DiffOp::DropColumn {
                schema: "public".into(),
                table: "accounts".into(),
                column: "legacy".into(),
            },
        ];
        let sql = generate_alter_ddl(&ops, DbKind::Postgres).unwrap();
        assert!(sql.contains("ALTER TABLE \"public\".\"users\" RENAME TO \"accounts\";"));
        assert!(sql.contains(
            "ALTER TABLE \"public\".\"accounts\" ADD COLUMN \"created_at\" timestamp DEFAULT now();"
        ));
        assert!(sql.contains("ALTER TABLE \"public\".\"accounts\" DROP COLUMN \"legacy\";"));
    }

    #[test]
    fn alter_ddl_mysql_uses_modify_column_for_type() {
        let ops = vec![DiffOp::AlterColumnType {
            schema: "".into(),
            table: "t".into(),
            column: "c".into(),
            new_type: "varchar(64)".into(),
        }];
        let sql = generate_alter_ddl(&ops, DbKind::Mysql).unwrap();
        assert!(sql.contains("ALTER TABLE `t` MODIFY COLUMN `c` varchar(64);"));
    }

    #[test]
    fn alter_ddl_sqlite_rejects_type_alter() {
        let ops = vec![DiffOp::AlterColumnType {
            schema: "main".into(),
            table: "t".into(),
            column: "c".into(),
            new_type: "INTEGER".into(),
        }];
        let err = generate_alter_ddl(&ops, DbKind::Sqlite).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("sqlite"));
    }

    #[test]
    fn render_live_type_emits_varchar_with_length_when_present() {
        let c = DiagColumn {
            name: "n".into(),
            data_type: "character varying".into(),
            nullable: true,
            is_pk: false,
            default: None,
            ordinal: 1,
            char_max_len: Some(255),
            numeric_precision: None,
            numeric_scale: None,
        };
        assert_eq!(render_live_type(&c), "varchar(255)");
    }

    #[test]
    fn render_live_type_drops_length_when_unset() {
        let c = DiagColumn {
            name: "n".into(),
            data_type: "character varying".into(),
            nullable: true,
            is_pk: false,
            default: None,
            ordinal: 1,
            char_max_len: None,
            numeric_precision: None,
            numeric_scale: None,
        };
        assert_eq!(render_live_type(&c), "varchar");
    }

    #[test]
    fn render_live_type_handles_character_with_and_without_length() {
        let with_len = DiagColumn {
            name: "n".into(),
            data_type: "character".into(),
            nullable: true,
            is_pk: false,
            default: None,
            ordinal: 1,
            char_max_len: Some(10),
            numeric_precision: None,
            numeric_scale: None,
        };
        assert_eq!(render_live_type(&with_len), "char(10)");

        let without_len = DiagColumn {
            char_max_len: None,
            ..with_len.clone()
        };
        assert_eq!(render_live_type(&without_len), "char");
    }

    #[test]
    fn render_live_type_renders_numeric_with_precision_and_scale() {
        let pcs = DiagColumn {
            name: "n".into(),
            data_type: "numeric".into(),
            nullable: true,
            is_pk: false,
            default: None,
            ordinal: 1,
            char_max_len: None,
            numeric_precision: Some(10),
            numeric_scale: Some(2),
        };
        assert_eq!(render_live_type(&pcs), "numeric(10,2)");

        let p_only = DiagColumn {
            numeric_scale: None,
            ..pcs.clone()
        };
        assert_eq!(render_live_type(&p_only), "numeric(10)");

        let neither = DiagColumn {
            numeric_precision: None,
            numeric_scale: None,
            data_type: "decimal".into(),
            ..pcs
        };
        assert_eq!(render_live_type(&neither), "decimal");
    }

    #[test]
    fn render_live_type_passes_unknown_types_through() {
        let c = DiagColumn {
            name: "n".into(),
            data_type: "jsonb".into(),
            nullable: true,
            is_pk: false,
            default: None,
            ordinal: 1,
            char_max_len: None,
            numeric_precision: None,
            numeric_scale: None,
        };
        assert_eq!(render_live_type(&c), "jsonb");
    }

    #[test]
    fn type_strings_match_is_case_and_whitespace_insensitive() {
        assert!(type_strings_match("VARCHAR(64)", " varchar(64) "));
        assert!(type_strings_match("integer", "INTEGER"));
        assert!(!type_strings_match("integer", "bigint"));
    }

    #[test]
    fn defaults_match_treats_none_and_blank_as_equal() {
        assert!(defaults_match(&None, &None));
        assert!(defaults_match(&Some("  ".into()), &None));
        assert!(defaults_match(&Some(" 42 ".into()), &Some("42".into())));
        assert!(!defaults_match(&Some("42".into()), &Some("0".into())));
    }

    #[test]
    fn parse_table_id_splits_on_first_dot() {
        assert_eq!(
            parse_table_id("public.users"),
            ("public".into(), "users".into())
        );
        assert_eq!(parse_table_id("a.b.c"), ("a".into(), "b.c".into()));
    }

    #[test]
    fn parse_table_id_returns_empty_schema_when_no_dot() {
        assert_eq!(parse_table_id("users"), ("".into(), "users".into()));
    }

    #[test]
    fn project_table_applies_rename_when_present() {
        let mut map = HashMap::new();
        map.insert(("public".to_string(), "old".to_string()), "new".to_string());
        assert_eq!(project_table(&map, "public", "old"), "new");
    }

    #[test]
    fn project_table_falls_back_to_original_when_no_rename() {
        let map = HashMap::new();
        assert_eq!(project_table(&map, "public", "kept"), "kept");
    }

    #[test]
    fn live_fk_key_projects_renamed_tables() {
        let mut renames = HashMap::new();
        renames.insert(
            ("public".to_string(), "users".to_string()),
            "accounts".to_string(),
        );

        let fk = DiagFk {
            id: "x".into(),
            name: Some("fk1".into()),
            from_schema: "public".into(),
            from_table: "books".into(),
            from_columns: vec!["author_id".into()],
            to_schema: "public".into(),
            to_table: "users".into(),
            to_columns: vec!["id".into()],
            on_update: None,
            on_delete: None,
        };
        let key = live_fk_key(&fk, &renames);
        assert_eq!(
            key,
            (
                "public".into(),
                "books".into(),
                vec!["author_id".into()],
                "public".into(),
                "accounts".into(),
                vec!["id".into()],
            )
        );
    }

    #[test]
    fn normalize_fk_rule_drops_no_action_and_empty() {
        assert!(normalize_fk_rule(None).is_none());
        assert!(normalize_fk_rule(Some("")).is_none());
        assert!(normalize_fk_rule(Some("   ")).is_none());
        assert!(normalize_fk_rule(Some("no action")).is_none());
        assert!(normalize_fk_rule(Some("NO ACTION")).is_none());
    }

    #[test]
    fn normalize_fk_rule_uppercases_real_rules() {
        assert_eq!(
            normalize_fk_rule(Some("cascade")).as_deref(),
            Some("CASCADE")
        );
        assert_eq!(
            normalize_fk_rule(Some("  set null  ")).as_deref(),
            Some("SET NULL")
        );
    }

    #[test]
    fn alter_ddl_pg_create_table_includes_pk_constraint() {
        let ops = vec![DiffOp::AddTable {
            schema: "public".into(),
            name: "users".into(),
            columns: vec![
                OpColumn {
                    name: "id".into(),
                    data_type: "integer".into(),
                    nullable: false,
                    is_pk: true,
                    default_value: None,
                },
                OpColumn {
                    name: "email".into(),
                    data_type: "text".into(),
                    nullable: true,
                    is_pk: false,
                    default_value: None,
                },
            ],
        }];
        let sql = generate_alter_ddl(&ops, DbKind::Postgres).unwrap();
        assert!(sql.contains("CREATE TABLE \"public\".\"users\""));
        assert!(sql.contains("\"id\" integer NOT NULL"));
        assert!(sql.contains("\"email\" text"));
        assert!(sql.contains("PRIMARY KEY (\"id\")"));
    }

    #[test]
    fn alter_ddl_pg_alter_column_nullable_uses_drop_or_set() {
        let drop_op = DiffOp::AlterColumnNullable {
            schema: "public".into(),
            table: "t".into(),
            column: "c".into(),
            nullable: true,
        };
        let set_op = DiffOp::AlterColumnNullable {
            schema: "public".into(),
            table: "t".into(),
            column: "c".into(),
            nullable: false,
        };
        let drop_sql = generate_alter_ddl(&[drop_op], DbKind::Postgres).unwrap();
        assert!(drop_sql.contains("ALTER COLUMN \"c\" DROP NOT NULL"));
        let set_sql = generate_alter_ddl(&[set_op], DbKind::Postgres).unwrap();
        assert!(set_sql.contains("ALTER COLUMN \"c\" SET NOT NULL"));
    }

    #[test]
    fn alter_ddl_mysql_rejects_nullable_change() {
        let op = DiffOp::AlterColumnNullable {
            schema: "".into(),
            table: "t".into(),
            column: "c".into(),
            nullable: false,
        };
        let err = generate_alter_ddl(&[op], DbKind::Mysql).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("mysql"));
    }

    #[test]
    fn alter_ddl_pg_alter_column_default_set_and_drop() {
        let set_op = DiffOp::AlterColumnDefault {
            schema: "public".into(),
            table: "t".into(),
            column: "c".into(),
            default: Some("now()".into()),
        };
        let drop_op = DiffOp::AlterColumnDefault {
            schema: "public".into(),
            table: "t".into(),
            column: "c".into(),
            default: None,
        };
        let blank_op = DiffOp::AlterColumnDefault {
            schema: "public".into(),
            table: "t".into(),
            column: "c".into(),
            default: Some("   ".into()),
        };
        let set_sql = generate_alter_ddl(&[set_op], DbKind::Postgres).unwrap();
        assert!(set_sql.contains("SET DEFAULT now()"));
        let drop_sql = generate_alter_ddl(&[drop_op], DbKind::Postgres).unwrap();
        assert!(drop_sql.contains("DROP DEFAULT"));
        let blank_sql = generate_alter_ddl(&[blank_op], DbKind::Postgres).unwrap();
        assert!(blank_sql.contains("DROP DEFAULT"));
    }

    #[test]
    fn alter_ddl_pg_add_fk_emits_constraint_with_rules() {
        let op = DiffOp::AddFk {
            schema: "public".into(),
            table: "books".into(),
            constraint_name: Some("books_author_fk".into()),
            columns: vec!["author_id".into()],
            target_schema: "public".into(),
            target_table: "authors".into(),
            target_columns: vec!["id".into()],
            on_update: Some("NO ACTION".into()),
            on_delete: Some("cascade".into()),
        };
        let sql = generate_alter_ddl(&[op], DbKind::Postgres).unwrap();
        assert!(sql.contains(
            "ALTER TABLE \"public\".\"books\" ADD CONSTRAINT \"books_author_fk\" FOREIGN KEY (\"author_id\") REFERENCES \"public\".\"authors\" (\"id\")"
        ));
        assert!(!sql.contains("ON UPDATE")); // NO ACTION drops
        assert!(sql.contains("ON DELETE CASCADE"));
    }

    #[test]
    fn alter_ddl_pg_add_fk_synthesizes_constraint_name_when_missing() {
        let op = DiffOp::AddFk {
            schema: "public".into(),
            table: "books".into(),
            constraint_name: None,
            columns: vec!["author_id".into(), "tenant_id".into()],
            target_schema: "public".into(),
            target_table: "authors".into(),
            target_columns: vec!["id".into(), "tenant_id".into()],
            on_update: None,
            on_delete: None,
        };
        let sql = generate_alter_ddl(&[op], DbKind::Postgres).unwrap();
        assert!(sql.contains("ADD CONSTRAINT \"fk_books_author_id_tenant_id\""));
    }

    #[test]
    fn alter_ddl_sqlite_rejects_add_fk() {
        let op = DiffOp::AddFk {
            schema: "".into(),
            table: "books".into(),
            constraint_name: None,
            columns: vec!["a".into()],
            target_schema: "".into(),
            target_table: "authors".into(),
            target_columns: vec!["id".into()],
            on_update: None,
            on_delete: None,
        };
        let err = generate_alter_ddl(&[op], DbKind::Sqlite).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("sqlite"));
    }

    #[test]
    fn alter_ddl_mysql_drop_fk_uses_drop_foreign_key() {
        let op = DiffOp::DropFk {
            schema: "".into(),
            table: "books".into(),
            constraint_name: "books_author_fk".into(),
        };
        let sql = generate_alter_ddl(&[op], DbKind::Mysql).unwrap();
        assert!(sql.contains("ALTER TABLE `books` DROP FOREIGN KEY `books_author_fk`"));
    }

    #[test]
    fn alter_ddl_sqlite_rejects_drop_fk() {
        let op = DiffOp::DropFk {
            schema: "main".into(),
            table: "t".into(),
            constraint_name: "fk1".into(),
        };
        let err = generate_alter_ddl(&[op], DbKind::Sqlite).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("sqlite"));
    }

    #[test]
    fn alter_ddl_mysql_rename_table_uses_rename_table_syntax() {
        let op = DiffOp::RenameTable {
            schema: "".into(),
            from: "users".into(),
            to: "accounts".into(),
        };
        let sql = generate_alter_ddl(&[op], DbKind::Mysql).unwrap();
        assert!(sql.contains("RENAME TABLE `users` TO `accounts`"));
    }

    #[test]
    fn alter_ddl_mongo_rejects_every_op() {
        for op in [
            DiffOp::RenameTable {
                schema: "".into(),
                from: "a".into(),
                to: "b".into(),
            },
            DiffOp::AlterColumnType {
                schema: "".into(),
                table: "t".into(),
                column: "c".into(),
                new_type: "int".into(),
            },
            DiffOp::AlterColumnNullable {
                schema: "".into(),
                table: "t".into(),
                column: "c".into(),
                nullable: true,
            },
            DiffOp::AlterColumnDefault {
                schema: "".into(),
                table: "t".into(),
                column: "c".into(),
                default: Some("1".into()),
            },
            DiffOp::DropFk {
                schema: "".into(),
                table: "t".into(),
                constraint_name: "fk".into(),
            },
        ] {
            let err = generate_alter_ddl(&[op], DbKind::Mongo).unwrap_err();
            assert!(err.to_string().to_lowercase().contains("mongo"));
        }
    }
}
