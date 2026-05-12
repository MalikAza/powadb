use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::error::AppResult;
use crate::pool_registry::PoolHandle;
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Serialize)]
pub struct TableMeta {
    pub name: String,
    pub kind: String,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Serialize)]
pub struct SchemaMeta {
    pub name: String,
    pub tables: Vec<TableMeta>,
}

#[tauri::command]
pub async fn introspect_schema(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<SchemaMeta>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    match handle {
        PoolHandle::Postgres(pool) => {
            let rows = sqlx::query(
                r#"
                SELECT
                    c.table_schema::text   AS schema_name,
                    c.table_name::text     AS table_name,
                    c.column_name::text    AS column_name,
                    c.data_type::text      AS data_type,
                    (c.is_nullable = 'YES') AS nullable,
                    t.table_type::text     AS table_type
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY c.table_schema, c.table_name, c.ordinal_position
                "#,
            )
            .fetch_all(&pool)
            .await?;
            Ok(group_rows(rows.into_iter().map(|r| RowOut {
                schema: r.try_get::<String, _>("schema_name").unwrap_or_default(),
                table: r.try_get::<String, _>("table_name").unwrap_or_default(),
                column: r.try_get::<String, _>("column_name").unwrap_or_default(),
                data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                nullable: r.try_get::<bool, _>("nullable").unwrap_or(true),
                table_type: r.try_get::<String, _>("table_type").unwrap_or_default(),
            })))
        }
        PoolHandle::MySql(pool) => {
            let rows = sqlx::query(
                r#"
                SELECT
                    c.table_schema AS schema_name,
                    c.table_name   AS table_name,
                    c.column_name  AS column_name,
                    c.data_type    AS data_type,
                    (c.is_nullable = 'YES') AS nullable,
                    t.table_type   AS table_type
                FROM information_schema.columns c
                JOIN information_schema.tables t
                  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                WHERE c.table_schema = DATABASE()
                ORDER BY c.table_schema, c.table_name, c.ordinal_position
                "#,
            )
            .fetch_all(&pool)
            .await?;
            Ok(group_rows(rows.into_iter().map(|r| {
                RowOut {
                    schema: r.try_get::<String, _>("schema_name").unwrap_or_default(),
                    table: r.try_get::<String, _>("table_name").unwrap_or_default(),
                    column: r.try_get::<String, _>("column_name").unwrap_or_default(),
                    data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                    nullable: r
                        .try_get::<i64, _>("nullable")
                        .map(|x| x != 0)
                        .unwrap_or(true),
                    table_type: r.try_get::<String, _>("table_type").unwrap_or_default(),
                }
            })))
        }
        PoolHandle::Sqlite(pool) => {
            // sqlite_master lists tables/views; PRAGMA table_info gives columns.
            let tables = sqlx::query(
                r#"
                SELECT name, type FROM sqlite_master
                WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                ORDER BY type, name
                "#,
            )
            .fetch_all(&pool)
            .await?;

            let mut rows_out: Vec<RowOut> = Vec::new();
            for tr in tables {
                let name: String = tr.try_get("name").unwrap_or_default();
                let ttype: String = tr.try_get("type").unwrap_or_default();
                let pragma = format!("PRAGMA table_info(\"{}\")", name.replace('"', "\"\""));
                let cols = sqlx::query(&pragma).fetch_all(&pool).await?;
                for c in cols {
                    let column: String = c.try_get("name").unwrap_or_default();
                    let data_type: String = c.try_get("type").unwrap_or_default();
                    let notnull: i64 = c.try_get("notnull").unwrap_or(0);
                    rows_out.push(RowOut {
                        schema: "main".into(),
                        table: name.clone(),
                        column,
                        data_type,
                        nullable: notnull == 0,
                        table_type: if ttype == "view" {
                            "VIEW".into()
                        } else {
                            "BASE TABLE".into()
                        },
                    });
                }
            }
            Ok(group_rows(rows_out.into_iter()))
        }
    }
}

struct RowOut {
    schema: String,
    table: String,
    column: String,
    data_type: String,
    nullable: bool,
    table_type: String,
}

fn group_rows<I: Iterator<Item = RowOut>>(rows: I) -> Vec<SchemaMeta> {
    let mut schemas: Vec<SchemaMeta> = Vec::new();
    for r in rows {
        let schema = match schemas.iter_mut().find(|s| s.name == r.schema) {
            Some(s) => s,
            None => {
                schemas.push(SchemaMeta {
                    name: r.schema.clone(),
                    tables: Vec::new(),
                });
                schemas.last_mut().unwrap()
            }
        };
        let table = match schema.tables.iter_mut().find(|t| t.name == r.table) {
            Some(t) => t,
            None => {
                let kind = if r.table_type.eq_ignore_ascii_case("VIEW") {
                    "view"
                } else {
                    "table"
                };
                schema.tables.push(TableMeta {
                    name: r.table.clone(),
                    kind: kind.to_string(),
                    columns: Vec::new(),
                });
                schema.tables.last_mut().unwrap()
            }
        };
        table.columns.push(ColumnMeta {
            name: r.column,
            data_type: r.data_type,
            nullable: r.nullable,
        });
    }
    schemas
}
