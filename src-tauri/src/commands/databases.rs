use tauri::State;

use crate::commands::connections::resolve_connection;
use crate::engine::SqlPoolView;
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;
use crate::AppState;

fn validate_db_name(name: &str) -> AppResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("database name is empty".into()));
    }
    if trimmed.len() > 63 {
        return Err(AppError::Other(
            "database name exceeds 63 characters".into(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::Other(
            "database name may not contain control characters".into(),
        ));
    }
    if trimmed.contains('"') || trimmed.contains('`') {
        return Err(AppError::Other(
            "database name may not contain quote characters".into(),
        ));
    }
    Ok(())
}

fn quote_identifier(kind: DbKind, name: &str) -> String {
    match kind {
        DbKind::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        DbKind::Mysql => format!("`{}`", name.replace('`', "``")),
        DbKind::Sqlite => name.to_string(),
        DbKind::Mongo => unreachable!("Mongo doesn't use SQL identifier quoting"),
    }
}

#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    validate_db_name(&name)?;
    let (conn, _, _, _) = resolve_connection(&state, &connection_id).await?;
    if matches!(conn.kind, DbKind::Sqlite) {
        return Err(AppError::Other(
            "creating databases is not supported for SQLite".into(),
        ));
    }
    if matches!(conn.kind, DbKind::Mongo) {
        return Err(AppError::Other(
            "MongoDB creates databases implicitly on first write".into(),
        ));
    }
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let stmt = format!(
        "CREATE DATABASE {}",
        quote_identifier(conn.kind, name.trim())
    );
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Mysql(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Sqlite(_)) => unreachable!("sqlite handled above"),
        None => {
            return Err(AppError::Other(
                "create_database requires a SQL engine".into(),
            ))
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn drop_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    validate_db_name(&name)?;
    let (conn, _, _, _) = resolve_connection(&state, &connection_id).await?;
    if matches!(conn.kind, DbKind::Sqlite) {
        return Err(AppError::Other(
            "dropping databases is not supported for SQLite".into(),
        ));
    }
    let target = name.trim();
    if target == conn.database {
        return Err(AppError::Other(
            "cannot drop the database the connection is currently using".into(),
        ));
    }
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    // Mongo branch goes through the typed `Client::database(name).drop()`.
    if let Some(mongo) = handle.as_mongo() {
        mongo
            .client
            .database(target)
            .drop()
            .await
            .map_err(|e| AppError::Other(format!("mongo dropDatabase failed: {e}")))?;
        return Ok(());
    }
    let stmt = format!("DROP DATABASE {}", quote_identifier(conn.kind, target));
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Mysql(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Sqlite(_)) => unreachable!("sqlite handled above"),
        None => {
            return Err(AppError::Other(
                "drop_database requires a SQL engine".into(),
            ))
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_empty() {
        assert!(validate_db_name("").is_err());
        assert!(validate_db_name("   ").is_err());
    }

    #[test]
    fn validate_rejects_quote_chars() {
        assert!(validate_db_name("abc\"def").is_err());
        assert!(validate_db_name("abc`def").is_err());
    }

    #[test]
    fn validate_rejects_control_chars() {
        assert!(validate_db_name("abc\ndef").is_err());
        assert!(validate_db_name("abc\0def").is_err());
        assert!(validate_db_name("abc\tdef").is_err());
    }

    #[test]
    fn validate_accepts_normal_names() {
        assert!(validate_db_name("my_db").is_ok());
        assert!(validate_db_name("_internal").is_ok());
        assert!(validate_db_name("App42$").is_ok());
        assert!(validate_db_name("my-db").is_ok());
        assert!(validate_db_name("my.db").is_ok());
        assert!(validate_db_name("123-numeric").is_ok());
        assert!(validate_db_name("with space").is_ok());
    }

    #[test]
    fn validate_rejects_too_long() {
        let s = "a".repeat(64);
        assert!(validate_db_name(&s).is_err());
        let s63 = "a".repeat(63);
        assert!(validate_db_name(&s63).is_ok());
    }

    #[test]
    fn quote_identifier_escapes_per_kind() {
        assert_eq!(quote_identifier(DbKind::Postgres, "my_db"), "\"my_db\"");
        assert_eq!(quote_identifier(DbKind::Mysql, "my_db"), "`my_db`");
    }
}
