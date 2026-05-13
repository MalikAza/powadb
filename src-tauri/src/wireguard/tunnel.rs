//! Userspace WireGuard tunnel: opens a local TCP listener on 127.0.0.1 and
//! forwards each accepted connection through WG to a single target IP:port.
//!
//! Architecture:
//!   - One tokio UDP socket talks to the WG peer (encrypted traffic).
//!   - One `boringtun::noise::Tunn` instance handles handshake + symmetric crypto.
//!   - One `smoltcp` userspace TCP/IP stack lives behind a virtual device whose
//!     RX/TX queues are bridged to boringtun + the UDP socket.
//!   - One "engine" tokio task owns the smoltcp Interface and runs the poll loop.
//!   - For each accepted local TCP connection we spawn a forwarder that talks
//!     to the engine via mpsc channels (one for bytes out → smoltcp, one for
//!     bytes in ← smoltcp).
//!
//! Scope: single-peer, IPv4-only, one TCP forward per tunnel — enough to replace
//! a WireGuard VPN dedicated to reaching one DB.

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp::{Socket as TcpSocket, SocketBuffer as TcpBuffer, State as TcpState};
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, Ipv4Address};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::{AppError, AppResult};
use crate::wireguard::WgConfig;

/// Handle for an active tunnel. Drop the value (or call `shutdown`) to tear it down.
pub struct TunnelHandle {
    pub local_addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    accept_task: Option<JoinHandle<()>>,
    engine_task: Option<JoinHandle<()>>,
}

impl TunnelHandle {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.accept_task.take() {
            let _ = tokio::time::timeout(Duration::from_millis(500), t).await;
        }
        if let Some(t) = self.engine_task.take() {
            let _ = tokio::time::timeout(Duration::from_millis(500), t).await;
        }
    }
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Open a WG tunnel against `cfg`'s peer and bind a local listener that forwards
/// new TCP connections to `target` over the tunnel.
pub async fn open_tunnel(cfg: &WgConfig, target: SocketAddr) -> AppResult<TunnelHandle> {
    if !cfg.allows(target.ip()) {
        return Err(AppError::WgTunnel(format!(
            "target {} is not covered by AllowedIPs in the WireGuard config",
            target.ip()
        )));
    }
    let target_v4 = match target {
        SocketAddr::V4(v) => v,
        SocketAddr::V6(_) => {
            return Err(AppError::WgTunnel(
                "IPv6 targets are not supported by the userspace tunnel yet".into(),
            ));
        }
    };

    let self_ipv4 = match cfg.address.addr() {
        IpAddr::V4(v) => v,
        IpAddr::V6(_) => {
            return Err(AppError::WgTunnel(
                "IPv6 interface addresses are not supported by the userspace tunnel yet".into(),
            ));
        }
    };

    // UDP socket talking to the WG peer.
    let udp = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| AppError::WgTunnel(format!("udp bind failed: {e}")))?;
    udp.connect(cfg.peer.endpoint)
        .await
        .map_err(|e| AppError::WgTunnel(format!("udp connect to peer failed: {e}")))?;
    let udp = Arc::new(udp);

    // boringtun Tunn instance.
    let static_private = StaticSecret::from(cfg.private_key);
    let peer_public = PublicKey::from(cfg.peer.public_key);
    let tunn = Tunn::new(
        static_private,
        peer_public,
        cfg.peer.preshared_key,
        cfg.peer.persistent_keepalive,
        0,
        None,
    );
    let tunn = Arc::new(Mutex::new(tunn));

    // Local listener for incoming DB client connections.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::WgTunnel(format!("local bind failed: {e}")))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| AppError::WgTunnel(format!("local_addr failed: {e}")))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<EngineCommand>();

    let engine_task = tokio::spawn(run_engine(
        tunn.clone(),
        udp.clone(),
        self_ipv4,
        cmd_rx,
        shutdown_rx,
    ));

    let accept_task = tokio::spawn(run_accept(listener, cmd_tx, target_v4));

    Ok(TunnelHandle {
        local_addr,
        shutdown: Some(shutdown_tx),
        accept_task: Some(accept_task),
        engine_task: Some(engine_task),
    })
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/// One TCP forward request from the accept loop.
struct EngineCommand {
    target: SocketAddrV4,
    /// Bytes that arrived from the local TCP stream and should be sent into the tunnel.
    to_remote: mpsc::Receiver<Vec<u8>>,
    /// Bytes coming out of the tunnel that should be written to the local stream.
    to_local: mpsc::Sender<Vec<u8>>,
    /// Signaled by the engine when the smoltcp socket reaches Closed.
    closed: oneshot::Sender<()>,
}

async fn run_engine(
    tunn: Arc<Mutex<Tunn>>,
    udp: Arc<UdpSocket>,
    self_ipv4: Ipv4Addr,
    mut cmd_rx: mpsc::UnboundedReceiver<EngineCommand>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    // Channels between the virtual device and the UDP socket.
    let (udp_to_dev_tx, udp_to_dev_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (dev_to_udp_tx, mut dev_to_udp_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let mut device = VirtualDevice::new(udp_to_dev_rx, dev_to_udp_tx);

    let mut iface = {
        let config = Config::new(HardwareAddress::Ip);
        let mut iface = Interface::new(config, &mut device, SmolInstant::now());
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv4(self_ipv4), 32));
        });
        iface
            .routes_mut()
            .add_default_ipv4_route(Ipv4Address::new(0, 0, 0, 0))
            .ok();
        iface
    };

    let mut sockets: SocketSet<'static> = SocketSet::new(Vec::with_capacity(8));
    let mut forwards: Vec<Forward> = Vec::new();

    let start = Instant::now();

    // Outbound pump: encrypt smoltcp packets + send via UDP.
    let tunn_send = tunn.clone();
    let udp_send = udp.clone();
    let send_pump = tokio::spawn(async move {
        while let Some(pkt) = dev_to_udp_rx.recv().await {
            let mut buf = vec![0u8; 65535];
            let bytes_to_send: Option<Vec<u8>> = {
                let mut t = tunn_send.lock().await;
                match t.encapsulate(&pkt, &mut buf) {
                    TunnResult::WriteToNetwork(out) => Some(out.to_vec()),
                    TunnResult::Done => None,
                    TunnResult::Err(e) => {
                        eprintln!("wg encapsulate error: {e:?}");
                        None
                    }
                    _ => None,
                }
            };
            if let Some(data) = bytes_to_send {
                let _ = udp_send.send(&data).await;
            }
        }
    });

    // Inbound pump: read UDP datagrams → decrypt → push IP packets to smoltcp device.
    let tunn_recv = tunn.clone();
    let udp_recv = udp.clone();
    let udp_for_handshake = udp.clone();
    let recv_pump = tokio::spawn(async move {
        let mut datagram = vec![0u8; 65535];
        loop {
            let n = match udp_recv.recv(&mut datagram).await {
                Ok(n) => n,
                Err(_) => return,
            };
            let input = datagram[..n].to_vec();
            drain_decapsulate(&tunn_recv, &input, &udp_to_dev_tx, &udp_for_handshake).await;
        }
    });

    // Periodic boringtun timer pump (handshake retries + keepalive).
    let tunn_timer = tunn.clone();
    let udp_timer = udp.clone();
    let timer_pump = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tick.tick().await;
            let bytes_to_send: Option<Vec<u8>> = {
                let mut t = tunn_timer.lock().await;
                let mut buf = vec![0u8; 256];
                match t.update_timers(&mut buf) {
                    TunnResult::WriteToNetwork(out) => Some(out.to_vec()),
                    TunnResult::Err(e) => {
                        eprintln!("wg timer error: {e:?}");
                        None
                    }
                    _ => None,
                }
            };
            if let Some(data) = bytes_to_send {
                let _ = udp_timer.send(&data).await;
            }
        }
    });

    // Kick off the initial handshake by trying to send an empty packet — boringtun
    // will respond with a WriteToNetwork carrying the handshake initiation.
    {
        let mut buf = vec![0u8; 256];
        let bytes_to_send = {
            let mut t = tunn.lock().await;
            match t.encapsulate(&[], &mut buf) {
                TunnResult::WriteToNetwork(out) => Some(out.to_vec()),
                _ => None,
            }
        };
        if let Some(data) = bytes_to_send {
            let _ = udp.send(&data).await;
        }
    }

    let mut poll_tick = tokio::time::interval(Duration::from_millis(5));
    poll_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,

            Some(cmd) = cmd_rx.recv() => {
                if let Err(e) = start_forward(
                    &mut iface,
                    &mut device,
                    &mut sockets,
                    &mut forwards,
                    self_ipv4,
                    cmd,
                    start,
                ) {
                    eprintln!("wg: failed to start forward: {e}");
                }
            }

            _ = poll_tick.tick() => {
                poll_once(&mut iface, &mut device, &mut sockets, &mut forwards, start).await;
            }
        }
    }

    send_pump.abort();
    recv_pump.abort();
    timer_pump.abort();
}

/// Drain boringtun's queued packets for a single received UDP datagram.
async fn drain_decapsulate(
    tunn: &Arc<Mutex<Tunn>>,
    initial_input: &[u8],
    to_dev: &mpsc::UnboundedSender<Vec<u8>>,
    udp: &UdpSocket,
) {
    // First call: process the actual datagram.
    let mut next: Action = decapsulate_once(tunn, initial_input).await;
    loop {
        match next {
            Action::ToTunnel(packet) => {
                let _ = to_dev.send(packet);
            }
            Action::ToNetwork(reply) => {
                let _ = udp.send(&reply).await;
            }
            Action::Done => return,
        }
        // Drain queued: empty input pulls additional packets.
        next = decapsulate_once(tunn, &[]).await;
    }
}

enum Action {
    ToTunnel(Vec<u8>),
    ToNetwork(Vec<u8>),
    Done,
}

async fn decapsulate_once(tunn: &Arc<Mutex<Tunn>>, input: &[u8]) -> Action {
    let mut buf = vec![0u8; 65535];
    let mut t = tunn.lock().await;
    match t.decapsulate(None, input, &mut buf) {
        TunnResult::WriteToTunnelV4(packet, _) => Action::ToTunnel(packet.to_vec()),
        TunnResult::WriteToNetwork(reply) => Action::ToNetwork(reply.to_vec()),
        TunnResult::WriteToTunnelV6(_, _) | TunnResult::Done => Action::Done,
        TunnResult::Err(e) => {
            eprintln!("wg decapsulate error: {e:?}");
            Action::Done
        }
    }
}

struct Forward {
    handle: SocketHandle,
    pending_out: VecDeque<u8>,
    to_local: mpsc::Sender<Vec<u8>>,
    closed: Option<oneshot::Sender<()>>,
    to_remote: mpsc::Receiver<Vec<u8>>,
    local_eof: bool,
}

fn start_forward(
    iface: &mut Interface,
    device: &mut VirtualDevice,
    sockets: &mut SocketSet<'static>,
    forwards: &mut Vec<Forward>,
    self_ipv4: Ipv4Addr,
    cmd: EngineCommand,
    start: Instant,
) -> Result<(), String> {
    let rx_buf = TcpBuffer::new(vec![0u8; 64 * 1024]);
    let tx_buf = TcpBuffer::new(vec![0u8; 64 * 1024]);
    let mut socket = TcpSocket::new(rx_buf, tx_buf);

    let local_port = 1024 + (rand_u16() % (u16::MAX - 1024));
    let remote_endpoint = (IpAddress::Ipv4(*cmd.target.ip()), cmd.target.port());
    let local_endpoint = (IpAddress::Ipv4(self_ipv4), local_port);

    let cx = iface.context();
    socket
        .connect(cx, remote_endpoint, local_endpoint)
        .map_err(|e| format!("smoltcp connect: {e:?}"))?;

    let handle = sockets.add(socket);
    forwards.push(Forward {
        handle,
        pending_out: VecDeque::new(),
        to_local: cmd.to_local,
        closed: Some(cmd.closed),
        to_remote: cmd.to_remote,
        local_eof: false,
    });
    let _ = iface.poll(smol_now(start), device, sockets);
    Ok(())
}

async fn poll_once(
    iface: &mut Interface,
    device: &mut VirtualDevice,
    sockets: &mut SocketSet<'static>,
    forwards: &mut Vec<Forward>,
    start: Instant,
) {
    for f in forwards.iter_mut() {
        while let Ok(chunk) = f.to_remote.try_recv() {
            if chunk.is_empty() {
                f.local_eof = true;
            } else {
                f.pending_out.extend(chunk);
            }
        }
    }

    let mut to_remove: Vec<usize> = Vec::new();
    for (idx, f) in forwards.iter_mut().enumerate() {
        let socket = sockets.get_mut::<TcpSocket>(f.handle);

        if socket.can_send() && !f.pending_out.is_empty() {
            let (head, tail) = f.pending_out.as_slices();
            let n1 = socket.send_slice(head).unwrap_or(0);
            let n2 = if n1 == head.len() {
                socket.send_slice(tail).unwrap_or(0)
            } else {
                0
            };
            drop_front(&mut f.pending_out, n1 + n2);
        }

        if f.local_eof && f.pending_out.is_empty() && socket.may_send() {
            socket.close();
        }

        while socket.can_recv() {
            let mut buf = vec![0u8; 16 * 1024];
            match socket.recv_slice(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    buf.truncate(n);
                    if f.to_local.try_send(buf).is_err() {
                        socket.abort();
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        if matches!(socket.state(), TcpState::Closed) {
            if let Some(tx) = f.closed.take() {
                let _ = tx.send(());
            }
            to_remove.push(idx);
        }
    }
    for idx in to_remove.into_iter().rev() {
        let f = forwards.swap_remove(idx);
        sockets.remove(f.handle);
    }

    let _ = iface.poll(smol_now(start), device, sockets);
}

fn smol_now(start: Instant) -> SmolInstant {
    let elapsed = Instant::now().duration_since(start);
    SmolInstant::from_micros(elapsed.as_micros() as i64)
}

fn rand_u16() -> u16 {
    use std::time::SystemTime;
    let t = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (t as u16) ^ 0x9E37
}

fn drop_front(q: &mut VecDeque<u8>, n: usize) {
    for _ in 0..n.min(q.len()) {
        q.pop_front();
    }
}

// ─── Virtual device bridging smoltcp ↔ boringtun ─────────────────────────────

struct VirtualDevice {
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    mtu: usize,
}

impl VirtualDevice {
    fn new(rx: mpsc::UnboundedReceiver<Vec<u8>>, tx: mpsc::UnboundedSender<Vec<u8>>) -> Self {
        Self { rx, tx, mtu: 1420 }
    }
}

impl Device for VirtualDevice {
    type RxToken<'a>
        = VRxToken
    where
        Self: 'a;
    type TxToken<'a>
        = VTxToken<'a>
    where
        Self: 'a;

    fn receive(&mut self, _ts: SmolInstant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        match self.rx.try_recv() {
            Ok(buf) => Some((VRxToken { buf }, VTxToken { tx: &self.tx })),
            Err(_) => None,
        }
    }

    fn transmit(&mut self, _ts: SmolInstant) -> Option<Self::TxToken<'_>> {
        Some(VTxToken { tx: &self.tx })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = self.mtu;
        c
    }
}

struct VRxToken {
    buf: Vec<u8>,
}

impl RxToken for VRxToken {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.buf)
    }
}

struct VTxToken<'a> {
    tx: &'a mpsc::UnboundedSender<Vec<u8>>,
}

impl<'a> TxToken for VTxToken<'a> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0u8; len];
        let r = f(&mut buf);
        let _ = self.tx.send(buf);
        r
    }
}

// ─── Accept loop + per-connection forwarder ─────────────────────────────────

async fn run_accept(
    listener: TcpListener,
    cmd_tx: mpsc::UnboundedSender<EngineCommand>,
    target: SocketAddrV4,
) {
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => return,
        };
        let cmd_tx = cmd_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = forward_one(stream, cmd_tx, target).await {
                eprintln!("wg tunnel forward error: {e}");
            }
        });
    }
}

async fn forward_one(
    stream: TcpStream,
    cmd_tx: mpsc::UnboundedSender<EngineCommand>,
    target: SocketAddrV4,
) -> Result<(), String> {
    let (to_remote_tx, to_remote_rx) = mpsc::channel::<Vec<u8>>(32);
    let (to_local_tx, mut to_local_rx) = mpsc::channel::<Vec<u8>>(32);
    let (closed_tx, _closed_rx) = oneshot::channel::<()>();

    cmd_tx
        .send(EngineCommand {
            target,
            to_remote: to_remote_rx,
            to_local: to_local_tx,
            closed: closed_tx,
        })
        .map_err(|_| "engine task is gone".to_string())?;

    let (mut read_half, mut write_half) = stream.into_split();

    let to_remote_for_read = to_remote_tx.clone();
    let read_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match read_half.read(&mut buf).await {
                Ok(0) => {
                    let _ = to_remote_for_read.send(Vec::new()).await;
                    return;
                }
                Ok(n) => {
                    if to_remote_for_read.send(buf[..n].to_vec()).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let write_task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = to_local_rx.recv().await {
            if write_half.write_all(&chunk).await.is_err() {
                return;
            }
        }
        let _ = write_half.shutdown().await;
    });

    let _ = tokio::join!(read_task, write_task);
    Ok(())
}
