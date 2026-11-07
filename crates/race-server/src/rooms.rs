//! Room lifecycle on Tokio: one task per room, each running the pure `Room`
//! state machine on a fixed 60 Hz clock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use protocol::token::JoinClaims;
use protocol::{InputPacket, RejectReason, ServerMsg};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::room::{ConnId, RaceReport, Room, RoomConfig};

/// Rooms with no humans for this long shut down.
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30);
/// A room whose plan is over closes this long after (its last snapshots).
const OVER_LINGER: Duration = Duration::from_secs(5);
/// Rooms that ended are remembered this long (longer than a join token
/// lives), so tokens signed before the end can't start the plan again.
const ENDED_MEMORY_SECS: u64 = 15 * 60;
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
    /// Rooms whose plan is over, and when it ended (unix seconds).
    ended: Mutex<HashMap<String, u64>>,
    pub draining: AtomicBool,
    pub metrics: Metrics,
    /// Where finished races go (the lobby reporter), if anywhere.
    reports: OnceLock<mpsc::Sender<RaceReport>>,
}

impl Rooms {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Sends every finished race to `tx` from now on.
    pub fn report_to(&self, tx: mpsc::Sender<RaceReport>) {
        let _ = self.reports.set(tx);
    }

    pub fn room_count(&self) -> usize {
        self.rooms.lock().expect("rooms lock").len()
    }

    /// Remembers that a room's plan is over, and lets its id go: a token
    /// signed after the end starts the room afresh.
    fn ended(&self, room: &str, now_unix: u64) {
        self.rooms.lock().expect("rooms lock").remove(room);
        let mut ended = self.ended.lock().expect("ended lock");
        ended.retain(|_, at| now_unix.saturating_sub(*at) < ENDED_MEMORY_SECS);
        ended.insert(room.to_owned(), now_unix);
    }

    /// The room's plan ended after this token was signed.
    fn ended_since(&self, claims: &JoinClaims, now_unix: u64) -> bool {
        let ended = self.ended.lock().expect("ended lock");
        ended
            .get(&claims.room)
            .is_some_and(|&at| now_unix.saturating_sub(at) < ENDED_MEMORY_SECS && claims.iat <= at)
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
        if self.ended_since(claims, now_unix()) {
            return Err(RejectReason::Over);
        }
        if self.draining.load(Ordering::Relaxed) {
            return Err(RejectReason::Draining);
        }
        let (tx, rx) = mpsc::channel(ROOM_INBOX);
        let handle = RoomHandle { tx };
        rooms.insert(claims.room.clone(), handle.clone());
        let config = RoomConfig::from_claims(claims);
        info!(room = %config.id, plan = ?config.plan, bots = config.bots, surface = ?config.surface_kind, "room created");
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

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
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
    let mut over_since: Option<Instant> = None;
    let mut humans = 0usize;
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
        for report in out.reports {
            if let Some(tx) = rooms.reports.get()
                && tx.try_send(report).is_err()
            {
                warn!(room = %room.config.id, "result report dropped (reporter backed up)");
            }
        }
        let now_humans = room.human_count();
        if now_humans != humans {
            rooms
                .metrics
                .humans
                .fetch_add(now_humans, Ordering::Relaxed);
            rooms.metrics.humans.fetch_sub(humans, Ordering::Relaxed);
            humans = now_humans;
        }

        if room.is_over() {
            let since = *over_since.get_or_insert_with(|| {
                info!(room = %room.config.id, "plan over");
                rooms.ended(&room.config.id, now_unix());
                now
            });
            if now.duration_since(since) > OVER_LINGER {
                break;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(room: &str, iat: u64) -> JoinClaims {
        JoinClaims {
            v: 1,
            aud: "test".into(),
            room: room.into(),
            pid: "ana".into(),
            name: "Ana".into(),
            exp: u64::MAX,
            iat,
            bots: 0,
            humans: 0,
            surface: 0,
            course: 0,
            events: vec![0],
            look: String::new(),
            setups: Vec::new(),
        }
    }

    #[test]
    fn an_ended_room_refuses_tokens_signed_before_the_end() {
        let rooms = Rooms::default();
        rooms.ended("r1", 1_000);
        assert!(rooms.ended_since(&claims("r1", 999), 1_010));
        assert!(rooms.ended_since(&claims("r1", 1_000), 1_010));
        assert!(rooms.ended_since(&claims("r1", 0), 1_010));
        // A token signed after the end starts the room afresh.
        assert!(!rooms.ended_since(&claims("r1", 1_001), 1_010));
        assert!(!rooms.ended_since(&claims("r2", 0), 1_010));
        // Forgotten once no token signed before the end can still be valid.
        assert!(!rooms.ended_since(&claims("r1", 0), 1_000 + ENDED_MEMORY_SECS));
    }
}
