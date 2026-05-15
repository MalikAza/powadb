use crate::storage::DbKind;

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
}
