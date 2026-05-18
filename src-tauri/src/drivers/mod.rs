pub mod mysql;
pub mod postgres;
pub mod sqlite;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, Clone)]
pub struct Column {
    pub name: String,
    pub type_name: String,
    /// Origin of this result column when it can be traced back to a real
    /// table column (i.e. not the result of an expression). Currently only
    /// populated by the Postgres driver, which reads `relation_id` /
    /// `relation_attribute_no` from sqlx's row description and resolves the
    /// OID + attnum against `pg_catalog`. MySQL's sqlx driver doesn't expose
    /// `org_table` / `org_name`, so those columns stay `None` there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub elapsed_ms: u128,
}
