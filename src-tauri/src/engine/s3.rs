//! S3 / object-storage engine.
//!
//! Implements `Engine` over the `rust-s3` crate so S3-compatible object stores
//! (Garage, RustFS, MinIO, OVH Object Storage, AWS S3) participate in the same
//! connection lifecycle as the database engines (pool registry, connection
//! state, secret resolution).
//!
//! Object stores have no query language: `execute` / `execute_script` /
//! `execute_query` and `as_sql_pool` all reject. The real surface is the set
//! of dedicated S3 commands in `commands/s3.rs`, which reach the live client
//! through `as_s3()`.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};

use async_trait::async_trait;
use futures_util::StreamExt;
use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};

use super::{Capabilities, Engine, QueryLanguage};
use crate::drivers::{QueryResult, ScriptResult};
use crate::error::{AppError, AppResult};
use crate::storage::DbKind;

/// A bucket as returned by the account-level `ListBuckets` call.
#[derive(Debug, Clone, Serialize)]
pub struct BucketInfo {
    pub name: String,
    pub creation_date: Option<String>,
}

/// One object in a listing (a real key, not a rolled-up folder prefix).
#[derive(Debug, Clone, Serialize)]
pub struct ObjectEntry {
    pub key: String,
    pub size: u64,
    pub last_modified: String,
    pub e_tag: Option<String>,
    pub storage_class: Option<String>,
}

/// A single page of a delimiter-based listing: virtual folders (common
/// prefixes) plus the objects directly under `prefix`. `next_token` carries
/// the continuation token when the bucket has more entries than one page.
#[derive(Debug, Clone, Serialize)]
pub struct Listing {
    pub prefix: String,
    pub folders: Vec<String>,
    pub objects: Vec<ObjectEntry>,
    pub next_token: Option<String>,
}

/// Metadata for a single object, from a `HEAD` request.
#[derive(Debug, Clone, Serialize)]
pub struct ObjectMetadata {
    pub content_type: Option<String>,
    pub content_length: Option<i64>,
    pub last_modified: Option<String>,
    pub e_tag: Option<String>,
    pub metadata: HashMap<String, String>,
}

/// A bounded preview of an object's contents. `kind` tells the frontend how to
/// render it; only the matching payload field is populated.
#[derive(Debug, Clone, Serialize)]
pub struct ObjectPreview {
    /// `"text"`, `"image"`, or `"binary"`.
    pub kind: String,
    pub content_type: Option<String>,
    /// Total object size in bytes (from `HEAD`), independent of how much we read.
    pub size: u64,
    /// Whether the object is larger than the preview window we fetched.
    pub truncated: bool,
    /// UTF-8 text, when `kind == "text"`.
    pub text: Option<String>,
    /// Base64 of the fetched bytes, when `kind == "image"`.
    pub base64: Option<String>,
}

pub struct S3Engine {
    region: Region,
    credentials: Credentials,
    /// Path-style addressing (`endpoint/bucket/key`) vs virtual-hosted
    /// (`bucket.endpoint/key`). Self-hosted stores (Garage/RustFS/MinIO)
    /// require path-style; AWS prefers virtual-hosted.
    path_style: bool,
}

impl S3Engine {
    /// Open an S3 engine from the connection's repurposed fields. Probes
    /// connectivity/credentials with a `ListBuckets` so a bad endpoint or bad
    /// key surfaces at connect time rather than on first browse.
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        endpoint_host: &str,
        port: u16,
        use_https: bool,
        region: &str,
        access_key: &str,
        secret_key: Option<&str>,
        path_style: bool,
    ) -> AppResult<Self> {
        let scheme = if use_https { "https" } else { "http" };
        let endpoint = format!("{scheme}://{endpoint_host}:{port}");
        let region_name = if region.trim().is_empty() {
            "us-east-1"
        } else {
            region.trim()
        };
        let region = Region::Custom {
            region: region_name.to_string(),
            endpoint,
        };
        let credentials = Credentials::new(Some(access_key), secret_key, None, None, None)
            .map_err(|e| AppError::Other(format!("invalid S3 credentials: {e}")))?;
        let engine = Self {
            region,
            credentials,
            path_style,
        };
        // Connectivity / credential probe. Root creds for self-hosted stores
        // can always list buckets; tightly-scoped keys may 403 here, which is
        // surfaced to the user (the whole UI starts from a bucket list anyway).
        engine.list_buckets().await?;
        Ok(engine)
    }

    fn bucket(&self, name: &str) -> AppResult<Box<Bucket>> {
        let b = Bucket::new(name, self.region.clone(), self.credentials.clone()).map_err(s3_err)?;
        Ok(if self.path_style {
            b.with_path_style()
        } else {
            b
        })
    }

    pub async fn list_buckets(&self) -> AppResult<Vec<BucketInfo>> {
        let resp = Bucket::list_buckets(self.region.clone(), self.credentials.clone())
            .await
            .map_err(s3_err)?;
        Ok(resp
            .buckets
            .bucket
            .into_iter()
            .map(|b| BucketInfo {
                name: b.name,
                creation_date: Some(b.creation_date),
            })
            .collect())
    }

    /// One page of a `/`-delimited listing under `prefix`. Always paginated —
    /// never lists a whole bucket flat — so huge buckets stay responsive.
    pub async fn list_objects(
        &self,
        bucket: &str,
        prefix: &str,
        continuation_token: Option<String>,
    ) -> AppResult<Listing> {
        let b = self.bucket(bucket)?;
        let (page, _status) = b
            .list_page(
                prefix.to_string(),
                Some("/".to_string()),
                continuation_token,
                None,
                Some(1000),
            )
            .await
            .map_err(s3_err)?;
        let folders = page
            .common_prefixes
            .unwrap_or_default()
            .into_iter()
            .map(|cp| cp.prefix)
            .collect();
        // The prefix entry itself can show up as a zero-byte "directory marker"
        // object; drop it so it doesn't render as a child of itself.
        let objects = page
            .contents
            .into_iter()
            .filter(|o| o.key != prefix)
            .map(|o| ObjectEntry {
                key: o.key,
                size: o.size,
                last_modified: o.last_modified,
                e_tag: o.e_tag,
                storage_class: o.storage_class,
            })
            .collect();
        Ok(Listing {
            prefix: prefix.to_string(),
            folders,
            objects,
            next_token: page.next_continuation_token,
        })
    }

    pub async fn object_meta(&self, bucket: &str, key: &str) -> AppResult<ObjectMetadata> {
        let b = self.bucket(bucket)?;
        let (head, _status) = b.head_object(key).await.map_err(s3_err)?;
        Ok(ObjectMetadata {
            content_type: head.content_type,
            content_length: head.content_length,
            last_modified: head.last_modified,
            e_tag: head.e_tag,
            metadata: head.metadata.unwrap_or_default(),
        })
    }

    /// Stream an object to a local file, checking `cancel` between chunks and
    /// reporting cumulative bytes via `on_progress`. Returns total bytes written.
    pub async fn download_object(
        &self,
        bucket: &str,
        key: &str,
        dest_path: &str,
        cancel: &AtomicBool,
        on_progress: impl Fn(u64),
    ) -> AppResult<u64> {
        let b = self.bucket(bucket)?;
        let mut stream = b.get_object_stream(key).await.map_err(s3_err)?;
        let mut file = tokio::fs::File::create(dest_path).await?;
        let mut written: u64 = 0;
        while let Some(chunk) = stream.bytes().next().await {
            if cancel.load(Ordering::SeqCst) {
                // Best-effort cleanup of the partial file.
                drop(file);
                let _ = tokio::fs::remove_file(dest_path).await;
                return Err(AppError::Canceled);
            }
            let bytes = chunk.map_err(s3_err)?;
            file.write_all(&bytes).await?;
            written += bytes.len() as u64;
            on_progress(written);
        }
        file.flush().await?;
        Ok(written)
    }

    /// Fetch at most `max_bytes` of an object for in-app preview. Never loads a
    /// large object whole: `truncated` is set when the object is bigger than
    /// the window. Classifies as text / image / binary so the UI can render it.
    pub async fn preview_object(
        &self,
        bucket: &str,
        key: &str,
        max_bytes: u64,
    ) -> AppResult<ObjectPreview> {
        let meta = self.object_meta(bucket, key).await?;
        let size = meta.content_length.unwrap_or(0).max(0) as u64;
        let want = max_bytes.min(if size == 0 { max_bytes } else { size });
        let b = self.bucket(bucket)?;
        // get_object_range is inclusive on both ends.
        let end = want.saturating_sub(1);
        let data = b
            .get_object_range(key, 0, Some(end))
            .await
            .map_err(s3_err)?;
        let bytes = data.to_vec();
        let truncated = size > bytes.len() as u64;
        let content_type = meta.content_type.clone();
        let is_image = content_type
            .as_deref()
            .is_some_and(|ct| ct.starts_with("image/"));
        if is_image {
            return Ok(ObjectPreview {
                kind: "image".into(),
                content_type,
                size,
                truncated,
                text: None,
                base64: Some(base64_encode(&bytes)),
            });
        }
        match std::str::from_utf8(&bytes) {
            Ok(text) => Ok(ObjectPreview {
                kind: "text".into(),
                content_type,
                size,
                truncated,
                text: Some(text.to_string()),
                base64: None,
            }),
            Err(_) => Ok(ObjectPreview {
                kind: "binary".into(),
                content_type,
                size,
                truncated,
                text: None,
                base64: None,
            }),
        }
    }

    /// Stream a local file up to `key`, checking `cancel` and reporting
    /// cumulative bytes via `on_progress`. Overwrites any existing object
    /// (S3 `PUT` semantics). Returns total bytes uploaded.
    pub async fn put_object_from_file(
        &self,
        bucket: &str,
        key: &str,
        local_path: &str,
        content_type: Option<&str>,
        cancel: &AtomicBool,
        on_progress: impl FnMut(u64) + Unpin,
    ) -> AppResult<u64> {
        let b = self.bucket(bucket)?;
        let file = tokio::fs::File::open(local_path).await?;
        let mut reader = CountingReader {
            inner: file,
            written: 0,
            cancel,
            on_progress,
        };
        let content_type = content_type.unwrap_or("application/octet-stream");
        let result = b
            .put_object_stream_with_content_type(&mut reader, key, content_type)
            .await;
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Canceled);
        }
        result.map_err(s3_err)?;
        Ok(reader.written)
    }

    /// Delete a single object.
    pub async fn delete_object(&self, bucket: &str, key: &str) -> AppResult<()> {
        let b = self.bucket(bucket)?;
        b.delete_object(key).await.map_err(s3_err)?;
        Ok(())
    }

    /// Recursively delete every object under `prefix` (a "folder"). Returns the
    /// number of objects deleted.
    pub async fn delete_prefix(&self, bucket: &str, prefix: &str) -> AppResult<u64> {
        let b = self.bucket(bucket)?;
        // No delimiter → a flat, recursive listing of every key under prefix.
        let pages = b.list(prefix.to_string(), None).await.map_err(s3_err)?;
        let mut deleted = 0u64;
        for page in pages {
            for obj in page.contents {
                b.delete_object(&obj.key).await.map_err(s3_err)?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// Create a zero-byte directory marker so an empty "folder" shows up in
    /// delimiter-based listings. `prefix` should end with `/`.
    pub async fn create_folder(&self, bucket: &str, prefix: &str) -> AppResult<()> {
        let b = self.bucket(bucket)?;
        b.put_object(prefix, &[]).await.map_err(s3_err)?;
        Ok(())
    }

    /// Copy then delete — S3 has no native rename. `src` and `dst` are full keys.
    pub async fn rename_object(&self, bucket: &str, src: &str, dst: &str) -> AppResult<()> {
        let b = self.bucket(bucket)?;
        b.copy_object_internal(src, dst).await.map_err(s3_err)?;
        b.delete_object(src).await.map_err(s3_err)?;
        Ok(())
    }

    /// Move every object under `src_prefix` to `dst_prefix` (folder rename).
    /// S3 has no native directory, so each key is copied then deleted. Returns
    /// the number of objects moved.
    pub async fn rename_prefix(
        &self,
        bucket: &str,
        src_prefix: &str,
        dst_prefix: &str,
    ) -> AppResult<u64> {
        let b = self.bucket(bucket)?;
        let pages = b.list(src_prefix.to_string(), None).await.map_err(s3_err)?;
        let mut moved = 0u64;
        for page in pages {
            for obj in page.contents {
                let rest = obj.key.strip_prefix(src_prefix).unwrap_or(&obj.key);
                let new_key = format!("{dst_prefix}{rest}");
                b.copy_object_internal(&obj.key, &new_key)
                    .await
                    .map_err(s3_err)?;
                b.delete_object(&obj.key).await.map_err(s3_err)?;
                moved += 1;
            }
        }
        Ok(moved)
    }
}

/// An `AsyncRead` adapter that tallies bytes read (for upload progress) and
/// aborts the read with an error once `cancel` is set.
struct CountingReader<'a, R, F> {
    inner: R,
    written: u64,
    cancel: &'a AtomicBool,
    on_progress: F,
}

impl<R: AsyncRead + Unpin, F: FnMut(u64) + Unpin> AsyncRead for CountingReader<'_, R, F> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.cancel.load(Ordering::SeqCst) {
            return Poll::Ready(Err(std::io::Error::other("upload canceled")));
        }
        let before = buf.filled().len();
        let r = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &r {
            let read = (buf.filled().len() - before) as u64;
            if read > 0 {
                this.written += read;
                (this.on_progress)(this.written);
            }
        }
        r
    }
}

#[async_trait]
impl Engine for S3Engine {
    fn kind(&self) -> DbKind {
        DbKind::S3
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Object stores are browsed through the dedicated S3 commands and a
            // custom object-browser UI, not the schema tree or query editor.
            supports_databases_list: false,
            supports_database_create: false,
            supports_database_drop: false,
            supports_schemas: false,
            supports_foreign_keys: false,
            supports_ddl_diff: false,
            supports_diagram: false,
            supports_geo: false,
            supports_native_dump: false,
            query_language: QueryLanguage::None,
        }
    }

    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        Err(AppError::unsupported("SQL query", "s3"))
    }

    async fn execute_script(&self, _sql: &str) -> AppResult<ScriptResult> {
        Err(AppError::unsupported("SQL script", "s3"))
    }

    async fn close(&self) {
        // rust-s3's `Bucket` is constructed per call and owns no long-lived
        // connection pool of its own (it goes through reqwest); nothing to tear
        // down here.
    }

    fn as_s3(&self) -> Option<&S3Engine> {
        Some(self)
    }
}

fn s3_err(e: s3::error::S3Error) -> AppError {
    AppError::Other(format!("s3 error: {e}"))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_matches_known_vector() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b""), "");
    }

    #[tokio::test]
    async fn connect_rejects_unreachable_endpoint() {
        // A port that nothing is listening on: the ListBuckets probe must fail
        // fast rather than yield a half-open engine.
        let res = S3Engine::connect(
            "127.0.0.1",
            1,
            false,
            "us-east-1",
            "AKIDEXAMPLE",
            Some("secret"),
            true,
        )
        .await;
        assert!(res.is_err(), "expected connect to fail on a dead endpoint");
    }
}
