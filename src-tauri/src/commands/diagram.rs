use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::engine::SqlPoolView;
use crate::error::{AppError, AppResult};
use crate::storage::{new_id, Diagram};
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
    #[serde(default)]
    pub indexes: Vec<DiagIndex>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiagIndex {
    pub name: String,
    pub is_unique: bool,
    pub is_primary: bool,
    pub columns: Vec<String>,
    pub method: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiagSequence {
    pub schema: String,
    pub name: String,
    pub data_type: String,
    pub owned_by_schema: Option<String>,
    pub owned_by_table: Option<String>,
    pub owned_by_column: Option<String>,
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
    #[serde(default)]
    pub sequences: Vec<DiagSequence>,
}

#[tauri::command]
pub async fn introspect_diagram(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
) -> AppResult<DiagramIntrospection> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => introspect_postgres(pool, schema.as_deref()).await,
        Some(SqlPoolView::Mysql(pool)) => introspect_mysql(pool).await,
        Some(SqlPoolView::Sqlite(pool)) => introspect_sqlite(pool).await,
        None => Err(AppError::Other(
            "introspect_diagram requires a SQL engine".into(),
        )),
    }
}

pub(crate) async fn introspect_postgres(
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

    // Indexes. `pg_index.indkey` is an int2vector of attnums in index column
    // order; we expand it through `generate_subscripts` to preserve order.
    let idx_sql = r#"
        SELECT
            n.nspname::text                                       AS schema_name,
            t.relname::text                                       AS table_name,
            i.relname::text                                       AS index_name,
            ix.indisunique                                        AS is_unique,
            ix.indisprimary                                       AS is_primary,
            am.amname::text                                       AS method,
            ARRAY(
                SELECT a.attname
                FROM generate_subscripts(ix.indkey, 1) AS s
                JOIN pg_attribute a
                  ON a.attrelid = t.oid AND a.attnum = ix.indkey[s]
                ORDER BY s
            )::text[]                                             AS columns
        FROM pg_index ix
        JOIN pg_class i        ON i.oid = ix.indexrelid
        JOIN pg_class t        ON t.oid = ix.indrelid
        JOIN pg_namespace n    ON n.oid = t.relnamespace
        JOIN pg_am am          ON am.oid = i.relam
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND t.relkind = 'r'
          AND ($1::text IS NULL OR n.nspname = $1::text)
        ORDER BY n.nspname, t.relname, i.relname
    "#;
    let idx_rows = sqlx::query(idx_sql)
        .bind(schema_filter)
        .fetch_all(pool)
        .await?;
    for r in idx_rows {
        let schema: String = r.try_get("schema_name").unwrap_or_default();
        let table: String = r.try_get("table_name").unwrap_or_default();
        let columns: Vec<String> = r.try_get("columns").unwrap_or_default();
        let idx = DiagIndex {
            name: r.try_get("index_name").unwrap_or_default(),
            is_unique: r.try_get("is_unique").unwrap_or(false),
            is_primary: r.try_get("is_primary").unwrap_or(false),
            columns,
            method: r.try_get("method").ok(),
        };
        if let Some(t) = tables
            .iter_mut()
            .find(|t| t.schema == schema && t.name == table)
        {
            t.indexes.push(idx);
        }
    }

    // Sequences. `pg_depend.deptype = 'a'` marks the auto-generated dependency
    // a serial/identity column creates between a sequence and its owning
    // column — that's how we attribute schema-level sequences to a table.
    let seq_sql = r#"
        SELECT
            s.sequence_schema::text                AS schema_name,
            s.sequence_name::text                  AS name,
            s.data_type::text                      AS data_type,
            dep.refobjschema                       AS owned_schema,
            dep.refobjtable                        AS owned_table,
            dep.refobjcolumn                       AS owned_column
        FROM information_schema.sequences s
        LEFT JOIN LATERAL (
            SELECT
                n2.nspname::text AS refobjschema,
                c2.relname::text AS refobjtable,
                a.attname::text  AS refobjcolumn
            FROM pg_class c
            JOIN pg_namespace n  ON n.oid = c.relnamespace
            JOIN pg_depend d
              ON d.objid = c.oid
             AND d.classid = 'pg_class'::regclass
             AND d.deptype = 'a'
            JOIN pg_class c2     ON c2.oid = d.refobjid
            JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
            JOIN pg_attribute a
              ON a.attrelid = c2.oid
             AND a.attnum   = d.refobjsubid
            WHERE n.nspname = s.sequence_schema
              AND c.relname = s.sequence_name
            LIMIT 1
        ) dep ON true
        WHERE s.sequence_schema NOT IN ('pg_catalog', 'information_schema')
          AND ($1::text IS NULL OR s.sequence_schema = $1::text)
        ORDER BY s.sequence_schema, s.sequence_name
    "#;
    let seq_rows = sqlx::query(seq_sql)
        .bind(schema_filter)
        .fetch_all(pool)
        .await?;
    let sequences: Vec<DiagSequence> = seq_rows
        .iter()
        .map(|r| DiagSequence {
            schema: r.try_get("schema_name").unwrap_or_default(),
            name: r.try_get("name").unwrap_or_default(),
            data_type: r.try_get("data_type").unwrap_or_default(),
            owned_by_schema: r.try_get("owned_schema").ok(),
            owned_by_table: r.try_get("owned_table").ok(),
            owned_by_column: r.try_get("owned_column").ok(),
        })
        .collect();

    Ok(DiagramIntrospection {
        tables,
        foreign_keys,
        sequences,
    })
}

pub(crate) async fn introspect_mysql(pool: &sqlx::MySqlPool) -> AppResult<DiagramIntrospection> {
    // CAST AS CHAR forces a non-binary string type so sqlx decodes the column
    // as `String` instead of `Vec<u8>` — see schema.rs for the full note.
    let col_sql = r#"
        SELECT
            CAST(c.table_schema AS CHAR) AS schema_name,
            CAST(c.table_name   AS CHAR) AS table_name,
            CAST(c.column_name  AS CHAR) AS column_name,
            CAST(c.data_type    AS CHAR) AS data_type,
            (c.is_nullable = 'YES')                AS nullable,
            CAST(c.column_default AS CHAR)         AS column_default,
            c.ordinal_position                     AS ordinal,
            c.character_maximum_length             AS char_max_len,
            c.numeric_precision                    AS numeric_precision,
            c.numeric_scale                        AS numeric_scale,
            (c.column_key = 'PRI')                 AS is_pk,
            CAST(t.table_type AS CHAR)             AS table_type
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
            CAST(kcu.constraint_schema      AS CHAR) AS constraint_schema,
            CAST(kcu.constraint_name        AS CHAR) AS constraint_name,
            CAST(kcu.table_schema           AS CHAR) AS from_schema,
            CAST(kcu.table_name             AS CHAR) AS from_table,
            CAST(kcu.column_name            AS CHAR) AS from_column,
            kcu.ordinal_position                     AS ordinal,
            CAST(kcu.referenced_table_schema AS CHAR) AS to_schema,
            CAST(kcu.referenced_table_name   AS CHAR) AS to_table,
            CAST(kcu.referenced_column_name  AS CHAR) AS to_column,
            CAST(rc.update_rule              AS CHAR) AS on_update,
            CAST(rc.delete_rule              AS CHAR) AS on_delete
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

    // Indexes via information_schema.statistics. Each index row appears once
    // per column, ordered by seq_in_index — we group as we read.
    let idx_sql = r#"
        SELECT
            CAST(table_schema AS CHAR) AS schema_name,
            CAST(table_name   AS CHAR) AS table_name,
            CAST(index_name   AS CHAR) AS index_name,
            CAST(index_type   AS CHAR) AS method,
            CAST(column_name  AS CHAR) AS column_name,
            (non_unique = 0)            AS is_unique,
            (index_name = 'PRIMARY')    AS is_primary,
            seq_in_index                AS seq
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
        ORDER BY table_schema, table_name, index_name, seq_in_index
    "#;
    let idx_rows = sqlx::query(idx_sql).fetch_all(pool).await?;
    for r in idx_rows {
        let schema: String = r.try_get("schema_name").unwrap_or_default();
        let table_name: String = r.try_get("table_name").unwrap_or_default();
        let index_name: String = r.try_get("index_name").unwrap_or_default();
        let column_name: String = r.try_get("column_name").unwrap_or_default();
        let is_unique = r
            .try_get::<i64, _>("is_unique")
            .map(|x| x != 0)
            .unwrap_or(false);
        let is_primary = r
            .try_get::<i64, _>("is_primary")
            .map(|x| x != 0)
            .unwrap_or(false);
        let method: Option<String> = r.try_get("method").ok();

        if let Some(t) = tables
            .iter_mut()
            .find(|t| t.schema == schema && t.name == table_name)
        {
            match t.indexes.iter_mut().find(|i| i.name == index_name) {
                Some(idx) => idx.columns.push(column_name),
                None => t.indexes.push(DiagIndex {
                    name: index_name,
                    is_unique,
                    is_primary,
                    columns: vec![column_name],
                    method,
                }),
            }
        }
    }

    Ok(DiagramIntrospection {
        tables,
        foreign_keys,
        sequences: Vec::new(),
    })
}

pub(crate) async fn introspect_sqlite(pool: &sqlx::SqlitePool) -> AppResult<DiagramIntrospection> {
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
            indexes: Vec::new(),
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
        // PRAGMA index_list: seq, name, unique, origin, partial
        // origin = 'pk' for primary-key auto indexes, 'u' for UNIQUE constraint,
        // 'c' for explicit CREATE INDEX. We surface all of them.
        let ilist_sql = format!("PRAGMA index_list(\"{}\")", safe);
        let ilist = sqlx::query(&ilist_sql).fetch_all(pool).await?;
        for ir in ilist {
            let iname: String = ir.try_get("name").unwrap_or_default();
            let uniq: i64 = ir.try_get("unique").unwrap_or(0);
            let origin: String = ir.try_get("origin").unwrap_or_default();
            let safe_idx = iname.replace('"', "\"\"");
            let info_sql = format!("PRAGMA index_info(\"{}\")", safe_idx);
            let icols = sqlx::query(&info_sql).fetch_all(pool).await?;
            let columns: Vec<String> = icols
                .iter()
                .map(|c| c.try_get::<String, _>("name").unwrap_or_default())
                .collect();
            table.indexes.push(DiagIndex {
                name: iname,
                is_unique: uniq != 0,
                is_primary: origin == "pk",
                columns,
                method: None,
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
        sequences: Vec::new(),
    })
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> AppResult<Vec<DiagFk>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    match handle.as_sql_pool() {
        Some(SqlPoolView::Postgres(pool)) => list_fks_postgres(pool, &schema, &table).await,
        Some(SqlPoolView::Mysql(pool)) => list_fks_mysql(pool, &table).await,
        Some(SqlPoolView::Sqlite(pool)) => list_fks_sqlite(pool, &table).await,
        None => Err(AppError::Other(
            "list_foreign_keys requires a SQL engine".into(),
        )),
    }
}

async fn list_fks_postgres(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> AppResult<Vec<DiagFk>> {
    let sql = r#"
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
          AND tc.table_schema = $1
          AND tc.table_name   = $2
        ORDER BY tc.constraint_schema, tc.constraint_name, kcu.ordinal_position
    "#;
    let rows = sqlx::query(sql)
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await?;
    Ok(group_fk_rows(rows.iter().map(|r| FkRow {
        constraint_schema: r.try_get("constraint_schema").unwrap_or_default(),
        constraint_name: r.try_get("constraint_name").unwrap_or_default(),
        from_schema: r.try_get("from_schema").unwrap_or_default(),
        from_table: r.try_get("from_table").unwrap_or_default(),
        from_column: r.try_get("from_column").unwrap_or_default(),
        to_schema: r.try_get("to_schema").unwrap_or_default(),
        to_table: r.try_get("to_table").unwrap_or_default(),
        to_column: r.try_get("to_column").unwrap_or_default(),
        on_update: r.try_get("on_update").ok(),
        on_delete: r.try_get("on_delete").ok(),
    })))
}

async fn list_fks_mysql(pool: &sqlx::MySqlPool, table: &str) -> AppResult<Vec<DiagFk>> {
    let sql = r#"
        SELECT
            CAST(kcu.constraint_schema       AS CHAR) AS constraint_schema,
            CAST(kcu.constraint_name         AS CHAR) AS constraint_name,
            CAST(kcu.table_schema            AS CHAR) AS from_schema,
            CAST(kcu.table_name              AS CHAR) AS from_table,
            CAST(kcu.column_name             AS CHAR) AS from_column,
            kcu.ordinal_position                      AS ordinal,
            CAST(kcu.referenced_table_schema AS CHAR) AS to_schema,
            CAST(kcu.referenced_table_name   AS CHAR) AS to_table,
            CAST(kcu.referenced_column_name  AS CHAR) AS to_column,
            CAST(rc.update_rule              AS CHAR) AS on_update,
            CAST(rc.delete_rule              AS CHAR) AS on_delete
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_schema = kcu.constraint_schema
         AND rc.constraint_name   = kcu.constraint_name
        WHERE kcu.referenced_table_name IS NOT NULL
          AND kcu.table_schema = DATABASE()
          AND kcu.table_name   = ?
        ORDER BY kcu.constraint_schema, kcu.constraint_name, kcu.ordinal_position
    "#;
    let rows = sqlx::query(sql).bind(table).fetch_all(pool).await?;
    Ok(group_fk_rows(rows.iter().map(|r| FkRow {
        constraint_schema: r.try_get("constraint_schema").unwrap_or_default(),
        constraint_name: r.try_get("constraint_name").unwrap_or_default(),
        from_schema: r.try_get("from_schema").unwrap_or_default(),
        from_table: r.try_get("from_table").unwrap_or_default(),
        from_column: r.try_get("from_column").unwrap_or_default(),
        to_schema: r.try_get("to_schema").unwrap_or_default(),
        to_table: r.try_get("to_table").unwrap_or_default(),
        to_column: r.try_get("to_column").unwrap_or_default(),
        on_update: r.try_get("on_update").ok(),
        on_delete: r.try_get("on_delete").ok(),
    })))
}

async fn list_fks_sqlite(pool: &sqlx::SqlitePool, table: &str) -> AppResult<Vec<DiagFk>> {
    let safe = table.replace('"', "\"\"");
    let pragma = format!("PRAGMA foreign_key_list(\"{}\")", safe);
    let rows = sqlx::query(&pragma).fetch_all(pool).await?;
    let mut foreign_keys: Vec<DiagFk> = Vec::new();
    for f in rows {
        let fid: i64 = f.try_get("id").unwrap_or(0);
        let to_table: String = f.try_get("table").unwrap_or_default();
        let from_col: String = f.try_get("from").unwrap_or_default();
        let to_col: String = f.try_get("to").unwrap_or_default();
        let on_update: Option<String> = f.try_get("on_update").ok();
        let on_delete: Option<String> = f.try_get("on_delete").ok();
        let id = format!("{table}__fk__{fid}");
        match foreign_keys.iter_mut().find(|fk| fk.id == id) {
            Some(fk) => {
                fk.from_columns.push(from_col);
                fk.to_columns.push(to_col);
            }
            None => foreign_keys.push(DiagFk {
                id,
                name: None,
                from_schema: "main".into(),
                from_table: table.to_string(),
                from_columns: vec![from_col],
                to_schema: "main".into(),
                to_table,
                to_columns: vec![to_col],
                on_update,
                on_delete,
            }),
        }
    }
    Ok(foreign_keys)
}

struct FkRow {
    constraint_schema: String,
    constraint_name: String,
    from_schema: String,
    from_table: String,
    from_column: String,
    to_schema: String,
    to_table: String,
    to_column: String,
    on_update: Option<String>,
    on_delete: Option<String>,
}

fn group_fk_rows(rows: impl Iterator<Item = FkRow>) -> Vec<DiagFk> {
    let mut out: Vec<DiagFk> = Vec::new();
    for r in rows {
        let id = format!("{}.{}", r.constraint_schema, r.constraint_name);
        match out.iter_mut().find(|f| f.id == id) {
            Some(fk) => {
                fk.from_columns.push(r.from_column);
                fk.to_columns.push(r.to_column);
            }
            None => out.push(DiagFk {
                id,
                name: Some(r.constraint_name),
                from_schema: r.from_schema,
                from_table: r.from_table,
                from_columns: vec![r.from_column],
                to_schema: r.to_schema,
                to_table: r.to_table,
                to_columns: vec![r.to_column],
                on_update: r.on_update,
                on_delete: r.on_delete,
            }),
        }
    }
    out
}

#[derive(Debug, Deserialize)]
pub struct DiagramInput {
    #[serde(default)]
    pub id: Option<String>,
    pub connection_id: String,
    pub name: String,
    pub doc_json: String,
}

#[tauri::command]
pub async fn list_diagrams(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<Diagram>> {
    state.storage.list_diagrams(&connection_id).await
}

#[tauri::command]
pub async fn get_diagram(state: State<'_, AppState>, id: String) -> AppResult<Option<Diagram>> {
    state.storage.get_diagram(&id).await
}

#[tauri::command]
pub async fn save_diagram(state: State<'_, AppState>, input: DiagramInput) -> AppResult<Diagram> {
    let diagram = Diagram {
        id: input.id.unwrap_or_else(new_id),
        connection_id: input.connection_id,
        name: input.name,
        doc_json: input.doc_json,
        created_at: String::new(),
        updated_at: String::new(),
    };
    state.storage.upsert_diagram(&diagram).await
}

#[tauri::command]
pub async fn delete_diagram(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.storage.delete_diagram(&id).await
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
        indexes: Vec::new(),
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

    fn fk_row(constraint: &str, from_col: &str, to_col: &str) -> FkRow {
        FkRow {
            constraint_schema: "public".into(),
            constraint_name: constraint.into(),
            from_schema: "public".into(),
            from_table: "books".into(),
            from_column: from_col.into(),
            to_schema: "public".into(),
            to_table: "authors".into(),
            to_column: to_col.into(),
            on_update: None,
            on_delete: None,
        }
    }

    #[test]
    fn group_fk_rows_merges_composite_constraints() {
        let rows = vec![
            fk_row("fk_books_authors", "author_id_a", "id_a"),
            fk_row("fk_books_authors", "author_id_b", "id_b"),
        ];
        let grouped = group_fk_rows(rows.into_iter());
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].id, "public.fk_books_authors");
        assert_eq!(grouped[0].from_columns, vec!["author_id_a", "author_id_b"]);
        assert_eq!(grouped[0].to_columns, vec!["id_a", "id_b"]);
    }

    #[test]
    fn group_fk_rows_keeps_distinct_constraints_separate() {
        let rows = vec![fk_row("fk_one", "a", "id"), fk_row("fk_two", "b", "id")];
        let grouped = group_fk_rows(rows.into_iter());
        assert_eq!(grouped.len(), 2);
        let names: Vec<_> = grouped.iter().map(|f| f.id.as_str()).collect();
        assert!(names.contains(&"public.fk_one"));
        assert!(names.contains(&"public.fk_two"));
    }

    #[test]
    fn group_fk_rows_preserves_on_update_and_on_delete() {
        let rows = vec![FkRow {
            constraint_schema: "s".into(),
            constraint_name: "fk".into(),
            from_schema: "s".into(),
            from_table: "t".into(),
            from_column: "x".into(),
            to_schema: "s".into(),
            to_table: "u".into(),
            to_column: "y".into(),
            on_update: Some("CASCADE".into()),
            on_delete: Some("RESTRICT".into()),
        }];
        let grouped = group_fk_rows(rows.into_iter());
        assert_eq!(grouped[0].on_update.as_deref(), Some("CASCADE"));
        assert_eq!(grouped[0].on_delete.as_deref(), Some("RESTRICT"));
    }

    #[test]
    fn upsert_table_reuses_existing_entry_when_schema_and_name_match() {
        let mut tables: Vec<DiagTable> = Vec::new();
        upsert_table(&mut tables, "public", "users")
            .columns
            .push(DiagColumn {
                name: "id".into(),
                data_type: "int".into(),
                nullable: false,
                is_pk: true,
                default: None,
                ordinal: 1,
                char_max_len: None,
                numeric_precision: None,
                numeric_scale: None,
            });
        // Calling again with the same identity should not append a new table.
        upsert_table(&mut tables, "public", "users")
            .columns
            .push(DiagColumn {
                name: "email".into(),
                data_type: "text".into(),
                nullable: true,
                is_pk: false,
                default: None,
                ordinal: 2,
                char_max_len: None,
                numeric_precision: None,
                numeric_scale: None,
            });
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].columns.len(), 2);
    }

    #[test]
    fn upsert_table_appends_when_identity_differs() {
        let mut tables: Vec<DiagTable> = Vec::new();
        upsert_table(&mut tables, "public", "a");
        upsert_table(&mut tables, "public", "b");
        upsert_table(&mut tables, "other", "a");
        assert_eq!(tables.len(), 3);
    }
}
