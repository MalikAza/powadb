pub mod mysql;
pub mod postgres;
pub mod sqlite;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, Clone)]
pub struct Column {
    pub name: String,
    pub type_name: String,
    /// Origin of this result column when it can be traced back to a real
    /// table column (i.e. not the result of an expression). Currently only
    /// populated by the Postgres driver, which reads `relation_id` /
    /// `relation_attribute_no` from sqlx's row description and resolves the
    /// OID + attnum against `pg_catalog`. MySQL's sqlx driver doesn't expose
    /// `org_table` / `org_name`, so those columns stay `None` there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub elapsed_ms: u128,
}

/// One executed statement in a multi-statement script.
///
/// Exactly one of `result` / `rows_affected` is set on success: `result` for
/// row-returning statements (SELECT, RETURNING, ...) and `rows_affected` for
/// non-returning DML/DDL. On failure, `error` holds the driver message and
/// no further statements run.
#[derive(Debug, Serialize)]
pub struct StatementResult {
    pub index: usize,
    /// First ~80 chars of the statement, single-line, for display in the
    /// summary row before the user expands it.
    pub sql_excerpt: String,
    pub elapsed_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<QueryResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct ScriptResult {
    pub statements: Vec<StatementResult>,
}

/// Build a single-line excerpt of the given SQL, capped at ~80 chars.
pub fn sql_excerpt(sql: &str) -> String {
    let collapsed: String = sql
        .chars()
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let trimmed = collapsed.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 80;
    if trimmed.chars().count() <= MAX {
        trimmed
    } else {
        let mut out: String = trimmed.chars().take(MAX).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_collapses_whitespace() {
        assert_eq!(sql_excerpt("SELECT\n  1,\n  2"), "SELECT 1, 2");
    }

    #[test]
    fn excerpt_truncates_long_input() {
        let long = "x".repeat(200);
        let out = sql_excerpt(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 81);
    }

    #[test]
    fn excerpt_keeps_short_input_intact() {
        assert_eq!(sql_excerpt("DELETE FROM t"), "DELETE FROM t");
    }
}
