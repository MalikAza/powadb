//! Versioned schema migrations for `powadb.db`.
//!
//! The runner records every applied migration in a `schema_version` table.
//! Migrations are applied in ascending version order, each inside its own
//! transaction — a partial failure leaves the previous version intact.
//!
//! Bootstrapping legacy installs: before this module existed, schema was
//! built up via inline `CREATE TABLE IF NOT EXISTS` + best-effort
//! `ALTER TABLE ADD COLUMN` blocks in `Storage::open`. Those installs land
//! here with no `schema_version` row but with a fully populated
//! `connections` table; we stamp them with version 1 (the consolidated
//! initial schema, which matches the cumulative shape the inline blocks
//! produced) and continue from there.

use sqlx::{Row, SqlitePool};

use crate::error::AppResult;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial",
    sql: include_str!("../migrations/0001_initial.sql"),
}];

/// Apply every migration whose version is greater than the highest already
/// recorded in `schema_version`. Idempotent: calling on an up-to-date DB
/// runs no SQL beyond reading `schema_version`.
pub async fn run(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(pool)
    .await?;

    let current = highest_applied(pool).await?;

    // Legacy installs (created before this runner existed) have all the v1
    // tables from the old inline `Storage::open` code but no `schema_version`
    // row. We don't shortcut around the v1 migration — every statement in
    // it is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so
    // re-running it against a legacy DB is a no-op except it stamps the row
    // and makes future migrations gate cleanly.

    for m in MIGRATIONS {
        if m.version <= current {
            continue;
        }
        let mut tx = pool.begin().await?;
        // `sqlx::raw_sql` executes a multi-statement script in one go, which
        // is what we want for a migration file — `sqlx::query` only compiles
        // the first statement.
        sqlx::raw_sql(m.sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO schema_version (version) VALUES (?1)")
            .bind(m.version)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        eprintln!("storage: applied migration {:04} ({})", m.version, m.name);
    }
    Ok(())
}

async fn highest_applied(pool: &SqlitePool) -> AppResult<i64> {
    let row = sqlx::query("SELECT MAX(version) AS v FROM schema_version")
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<Option<i64>, _>("v")?.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn has_table(pool: &SqlitePool, name: &str) -> AppResult<bool> {
        let row =
            sqlx::query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?1")
                .bind(name)
                .fetch_one(pool)
                .await?;
        Ok(row.try_get::<i64, _>("n")? > 0)
    }

    async fn fresh_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn run_on_empty_db_creates_schema_and_stamps_v1() {
        let pool = fresh_pool().await;
        run(&pool).await.unwrap();
        assert_eq!(highest_applied(&pool).await.unwrap(), 1);
        // All v1 tables exist.
        for t in [
            "connections",
            "folders",
            "query_history",
            "snippets",
            "settings",
            "diagrams",
            "themes",
            "schema_version",
        ] {
            assert!(has_table(&pool, t).await.unwrap(), "missing table {t}");
        }
    }

    #[tokio::test]
    async fn run_is_idempotent() {
        let pool = fresh_pool().await;
        run(&pool).await.unwrap();
        // A second pass must not change anything or fail.
        run(&pool).await.unwrap();
        let rows = sqlx::query("SELECT version FROM schema_version ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].try_get::<i64, _>("version").unwrap(), 1);
    }

    #[tokio::test]
    async fn legacy_db_without_schema_version_gets_stamped_v1() {
        let pool = fresh_pool().await;
        // Simulate the pre-migration world: a `connections` table exists but
        // there's no schema_version row.
        sqlx::query("CREATE TABLE connections (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        run(&pool).await.unwrap();
        assert_eq!(highest_applied(&pool).await.unwrap(), 1);
        // The legacy `connections` table is left untouched — `IF NOT EXISTS`
        // is a no-op against it. (The other tables get created.)
        assert!(has_table(&pool, "snippets").await.unwrap());
    }
}
