//! S3 / object-storage commands.
//!
//! The object-browser counterpart to the SQL `query`/`schema` commands. Each
//! resolves the live engine via the pool registry and reaches the S3 client
//! through `as_s3()`; a non-S3 connection is rejected with a consistent
//! `Unsupported` error (the UI gates these off by connection kind anyway).

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::engine::s3::{BucketInfo, Listing, ObjectMetadata, ObjectPreview, S3Engine};
use crate::engine::EngineHandle;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// Default preview window: 1 MiB. Enough to render text/JSON and most images
/// inline without ever pulling a large object into memory.
const DEFAULT_PREVIEW_BYTES: u64 = 1024 * 1024;

/// Borrow the S3 engine from a handle, or fail with a consistent error.
fn require_s3(handle: &EngineHandle) -> AppResult<&S3Engine> {
    handle
        .as_s3()
        .ok_or_else(|| AppError::unsupported("object storage", handle.kind().as_str()))
}

#[tauri::command]
pub async fn s3_list_buckets(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<BucketInfo>> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?.list_buckets().await
}

#[tauri::command]
pub async fn s3_list_objects(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    prefix: String,
    continuation_token: Option<String>,
) -> AppResult<Listing> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?
        .list_objects(&bucket, &prefix, continuation_token)
        .await
}

#[tauri::command]
pub async fn s3_object_meta(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> AppResult<ObjectMetadata> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?.object_meta(&bucket, &key).await
}

#[tauri::command]
pub async fn s3_preview_object(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    max_bytes: Option<u64>,
) -> AppResult<ObjectPreview> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?
        .preview_object(&bucket, &key, max_bytes.unwrap_or(DEFAULT_PREVIEW_BYTES))
        .await
}

/// Progress event for a streaming download. Emitted on the
/// `s3-download-progress` channel; the frontend keys updates by `job_id`.
#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    job_id: String,
    bytes_done: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadSummary {
    pub bytes: u64,
}

#[tauri::command]
pub async fn s3_download_object(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    bucket: String,
    key: String,
    dest_path: String,
    job_id: String,
) -> AppResult<DownloadSummary> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let cancel = state.jobs.register(&job_id).await;
    let result = {
        let s3 = require_s3(&handle)?;
        let app = app.clone();
        let job_id_for_progress = job_id.clone();
        s3.download_object(&bucket, &key, &dest_path, &cancel, move |bytes_done| {
            // Best-effort progress; a failed emit must not abort the download.
            let _ = app.emit(
                "s3-download-progress",
                DownloadProgress {
                    job_id: job_id_for_progress.clone(),
                    bytes_done,
                },
            );
        })
        .await
    };
    state.jobs.forget(&job_id).await;
    // `download_object` already removes the partial file on cancel.
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Canceled);
    }
    result.map(|bytes| DownloadSummary { bytes })
}
