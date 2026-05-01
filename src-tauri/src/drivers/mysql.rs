use std::time::Instant;

use serde_json::{json, Value};
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Row, TypeInfo};

use super::{Column as ColMeta, QueryResult};
use crate::error::{AppError, AppResult};

pub async fn connect(url: &str) -> AppResult<MySqlPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(5)
        .connect(url)
        .await?;
    Ok(pool)
}

pub async fn execute(pool: &MySqlPool, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let rows: Vec<MySqlRow> = sqlx::query(sql).fetch_all(pool).await?;

    let columns: Vec<ColMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| ColMeta {
                name: c.name().to_string(),
                type_name: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut json_rows: Vec<Vec<Value>> = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut out = Vec::with_capacity(row.columns().len());
        for (i, col) in row.columns().iter().enumerate() {
            out.push(decode_mysql(row, i, col.type_info().name())?);
        }
        json_rows.push(out);
    }

    Ok(QueryResult {
        columns,
        rows: json_rows,
        elapsed_ms: start.elapsed().as_millis(),
    })
}

fn decode_mysql(row: &MySqlRow, idx: usize, type_name: &str) -> AppResult<Value> {
    macro_rules! try_decode {
        ($ty:ty) => {{
            let v: Result<Option<$ty>, _> = row.try_get(idx);
            match v {
                Ok(Some(x)) => return Ok(json!(x)),
                Ok(None) => return Ok(Value::Null),
                Err(_) => {}
            }
        }};
    }

    match type_name {
        "BOOLEAN" | "TINYINT" => try_decode!(i8),
        "SMALLINT" => try_decode!(i16),
        "INT" | "MEDIUMINT" => try_decode!(i32),
        "BIGINT" => try_decode!(i64),
        "TINYINT UNSIGNED" => try_decode!(u8),
        "SMALLINT UNSIGNED" => try_decode!(u16),
        "INT UNSIGNED" | "MEDIUMINT UNSIGNED" => try_decode!(u32),
        "BIGINT UNSIGNED" => try_decode!(u64),
        "FLOAT" => try_decode!(f32),
        "DOUBLE" => try_decode!(f64),
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            try_decode!(String)
        }
        "JSON" => {
            let v: Result<Option<Value>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v { return Ok(x); }
            if let Ok(None) = v { return Ok(Value::Null); }
        }
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => {
            let v: Result<Option<Vec<u8>>, _> = row.try_get(idx);
            if let Ok(Some(b)) = v {
                let mut s = String::with_capacity(2 + b.len() * 2);
                s.push_str("0x");
                for byte in &b {
                    s.push_str(&format!("{:02X}", byte));
                }
                return Ok(json!(s));
            }
            if let Ok(None) = v { return Ok(Value::Null); }
        }
        "DATETIME" | "TIMESTAMP" => {
            let v: Result<Option<sqlx::types::chrono::NaiveDateTime>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v { return Ok(json!(x.to_string())); }
            if let Ok(None) = v { return Ok(Value::Null); }
        }
        "DATE" => {
            let v: Result<Option<sqlx::types::chrono::NaiveDate>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v { return Ok(json!(x.to_string())); }
            if let Ok(None) = v { return Ok(Value::Null); }
        }
        "TIME" => {
            let v: Result<Option<sqlx::types::chrono::NaiveTime>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v { return Ok(json!(x.to_string())); }
            if let Ok(None) = v { return Ok(Value::Null); }
        }
        "DECIMAL" | "NUMERIC" => {
            let v: Result<Option<sqlx::types::BigDecimal>, _> = row.try_get(idx);
            if let Ok(Some(x)) = v { return Ok(json!(x.to_string())); }
            if let Ok(None) = v { return Ok(Value::Null); }
        }
        _ => {}
    }

    let s: Result<Option<String>, _> = row.try_get(idx);
    match s {
        Ok(Some(x)) => Ok(Value::String(x)),
        Ok(None) => Ok(Value::Null),
        Err(_) => Err(AppError::UnsupportedType(type_name.to_string())),
    }
}
