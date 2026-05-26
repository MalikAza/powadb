use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, State};

use crate::drivers::{QueryResult, ScriptResult};
use crate::engine::{EngineQuery, EngineResult};
use crate::error::{AppError, AppResult};
use crate::pool_registry::{run_engine_with_cancel, run_script_with_cancel, run_with_cancel};
use crate::AppState;

/// Fires on the first storage-side failure to persist a query-history row.
/// The eprintln still happens every time (so the dev terminal shows the full
/// trail), but we only emit the frontend event once per session — the
/// frontend's job is to show a one-off "your history isn't being saved"
/// banner, not to spam toasts on every query.
pub const HISTORY_DEGRADED_EVENT: &str = "history-degraded";

static HISTORY_WARNED: AtomicBool = AtomicBool::new(false);

/// Wrap `Storage::log_history` so a failure is observable instead of
/// silently dropped. Errors are logged to stderr; the first failure also
/// emits a one-shot `history-degraded` event so the frontend can surface
/// the regression to the user.
async fn try_log_history(
    state: &AppState,
    app: &AppHandle,
    connection_id: &str,
    sql: &str,
    elapsed_ms: Option<i64>,
    row_count: Option<i64>,
    error: Option<&str>,
) {
    if let Err(e) = state
        .storage
        .log_history(connection_id, sql, elapsed_ms, row_count, error)
        .await
    {
        eprintln!("query: failed to log history for {connection_id}: {e}");
        if !HISTORY_WARNED.swap(true, Ordering::Relaxed) {
            let _ = app.emit(HISTORY_DEGRADED_EVENT, e.to_string());
        }
    }
}

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    query_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let result = run_with_cancel(&state.pools, handle, &query_id, &sql).await;

    match &result {
        Ok(r) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &sql,
                Some(r.elapsed_ms as i64),
                Some(r.rows.len() as i64),
                None,
            )
            .await;
        }
        Err(AppError::Canceled) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &sql,
                None,
                None,
                Some("canceled"),
            )
            .await;
        }
        Err(e) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &sql,
                None,
                None,
                Some(&e.to_string()),
            )
            .await;
        }
    }

    result
}

#[tauri::command]
pub async fn run_script(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    query_id: String,
    sql: String,
) -> AppResult<ScriptResult> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let result = run_script_with_cancel(&state.pools, handle, &query_id, &sql).await;

    // Log each statement separately so the history view shows the actual
    // statements the user ran, not the concatenated source.
    match &result {
        Ok(r) => {
            for s in &r.statements {
                let rows = s.result.as_ref().map(|q| q.rows.len() as i64).or_else(|| {
                    s.rows_affected
                        .map(|n| i64::try_from(n).unwrap_or(i64::MAX))
                });
                try_log_history(
                    &state,
                    &app,
                    &connection_id,
                    &s.sql_excerpt,
                    Some(s.elapsed_ms as i64),
                    rows,
                    s.error.as_deref(),
                )
                .await;
            }
        }
        Err(AppError::Canceled) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &sql,
                None,
                None,
                Some("canceled"),
            )
            .await;
        }
        Err(e) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &sql,
                None,
                None,
                Some(&e.to_string()),
            )
            .await;
        }
    }

    result
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, query_id: String) -> AppResult<bool> {
    Ok(state.pools.fire_cancel(&query_id).await)
}

/// Engine-agnostic query path. Routes through `Engine::execute_query`, which
/// SQL engines satisfy via their existing `execute()` and Mongo overrides for
/// `MongoOp` dispatch. Used by the frontend when `capabilities.query_language`
/// isn't SQL — SQL connections keep using `run_query` for now (the migration
/// is incremental).
///
/// History logging: the `query_history` table stores a single `sql` text
/// column. For Mongo we serialize the `MongoOp` to a JSON one-liner so the
/// history view shows a readable representation (the `parseMongoOp` helper
/// on the frontend round-trips it back to a runnable form).
#[tauri::command]
pub async fn run_engine_query(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    query_id: String,
    query: EngineQuery,
) -> AppResult<EngineResult> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let history_text = engine_query_history_text(&query);
    let result = run_engine_with_cancel(&state.pools, handle, &query_id, query).await;

    match &result {
        Ok(r) => {
            let (rows, elapsed) = match r {
                EngineResult::Tabular(q) => (Some(q.rows.len() as i64), Some(q.elapsed_ms as i64)),
                EngineResult::Documents { docs, elapsed_ms } => {
                    (Some(docs.len() as i64), Some(*elapsed_ms as i64))
                }
                EngineResult::Affected { rows, elapsed_ms } => {
                    (Some(*rows as i64), Some(*elapsed_ms as i64))
                }
            };
            try_log_history(
                &state,
                &app,
                &connection_id,
                &history_text,
                elapsed,
                rows,
                None,
            )
            .await;
        }
        Err(AppError::Canceled) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &history_text,
                None,
                None,
                Some("canceled"),
            )
            .await;
        }
        Err(e) => {
            try_log_history(
                &state,
                &app,
                &connection_id,
                &history_text,
                None,
                None,
                Some(&e.to_string()),
            )
            .await;
        }
    }

    result
}

/// Render an `EngineQuery` as a single line suitable for the history view.
/// SQL queries are stored verbatim; Mongo ops are JSON-serialized.
fn engine_query_history_text(q: &EngineQuery) -> String {
    match q {
        EngineQuery::Sql(s) => s.clone(),
        EngineQuery::Mongo(op) => serde_json::to_string(op)
            .unwrap_or_else(|_| format!("<unserializable mongo op: {op:?}>")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::MongoOp;
    use serde_json::json;

    #[test]
    fn history_text_passes_sql_through_verbatim() {
        let q = EngineQuery::Sql("SELECT 1 -- comment".into());
        assert_eq!(engine_query_history_text(&q), "SELECT 1 -- comment");
    }

    #[test]
    fn history_text_serializes_mongo_op_as_json() {
        let q = EngineQuery::Mongo(Box::new(MongoOp::Find {
            collection: "users".into(),
            database: None,
            filter: json!({ "active": true }),
            projection: None,
            limit: Some(10),
            skip: None,
            sort: None,
        }));
        let text = engine_query_history_text(&q);
        // Must round-trip back to a MongoOp so the history view's
        // "re-run" affordance keeps working.
        let back: MongoOp = serde_json::from_str(&text).unwrap();
        assert!(matches!(back, MongoOp::Find { .. }));
        assert!(text.contains("\"users\""));
        assert!(text.contains("\"active\""));
    }

    #[test]
    fn history_text_for_run_command_is_a_one_liner() {
        let q = EngineQuery::Mongo(Box::new(MongoOp::RunCommand {
            value: json!({ "ping": 1 }),
        }));
        let text = engine_query_history_text(&q);
        assert!(
            !text.contains('\n'),
            "history text must stay on one line: {text}"
        );
        assert!(text.contains("\"ping\""));
    }
}
