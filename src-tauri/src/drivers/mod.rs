pub mod mysql;
pub mod postgres;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, Clone)]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub elapsed_ms: u128,
}
