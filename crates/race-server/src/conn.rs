//! Transport-independent connection handling. WebTransport and WebSocket
//! adapters both turn their connection into a pair of channels (datagrams
//! in, datagrams out) and hand them to [`serve`].

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use protocol::{ClientMsg, PROTOCOL_VERSION, RejectReason, ServerMsg};
use tokio::sync::mpsc;
use tracing::{debug, info};

use crate::config::Config;
use crate::room::ConnId;
use crate::rooms::{RoomCmd, Rooms};

/// Per-connection outgoing queue. Small on purpose: stale snapshots are
/// worthless, so a slow connection drops instead of buffering.
pub const OUT_QUEUE: usize = 32;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BAD_PACKETS: u32 = 50;

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

pub fn next_conn_id() -> ConnId {
    NEXT_CONN.fetch_add(1, Ordering::Relaxed)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Runs one client connection until it closes.
pub async fn serve(
    conn: ConnId,
    transport: &'static str,
    mut incoming: mpsc::Receiver<Bytes>,
    out: mpsc::Sender<Bytes>,
    config: Arc<Config>,
    rooms: Arc<Rooms>,
) {
    rooms.metrics.connections.fetch_add(1, Ordering::Relaxed);
    let reject = |reason| {
        let _ = out.try_send(Bytes::from(ServerMsg::Reject(reason).encode()));
    };

    // 1. Wait for a valid Hello.
    let joined = tokio::time::timeout(HELLO_TIMEOUT, async {
        let mut bad = 0;
        while let Some(bytes) = incoming.recv().await {
            match ClientMsg::decode(&bytes) {
                Ok(ClientMsg::Hello {
                    version,
                    sim_version,
                    token,
                    client_time,
                }) => {
                    // Same wire format AND the exact same sim, or prediction would drift.
                    if version != PROTOCOL_VERSION || sim_version != sim::SIM_VERSION {
                        info!(
                            conn,
                            transport, version, sim_version, "rejected client from another build"
                        );
                        reject(RejectReason::BadVersion);
                        return None;
                    }
                    let claims = match protocol::token::verify(
                        &token,
                        &config.lobby_public_key,
                        &config.public_addr,
                        now_unix(),
                    ) {
                        Ok(c) => c,
                        Err(e) => {
                            rooms.metrics.bad_tokens.fetch_add(1, Ordering::Relaxed);
                            info!(conn, transport, error = %e, "rejected join token");
                            reject(RejectReason::BadToken);
                            return None;
                        }
                    };
                    let room = match rooms.get_or_create(&claims) {
                        Ok(r) => r,
                        Err(reason) => {
                            reject(reason);
                            return None;
                        }
                    };
                    let cmd = RoomCmd::Join {
                        conn,
                        claims: Box::new(claims.clone()),
                        client_time,
                        tx: out.clone(),
                    };
                    room.tx.send(cmd).await.ok()?;
                    return Some((room, claims));
                }
                _ => {
                    bad += 1;
                    if bad > MAX_BAD_PACKETS {
                        return None;
                    }
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten();

    let Some((room, claims)) = joined else {
        rooms.metrics.connections.fetch_sub(1, Ordering::Relaxed);
        return;
    };
    debug!(conn, transport, room = %claims.room, "connection joined room");

    // 2. Forward inputs until the client leaves or the room goes away.
    let mut bad = 0;
    while let Some(bytes) = incoming.recv().await {
        match ClientMsg::decode(&bytes) {
            Ok(ClientMsg::Inputs(packet)) => {
                // Drop rather than wait if the room is overwhelmed.
                if room.tx.try_send(RoomCmd::Inputs { conn, packet }).is_err()
                    && room.tx.is_closed()
                {
                    break;
                }
            }
            Ok(ClientMsg::Hello { client_time, .. }) => {
                // Our Welcome was lost; the room answers a repeated join idempotently.
                let cmd = RoomCmd::Join {
                    conn,
                    claims: Box::new(claims.clone()),
                    client_time,
                    tx: out.clone(),
                };
                if room.tx.send(cmd).await.is_err() {
                    break;
                }
            }
            Ok(ClientMsg::Bye) => break,
            Err(_) => {
                rooms.metrics.bad_packets.fetch_add(1, Ordering::Relaxed);
                bad += 1;
                if bad > MAX_BAD_PACKETS {
                    info!(conn, "too many malformed packets, disconnecting");
                    break;
                }
            }
        }
    }
    let _ = room.tx.send(RoomCmd::Leave { conn }).await;
    rooms.metrics.connections.fetch_sub(1, Ordering::Relaxed);
}
