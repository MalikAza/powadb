use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::error::AppResult;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    Mysql,
}

impl DbKind {
    fn as_str(&self) -> &'static str {
        match self {
            DbKind::Postgres => "postgres",
            DbKind::Mysql => "mysql",
        }
    }
    fn parse(s: &str) -> Option<DbKind> {
        match s {
            "postgres" => Some(DbKind::Postgres),
            "mysql" => Some(DbKind::Mysql),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

pub struct Storage {
    pool: SqlitePool,
}

impl Storage {
    pub async fn open(path: PathBuf) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                database TEXT NOT NULL,
                username TEXT NOT NULL,
                ssl INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            "#,
        )
        .execute(&pool)
        .await?;

        let _ = sqlx::query("ALTER TABLE connections ADD COLUMN password TEXT")
            .execute(&pool)
            .await;
        let _ = sqlx::query("ALTER TABLE connections ADD COLUMN folder_id TEXT")
            .execute(&pool)
            .await;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS query_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_id TEXT NOT NULL,
                sql TEXT NOT NULL,
                executed_at TEXT NOT NULL DEFAULT (datetime('now')),
                elapsed_ms INTEGER,
                row_count INTEGER,
                error TEXT
            )
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_history_conn_time ON query_history(connection_id, executed_at DESC)",
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                connection_id TEXT,
                name TEXT NOT NULL,
                sql TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            "#,
        )
        .execute(&pool)
        .await?;

        Ok(Self { pool })
    }

    pub async fn list_snippets(&self, connection_id: Option<&str>) -> AppResult<Vec<Snippet>> {
        let q = if connection_id.is_some() {
            "SELECT id, connection_id, name, sql, created_at FROM snippets
             WHERE connection_id IS NULL OR connection_id = ?1
             ORDER BY name"
        } else {
            "SELECT id, connection_id, name, sql, created_at FROM snippets ORDER BY name"
        };
        let mut q = sqlx::query(q);
        if let Some(cid) = connection_id {
            q = q.bind(cid);
        }
        let rows = q.fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(Snippet {
                    id: r.try_get("id").ok()?,
                    connection_id: r.try_get("connection_id").ok(),
                    name: r.try_get("name").ok()?,
                    sql: r.try_get("sql").ok()?,
                    created_at: r.try_get("created_at").ok()?,
                })
            })
            .collect())
    }

    pub async fn upsert_snippet(&self, s: &Snippet) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO snippets (id, connection_id, name, sql)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                connection_id=excluded.connection_id,
                name=excluded.name,
                sql=excluded.sql
            "#,
        )
        .bind(&s.id)
        .bind(&s.connection_id)
        .bind(&s.name)
        .bind(&s.sql)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_snippet(&self, id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM snippets WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn log_history(
        &self,
        connection_id: &str,
        sql: &str,
        elapsed_ms: Option<i64>,
        row_count: Option<i64>,
        error: Option<&str>,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO query_history (connection_id, sql, elapsed_ms, row_count, error) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(connection_id)
        .bind(sql)
        .bind(elapsed_ms)
        .bind(row_count)
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_history(
        &self,
        connection_id: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<HistoryEntry>> {
        let q = if connection_id.is_some() {
            "SELECT id, connection_id, sql, executed_at, elapsed_ms, row_count, error
             FROM query_history WHERE connection_id = ?1
             ORDER BY id DESC LIMIT ?2"
        } else {
            "SELECT id, connection_id, sql, executed_at, elapsed_ms, row_count, error
             FROM query_history ORDER BY id DESC LIMIT ?1"
        };
        let mut q = sqlx::query(q);
        if let Some(cid) = connection_id {
            q = q.bind(cid);
        }
        q = q.bind(limit);
        let rows = q.fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(HistoryEntry {
                    id: r.try_get("id").ok()?,
                    connection_id: r.try_get("connection_id").ok()?,
                    sql: r.try_get("sql").ok()?,
                    executed_at: r.try_get("executed_at").ok()?,
                    elapsed_ms: r.try_get("elapsed_ms").ok(),
                    row_count: r.try_get("row_count").ok(),
                    error: r.try_get("error").ok(),
                })
            })
            .collect())
    }

    pub async fn clear_history(&self, connection_id: Option<&str>) -> AppResult<()> {
        if let Some(cid) = connection_id {
            sqlx::query("DELETE FROM query_history WHERE connection_id = ?1")
                .bind(cid)
                .execute(&self.pool)
                .await?;
        } else {
            sqlx::query("DELETE FROM query_history").execute(&self.pool).await?;
        }
        Ok(())
    }

    pub async fn list(&self) -> AppResult<Vec<SavedConnection>> {
        let rows = sqlx::query(
            "SELECT id, name, kind, host, port, database, username, ssl, folder_id FROM connections ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let kind_s: String = r.try_get("kind").ok()?;
                let port_i: i64 = r.try_get("port").ok()?;
                let ssl_i: i64 = r.try_get("ssl").ok()?;
                Some(SavedConnection {
                    id: r.try_get("id").ok()?,
                    name: r.try_get("name").ok()?,
                    kind: DbKind::parse(&kind_s)?,
                    host: r.try_get("host").ok()?,
                    port: port_i.clamp(0, u16::MAX as i64) as u16,
                    database: r.try_get("database").ok()?,
                    username: r.try_get("username").ok()?,
                    ssl: ssl_i != 0,
                    folder_id: r.try_get("folder_id").ok().flatten(),
                })
            })
            .collect())
    }

    pub async fn upsert(&self, c: &SavedConnection) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO connections (id, name, kind, host, port, database, username, ssl, folder_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                kind=excluded.kind,
                host=excluded.host,
                port=excluded.port,
                database=excluded.database,
                username=excluded.username,
                ssl=excluded.ssl,
                folder_id=excluded.folder_id
            "#,
        )
        .bind(&c.id)
        .bind(&c.name)
        .bind(c.kind.as_str())
        .bind(&c.host)
        .bind(c.port as i64)
        .bind(&c.database)
        .bind(&c.username)
        .bind(c.ssl as i64)
        .bind(&c.folder_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_folders(&self) -> AppResult<Vec<Folder>> {
        let rows = sqlx::query("SELECT id, name, parent_id FROM folders ORDER BY name")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(Folder {
                    id: r.try_get("id").ok()?,
                    name: r.try_get("name").ok()?,
                    parent_id: r.try_get("parent_id").ok().flatten(),
                })
            })
            .collect())
    }

    pub async fn upsert_folder(&self, f: &Folder) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO folders (id, name, parent_id)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id
            "#,
        )
        .bind(&f.id)
        .bind(&f.name)
        .bind(&f.parent_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete a folder. Children (subfolders + connections) are promoted to the deleted folder's parent.
    pub async fn delete_folder(&self, id: &str) -> AppResult<()> {
        let row = sqlx::query("SELECT parent_id FROM folders WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        let new_parent: Option<String> = row.and_then(|r| r.try_get("parent_id").ok().flatten());

        sqlx::query("UPDATE folders SET parent_id = ?1 WHERE parent_id = ?2")
            .bind(&new_parent)
            .bind(id)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE connections SET folder_id = ?1 WHERE folder_id = ?2")
            .bind(&new_parent)
            .bind(id)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM folders WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM connections WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_password(&self, id: &str) -> AppResult<Option<String>> {
        let row = sqlx::query("SELECT password FROM connections WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.try_get::<Option<String>, _>("password").ok().flatten()))
    }

    pub async fn set_password(&self, id: &str, password: Option<&str>) -> AppResult<()> {
        sqlx::query("UPDATE connections SET password = ?1 WHERE id = ?2")
            .bind(password)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub sql: String,
    pub executed_at: String,
    pub elapsed_ms: Option<i64>,
    pub row_count: Option<i64>,
    pub error: Option<String>,
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}
