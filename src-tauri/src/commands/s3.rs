//! S3 / object-storage commands.
//!
//! The object-browser counterpart to the SQL `query`/`schema` commands. Each
//! resolves the live engine via the pool registry and reaches the S3 client
//! through `as_s3()`; a non-S3 connection is rejected with a consistent
//! `Unsupported` error (the UI gates these off by connection kind anyway).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::engine::s3::{BucketInfo, Listing, ObjectMetadata, ObjectPreview, S3Engine};
use crate::engine::EngineHandle;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// Default preview window: 1 MiB. Enough to render text/JSON and most images
/// inline without ever pulling a large object into memory.
const DEFAULT_PREVIEW_BYTES: u64 = 1024 * 1024;

/// Cap on archive entries returned for the in-app explorer, to stay responsive
/// on archives with very many members.
const MAX_ARCHIVE_ENTRIES: usize = 5000;

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

// ─── Preview caching ────────────────────────────────────────────────────────

/// Local path of an object's preview cache file, mirroring the bucket/key
/// hierarchy under `<app_cache_dir>/s3-preview/`. The extension is preserved so
/// the Tauri asset protocol serves it with the right MIME type. Drops any `..`
/// or empty path components to stay inside the cache root.
fn cache_path(app: &AppHandle, bucket: &str, key: &str) -> AppResult<PathBuf> {
    let mut path = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("no cache dir: {e}")))?;
    path.push("s3-preview");
    path.push(sanitize_component(bucket));
    for seg in key.split('/') {
        if seg.is_empty() || seg == ".." || seg == "." {
            continue;
        }
        path.push(sanitize_component(seg));
    }
    Ok(path)
}

/// Make a single path component filesystem-safe (no separators / traversal).
fn sanitize_component(s: &str) -> String {
    s.replace(['/', '\\'], "_")
}

#[derive(Debug, Clone, Serialize)]
pub struct CachedObject {
    pub path: String,
}

/// Download an object into the local preview cache and return its path. The
/// frontend renders it through the asset protocol (`convertFileSrc`) — used for
/// PDFs, audio/video and archives that don't fit the bounded inline preview.
#[tauri::command]
pub async fn s3_cache_object(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    bucket: String,
    key: String,
) -> AppResult<CachedObject> {
    let dest = cache_path(&app, &bucket, &key)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let dest_str = dest.to_string_lossy().to_string();
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let cancel = AtomicBool::new(false);
    require_s3(&handle)?
        .download_object(&bucket, &key, &dest_str, &cancel, |_| {})
        .await?;
    Ok(CachedObject { path: dest_str })
}

/// One member of an archive object (zip), for the in-app explorer.
#[derive(Debug, Clone, Serialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

/// Cache an archive object, then read its central directory (no full
/// extraction) and return up to `MAX_ARCHIVE_ENTRIES` members.
#[tauri::command]
pub async fn s3_archive_entries(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    bucket: String,
    key: String,
) -> AppResult<Vec<ArchiveEntry>> {
    let cached = s3_cache_object(state, app, connection_id, bucket, key).await?;
    let path = cached.path;
    tokio::task::spawn_blocking(move || -> AppResult<Vec<ArchiveEntry>> {
        let file = std::fs::File::open(&path)?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| AppError::Other(format!("not a readable zip: {e}")))?;
        let count = zip.len().min(MAX_ARCHIVE_ENTRIES);
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let e = zip
                .by_index(i)
                .map_err(|e| AppError::Other(format!("zip entry error: {e}")))?;
            out.push(ArchiveEntry {
                name: e.name().to_string(),
                size: e.size(),
                compressed_size: e.compressed_size(),
                is_dir: e.is_dir(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(format!("archive read task failed: {e}")))?
}

// ─── Write operations ───────────────────────────────────────────────────────

/// Progress event for a streaming upload, mirroring `s3-download-progress`.
#[derive(Debug, Clone, Serialize)]
struct UploadProgress {
    job_id: String,
    bytes_done: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadSummary {
    pub bytes: u64,
}

/// Stream a local file up to `<prefix><name>` (overwriting any existing key).
#[tauri::command]
pub async fn s3_put_object(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    bucket: String,
    key: String,
    src_path: String,
    job_id: String,
) -> AppResult<UploadSummary> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let cancel = state.jobs.register(&job_id).await;
    let content_type = guess_content_type(&key);
    let result = {
        let s3 = require_s3(&handle)?;
        let app = app.clone();
        let job_id_for_progress = job_id.clone();
        s3.put_object_from_file(
            &bucket,
            &key,
            &src_path,
            content_type,
            &cancel,
            move |bytes_done| {
                let _ = app.emit(
                    "s3-upload-progress",
                    UploadProgress {
                        job_id: job_id_for_progress.clone(),
                        bytes_done,
                    },
                );
            },
        )
        .await
    };
    state.jobs.forget(&job_id).await;
    result.map(|bytes| UploadSummary { bytes })
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadDirSummary {
    pub bytes: u64,
    pub files: u64,
}

/// Recursively collect every file under `root`, paired with its `/`-joined path
/// relative to `root` (the object-key suffix).
fn collect_files(root: &Path) -> AppResult<Vec<(PathBuf, String)>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let ft = entry.file_type()?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((path, rel_str));
            }
        }
    }
    Ok(out)
}

/// Upload every file under a local directory to `<dest_prefix><relative path>`,
/// streaming each and reporting cumulative bytes on `s3-upload-progress`.
#[tauri::command]
pub async fn s3_put_directory(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    bucket: String,
    dest_prefix: String,
    src_dir: String,
    job_id: String,
) -> AppResult<UploadDirSummary> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let cancel = state.jobs.register(&job_id).await;
    let root = PathBuf::from(&src_dir);
    let files = tokio::task::spawn_blocking(move || collect_files(&root))
        .await
        .map_err(|e| AppError::Other(format!("directory scan failed: {e}")))??;

    let result: AppResult<(u64, u64)> = async {
        let s3 = require_s3(&handle)?;
        let mut total_bytes = 0u64;
        let mut uploaded = 0u64;
        for (abs, rel) in files {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Canceled);
            }
            let key = format!("{dest_prefix}{rel}");
            let content_type = guess_content_type(&key);
            let base = total_bytes;
            let app = app.clone();
            let job_id = job_id.clone();
            let bytes = s3
                .put_object_from_file(
                    &bucket,
                    &key,
                    &abs.to_string_lossy(),
                    content_type,
                    &cancel,
                    move |b| {
                        let _ = app.emit(
                            "s3-upload-progress",
                            UploadProgress {
                                job_id: job_id.clone(),
                                bytes_done: base + b,
                            },
                        );
                    },
                )
                .await?;
            total_bytes += bytes;
            uploaded += 1;
        }
        Ok((total_bytes, uploaded))
    }
    .await;

    state.jobs.forget(&job_id).await;
    let (bytes, files) = result?;
    Ok(UploadDirSummary { bytes, files })
}

#[tauri::command]
pub async fn s3_delete_object(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> AppResult<()> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?.delete_object(&bucket, &key).await
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteFolderSummary {
    pub deleted: u64,
}

#[tauri::command]
pub async fn s3_delete_folder(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    prefix: String,
) -> AppResult<DeleteFolderSummary> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let deleted = require_s3(&handle)?.delete_prefix(&bucket, &prefix).await?;
    Ok(DeleteFolderSummary { deleted })
}

#[tauri::command]
pub async fn s3_create_folder(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    prefix: String,
) -> AppResult<()> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?.create_folder(&bucket, &prefix).await
}

#[tauri::command]
pub async fn s3_rename_object(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    src_key: String,
    dst_key: String,
) -> AppResult<()> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    require_s3(&handle)?
        .rename_object(&bucket, &src_key, &dst_key)
        .await
}

#[derive(Debug, Clone, Serialize)]
pub struct RenameFolderSummary {
    pub moved: u64,
}

#[tauri::command]
pub async fn s3_rename_folder(
    state: State<'_, AppState>,
    connection_id: String,
    bucket: String,
    src_prefix: String,
    dst_prefix: String,
) -> AppResult<RenameFolderSummary> {
    let handle = state.pools.get_or_open(&state, &connection_id).await?;
    let moved = require_s3(&handle)?
        .rename_prefix(&bucket, &src_prefix, &dst_prefix)
        .await?;
    Ok(RenameFolderSummary { moved })
}

/// Best-effort `Content-Type` from a key's extension; defaults to octet-stream.
fn guess_content_type(key: &str) -> Option<&'static str> {
    let ext = key.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "html" => "text/html",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_component_strips_separators() {
        assert_eq!(sanitize_component("a/b"), "a_b");
        assert_eq!(sanitize_component("a\\b"), "a_b");
        assert_eq!(sanitize_component("plain"), "plain");
    }

    #[test]
    fn guess_content_type_maps_common_extensions() {
        assert_eq!(guess_content_type("doc.pdf"), Some("application/pdf"));
        assert_eq!(guess_content_type("a/b/photo.PNG"), Some("image/png"));
        assert_eq!(guess_content_type("data.csv"), Some("text/csv"));
        assert_eq!(
            guess_content_type("mystery.bin"),
            Some("application/octet-stream")
        );
        assert_eq!(
            guess_content_type("noextension"),
            Some("application/octet-stream")
        );
    }
}
