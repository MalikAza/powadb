use crate::error::{AppError, AppResult};
use crate::storage::DbKind;

/// Reject identifiers containing NULs or other control characters before we
/// embed them in DDL. These can never appear in a legitimate Postgres/MySQL/
/// SQLite identifier (per their lexers) and they're the main way an
/// adversarial input could prematurely terminate or hijack a quoted string.
pub fn validate_ident_chars(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::Other("identifier is empty".into()));
    }
    if name.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(AppError::Other(
            "identifier contains control characters".into(),
        ));
    }
    Ok(())
}

/// Quote an identifier (table/column/constraint name) for the given engine,
/// escaping any embedded quote characters per engine convention.
pub fn quote_ident(name: &str, kind: DbKind) -> String {
    match kind {
        DbKind::Postgres | DbKind::Sqlite => {
            let escaped = name.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        }
        DbKind::Mysql => {
            let escaped = name.replace('`', "``");
            format!("`{}`", escaped)
        }
        DbKind::Mongo | DbKind::S3 => {
            unreachable!("non-SQL engines don't use SQL identifier quoting")
        }
    }
}

/// Qualified `schema.name` for engines that scope by schema; bare name for
/// MySQL (DB-scoped) and SQLite (single-schema).
pub fn quote_table(schema: &str, name: &str, kind: DbKind) -> String {
    match kind {
        DbKind::Postgres if !schema.is_empty() => {
            format!("{}.{}", quote_ident(schema, kind), quote_ident(name, kind))
        }
        _ => quote_ident(name, kind),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_postgres_wraps_in_double_quotes() {
        assert_eq!(quote_ident("users", DbKind::Postgres), "\"users\"");
    }

    #[test]
    fn quote_ident_mysql_wraps_in_backticks() {
        assert_eq!(quote_ident("users", DbKind::Mysql), "`users`");
    }

    #[test]
    fn quote_ident_escapes_embedded_quote_chars() {
        assert_eq!(quote_ident("we\"ird", DbKind::Postgres), "\"we\"\"ird\"");
        assert_eq!(quote_ident("we`ird", DbKind::Mysql), "`we``ird`");
    }

    #[test]
    fn quote_table_postgres_qualifies_with_schema() {
        assert_eq!(
            quote_table("public", "users", DbKind::Postgres),
            "\"public\".\"users\""
        );
    }

    #[test]
    fn quote_table_postgres_omits_empty_schema() {
        assert_eq!(quote_table("", "users", DbKind::Postgres), "\"users\"");
    }

    #[test]
    fn quote_table_mysql_ignores_schema() {
        assert_eq!(quote_table("anything", "users", DbKind::Mysql), "`users`");
    }

    #[test]
    fn quote_table_sqlite_ignores_schema() {
        assert_eq!(quote_table("main", "users", DbKind::Sqlite), "\"users\"");
    }

    #[test]
    fn validate_ident_chars_accepts_normal_names() {
        assert!(validate_ident_chars("users").is_ok());
        assert!(validate_ident_chars("we\"ird").is_ok());
        assert!(validate_ident_chars("schema.with_dot").is_ok());
    }

    #[test]
    fn validate_ident_chars_rejects_empty() {
        assert!(validate_ident_chars("").is_err());
    }

    #[test]
    fn validate_ident_chars_rejects_nul() {
        assert!(validate_ident_chars("users\0evil").is_err());
    }

    #[test]
    fn validate_ident_chars_rejects_control_chars() {
        assert!(validate_ident_chars("users\nDROP TABLE x").is_err());
        assert!(validate_ident_chars("users\r").is_err());
        assert!(validate_ident_chars("users\t").is_err());
    }
}
