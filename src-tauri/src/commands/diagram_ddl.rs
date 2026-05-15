use serde::Deserialize;
use tauri::State;

use crate::commands::ddl_util::{quote_ident, quote_table};
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;
use crate::AppState;

#[derive(Debug, Deserialize)]
struct DocColumn {
    name: String,
    #[serde(rename = "dataType")]
    data_type: String,
    nullable: bool,
    #[serde(rename = "isPk")]
    is_pk: bool,
    #[serde(default, rename = "defaultValue")]
    default_value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DocTable {
    #[serde(default)]
    schema: String,
    name: String,
    columns: Vec<DocColumn>,
}

#[derive(Debug, Deserialize)]
struct DocEdge {
    #[serde(default)]
    name: Option<String>,
    source: String,
    target: String,
    #[serde(rename = "sourceColumns")]
    source_columns: Vec<String>,
    #[serde(rename = "targetColumns")]
    target_columns: Vec<String>,
    #[serde(default, rename = "onUpdate")]
    on_update: Option<String>,
    #[serde(default, rename = "onDelete")]
    on_delete: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Doc {
    tables: Vec<DocTable>,
    #[serde(default)]
    edges: Vec<DocEdge>,
}

/// Render full DDL for a diagram document. CREATE TABLE statements come first;
/// for engines that support it, FK constraints are emitted as a separate
/// ALTER TABLE block at the end so the order of table creation doesn't matter.
/// SQLite, which can't ALTER TABLE ADD CONSTRAINT, gets inline FK clauses.
pub fn generate_diagram_ddl(doc_json: &str, kind: DbKind) -> AppResult<String> {
    let doc: Doc = serde_json::from_str(doc_json)
        .map_err(|e| AppError::Other(format!("invalid diagram doc: {e}")))?;

    let mut out = String::new();

    for t in &doc.tables {
        let inline_fks: Vec<&DocEdge> = if matches!(kind, DbKind::Sqlite) {
            doc.edges
                .iter()
                .filter(|e| e.source == t.lookup_id())
                .collect()
        } else {
            Vec::new()
        };
        out.push_str(&render_create_table(t, &inline_fks, &doc.tables, kind));
        out.push('\n');
    }

    if !matches!(kind, DbKind::Sqlite) {
        for e in &doc.edges {
            if let Some(stmt) = render_add_fk(e, &doc.tables, kind) {
                out.push_str(&stmt);
                out.push('\n');
            }
        }
    }

    Ok(out)
}

impl DocTable {
    /// Stable identifier used to match edges back to a table. Frontend uses
    /// `{schema}.{name}` so we mirror it here.
    fn lookup_id(&self) -> String {
        format!("{}.{}", self.schema, self.name)
    }
}

fn render_create_table(
    t: &DocTable,
    inline_fks: &[&DocEdge],
    all: &[DocTable],
    kind: DbKind,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    for c in &t.columns {
        let mut line = format!("    {} {}", quote_ident(&c.name, kind), c.data_type.trim());
        if !c.nullable {
            line.push_str(" NOT NULL");
        }
        if let Some(d) = &c.default_value {
            let d = d.trim();
            if !d.is_empty() {
                line.push_str(&format!(" DEFAULT {}", d));
            }
        }
        lines.push(line);
    }

    let pk_cols: Vec<&str> = t
        .columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.as_str())
        .collect();
    if !pk_cols.is_empty() {
        let quoted: Vec<String> = pk_cols.iter().map(|n| quote_ident(n, kind)).collect();
        lines.push(format!("    PRIMARY KEY ({})", quoted.join(", ")));
    }

    for fk in inline_fks {
        if let Some(target) = all.iter().find(|t2| t2.lookup_id() == fk.target) {
            let src_cols: Vec<String> = fk
                .source_columns
                .iter()
                .map(|c| quote_ident(c, kind))
                .collect();
            let tgt_cols: Vec<String> = fk
                .target_columns
                .iter()
                .map(|c| quote_ident(c, kind))
                .collect();
            let mut line = format!(
                "    FOREIGN KEY ({}) REFERENCES {} ({})",
                src_cols.join(", "),
                quote_table(&target.schema, &target.name, kind),
                tgt_cols.join(", "),
            );
            if let Some(rule) = clean_fk_rule(fk.on_update.as_deref()) {
                line.push_str(&format!(" ON UPDATE {}", rule));
            }
            if let Some(rule) = clean_fk_rule(fk.on_delete.as_deref()) {
                line.push_str(&format!(" ON DELETE {}", rule));
            }
            lines.push(line);
        }
    }

    format!(
        "CREATE TABLE {} (\n{}\n);\n",
        quote_table(&t.schema, &t.name, kind),
        lines.join(",\n"),
    )
}

fn render_add_fk(e: &DocEdge, tables: &[DocTable], kind: DbKind) -> Option<String> {
    let source = tables.iter().find(|t| t.lookup_id() == e.source)?;
    let target = tables.iter().find(|t| t.lookup_id() == e.target)?;
    let constraint = e
        .name
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|n| quote_ident(n, kind))
        .unwrap_or_else(|| {
            quote_ident(
                &format!("fk_{}_{}", source.name, e.source_columns.join("_")),
                kind,
            )
        });
    let src_cols: Vec<String> = e
        .source_columns
        .iter()
        .map(|c| quote_ident(c, kind))
        .collect();
    let tgt_cols: Vec<String> = e
        .target_columns
        .iter()
        .map(|c| quote_ident(c, kind))
        .collect();
    let mut stmt = format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote_table(&source.schema, &source.name, kind),
        constraint,
        src_cols.join(", "),
        quote_table(&target.schema, &target.name, kind),
        tgt_cols.join(", "),
    );
    if let Some(rule) = clean_fk_rule(e.on_update.as_deref()) {
        stmt.push_str(&format!(" ON UPDATE {}", rule));
    }
    if let Some(rule) = clean_fk_rule(e.on_delete.as_deref()) {
        stmt.push_str(&format!(" ON DELETE {}", rule));
    }
    stmt.push(';');
    Some(stmt)
}

fn clean_fk_rule(rule: Option<&str>) -> Option<String> {
    let r = rule?.trim();
    if r.is_empty() || r.eq_ignore_ascii_case("NO ACTION") {
        return None;
    }
    Some(r.to_uppercase())
}

#[tauri::command]
pub async fn generate_diagram_ddl_cmd(
    _state: State<'_, AppState>,
    doc_json: String,
    engine: DbKind,
) -> AppResult<String> {
    generate_diagram_ddl(&doc_json, engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(json: &str) -> String {
        json.to_string()
    }

    #[test]
    fn postgres_emits_create_table_with_pk_and_alter_fk() {
        let json = doc(r#"{
              "version": 1,
              "tables": [
                {"schema":"public","name":"authors","columns":[
                  {"id":"a1","name":"id","dataType":"integer","nullable":false,"isPk":true,"isFk":false,"defaultValue":null},
                  {"id":"a2","name":"name","dataType":"varchar(255)","nullable":false,"isPk":false,"isFk":false,"defaultValue":null}
                ]},
                {"schema":"public","name":"books","columns":[
                  {"id":"b1","name":"id","dataType":"integer","nullable":false,"isPk":true,"isFk":false,"defaultValue":null},
                  {"id":"b2","name":"author_id","dataType":"integer","nullable":false,"isPk":false,"isFk":true,"defaultValue":null}
                ]}
              ],
              "edges": [
                {"id":"fk1","name":"books_author_fk","source":"public.books","target":"public.authors","sourceColumns":["author_id"],"targetColumns":["id"],"onUpdate":null,"onDelete":"CASCADE"}
              ]
            }"#);
        let out = generate_diagram_ddl(&json, DbKind::Postgres).unwrap();
        assert!(out.contains("CREATE TABLE \"public\".\"authors\""));
        assert!(out.contains("CREATE TABLE \"public\".\"books\""));
        assert!(out.contains("PRIMARY KEY (\"id\")"));
        assert!(out.contains(
            "ALTER TABLE \"public\".\"books\" ADD CONSTRAINT \"books_author_fk\" FOREIGN KEY (\"author_id\") REFERENCES \"public\".\"authors\" (\"id\") ON DELETE CASCADE;"
        ));
        let create_pos = out.find("CREATE TABLE").unwrap();
        let alter_pos = out.find("ALTER TABLE").unwrap();
        assert!(create_pos < alter_pos, "ALTER must come after CREATE");
    }

    #[test]
    fn mysql_uses_backticks_and_alter_fk() {
        let json = doc(r#"{
              "version":1,
              "tables":[{"schema":"","name":"t","columns":[
                {"id":"c1","name":"id","dataType":"int","nullable":false,"isPk":true,"isFk":false}
              ]}],
              "edges":[]
            }"#);
        let out = generate_diagram_ddl(&json, DbKind::Mysql).unwrap();
        assert!(out.contains("CREATE TABLE `t`"));
        assert!(out.contains("`id`"));
        assert!(!out.contains("\"id\""));
    }

    #[test]
    fn sqlite_inlines_fks_and_skips_alter() {
        let json = doc(r#"{
              "version":1,
              "tables":[
                {"schema":"main","name":"authors","columns":[
                  {"id":"a1","name":"id","dataType":"INTEGER","nullable":false,"isPk":true,"isFk":false}
                ]},
                {"schema":"main","name":"books","columns":[
                  {"id":"b1","name":"id","dataType":"INTEGER","nullable":false,"isPk":true,"isFk":false},
                  {"id":"b2","name":"author_id","dataType":"INTEGER","nullable":false,"isPk":false,"isFk":true}
                ]}
              ],
              "edges":[
                {"id":"fk1","name":null,"source":"main.books","target":"main.authors","sourceColumns":["author_id"],"targetColumns":["id"],"onDelete":"CASCADE"}
              ]
            }"#);
        let out = generate_diagram_ddl(&json, DbKind::Sqlite).unwrap();
        assert!(out.contains(
            "FOREIGN KEY (\"author_id\") REFERENCES \"authors\" (\"id\") ON DELETE CASCADE"
        ));
        assert!(
            !out.contains("ALTER TABLE"),
            "sqlite must not use ALTER for FKs"
        );
    }

    #[test]
    fn columns_render_nullable_and_default() {
        let json = doc(r#"{
              "version":1,
              "tables":[{"schema":"public","name":"t","columns":[
                {"id":"c1","name":"id","dataType":"integer","nullable":false,"isPk":true,"isFk":false,"defaultValue":null},
                {"id":"c2","name":"created_at","dataType":"timestamp","nullable":true,"isPk":false,"isFk":false,"defaultValue":"now()"}
              ]}],
              "edges":[]
            }"#);
        let out = generate_diagram_ddl(&json, DbKind::Postgres).unwrap();
        assert!(out.contains("\"id\" integer NOT NULL"));
        assert!(out.contains("\"created_at\" timestamp DEFAULT now()"));
    }

    #[test]
    fn rejects_invalid_json() {
        let err = generate_diagram_ddl("not json", DbKind::Postgres).unwrap_err();
        assert!(err.to_string().contains("invalid diagram doc"));
    }
}
