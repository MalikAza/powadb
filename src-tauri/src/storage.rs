use std::path::PathBuf;
use std::sync::RwLock;

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
    Sqlite,
}

impl DbKind {
    fn as_str(&self) -> &'static str {
        match self {
            DbKind::Postgres => "postgres",
            DbKind::Mysql => "mysql",
            DbKind::Sqlite => "sqlite",
        }
    }
    fn parse(s: &str) -> Option<DbKind> {
        match s {
            "postgres" => Some(DbKind::Postgres),
            "mysql" => Some(DbKind::Mysql),
            "sqlite" => Some(DbKind::Sqlite),
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
    #[serde(default)]
    pub color: Option<String>,
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
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await?;

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
        let _ = sqlx::query("ALTER TABLE connections ADD COLUMN color TEXT")
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

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            "#,
        )
        .execute(&pool)
        .await?;

        Ok(Self { pool })
    }

    pub async fn load_settings(&self) -> AppResult<AppSettings> {
        let rows = sqlx::query("SELECT key, value FROM settings")
            .fetch_all(&self.pool)
            .await?;
        let mut s = AppSettings::default();
        for r in rows {
            let key: String = r.try_get("key").unwrap_or_default();
            let val: Option<String> = r.try_get("value").ok().flatten();
            match key.as_str() {
                "pg_dump_path" => s.pg_dump_path = val,
                "mysqldump_path" => s.mysqldump_path = val,
                "psql_path" => s.psql_path = val,
                "mysql_path" => s.mysql_path = val,
                "sqlite3_path" => s.sqlite3_path = val,
                _ => {}
            }
        }
        Ok(s)
    }

    pub async fn save_settings(&self, s: &AppSettings) -> AppResult<()> {
        let entries: [(&str, Option<&str>); 5] = [
            ("pg_dump_path", s.pg_dump_path.as_deref()),
            ("mysqldump_path", s.mysqldump_path.as_deref()),
            ("psql_path", s.psql_path.as_deref()),
            ("mysql_path", s.mysql_path.as_deref()),
            ("sqlite3_path", s.sqlite3_path.as_deref()),
        ];
        for (k, v) in entries {
            sqlx::query(
                r#"
                INSERT INTO settings (key, value) VALUES (?1, ?2)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                "#,
            )
            .bind(k)
            .bind(v)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
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
            sqlx::query("DELETE FROM query_history")
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn list(&self) -> AppResult<Vec<SavedConnection>> {
        let rows = sqlx::query(
            "SELECT id, name, kind, host, port, database, username, ssl, folder_id, color FROM connections ORDER BY name",
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
                    color: r.try_get("color").ok().flatten(),
                })
            })
            .collect())
    }

    pub async fn upsert(&self, c: &SavedConnection) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO connections (id, name, kind, host, port, database, username, ssl, folder_id, color)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                kind=excluded.kind,
                host=excluded.host,
                port=excluded.port,
                database=excluded.database,
                username=excluded.username,
                ssl=excluded.ssl,
                folder_id=excluded.folder_id,
                color=excluded.color
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
        .bind(&c.color)
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub pg_dump_path: Option<String>,
    #[serde(default)]
    pub mysqldump_path: Option<String>,
    #[serde(default)]
    pub psql_path: Option<String>,
    #[serde(default)]
    pub mysql_path: Option<String>,
    #[serde(default)]
    pub sqlite3_path: Option<String>,
}

pub struct SettingsStore {
    inner: RwLock<AppSettings>,
}

impl SettingsStore {
    pub fn new(initial: AppSettings) -> Self {
        Self {
            inner: RwLock::new(initial),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.inner.read().unwrap().clone()
    }

    pub fn set(&self, s: AppSettings) {
        *self.inner.write().unwrap() = s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn fresh_storage() -> (TempDir, Storage) {
        let dir = TempDir::new().unwrap();
        let storage = Storage::open(dir.path().join("test.db")).await.unwrap();
        (dir, storage)
    }

    fn sample_conn(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: format!("conn-{id}"),
            kind: DbKind::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "app".into(),
            username: "user".into(),
            ssl: false,
            folder_id: None,
            color: None,
        }
    }

    #[tokio::test]
    async fn db_kind_round_trips_via_parse() {
        assert_eq!(DbKind::parse("postgres"), Some(DbKind::Postgres));
        assert_eq!(DbKind::parse("mysql"), Some(DbKind::Mysql));
        assert_eq!(DbKind::parse("sqlite"), None);
        assert_eq!(DbKind::Postgres.as_str(), "postgres");
        assert_eq!(DbKind::Mysql.as_str(), "mysql");
    }

    #[test]
    fn new_id_is_a_valid_uuid_v4() {
        let id = new_id();
        let parsed = Uuid::parse_str(&id).expect("uuid");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[tokio::test]
    async fn open_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db");
        let s1 = Storage::open(path.clone()).await.unwrap();
        drop(s1);
        // Opening again on the same file must succeed (CREATE TABLE IF NOT EXISTS).
        let s2 = Storage::open(path).await.unwrap();
        assert!(s2.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn upsert_then_list_returns_connection() {
        let (_d, s) = fresh_storage().await;
        s.upsert(&sample_conn("a")).await.unwrap();
        let all = s.list().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "a");
        assert_eq!(all[0].kind, DbKind::Postgres);
    }

    #[tokio::test]
    async fn upsert_updates_existing_row() {
        let (_d, s) = fresh_storage().await;
        s.upsert(&sample_conn("a")).await.unwrap();
        let mut updated = sample_conn("a");
        updated.name = "renamed".into();
        updated.port = 6543;
        s.upsert(&updated).await.unwrap();
        let all = s.list().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "renamed");
        assert_eq!(all[0].port, 6543);
    }

    #[tokio::test]
    async fn list_orders_by_name() {
        let (_d, s) = fresh_storage().await;
        let mut a = sample_conn("1");
        a.name = "Zeta".into();
        let mut b = sample_conn("2");
        b.name = "Alpha".into();
        s.upsert(&a).await.unwrap();
        s.upsert(&b).await.unwrap();
        let names: Vec<_> = s
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "Zeta"]);
    }

    #[tokio::test]
    async fn delete_removes_connection() {
        let (_d, s) = fresh_storage().await;
        s.upsert(&sample_conn("a")).await.unwrap();
        s.delete("a").await.unwrap();
        assert!(s.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn password_round_trip() {
        let (_d, s) = fresh_storage().await;
        s.upsert(&sample_conn("a")).await.unwrap();
        assert_eq!(s.get_password("a").await.unwrap(), None);
        s.set_password("a", Some("secret")).await.unwrap();
        assert_eq!(s.get_password("a").await.unwrap(), Some("secret".into()));
        s.set_password("a", None).await.unwrap();
        assert_eq!(s.get_password("a").await.unwrap(), None);
    }

    #[tokio::test]
    async fn get_password_for_missing_connection_is_none() {
        let (_d, s) = fresh_storage().await;
        assert_eq!(s.get_password("missing").await.unwrap(), None);
    }

    #[tokio::test]
    async fn folder_upsert_and_list() {
        let (_d, s) = fresh_storage().await;
        let f = Folder {
            id: "f1".into(),
            name: "Work".into(),
            parent_id: None,
        };
        s.upsert_folder(&f).await.unwrap();
        let all = s.list_folders().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Work");
    }

    #[tokio::test]
    async fn delete_folder_promotes_children_to_parent() {
        let (_d, s) = fresh_storage().await;
        let root = Folder {
            id: "root".into(),
            name: "Root".into(),
            parent_id: None,
        };
        let mid = Folder {
            id: "mid".into(),
            name: "Mid".into(),
            parent_id: Some("root".into()),
        };
        let leaf = Folder {
            id: "leaf".into(),
            name: "Leaf".into(),
            parent_id: Some("mid".into()),
        };
        s.upsert_folder(&root).await.unwrap();
        s.upsert_folder(&mid).await.unwrap();
        s.upsert_folder(&leaf).await.unwrap();

        let mut conn_in_mid = sample_conn("c");
        conn_in_mid.folder_id = Some("mid".into());
        s.upsert(&conn_in_mid).await.unwrap();

        s.delete_folder("mid").await.unwrap();

        let folders = s.list_folders().await.unwrap();
        let leaf_after = folders.iter().find(|f| f.id == "leaf").unwrap();
        assert_eq!(leaf_after.parent_id.as_deref(), Some("root"));

        let connections = s.list().await.unwrap();
        assert_eq!(connections[0].folder_id.as_deref(), Some("root"));
    }

    #[tokio::test]
    async fn delete_folder_promotes_children_to_root_when_parent_is_root() {
        let (_d, s) = fresh_storage().await;
        let top = Folder {
            id: "top".into(),
            name: "Top".into(),
            parent_id: None,
        };
        let child = Folder {
            id: "child".into(),
            name: "Child".into(),
            parent_id: Some("top".into()),
        };
        s.upsert_folder(&top).await.unwrap();
        s.upsert_folder(&child).await.unwrap();

        s.delete_folder("top").await.unwrap();

        let folders = s.list_folders().await.unwrap();
        let child_after = folders.iter().find(|f| f.id == "child").unwrap();
        assert!(child_after.parent_id.is_none());
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let (_d, s) = fresh_storage().await;
        let settings = AppSettings {
            pg_dump_path: Some("/usr/bin/pg_dump".into()),
            mysql_path: Some("/usr/bin/mysql".into()),
            ..AppSettings::default()
        };
        s.save_settings(&settings).await.unwrap();

        let loaded = s.load_settings().await.unwrap();
        assert_eq!(loaded.pg_dump_path.as_deref(), Some("/usr/bin/pg_dump"));
        assert_eq!(loaded.mysql_path.as_deref(), Some("/usr/bin/mysql"));
        assert_eq!(loaded.psql_path, None);
        assert_eq!(loaded.mysqldump_path, None);
    }

    #[tokio::test]
    async fn snippet_round_trip() {
        let (_d, s) = fresh_storage().await;
        let snip = Snippet {
            id: "s1".into(),
            connection_id: Some("c1".into()),
            name: "All users".into(),
            sql: "SELECT * FROM users".into(),
            created_at: String::new(),
        };
        s.upsert_snippet(&snip).await.unwrap();

        let scoped = s.list_snippets(Some("c1")).await.unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].sql, "SELECT * FROM users");

        let other = s.list_snippets(Some("other")).await.unwrap();
        assert!(
            other.is_empty(),
            "snippet should not leak across connections"
        );

        s.delete_snippet("s1").await.unwrap();
        assert!(s.list_snippets(None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn global_snippets_are_visible_to_any_connection() {
        let (_d, s) = fresh_storage().await;
        let global = Snippet {
            id: "g1".into(),
            connection_id: None,
            name: "Global".into(),
            sql: "SELECT 1".into(),
            created_at: String::new(),
        };
        s.upsert_snippet(&global).await.unwrap();
        // Visible whether you ask scoped or unscoped — that's the contract.
        let scoped = s.list_snippets(Some("any-conn")).await.unwrap();
        let unscoped = s.list_snippets(None).await.unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(unscoped.len(), 1);
        assert_eq!(scoped[0].id, "g1");
    }

    #[tokio::test]
    async fn history_logs_and_lists_in_reverse_chronological_order() {
        let (_d, s) = fresh_storage().await;
        s.log_history("c1", "SELECT 1", Some(5), Some(1), None)
            .await
            .unwrap();
        s.log_history("c1", "SELECT 2", Some(10), Some(2), None)
            .await
            .unwrap();
        s.log_history("c2", "SELECT 3", None, None, Some("boom"))
            .await
            .unwrap();

        let h1 = s.list_history(Some("c1"), 10).await.unwrap();
        assert_eq!(h1.len(), 2);
        assert_eq!(h1[0].sql, "SELECT 2");
        assert_eq!(h1[1].sql, "SELECT 1");

        let h_all = s.list_history(None, 10).await.unwrap();
        assert_eq!(h_all.len(), 3);
        assert_eq!(h_all[0].error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn history_respects_limit() {
        let (_d, s) = fresh_storage().await;
        for i in 0..5 {
            s.log_history("c", &format!("SELECT {i}"), None, None, None)
                .await
                .unwrap();
        }
        let h = s.list_history(Some("c"), 2).await.unwrap();
        assert_eq!(h.len(), 2);
    }

    #[tokio::test]
    async fn clear_history_scopes_to_connection() {
        let (_d, s) = fresh_storage().await;
        s.log_history("c1", "SELECT 1", None, None, None)
            .await
            .unwrap();
        s.log_history("c2", "SELECT 2", None, None, None)
            .await
            .unwrap();
        s.clear_history(Some("c1")).await.unwrap();
        let remaining = s.list_history(None, 10).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].connection_id, "c2");
    }

    #[tokio::test]
    async fn clear_history_with_no_scope_wipes_everything() {
        let (_d, s) = fresh_storage().await;
        s.log_history("c1", "SELECT 1", None, None, None)
            .await
            .unwrap();
        s.log_history("c2", "SELECT 2", None, None, None)
            .await
            .unwrap();
        s.clear_history(None).await.unwrap();
        assert!(s.list_history(None, 10).await.unwrap().is_empty());
    }

    #[test]
    fn settings_store_is_thread_safe_for_read_write() {
        let store = SettingsStore::new(AppSettings::default());
        let snapshot = store.get();
        assert!(snapshot.pg_dump_path.is_none());

        let next = AppSettings {
            psql_path: Some("/bin/psql".into()),
            ..AppSettings::default()
        };
        store.set(next);
        assert_eq!(store.get().psql_path.as_deref(), Some("/bin/psql"));
    }
}
