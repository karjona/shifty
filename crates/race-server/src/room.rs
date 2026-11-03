//! One race room: the authority. A pure state machine with no async, no
//! sockets and no clock of its own. The caller passes `now_ms` in and ships
//! the returned packets. This keeps the netcode testable in-process with a
//! simulated network (see `tests/netcode.rs`).

use std::collections::VecDeque;

use protocol::token::JoinClaims;
use protocol::{
    Event, EventBody, InputPacket, MAX_EVENTS_PER_SNAPSHOT, PROTOCOL_VERSION, RejectReason,
    RiderKind, RiderState, ServerMsg, Snapshot, Welcome, truncate_utf8,
};
use sim::bot::bot_input;
use sim::{CourseId, Input, Inputs, MAX_HUMANS, MAX_RIDERS, SurfaceKind, TICK_HZ, World};

pub type ConnId = u64;

/// Snapshots go out every N ticks (60 Hz sim / 2 = 30 Hz snapshots).
pub const SNAPSHOT_INTERVAL: u32 = 2;
/// Inputs further ahead than this are refused (1 s at 60 Hz).
pub const MAX_INPUT_LEAD_TICKS: u32 = 60;
/// Window (in ticks) over which the worst input lead is reported.
const LEAD_WINDOW_TICKS: u32 = 30;
/// Players silent for this long are removed.
pub const IDLE_TIMEOUT_MS: u64 = 10_000;
/// Packet rate limit per connection: burst and sustained packets per second.
const RATE_BURST: f64 = 40.0;
const RATE_PER_SEC: f64 = 150.0;
const INPUT_RING: usize = 128;

#[derive(Clone, Debug)]
pub struct RoomConfig {
    pub id: String,
    pub course: CourseId,
    pub surface_kind: SurfaceKind,
    pub surface_seed: u32,
    pub bots: u8,
}

impl RoomConfig {
    pub fn from_claims(claims: &JoinClaims) -> Self {
        let mut seed = 0x9E37_79B9u32;
        for b in claims.room.bytes() {
            seed = (seed ^ u32::from(b)).wrapping_mul(0x0100_0193);
        }
        Self {
            id: claims.room.clone(),
            course: CourseId::Oval,
            surface_kind: SurfaceKind::from_u8(claims.surface).unwrap_or(SurfaceKind::Flat),
            surface_seed: seed,
            bots: claims.bots.min((MAX_RIDERS - 1) as u8),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RoomStats {
    pub late_inputs: u64,
    pub missed_inputs: u64,
    pub future_inputs: u64,
    pub rate_limited_packets: u64,
}

struct Player {
    conn: ConnId,
    pid: String,
    name: String,
    /// Ring buffer of inputs keyed by tick.
    inputs: [Option<(u32, Input)>; INPUT_RING],
    highest_input_tick: u32,
    lead_min_window: i32,
    lead_report: i8,
    echo_client_time: u16,
    echo_received_ms: u64,
    last_packet_ms: u64,
    rate_tokens: f64,
    rate_last_ms: u64,
    events: VecDeque<Event>,
    next_event_id: u16,
}

impl Player {
    fn push_event(&mut self, body: EventBody) {
        self.events.push_back(Event {
            id: self.next_event_id,
            body,
        });
        self.next_event_id = self.next_event_id.wrapping_add(1);
    }

    fn ack_events(&mut self, next_expected: u16) {
        while let Some(front) = self.events.front() {
            // `front.id < next_expected` in wrapping u16 space.
            let behind = next_expected.wrapping_sub(front.id);
            if behind != 0 && behind < 0x8000 {
                self.events.pop_front();
            } else {
                break;
            }
        }
    }

    fn allow_packet(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.rate_last_ms) as f64 / 1000.0;
        self.rate_last_ms = now_ms;
        self.rate_tokens = (self.rate_tokens + elapsed * RATE_PER_SEC).min(RATE_BURST);
        if self.rate_tokens >= 1.0 {
            self.rate_tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Seat {
    Empty,
    Human,
    Bot,
}

pub struct Room {
    pub config: RoomConfig,
    world: World,
    seats: [Seat; MAX_RIDERS],
    players: [Option<Player>; MAX_RIDERS],
    pub stats: RoomStats,
}

/// What the room wants the transport layer to do.
#[derive(Debug, Default)]
pub struct Outbox {
    pub packets: Vec<(ConnId, Vec<u8>)>,
    /// Connections to close (kicked or replaced).
    pub close: Vec<ConnId>,
}

impl Room {
    pub fn new(config: RoomConfig) -> Self {
        let mut room = Self {
            world: World::on_course(config.course, config.surface_kind, config.surface_seed),
            seats: [Seat::Empty; MAX_RIDERS],
            players: Default::default(),
            stats: RoomStats::default(),
            config,
        };
        // Bots fill seats from the back; humans take seats from the front.
        for i in 0..room.config.bots as usize {
            let slot = MAX_RIDERS - 1 - i;
            room.seats[slot] = Seat::Bot;
            room.world.spawn(slot);
        }
        room
    }

    pub fn tick(&self) -> u32 {
        self.world.tick
    }

    pub fn world(&self) -> &World {
        &self.world
    }

    pub fn human_count(&self) -> usize {
        self.players.iter().flatten().count()
    }

    pub fn slot_of(&self, conn: ConnId) -> Option<usize> {
        self.players
            .iter()
            .position(|p| p.as_ref().is_some_and(|p| p.conn == conn))
    }

    fn broadcast_event(&mut self, body: &EventBody, except: Option<usize>) {
        for (slot, p) in self.players.iter_mut().enumerate() {
            if let Some(p) = p
                && Some(slot) != except
            {
                p.push_event(body.clone());
            }
        }
    }

    fn roster_event(&self, slot: usize) -> Option<EventBody> {
        let kind = match self.seats[slot] {
            Seat::Empty => return None,
            Seat::Human => RiderKind::Human,
            Seat::Bot => RiderKind::Bot,
        };
        let name = match (&self.players[slot], kind) {
            (Some(p), _) => p.name.clone(),
            (None, RiderKind::Bot) => format!("Bot {}", slot + 1),
            (None, RiderKind::Human) => return None,
        };
        Some(EventBody::RiderJoined {
            slot: slot as u8,
            kind,
            name,
        })
    }

    /// Seat a verified player. Same `pid` again = reconnect: keeps the seat
    /// and the rider, swaps the connection.
    pub fn join(
        &mut self,
        conn: ConnId,
        claims: &JoinClaims,
        client_time: u16,
        now_ms: u64,
    ) -> Result<(Welcome, Outbox), RejectReason> {
        let mut out = Outbox::default();
        let existing = self
            .players
            .iter()
            .position(|p| p.as_ref().is_some_and(|p| p.pid == claims.pid));
        let slot = match existing {
            Some(slot) => {
                let p = self.players[slot].as_mut().expect("seated");
                if p.conn != conn {
                    out.close.push(p.conn);
                    p.conn = conn;
                }
                p.last_packet_ms = now_ms;
                slot
            }
            None => {
                if self.human_count() >= MAX_HUMANS {
                    return Err(RejectReason::RoomFull);
                }
                if self.human_count() == 0 {
                    // First player in: a fresh warm-up, not the middle of a
                    // bots-only race.
                    self.world.restart_warmup();
                }
                let slot = match self.seats.iter().position(|s| *s == Seat::Empty) {
                    Some(s) => s,
                    None => {
                        // Bots give their seat to humans.
                        let bot = self
                            .seats
                            .iter()
                            .position(|s| *s == Seat::Bot)
                            .ok_or(RejectReason::RoomFull)?;
                        self.seats[bot] = Seat::Empty;
                        self.world.remove(bot);
                        self.broadcast_event(&EventBody::RiderLeft { slot: bot as u8 }, None);
                        bot
                    }
                };
                self.seats[slot] = Seat::Human;
                self.world.spawn(slot);
                let mut player = Player {
                    conn,
                    pid: claims.pid.clone(),
                    name: truncate_utf8(claims.name.trim(), protocol::NAME_MAX_BYTES).to_owned(),
                    inputs: [None; INPUT_RING],
                    highest_input_tick: self.world.tick,
                    lead_min_window: i32::MAX,
                    lead_report: 0,
                    echo_client_time: client_time,
                    echo_received_ms: now_ms,
                    last_packet_ms: now_ms,
                    rate_tokens: RATE_BURST,
                    rate_last_ms: now_ms,
                    events: VecDeque::new(),
                    next_event_id: 0,
                };
                // The newcomer learns the whole roster, in slot order.
                for s in 0..MAX_RIDERS {
                    if s == slot {
                        player.push_event(EventBody::RiderJoined {
                            slot: slot as u8,
                            kind: RiderKind::Human,
                            name: player.name.clone(),
                        });
                    } else if let Some(e) = self.roster_event(s) {
                        player.push_event(e);
                    }
                }
                let joined = EventBody::RiderJoined {
                    slot: slot as u8,
                    kind: RiderKind::Human,
                    name: player.name.clone(),
                };
                self.players[slot] = Some(player);
                self.broadcast_event(&joined, Some(slot));
                slot
            }
        };
        Ok((self.welcome(slot, client_time), out))
    }

    pub fn welcome(&self, slot: usize, client_time: u16) -> Welcome {
        Welcome {
            version: PROTOCOL_VERSION,
            slot: slot as u8,
            tick_hz: TICK_HZ as u8,
            snapshot_interval: SNAPSHOT_INTERVAL as u8,
            max_riders: MAX_RIDERS as u8,
            course: self.config.course,
            surface_kind: self.config.surface_kind,
            surface_seed: self.config.surface_seed,
            server_tick: self.world.tick,
            echo_client_time: client_time,
        }
    }

    pub fn leave(&mut self, conn: ConnId) {
        if let Some(slot) = self.slot_of(conn) {
            self.players[slot] = None;
            self.seats[slot] = Seat::Empty;
            self.world.remove(slot);
            self.broadcast_event(&EventBody::RiderLeft { slot: slot as u8 }, None);
        }
    }

    /// Validate and buffer a packet of inputs. Never trusts the client: values
    /// are clamped, ticks outside the accepted window are dropped, and the
    /// packet rate is limited. One input is consumed per tick no matter how
    /// many arrive, so flooding cannot speed a rider up.
    pub fn handle_inputs(&mut self, conn: ConnId, packet: &InputPacket, now_ms: u64) {
        let Some(slot) = self.slot_of(conn) else {
            return;
        };
        let server_tick = self.world.tick;
        let p = self.players[slot].as_mut().expect("seated");
        if !p.allow_packet(now_ms) {
            self.stats.rate_limited_packets += 1;
            return;
        }
        p.last_packet_ms = now_ms;
        p.ack_events(packet.event_ack);
        p.echo_client_time = packet.client_time;
        p.echo_received_ms = now_ms;

        // Lead = how many ticks early each *newly received* input arrived;
        // the worst one in the window is reported. Late inputs count as
        // negative lead, which makes the client grow its input buffer.
        let prev_highest = p.highest_input_tick;
        let mut worst: Option<i64> = None;
        for (i, input) in packet.inputs.iter().enumerate() {
            let tick = packet.first_tick.wrapping_add(i as u32);
            if tick > server_tick + MAX_INPUT_LEAD_TICKS {
                self.stats.future_inputs += 1;
                continue;
            }
            let fresh = tick > prev_highest;
            if fresh {
                let margin = i64::from(tick) - i64::from(server_tick);
                worst = Some(worst.map_or(margin, |w| w.min(margin)));
                p.highest_input_tick = p.highest_input_tick.max(tick);
            }
            if tick <= server_tick {
                // Already simulated: a resend, or genuinely late.
                if fresh {
                    self.stats.late_inputs += 1;
                }
                continue;
            }
            p.inputs[tick as usize % INPUT_RING] = Some((tick, input.sanitized()));
        }
        if let Some(w) = worst {
            p.lead_min_window = p.lead_min_window.min(w.clamp(-127, 127) as i32);
        }
    }

    /// Advance the world one tick. Returns snapshots on snapshot ticks.
    pub fn step(&mut self, now_ms: u64) -> Outbox {
        let mut out = Outbox::default();
        let next = self.world.tick.wrapping_add(1);
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for slot in 0..MAX_RIDERS {
            match self.seats[slot] {
                Seat::Empty => {}
                Seat::Bot => inputs[slot] = Some(bot_input(&self.world, slot)),
                Seat::Human => {
                    let p = self.players[slot].as_mut().expect("seated");
                    match p.inputs[next as usize % INPUT_RING].take() {
                        Some((t, input)) if t == next => inputs[slot] = Some(input),
                        _ => self.stats.missed_inputs += 1, // repeat last input
                    }
                }
            }
        }
        self.world.step(&inputs);

        let tick = self.world.tick;
        if tick.is_multiple_of(LEAD_WINDOW_TICKS) {
            for p in self.players.iter_mut().flatten() {
                if p.lead_min_window != i32::MAX {
                    p.lead_report = p.lead_min_window.clamp(-127, 127) as i8;
                }
                p.lead_min_window = i32::MAX;
            }
        }

        // Idle players are removed.
        let idle: Vec<ConnId> = self
            .players
            .iter()
            .flatten()
            .filter(|p| now_ms.saturating_sub(p.last_packet_ms) > IDLE_TIMEOUT_MS)
            .map(|p| p.conn)
            .collect();
        for conn in idle {
            out.packets
                .push((conn, ServerMsg::Reject(RejectReason::Kicked).encode()));
            out.close.push(conn);
            self.leave(conn);
        }

        if tick.is_multiple_of(SNAPSHOT_INTERVAL) {
            let riders: Vec<RiderState> = self
                .world
                .riders
                .iter()
                .enumerate()
                .filter_map(|(slot, r)| {
                    r.map(|rider| RiderState {
                        slot: slot as u8,
                        rider,
                    })
                })
                .collect();
            for p in self.players.iter().flatten() {
                let snap = Snapshot {
                    tick,
                    input_ack: p.highest_input_tick,
                    input_lead: p.lead_report,
                    echo_client_time: p.echo_client_time,
                    echo_hold_ms: now_ms
                        .saturating_sub(p.echo_received_ms)
                        .min(u64::from(u16::MAX)) as u16,
                    race: self.world.race,
                    events: p
                        .events
                        .iter()
                        .take(MAX_EVENTS_PER_SNAPSHOT)
                        .cloned()
                        .collect(),
                    riders: riders.clone(),
                };
                out.packets
                    .push((p.conn, ServerMsg::Snapshot(snap).encode()));
            }
        }
        out
    }
}
