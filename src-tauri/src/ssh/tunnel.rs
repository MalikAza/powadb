//! SSH tunnel: opens an SSH session and exposes a local TCP listener that
//! forwards each accepted connection through a `direct-tcpip` channel to the
//! target host:port (as seen from the SSH server). Mirrors the public shape of
//! `crate::wireguard::tunnel`: `open_tunnel(cfg, target) -> Handle`, with
//! `handle.local_addr` and `handle.shutdown()` lifecycle.
//!
//! Host-key verification follows TOFU: if `cfg.known_host_fingerprint` is set
//! the captured fingerprint must match exactly; otherwise the first connect
//! captures it and the caller persists it back to storage.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Config, Handle, Handler};
use russh::keys::key;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::ssh::config::{SshAuth, SshConfig};

/// Handle for an active SSH tunnel. Drop or `shutdown()` to tear it down.
pub struct SshTunnelHandle {
    pub local_addr: SocketAddr,
    /// `SHA256:<base64>` of the server's host key, captured during the initial
    /// handshake. Populated only when `cfg.known_host_fingerprint` was `None`
    /// (i.e. first connect / TOFU). The caller is expected to persist this so
    /// future connects can reject mismatching keys.
    pub captured_fingerprint: Option<String>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl SshTunnelHandle {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_millis(500), t).await;
        }
    }
}

impl Drop for SshTunnelHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

struct ClientHandler {
    expected_fingerprint: Option<String>,
    captured: Arc<StdMutex<Option<String>>>,
    mismatch: Arc<StdMutex<Option<(String, String)>>>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let actual = format!("SHA256:{}", server_public_key.fingerprint());
        if let Some(expected) = &self.expected_fingerprint {
            if expected != &actual {
                if let Ok(mut slot) = self.mismatch.lock() {
                    *slot = Some((expected.clone(), actual));
                }
                return Ok(false);
            }
        } else if let Ok(mut slot) = self.captured.lock() {
            *slot = Some(actual);
        }
        Ok(true)
    }
}

pub async fn open_tunnel(cfg: &SshConfig, target: SocketAddr) -> AppResult<SshTunnelHandle> {
    let captured: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
    let mismatch: Arc<StdMutex<Option<(String, String)>>> = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        expected_fingerprint: cfg.known_host_fingerprint.clone(),
        captured: captured.clone(),
        mismatch: mismatch.clone(),
    };

    let russh_cfg = Arc::new(Config {
        // `None` disables the inactivity timeout; `Some(_)` is treated as a hard
        // deadline and even `Some(Duration::ZERO)` makes russh time out
        // immediately. We rely on keepalive to detect dead peers instead.
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Config::default()
    });

    let addr = (cfg.host.as_str(), cfg.port);
    let mut handle = match client::connect(russh_cfg, addr, handler).await {
        Ok(h) => h,
        Err(e) => {
            if let Ok(slot) = mismatch.lock() {
                if let Some((expected, actual)) = slot.clone() {
                    return Err(AppError::SshHostKeyMismatch { expected, actual });
                }
            }
            return Err(AppError::SshTunnel(format!(
                "connect to {}:{} failed: {e}",
                cfg.host, cfg.port
            )));
        }
    };

    let authed = match &cfg.auth {
        SshAuth::Password { password } => handle
            .authenticate_password(cfg.username.clone(), password.clone())
            .await
            .map_err(|e| AppError::SshTunnel(format!("password auth error: {e}")))?,
        SshAuth::PrivateKey { path, passphrase } => {
            let key = russh_keys::load_secret_key(path, passphrase.as_deref())
                .map_err(|e| AppError::SshTunnel(format!("load private key {path:?}: {e}")))?;
            handle
                .authenticate_publickey(cfg.username.clone(), Arc::new(key))
                .await
                .map_err(|e| AppError::SshTunnel(format!("publickey auth error: {e}")))?
        }
    };
    if !authed {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        return Err(AppError::SshTunnel(
            "ssh authentication rejected by the server".into(),
        ));
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::SshTunnel(format!("local bind failed: {e}")))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| AppError::SshTunnel(format!("local_addr failed: {e}")))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(run_accept_loop(handle, listener, target, shutdown_rx));

    let captured_fp = captured.lock().ok().and_then(|s| s.clone());

    Ok(SshTunnelHandle {
        local_addr,
        captured_fingerprint: captured_fp,
        shutdown: Some(shutdown_tx),
        task: Some(task),
    })
}

async fn run_accept_loop(
    handle: Handle<ClientHandler>,
    listener: TcpListener,
    target: SocketAddr,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let handle = Arc::new(handle);
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            accept = listener.accept() => {
                let (stream, _peer) = match accept {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let handle = handle.clone();
                let target_host = target.ip().to_string();
                let target_port = target.port() as u32;
                tokio::spawn(async move {
                    // `forward_one` returns Err on *any* end-of-stream, including
                    // perfectly normal closes (server-side connection drop, pool
                    // reaping an idle connection, etc.). We can't reliably tell
                    // those apart from genuine I/O errors, and they're frequent
                    // enough that logging them clutters the dev console.
                    let _ = forward_one(handle, stream, target_host, target_port).await;
                });
            }
        }
    }
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
}

async fn forward_one(
    handle: Arc<Handle<ClientHandler>>,
    mut local: tokio::net::TcpStream,
    target_host: String,
    target_port: u32,
) -> Result<(), String> {
    let channel = handle
        .channel_open_direct_tcpip(target_host, target_port, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("channel open failed: {e}"))?;
    let mut stream = channel.into_stream();
    match tokio::io::copy_bidirectional(&mut local, &mut stream).await {
        Ok(_) => {}
        Err(e) => return Err(format!("bidirectional copy: {e}")),
    }
    let _ = stream.shutdown().await;
    Ok(())
}
