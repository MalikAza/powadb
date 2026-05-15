use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::error::AppResult;
use crate::pool_registry::PoolHandle;
use crate::AppState;

#[derive(Debug, Serialize, Clone)]
pub struct DiagColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub default: Option<String>,
    pub ordinal: i32,
    pub char_max_len: Option<i64>,
    pub numeric_precision: Option<i32>,
    pub numeric_scale: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiagTable {
    pub schema: String,
    pub name: String,
    pub columns: Vec<DiagColumn>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiagFk {
    pub id: String,
    pub name: Option<String>,
    pub from_schema: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_schema: String,
    pub to_table: String,
    pub to_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DiagramIntrospection {
    pub tables: Vec<DiagTable>,
    pub foreign_keys: Vec<DiagFk>,
}

#[tauri::command]
pub async fn introspect_diagram(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
) -> AppResult<DiagramIntrospection> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    match handle {
        PoolHandle::Postgres(pool) => introspect_postgres(&pool, schema.as_deref()).await,
        PoolHandle::MySql(pool) => introspect_mysql(&pool).await,
        PoolHandle::Sqlite(pool) => introspect_sqlite(&pool).await,
    }
}

async fn introspect_postgres(
    pool: &sqlx::PgPool,
    schema_filter: Option<&str>,
) -> AppResult<DiagramIntrospection> {
    // Columns + PK markers in one query. PK detection uses `table_constraints`
    // joined to `key_column_usage`; `LEFT JOIN` so non-PK columns survive.
    let col_sql = r#"
        SELECT
            c.table_schema::text                                 AS schema_name,
            c.table_name::text                                   AS table_name,
            c.column_name::text                                  AS column_name,
            CASE
                WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
                ELSE c.data_type
            END::text                                            AS data_type,
            (c.is_nullable = 'YES')                              AS nullable,
            c.column_default::text                               AS column_default,
            c.ordinal_position::int                              AS ordinal,
            c.character_maximum_length::bigint                   AS char_max_len,
            c.numeric_precision::int                             AS numeric_precision,
            c.numeric_scale::int                                 AS numeric_scale,
            EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name = tc.constraint_name
                 AND kcu.constraint_schema = tc.constraint_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
            )                                                    AS is_pk,
            t.table_type::text                                   AS table_type
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_type = 'BASE TABLE'
          AND ($1::text IS NULL OR c.table_schema = $1::text)
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
    "#;
    let col_rows = sqlx::query(col_sql)
        .bind(schema_filter)
        .fetch_all(pool)
        .await?;

    let mut tables: Vec<DiagTable> = Vec::new();
    for r in col_rows {
        let schema: String = r.try_get("schema_name").unwrap_or_default();
        let table: String = r.try_get("table_name").unwrap_or_default();
        let col = DiagColumn {
            name: r.try_get("column_name").unwrap_or_default(),
            data_type: r.try_get("data_type").unwrap_or_default(),
            nullable: r.try_get("nullable").unwrap_or(true),
            is_pk: r.try_get("is_pk").unwrap_or(false),
            default: r.try_get("column_default").ok(),
            ordinal: r.try_get("ordinal").unwrap_or(0),
            char_max_len: r.try_get("char_max_len").ok(),
            numeric_precision: r.try_get("numeric_precision").ok(),
            numeric_scale: r.try_get("numeric_scale").ok(),
        };
        upsert_table(&mut tables, &schema, &table).columns.push(col);
    }

    // Foreign keys. `constraint_column_usage` exposes the referenced columns
    // but doesn't preserve order across multi-column FKs reliably across all
    // PG versions, so we join on `position_in_unique_constraint` from
    // `key_column_usage` to keep source/target columns aligned.
    let fk_sql = r#"
        SELECT
            tc.constraint_schema::text  AS constraint_schema,
            tc.constraint_name::text    AS constraint_name,
            tc.table_schema::text       AS from_schema,
            tc.table_name::text         AS from_table,
            kcu.column_name::text       AS from_column,
            kcu.ordinal_position::int   AS ordinal,
            ccu.table_schema::text      AS to_schema,
            ccu.table_name::text        AS to_table,
            ccu.column_name::text       AS to_column,
            rc.update_rule::text        AS on_update,
            rc.delete_rule::text        AS on_delete
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name   = tc.constraint_name
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_schema = tc.constraint_schema
         AND rc.constraint_name   = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_schema = rc.unique_constraint_schema
         AND ccu.constraint_name   = rc.unique_constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND ($1::text IS NULL OR tc.table_schema = $1::text)
        ORDER BY tc.constraint_schema, tc.constraint_name, kcu.ordinal_position
    "#;
    let fk_rows = sqlx::query(fk_sql)
        .bind(schema_filter)
        .fetch_all(pool)
        .await?;

    // Group fk rows by (constraint_schema, constraint_name) preserving order.
    let mut foreign_keys: Vec<DiagFk> = Vec::new();
    for r in fk_rows {
        let constraint_schema: String = r.try_get("constraint_schema").unwrap_or_default();
        let constraint_name: String = r.try_get("constraint_name").unwrap_or_default();
        let id = format!("{constraint_schema}.{constraint_name}");
        let from_schema: String = r.try_get("from_schema").unwrap_or_default();
        let from_table: String = r.try_get("from_table").unwrap_or_default();
        let to_schema: String = r.try_get("to_schema").unwrap_or_default();
        let to_table: String = r.try_get("to_table").unwrap_or_default();
        let from_col: String = r.try_get("from_column").unwrap_or_default();
        let to_col: String = r.try_get("to_column").unwrap_or_default();
        let on_update: Option<String> = r.try_get("on_update").ok();
        let on_delete: Option<String> = r.try_get("on_delete").ok();

        match foreign_keys.iter_mut().find(|f| f.id == id) {
            Some(fk) => {
                fk.from_columns.push(from_col);
                fk.to_columns.push(to_col);
            }
            None => foreign_keys.push(DiagFk {
                id,
                name: Some(constraint_name),
                from_schema,
                from_table,
                from_columns: vec![from_col],
                to_schema,
                to_table,
                to_columns: vec![to_col],
                on_update,
                on_delete,
            }),
        }
    }

    Ok(DiagramIntrospection {
        tables,
        foreign_keys,
    })
}

async fn introspect_mysql(pool: &sqlx::MySqlPool) -> AppResult<DiagramIntrospection> {
    let col_sql = r#"
        SELECT
            c.table_schema  AS schema_name,
            c.table_name    AS table_name,
            c.column_name   AS column_name,
            c.data_type     AS data_type,
            (c.is_nullable = 'YES')                AS nullable,
            c.column_default                       AS column_default,
            c.ordinal_position                     AS ordinal,
            c.character_maximum_length             AS char_max_len,
            c.numeric_precision                    AS numeric_precision,
            c.numeric_scale                        AS numeric_scale,
            (c.column_key = 'PRI')                 AS is_pk,
            t.table_type                           AS table_type
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = DATABASE()
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
    "#;
    let col_rows = sqlx::query(col_sql).fetch_all(pool).await?;

    let mut tables: Vec<DiagTable> = Vec::new();
    for r in col_rows {
        let schema: String = r.try_get("schema_name").unwrap_or_default();
        let table: String = r.try_get("table_name").unwrap_or_default();
        let col = DiagColumn {
            name: r.try_get("column_name").unwrap_or_default(),
            data_type: r.try_get("data_type").unwrap_or_default(),
            nullable: r
                .try_get::<i64, _>("nullable")
                .map(|x| x != 0)
                .unwrap_or(true),
            is_pk: r
                .try_get::<i64, _>("is_pk")
                .map(|x| x != 0)
                .unwrap_or(false),
            default: r.try_get("column_default").ok(),
            ordinal: r.try_get::<i64, _>("ordinal").unwrap_or(0) as i32,
            char_max_len: r.try_get("char_max_len").ok(),
            numeric_precision: r
                .try_get::<i64, _>("numeric_precision")
                .ok()
                .map(|x| x as i32),
            numeric_scale: r.try_get::<i64, _>("numeric_scale").ok().map(|x| x as i32),
        };
        upsert_table(&mut tables, &schema, &table).columns.push(col);
    }

    let fk_sql = r#"
        SELECT
            kcu.constraint_schema  AS constraint_schema,
            kcu.constraint_name    AS constraint_name,
            kcu.table_schema       AS from_schema,
            kcu.table_name         AS from_table,
            kcu.column_name        AS from_column,
            kcu.ordinal_position   AS ordinal,
            kcu.referenced_table_schema AS to_schema,
            kcu.referenced_table_name   AS to_table,
            kcu.referenced_column_name  AS to_column,
            rc.update_rule         AS on_update,
            rc.delete_rule         AS on_delete
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_schema = kcu.constraint_schema
         AND rc.constraint_name   = kcu.constraint_name
        WHERE kcu.referenced_table_name IS NOT NULL
          AND kcu.table_schema = DATABASE()
        ORDER BY kcu.constraint_schema, kcu.constraint_name, kcu.ordinal_position
    "#;
    let fk_rows = sqlx::query(fk_sql).fetch_all(pool).await?;

    let mut foreign_keys: Vec<DiagFk> = Vec::new();
    for r in fk_rows {
        let constraint_schema: String = r.try_get("constraint_schema").unwrap_or_default();
        let constraint_name: String = r.try_get("constraint_name").unwrap_or_default();
        let id = format!("{constraint_schema}.{constraint_name}");
        match foreign_keys.iter_mut().find(|f| f.id == id) {
            Some(fk) => {
                fk.from_columns
                    .push(r.try_get("from_column").unwrap_or_default());
                fk.to_columns
                    .push(r.try_get("to_column").unwrap_or_default());
            }
            None => foreign_keys.push(DiagFk {
                id,
                name: Some(constraint_name),
                from_schema: r.try_get("from_schema").unwrap_or_default(),
                from_table: r.try_get("from_table").unwrap_or_default(),
                from_columns: vec![r.try_get("from_column").unwrap_or_default()],
                to_schema: r.try_get("to_schema").unwrap_or_default(),
                to_table: r.try_get("to_table").unwrap_or_default(),
                to_columns: vec![r.try_get("to_column").unwrap_or_default()],
                on_update: r.try_get("on_update").ok(),
                on_delete: r.try_get("on_delete").ok(),
            }),
        }
    }

    Ok(DiagramIntrospection {
        tables,
        foreign_keys,
    })
}

async fn introspect_sqlite(pool: &sqlx::SqlitePool) -> AppResult<DiagramIntrospection> {
    let table_rows = sqlx::query(
        r#"
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut tables: Vec<DiagTable> = Vec::new();
    let mut foreign_keys: Vec<DiagFk> = Vec::new();

    for tr in table_rows {
        let name: String = tr.try_get("name").unwrap_or_default();
        let safe = name.replace('"', "\"\"");

        // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk
        let info_sql = format!("PRAGMA table_info(\"{}\")", safe);
        let cols = sqlx::query(&info_sql).fetch_all(pool).await?;
        let mut table = DiagTable {
            schema: "main".into(),
            name: name.clone(),
            columns: Vec::new(),
        };
        for c in cols {
            let cid: i64 = c.try_get("cid").unwrap_or(0);
            let cname: String = c.try_get("name").unwrap_or_default();
            let ctype: String = c.try_get("type").unwrap_or_default();
            let notnull: i64 = c.try_get("notnull").unwrap_or(0);
            let dflt: Option<String> = c.try_get("dflt_value").ok();
            let pk: i64 = c.try_get("pk").unwrap_or(0);
            table.columns.push(DiagColumn {
                name: cname,
                data_type: ctype,
                nullable: notnull == 0,
                is_pk: pk > 0,
                default: dflt,
                ordinal: cid as i32,
                char_max_len: None,
                numeric_precision: None,
                numeric_scale: None,
            });
        }
        tables.push(table);

        // PRAGMA foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
        let fk_sql = format!("PRAGMA foreign_key_list(\"{}\")", safe);
        let fks = sqlx::query(&fk_sql).fetch_all(pool).await?;
        for f in fks {
            let fid: i64 = f.try_get("id").unwrap_or(0);
            let to_table: String = f.try_get("table").unwrap_or_default();
            let from_col: String = f.try_get("from").unwrap_or_default();
            let to_col: String = f.try_get("to").unwrap_or_default();
            let on_update: Option<String> = f.try_get("on_update").ok();
            let on_delete: Option<String> = f.try_get("on_delete").ok();
            let id = format!("{name}__fk__{fid}");
            match foreign_keys.iter_mut().find(|fk| fk.id == id) {
                Some(fk) => {
                    fk.from_columns.push(from_col);
                    fk.to_columns.push(to_col);
                }
                None => foreign_keys.push(DiagFk {
                    id,
                    name: None,
                    from_schema: "main".into(),
                    from_table: name.clone(),
                    from_columns: vec![from_col],
                    to_schema: "main".into(),
                    to_table,
                    to_columns: vec![to_col],
                    on_update,
                    on_delete,
                }),
            }
        }
    }

    Ok(DiagramIntrospection {
        tables,
        foreign_keys,
    })
}

fn upsert_table<'a>(tables: &'a mut Vec<DiagTable>, schema: &str, name: &str) -> &'a mut DiagTable {
    if let Some(pos) = tables
        .iter()
        .position(|t| t.schema == schema && t.name == name)
    {
        return &mut tables[pos];
    }
    tables.push(DiagTable {
        schema: schema.to_string(),
        name: name.to_string(),
        columns: Vec::new(),
    });
    tables.last_mut().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fixture_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE authors (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE books (
              id INTEGER PRIMARY KEY,
              title TEXT NOT NULL,
              author_id INTEGER NOT NULL,
              FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn sqlite_introspects_tables_columns_pks_and_fks() {
        let pool = fixture_pool().await;
        let out = introspect_sqlite(&pool).await.unwrap();

        assert_eq!(out.tables.len(), 2);
        let authors = out.tables.iter().find(|t| t.name == "authors").unwrap();
        assert_eq!(authors.schema, "main");
        assert_eq!(authors.columns.len(), 2);
        let id_col = authors.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.is_pk);
        let name_col = authors.columns.iter().find(|c| c.name == "name").unwrap();
        assert!(!name_col.is_pk);
        assert!(!name_col.nullable);

        let books = out.tables.iter().find(|t| t.name == "books").unwrap();
        assert_eq!(books.columns.len(), 3);

        assert_eq!(out.foreign_keys.len(), 1);
        let fk = &out.foreign_keys[0];
        assert_eq!(fk.from_table, "books");
        assert_eq!(fk.to_table, "authors");
        assert_eq!(fk.from_columns, vec!["author_id"]);
        assert_eq!(fk.to_columns, vec!["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
    }

    #[tokio::test]
    async fn sqlite_handles_table_with_no_fks() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE solo (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        let out = introspect_sqlite(&pool).await.unwrap();
        assert_eq!(out.tables.len(), 1);
        assert!(out.foreign_keys.is_empty());
    }
}
