//! Room lifecycle on Tokio: one task per room, each running the pure `Room`
//! state machine on a fixed 60 Hz clock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use protocol::token::JoinClaims;
use protocol::{InputPacket, RejectReason, ServerMsg};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::room::{ConnId, Room, RoomConfig};

/// Rooms with no humans for this long shut down.
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30);
const ROOM_INBOX: usize = 1024;

pub enum RoomCmd {
    Join {
        conn: ConnId,
        claims: Box<JoinClaims>,
        client_time: u16,
        tx: mpsc::Sender<Bytes>,
    },
    Inputs {
        conn: ConnId,
        packet: InputPacket,
    },
    Leave {
        conn: ConnId,
    },
}

#[derive(Clone)]
pub struct RoomHandle {
    pub tx: mpsc::Sender<RoomCmd>,
}

#[derive(Default)]
pub struct Metrics {
    pub rooms: AtomicUsize,
    pub connections: AtomicUsize,
    pub humans: AtomicUsize,
    pub ticks: AtomicU64,
    /// Worst tick time in the last report window, microseconds.
    pub tick_us_max: AtomicU64,
    pub tick_us_total: AtomicU64,
    pub late_ticks: AtomicU64,
    pub bad_tokens: AtomicU64,
    pub bad_packets: AtomicU64,
}

#[derive(Default)]
pub struct Rooms {
    rooms: Mutex<HashMap<String, RoomHandle>>,
    pub draining: AtomicBool,
    pub metrics: Metrics,
}

impl Rooms {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn room_count(&self) -> usize {
        self.rooms.lock().expect("rooms lock").len()
    }

    /// Find the room named in the token, creating it (with the token's room
    /// settings) if it does not exist. New rooms are refused while draining.
    pub fn get_or_create(
        self: &Arc<Self>,
        claims: &JoinClaims,
    ) -> Result<RoomHandle, RejectReason> {
        let mut rooms = self.rooms.lock().expect("rooms lock");
        if let Some(h) = rooms.get(&claims.room)
            && !h.tx.is_closed()
        {
            return Ok(h.clone());
        }
        if self.draining.load(Ordering::Relaxed) {
            return Err(RejectReason::Draining);
        }
        let (tx, rx) = mpsc::channel(ROOM_INBOX);
        let handle = RoomHandle { tx };
        rooms.insert(claims.room.clone(), handle.clone());
        let config = RoomConfig::from_claims(claims);
        info!(room = %config.id, bots = config.bots, surface = ?config.surface_kind, "room created");
        self.metrics.rooms.fetch_add(1, Ordering::Relaxed);
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let id = config.id.clone();
            run_room(Room::new(config), rx, &me).await;
            let mut rooms = me.rooms.lock().expect("rooms lock");
            if rooms.get(&id).is_some_and(|h| h.tx.is_closed()) {
                rooms.remove(&id);
            }
            me.metrics.rooms.fetch_sub(1, Ordering::Relaxed);
            info!(room = %id, "room closed");
        });
        Ok(handle)
    }
}

fn send(conns: &HashMap<ConnId, mpsc::Sender<Bytes>>, conn: ConnId, bytes: Vec<u8>) {
    if let Some(tx) = conns.get(&conn) {
        // Datagram semantics: if the connection is backed up, drop.
        let _ = tx.try_send(Bytes::from(bytes));
    }
}

async fn run_room(mut room: Room, mut rx: mpsc::Receiver<RoomCmd>, rooms: &Rooms) {
    let tick = Duration::from_secs_f64(1.0 / f64::from(sim::TICK_HZ));
    let start = Instant::now();
    let mut next = start + tick;
    let mut conns: HashMap<ConnId, mpsc::Sender<Bytes>> = HashMap::new();
    let mut empty_since = Some(Instant::now());
    let now_ms = |at: Instant| at.duration_since(start).as_millis() as u64;
    loop {
        tokio::time::sleep_until(next.into()).await;
        let now = Instant::now();
        // Fell far behind (machine stalled)? Skip ahead instead of bursting.
        if now.duration_since(next) > tick * 5 {
            rooms.metrics.late_ticks.fetch_add(1, Ordering::Relaxed);
            next = now;
        }
        next += tick;

        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                RoomCmd::Join {
                    conn,
                    claims,
                    client_time,
                    tx,
                } => {
                    conns.insert(conn, tx);
                    let humans_before = room.human_count();
                    match room.join(conn, &claims, client_time, now_ms(now)) {
                        Ok((welcome, out)) => {
                            send(&conns, conn, ServerMsg::Welcome(welcome).encode());
                            for c in out.close {
                                conns.remove(&c);
                            }
                            if room.human_count() > humans_before {
                                info!(room = %room.config.id, pid = %claims.pid, slot = welcome.slot, "player joined");
                            }
                        }
                        Err(reason) => {
                            send(&conns, conn, ServerMsg::Reject(reason).encode());
                            conns.remove(&conn);
                        }
                    }
                }
                RoomCmd::Inputs { conn, packet } => room.handle_inputs(conn, &packet, now_ms(now)),
                RoomCmd::Leave { conn } => {
                    if room.slot_of(conn).is_some() {
                        info!(room = %room.config.id, conn, "player left");
                    }
                    room.leave(conn);
                    conns.remove(&conn);
                }
            }
        }

        let t0 = Instant::now();
        let out = room.step(now_ms(now));
        let us = t0.elapsed().as_micros() as u64;
        rooms.metrics.ticks.fetch_add(1, Ordering::Relaxed);
        rooms.metrics.tick_us_total.fetch_add(us, Ordering::Relaxed);
        rooms.metrics.tick_us_max.fetch_max(us, Ordering::Relaxed);
        if us > 4000 {
            warn!(room = %room.config.id, us, "slow tick");
        }
        for (conn, bytes) in out.packets {
            send(&conns, conn, bytes);
        }
        for conn in out.close {
            conns.remove(&conn);
        }

        if room.human_count() == 0 {
            let since = *empty_since.get_or_insert(now);
            if now.duration_since(since) > EMPTY_ROOM_TTL {
                break;
            }
        } else {
            empty_since = None;
        }
    }
}
