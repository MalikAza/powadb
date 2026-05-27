use serde::Deserialize;
use tauri::State;

use crate::commands::ddl_util::{quote_ident, quote_table, validate_ident_chars};
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;
use crate::AppState;

// ─── Input validators ─────────────────────────────────────────────────────────
//
// These guard the three free-text fields the frontend ships through (and that
// also flow in via the diagram import path in `ImportDialog.tsx`, which
// bypasses any UI-level validation). The fields are interpolated raw into
// DDL — DDL can't be parameterized — so the only defense against injection
// from an imported diagram JSON is to refuse anything that doesn't match the
// canonical shape.

/// Canonical SQL FK referential actions. Anything outside this set is
/// rejected. Case-insensitive on input; normalized to uppercase.
const FK_ACTIONS: &[&str] = &[
    "CASCADE",
    "RESTRICT",
    "SET NULL",
    "SET DEFAULT",
    "NO ACTION",
];

/// Validate a column data type. Permits the shapes the diagram editor and
/// the SQL importer can produce — identifiers, optional length/precision in
/// parens, optional array brackets, and multi-word types (`timestamp with
/// time zone`). Rejects anything else (semicolons, comments, quotes…).
fn validate_data_type(raw: &str) -> AppResult<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(AppError::bad_input("data_type", "empty"));
    }
    let bytes = s.as_bytes();
    if !bytes[0].is_ascii_alphabetic() && bytes[0] != b'_' {
        return Err(AppError::bad_input(
            "data_type",
            format!("must start with a letter or underscore: {s:?}"),
        ));
    }
    for &b in bytes {
        let ok = b.is_ascii_alphanumeric()
            || matches!(b, b'_' | b' ' | b'(' | b')' | b',' | b'[' | b']');
        if !ok {
            return Err(AppError::bad_input(
                "data_type",
                format!("disallowed character {:?} in {s:?}", b as char),
            ));
        }
    }
    // Defense in depth: the char set above already rules out `--`, `/*`, `*/`,
    // but reject them explicitly so a future widening of the allowed chars
    // doesn't silently re-introduce SQL-comment injection.
    if s.contains("--") || s.contains("/*") || s.contains("*/") {
        return Err(AppError::bad_input(
            "data_type",
            "must not contain SQL comment markers",
        ));
    }
    Ok(s.to_string())
}

/// Validate a column DEFAULT expression. Accepts the forms the diagram
/// editor produces today: `NULL`, numeric literal, `TRUE`/`FALSE`, a
/// single-quoted string with `''`-escaped internal quotes, a bare
/// identifier (for constants like `CURRENT_TIMESTAMP`), or a function
/// call whose only arguments are numeric literals or single-quoted
/// strings (for `now()`, `gen_random_uuid()`, `nextval('seq_name')`).
fn validate_default_value(raw: &str) -> AppResult<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(AppError::bad_input("default_value", "empty"));
    }

    if s.eq_ignore_ascii_case("NULL")
        || s.eq_ignore_ascii_case("TRUE")
        || s.eq_ignore_ascii_case("FALSE")
    {
        return Ok(s.to_string());
    }
    if looks_like_numeric_literal(s)
        || looks_like_quoted_string(s)
        || looks_like_bare_identifier(s)
        || looks_like_simple_function_call(s)
    {
        return Ok(s.to_string());
    }
    Err(AppError::bad_input(
        "default_value",
        format!("not a recognized SQL literal or simple function call: {s:?}"),
    ))
}

/// Normalize a FK referential action against the SQL standard 5-value
/// whitelist. Returns `Ok(None)` for empty / `NO ACTION` (so the caller
/// can omit the clause entirely); `Err(BadInput)` for anything outside
/// the whitelist; `Ok(Some(uppercase))` otherwise.
fn require_fk_rule(rule: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = rule else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let up = trimmed.to_uppercase();
    if !FK_ACTIONS.iter().any(|a| *a == up) {
        return Err(AppError::bad_input(
            "fk_action",
            format!("must be one of {FK_ACTIONS:?}, got {trimmed:?}"),
        ));
    }
    if up == "NO ACTION" {
        return Ok(None);
    }
    Ok(Some(up))
}

fn looks_like_numeric_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let (start, has_sign) = if matches!(bytes[0], b'-' | b'+') {
        (1, true)
    } else {
        (0, false)
    };
    let rest = &bytes[start..];
    if rest.is_empty() {
        return false;
    }
    let mut seen_dot = false;
    let mut seen_digit = false;
    for &b in rest {
        if b == b'.' {
            if seen_dot {
                return false;
            }
            seen_dot = true;
        } else if b.is_ascii_digit() {
            seen_digit = true;
        } else {
            return false;
        }
    }
    seen_digit || (!has_sign && !seen_dot)
}

fn looks_like_quoted_string(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'\'' || *bytes.last().unwrap() != b'\'' {
        return false;
    }
    // Walk the interior: every `'` must be doubled. NULs and other control
    // chars aren't valid in legitimate SQL string literals.
    let inner = &bytes[1..bytes.len() - 1];
    let mut i = 0;
    while i < inner.len() {
        let b = inner[i];
        if b == 0 {
            return false;
        }
        if b == b'\'' {
            if i + 1 >= inner.len() || inner[i + 1] != b'\'' {
                return false;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    true
}

fn looks_like_bare_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return false;
    }
    if !bytes[0].is_ascii_alphabetic() && bytes[0] != b'_' {
        return false;
    }
    bytes
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'_')
}

fn looks_like_simple_function_call(s: &str) -> bool {
    let Some(open) = s.find('(') else {
        return false;
    };
    if !s.ends_with(')') {
        return false;
    }
    let name = &s[..open];
    if !looks_like_bare_identifier(name) {
        return false;
    }
    let inside = &s[open + 1..s.len() - 1];
    if inside.trim().is_empty() {
        return true;
    }
    // Permit a comma-separated list of numeric literals or single-quoted
    // strings — that covers `nextval('seq_name')`, `to_timestamp(0)`, and
    // the like, without opening the door to nested expressions.
    split_top_level_args(inside)
        .into_iter()
        .all(|arg| looks_like_numeric_literal(arg) || looks_like_quoted_string(arg))
}

/// Split a function-argument string on commas that are *not* inside a
/// single-quoted segment. Returns each trimmed argument as-is.
fn split_top_level_args(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_quote = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if in_quote && i + 1 < bytes.len() && bytes[i + 1] == b'\'' => {
                i += 2; // escaped single-quote stays inside the quoted segment
                continue;
            }
            b'\'' => in_quote = !in_quote,
            b',' if !in_quote => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(s[start..].trim());
    out
}

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
        .map_err(|e| AppError::bad_input("diagram doc", e.to_string()))?;

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
        out.push_str(&render_create_table(t, &inline_fks, &doc.tables, kind)?);
        out.push('\n');
    }

    if !matches!(kind, DbKind::Sqlite) {
        for e in &doc.edges {
            if let Some(stmt) = render_add_fk(e, &doc.tables, kind)? {
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
) -> AppResult<String> {
    validate_ident_chars(&t.name)?;
    if !t.schema.is_empty() {
        validate_ident_chars(&t.schema)?;
    }

    let mut lines: Vec<String> = Vec::new();
    for c in &t.columns {
        validate_ident_chars(&c.name)?;
        let data_type = validate_data_type(&c.data_type)?;
        let mut line = format!("    {} {}", quote_ident(&c.name, kind), data_type);
        if !c.nullable {
            line.push_str(" NOT NULL");
        }
        if let Some(d) = &c.default_value {
            if !d.trim().is_empty() {
                let validated = validate_default_value(d)?;
                line.push_str(&format!(" DEFAULT {validated}"));
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
            for col in fk.source_columns.iter().chain(fk.target_columns.iter()) {
                validate_ident_chars(col)?;
            }
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
            if let Some(rule) = require_fk_rule(fk.on_update.as_deref())? {
                line.push_str(&format!(" ON UPDATE {rule}"));
            }
            if let Some(rule) = require_fk_rule(fk.on_delete.as_deref())? {
                line.push_str(&format!(" ON DELETE {rule}"));
            }
            lines.push(line);
        }
    }

    Ok(format!(
        "CREATE TABLE {} (\n{}\n);\n",
        quote_table(&t.schema, &t.name, kind),
        lines.join(",\n"),
    ))
}

fn render_add_fk(e: &DocEdge, tables: &[DocTable], kind: DbKind) -> AppResult<Option<String>> {
    let Some(source) = tables.iter().find(|t| t.lookup_id() == e.source) else {
        return Ok(None);
    };
    let Some(target) = tables.iter().find(|t| t.lookup_id() == e.target) else {
        return Ok(None);
    };
    for col in e.source_columns.iter().chain(e.target_columns.iter()) {
        validate_ident_chars(col)?;
    }
    let constraint = match e.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => {
            validate_ident_chars(n)?;
            quote_ident(n, kind)
        }
        None => quote_ident(
            &format!("fk_{}_{}", source.name, e.source_columns.join("_")),
            kind,
        ),
    };
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
    if let Some(rule) = require_fk_rule(e.on_update.as_deref())? {
        stmt.push_str(&format!(" ON UPDATE {rule}"));
    }
    if let Some(rule) = require_fk_rule(e.on_delete.as_deref())? {
        stmt.push_str(&format!(" ON DELETE {rule}"));
    }
    stmt.push(';');
    Ok(Some(stmt))
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

    // ─── Validator unit tests ─────────────────────────────────────────────

    #[test]
    fn data_type_accepts_canonical_forms() {
        for ok in [
            "integer",
            "int",
            "int4",
            "text",
            "varchar(255)",
            "char(10)",
            "numeric(10,2)",
            "decimal(12, 2)",
            "timestamp with time zone",
            "character varying",
            "jsonb",
            "int[]",
            "int4[][]",
            "_underscore_start",
        ] {
            assert!(validate_data_type(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn data_type_rejects_injection_attempts() {
        for bad in [
            "",
            "  ",
            "int; DROP TABLE x",
            "int--",
            "int /* hi */",
            "int)/**/",
            "1invalid",
            "int\"x",
            "int`x",
            "int'x",
            "int;",
        ] {
            assert!(validate_data_type(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn default_value_accepts_canonical_forms() {
        for ok in [
            "NULL",
            "null",
            "TRUE",
            "false",
            "0",
            "-1",
            "3.14",
            "-0.5",
            "'hello'",
            "''",
            "'O''Brien'",
            "CURRENT_TIMESTAMP",
            "CURRENT_DATE",
            "now()",
            "gen_random_uuid()",
            "nextval('my_seq')",
            "to_timestamp(0)",
        ] {
            assert!(
                validate_default_value(ok).is_ok(),
                "should accept default {ok:?}"
            );
        }
    }

    #[test]
    fn default_value_rejects_injection_attempts() {
        for bad in [
            "",
            "0; DROP TABLE x",
            "'unterminated",
            "'a'b'",     // single quote in the middle, not doubled
            "now(); --", // trailing comment
            "(SELECT 1)",
            "1 + 1",
            "now() || 'x'",
            "foo(bar(1))", // nested function calls aren't permitted
            "foo(a + 1)",  // arithmetic in args
        ] {
            assert!(
                validate_default_value(bad).is_err(),
                "should reject default {bad:?}"
            );
        }
    }

    #[test]
    fn fk_rule_accepts_whitelist_only() {
        assert_eq!(require_fk_rule(None).unwrap(), None);
        assert_eq!(require_fk_rule(Some("")).unwrap(), None);
        assert_eq!(require_fk_rule(Some("NO ACTION")).unwrap(), None);
        assert_eq!(require_fk_rule(Some("no action")).unwrap(), None);
        assert_eq!(
            require_fk_rule(Some("cascade")).unwrap(),
            Some("CASCADE".into())
        );
        assert_eq!(
            require_fk_rule(Some("set null")).unwrap(),
            Some("SET NULL".into())
        );
        assert_eq!(
            require_fk_rule(Some("set default")).unwrap(),
            Some("SET DEFAULT".into())
        );
        assert_eq!(
            require_fk_rule(Some("RESTRICT")).unwrap(),
            Some("RESTRICT".into())
        );

        // Anything outside the whitelist (including embedded SQL) is rejected.
        for bad in [
            "DROP TABLE x",
            "CASCADE; DROP TABLE x",
            "SET something",
            "RESTRICT, CASCADE",
        ] {
            assert!(
                require_fk_rule(Some(bad)).is_err(),
                "should reject FK rule {bad:?}"
            );
        }
    }

    #[test]
    fn create_table_rejects_malicious_default_from_import() {
        let json = doc(r#"{
              "version":1,
              "tables":[{"schema":"public","name":"t","columns":[
                {"id":"c1","name":"id","dataType":"integer","nullable":false,"isPk":true,"isFk":false,"defaultValue":"0; DROP TABLE x"}
              ]}],
              "edges":[]
            }"#);
        let err = generate_diagram_ddl(&json, DbKind::Postgres).unwrap_err();
        assert!(err.to_string().contains("default_value"), "got {err}");
    }

    #[test]
    fn create_table_rejects_malicious_data_type_from_import() {
        let json = doc(r#"{
              "version":1,
              "tables":[{"schema":"public","name":"t","columns":[
                {"id":"c1","name":"id","dataType":"integer; DROP TABLE x","nullable":false,"isPk":true,"isFk":false}
              ]}],
              "edges":[]
            }"#);
        let err = generate_diagram_ddl(&json, DbKind::Postgres).unwrap_err();
        assert!(err.to_string().contains("data_type"), "got {err}");
    }

    #[test]
    fn numeric_literal_accepts_signed_and_decimal_forms() {
        for ok in ["0", "42", "-42", "+1", "3.14", "-0.5", ".5", "10."] {
            assert!(looks_like_numeric_literal(ok), "should accept {ok:?}");
        }
    }

    #[test]
    fn numeric_literal_rejects_non_numeric_input() {
        for bad in ["", " ", "abc", "1a", "1..2", "+", "-", "1+1", "0x1f"] {
            assert!(!looks_like_numeric_literal(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn quoted_string_accepts_well_formed_literals() {
        for ok in ["''", "'abc'", "'O''Brien'", "'a''b''c'"] {
            assert!(looks_like_quoted_string(ok), "should accept {ok:?}");
        }
    }

    #[test]
    fn quoted_string_rejects_unbalanced_or_unescaped_quotes() {
        for bad in ["'", "'abc", "abc'", "'a'b'", "''abc"] {
            assert!(!looks_like_quoted_string(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn bare_identifier_accepts_alphanumeric_underscore_starting_with_letter_or_underscore() {
        for ok in ["a", "_x", "foo_bar", "Foo123", "_"] {
            assert!(looks_like_bare_identifier(ok), "should accept {ok:?}");
        }
    }

    #[test]
    fn bare_identifier_rejects_invalid_starts_and_chars() {
        for bad in ["", "1abc", "foo bar", "foo-bar", "foo.bar"] {
            assert!(!looks_like_bare_identifier(bad), "should reject {bad:?}");
        }
        // Length cap: 64+ chars rejected.
        let long = "a".repeat(64);
        assert!(!looks_like_bare_identifier(&long));
    }

    #[test]
    fn simple_function_call_accepts_zero_or_literal_args() {
        for ok in [
            "now()",
            "uuid_generate_v4()",
            "nextval('seq')",
            "to_timestamp(0)",
        ] {
            assert!(looks_like_simple_function_call(ok), "should accept {ok:?}");
        }
    }

    #[test]
    fn simple_function_call_rejects_expressions_and_malformed_input() {
        for bad in [
            "now(",
            "now)",
            "1 + 1",
            "foo(a + b)",
            "foo(BAR)",
            "(no name)",
        ] {
            assert!(
                !looks_like_simple_function_call(bad),
                "should reject {bad:?}"
            );
        }
    }

    #[test]
    fn split_top_level_args_respects_quoted_commas() {
        assert_eq!(split_top_level_args("a, b, c"), vec!["a", "b", "c"]);
        assert_eq!(split_top_level_args("'a,b', c"), vec!["'a,b'", "c"]);
        // Escaped single-quote inside a quoted segment stays inside.
        assert_eq!(split_top_level_args("'a''b', c"), vec!["'a''b'", "c"]);
        // No commas → one element.
        assert_eq!(split_top_level_args("solo"), vec!["solo"]);
    }

    #[test]
    fn alter_fk_rejects_off_whitelist_action() {
        let json = doc(r#"{
              "version":1,
              "tables":[
                {"schema":"public","name":"a","columns":[{"id":"a1","name":"id","dataType":"integer","nullable":false,"isPk":true,"isFk":false}]},
                {"schema":"public","name":"b","columns":[{"id":"b1","name":"a_id","dataType":"integer","nullable":false,"isPk":false,"isFk":true}]}
              ],
              "edges":[{"id":"e1","name":"bad","source":"public.b","target":"public.a","sourceColumns":["a_id"],"targetColumns":["id"],"onDelete":"CASCADE; DROP TABLE x"}]
            }"#);
        let err = generate_diagram_ddl(&json, DbKind::Postgres).unwrap_err();
        assert!(err.to_string().contains("fk_action"), "got {err}");
    }
}
