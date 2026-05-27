use tauri::State;

use crate::commands::connections::resolve_connection;
use crate::commands::ddl_util::quote_ident;
use crate::engine::SqlPoolView;
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;
use crate::AppState;

fn validate_db_name(name: &str) -> AppResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::bad_input("name", "database name is empty"));
    }
    if trimmed.len() > 63 {
        return Err(AppError::bad_input(
            "name",
            "database name exceeds 63 characters",
        ));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::bad_input(
            "name",
            "database name may not contain control characters",
        ));
    }
    if trimmed.contains('"') || trimmed.contains('`') {
        return Err(AppError::bad_input(
            "name",
            "database name may not contain quote characters",
        ));
    }
    Ok(())
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
        return Err(AppError::unsupported("create_database", "sqlite"));
    }
    if matches!(conn.kind, DbKind::Mongo) {
        return Err(AppError::unsupported("create_database", "mongo"));
    }
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let stmt = format!("CREATE DATABASE {}", quote_ident(name.trim(), conn.kind));
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Mysql(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Sqlite(_)) => unreachable!("sqlite handled above"),
        None => {
            return Err(AppError::unsupported(
                "create_database",
                handle.kind().as_str(),
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
        return Err(AppError::unsupported("drop_database", "sqlite"));
    }
    let target = name.trim();
    if target == conn.database {
        return Err(AppError::bad_input(
            "name",
            "cannot drop the database the connection is currently using",
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
    let stmt = format!("DROP DATABASE {}", quote_ident(target, conn.kind));
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Mysql(pool)) => {
            sqlx::query(&stmt).execute(pool).await?;
        }
        Some(SqlPoolView::Sqlite(_)) => unreachable!("sqlite handled above"),
        None => {
            return Err(AppError::unsupported(
                "drop_database",
                handle.kind().as_str(),
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

    // The CREATE / DROP DATABASE statements now route identifier quoting
    // through `ddl_util::quote_ident`, which is already covered by tests
    // in that module.
}
