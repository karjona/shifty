//! One race room: the authority. A pure state machine with no async, no
//! sockets and no clock of its own. The caller passes `now_ms` in and ships
//! the returned packets. This keeps the netcode testable in-process with a
//! simulated network (see `tests/netcode.rs`).
//!
//! A room races its plan once: one course, or a Tilt (every course in
//! order, points by finishing place). After the last race's results the room
//! is over: it refuses everyone, and the caller closes it.
//!
//! Every race starts on the grid and waits there until everyone the lobby
//! sent has arrived and every screen in the room has the race's course
//! loaded (each input packet says which race its screen is ready for), or
//! until the grid has waited `GRID_TIMEOUT_TICKS`. Then the intro starts and
//! the sim takes it from there.

use std::collections::VecDeque;

use protocol::token::JoinClaims;
use protocol::{
    Event, EventBody, InputPacket, PROTOCOL_VERSION, RejectReason, RiderKind, RiderState,
    ServerMsg, Snapshot, Welcome, truncate_utf8,
};
use serde::Serialize;
use sim::bot::bot_input;

use crate::record::{RunReport, Trial};
use sim::race::{Phase, Race};
use sim::{CourseId, Input, Inputs, MAX_HUMANS, MAX_RIDERS, Setup, SurfaceKind, TICK_HZ, World};

pub type ConnId = u64;

/// Snapshots go out every N ticks (60 Hz sim / 2 = 30 Hz snapshots).
pub const SNAPSHOT_INTERVAL: u32 = 2;
/// Inputs further ahead than this are refused (1 s at 60 Hz).
pub const MAX_INPUT_LEAD_TICKS: u32 = 60;
/// Window (in ticks) over which the worst input lead is reported.
const LEAD_WINDOW_TICKS: u32 = 30;
/// Players silent for this long are removed.
pub const IDLE_TIMEOUT_MS: u64 = 10_000;
/// The grid waits at most this long for every screen to be ready; screens
/// still loading then see the race wherever it is.
pub const GRID_TIMEOUT_TICKS: u32 = TICK_HZ * 30;
/// Packet rate limit per connection: burst and sustained packets per second.
const RATE_BURST: f64 = 40.0;
const RATE_PER_SEC: f64 = 150.0;
const INPUT_RING: usize = 128;

/// Tilt points by finishing place. Riders who don't finish get the
/// last place's points.
pub const GP_POINTS: [u16; MAX_RIDERS] = [10, 8, 6, 5, 4, 3, 2, 1];
/// Bots' setups by seat (the same for every sport): a spread, so the field
/// rides differently.
const BOT_SETUPS: [[u8; 4]; 8] = [
    [3, 3, 3, 3],
    [4, 3, 3, 2],
    [3, 4, 2, 3],
    [2, 3, 4, 3],
    [3, 3, 2, 4],
    [4, 4, 2, 2],
    [2, 4, 3, 3],
    [3, 2, 4, 3],
];

#[derive(Clone, Debug)]
pub struct RoomConfig {
    pub id: String,
    /// The courses raced, in order: one, or a Tilt.
    pub plan: Vec<CourseId>,
    pub surface_kind: SurfaceKind,
    pub surface_seed: u32,
    pub bots: u8,
    /// People the lobby sent: the first race waits for them all to arrive.
    pub humans: u8,
    /// A time trial in this season (0-3): one rider, no bots, runs recorded.
    pub trial: Option<u8>,
}

impl RoomConfig {
    pub fn from_claims(claims: &JoinClaims) -> Self {
        let mut seed = 0x9E37_79B9u32;
        for b in claims.room.bytes() {
            seed = (seed ^ u32::from(b)).wrapping_mul(0x0100_0193);
        }
        let mut plan = claims.plan();
        if plan.is_empty() {
            plan.push(CourseId::Oval);
        }
        let trial = claims.trial.then_some(claims.season);
        if trial.is_some() {
            plan.truncate(1);
        }
        Self {
            id: claims.room.clone(),
            plan,
            surface_kind: SurfaceKind::from_u8(claims.surface).unwrap_or(SurfaceKind::Flat),
            surface_seed: seed,
            bots: if trial.is_some() {
                0
            } else {
                claims.bots.min((MAX_RIDERS - 1) as u8)
            },
            humans: if trial.is_some() {
                1
            } else {
                claims.humans.min(MAX_HUMANS as u8)
            },
            trial,
        }
    }

    pub fn grand_prix(&self) -> bool {
        self.plan.len() > 1
    }
}

/// One rider's race, for the lobby (JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    /// Account id; None for bots.
    pub pid: Option<String>,
    pub place: u8,
    pub time_ms: Option<u32>,
    pub trick_points: u16,
    /// Tilt points after this race.
    pub gp_points: Option<u16>,
}

/// A finished race, for the lobby (JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RaceReport {
    pub room: String,
    /// Counts runs through the plan (a plan started again from the top, when
    /// the first player arrives in a room that bots kept racing, is a new round).
    pub round: u16,
    /// The race's place in the plan.
    pub event: u8,
    pub course: u8,
    pub entries: Vec<ReportEntry>,
}

/// Whoever holds a seat in this Tilt, and their points.
#[derive(Clone, Debug)]
struct Entrant {
    pid: Option<String>,
    points: u16,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RoomStats {
    pub late_inputs: u64,
    pub missed_inputs: u64,
    pub future_inputs: u64,
    pub rate_limited_packets: u64,
    /// Races that started without every screen ready.
    pub grid_timeouts: u64,
}

struct Player {
    conn: ConnId,
    pid: String,
    name: String,
    /// Appearance bytes and setups from the join token, kept for the room's plan.
    look: Vec<u8>,
    setups: Vec<[u8; 4]>,
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
    /// The race of the plan this player's screen is ready for, plus one
    /// (0 = none yet).
    ready: u8,
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
    entrants: [Option<Entrant>; MAX_RIDERS],
    /// Which race of the plan is on.
    event_index: usize,
    round: u16,
    /// People seated in this run of the plan so far.
    arrived: usize,
    /// The last race's results are done.
    over: bool,
    /// A time trial's runs.
    trial: Option<Trial>,
    pub stats: RoomStats,
}

/// What the room wants the transport layer to do.
#[derive(Debug, Default)]
pub struct Outbox {
    pub packets: Vec<(ConnId, Vec<u8>)>,
    /// Connections to close (kicked or replaced).
    pub close: Vec<ConnId>,
    /// Races that just ended, for the lobby.
    pub reports: Vec<RaceReport>,
    /// Time trial runs that just finished, for the lobby.
    pub runs: Vec<RunReport>,
}

impl Room {
    pub fn new(config: RoomConfig) -> Self {
        let mut world = World::on_course(config.plan[0], config.surface_kind, config.surface_seed);
        world.trial = config.trial.is_some();
        let mut room = Self {
            trial: config.trial.map(|season| Trial::new(&config.id, season)),
            world,
            seats: [Seat::Empty; MAX_RIDERS],
            players: Default::default(),
            entrants: Default::default(),
            event_index: 0,
            round: 1,
            arrived: 0,
            over: false,
            stats: RoomStats::default(),
            config,
        };
        // Bots fill seats from the back; humans take seats from the front.
        for i in 0..room.config.bots as usize {
            let slot = MAX_RIDERS - 1 - i;
            room.seats[slot] = Seat::Bot;
            room.entrants[slot] = Some(Entrant {
                pid: None,
                points: 0,
            });
            room.world.spawn(slot);
        }
        room.apply_setups();
        room
    }

    /// The Tilt is under way: its first race has left the grid.
    pub fn grand_prix_started(&self) -> bool {
        self.config.grand_prix() && (self.event_index > 0 || self.world.race.phase != Phase::Grid)
    }

    pub fn event_index(&self) -> usize {
        self.event_index
    }

    /// The plan is done: the last race's results are over.
    pub fn is_over(&self) -> bool {
        self.over
    }

    fn standings_event(&self) -> EventBody {
        EventBody::Standings {
            points: self
                .entrants
                .iter()
                .enumerate()
                .filter_map(|(slot, e)| e.as_ref().map(|e| (slot as u8, e.points)))
                .collect(),
        }
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
        let (name, look) = match (&self.players[slot], kind) {
            (Some(p), _) => (p.name.clone(), p.look.clone()),
            (None, RiderKind::Bot) => (format!("Bot {}", slot + 1), Vec::new()),
            (None, RiderKind::Human) => return None,
        };
        Some(EventBody::RiderJoined {
            slot: slot as u8,
            kind,
            name,
            look,
            setups: self.setups_of(slot),
        })
    }

    /// A seat's setups (one per sport): the player's, or the bot's.
    fn setups_of(&self, slot: usize) -> Vec<[u8; 4]> {
        match (&self.players[slot], self.seats[slot]) {
            (Some(p), _) => p.setups.clone(),
            (None, Seat::Bot) => vec![BOT_SETUPS[slot % BOT_SETUPS.len()]; 2],
            _ => Vec::new(),
        }
    }

    /// Every seat's setup for the course raced now.
    fn apply_setups(&mut self) {
        let sport = self.world.course().sport;
        for slot in 0..MAX_RIDERS {
            self.world.setups[slot] = Setup::for_sport(&self.setups_of(slot), sport);
        }
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
        if self.over {
            return Err(RejectReason::Over);
        }
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
                    // A new screen: it says again what it has loaded.
                    p.ready = 0;
                    if let Some(trial) = &mut self.trial {
                        trial.seat(&claims.pid, &claims.look_bytes());
                    }
                }
                p.last_packet_ms = now_ms;
                slot
            }
            None => {
                let most = if self.trial.is_some() { 1 } else { MAX_HUMANS };
                if self.human_count() >= most {
                    return Err(RejectReason::RoomFull);
                }
                if self.human_count() == 0 {
                    // First player in: a fresh start on the grid (and
                    // Tilt), not the middle of a bots-only race.
                    self.restart_plan();
                } else if self.grand_prix_started() {
                    return Err(RejectReason::Started);
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
                self.entrants[slot] = Some(Entrant {
                    pid: Some(claims.pid.clone()),
                    points: 0,
                });
                self.world.spawn(slot);
                let player = Player {
                    conn,
                    pid: claims.pid.clone(),
                    name: truncate_utf8(claims.name.trim(), protocol::NAME_MAX_BYTES).to_owned(),
                    look: claims.look_bytes(),
                    setups: claims.setups.clone(),
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
                    ready: 0,
                };
                self.arrived += 1;
                // The newcomer learns the whole roster, in slot order, and
                // the Tilt table.
                self.players[slot] = Some(player);
                self.apply_setups();
                if let Some(trial) = &mut self.trial {
                    trial.seat(&claims.pid, &claims.look_bytes());
                }
                let events: Vec<EventBody> = (0..MAX_RIDERS)
                    .filter_map(|s| self.roster_event(s))
                    .collect();
                let standings = self.config.grand_prix().then(|| self.standings_event());
                let player = self.players[slot].as_mut().expect("seated");
                for e in events {
                    player.push_event(e);
                }
                if let Some(t) = standings {
                    player.push_event(t);
                }
                if let Some(joined) = self.roster_event(slot) {
                    self.broadcast_event(&joined, Some(slot));
                }
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
            course: self.world.course,
            surface_kind: self.config.surface_kind,
            surface_seed: self.config.surface_seed,
            server_tick: self.world.tick,
            echo_client_time: client_time,
            trial: self.trial.is_some(),
        }
    }

    /// A player leaves. In a Tilt under way a bot takes the seat (the
    /// player's points so far were already reported).
    pub fn leave(&mut self, conn: ConnId) {
        let Some(slot) = self.slot_of(conn) else {
            return;
        };
        self.players[slot] = None;
        self.broadcast_event(&EventBody::RiderLeft { slot: slot as u8 }, None);
        if self.grand_prix_started() && self.human_count() > 0 {
            self.seats[slot] = Seat::Bot;
            self.entrants[slot] = Some(Entrant {
                pid: None,
                points: 0,
            });
            // The bot starts from the grid: in this race if it hasn't
            // started, riding free until the next one if it has.
            self.world.remove(slot);
            self.world.spawn(slot);
            self.apply_setups();
            if let Some(e) = self.roster_event(slot) {
                self.broadcast_event(&e, None);
            }
            let table = self.standings_event();
            self.broadcast_event(&table, None);
        } else {
            self.seats[slot] = Seat::Empty;
            self.entrants[slot] = None;
            self.world.remove(slot);
        }
    }

    /// The race just ended: points (Tilt) and the report.
    fn race_ended(&mut self, out: &mut Outbox) {
        let standings = self.world.standings();
        let gp = self.config.grand_prix();
        let last = GP_POINTS[standings.len().clamp(1, MAX_RIDERS) - 1];
        let mut entries = Vec::with_capacity(standings.len());
        for st in &standings {
            let slot = st.slot as usize;
            let finished = st.progress.finished();
            let Some(entrant) = self.entrants[slot].as_mut() else {
                continue;
            };
            if gp {
                let won = if finished {
                    GP_POINTS[(st.place as usize - 1).min(MAX_RIDERS - 1)]
                } else {
                    last
                };
                entrant.points = entrant.points.saturating_add(won);
            }
            entries.push(ReportEntry {
                pid: entrant.pid.clone(),
                place: st.place,
                time_ms: finished.then(|| st.progress.finish_ticks * 1000 / TICK_HZ),
                trick_points: st.progress.points,
                gp_points: gp.then_some(entrant.points),
            });
        }
        if gp {
            let table = self.standings_event();
            self.broadcast_event(&table, None);
        }
        if self.trial.is_none() && entries.iter().any(|e| e.pid.is_some()) {
            out.reports.push(RaceReport {
                room: self.config.id.clone(),
                round: self.round,
                event: self.event_index as u8,
                course: self.world.course as u8,
                entries,
            });
        }
    }

    /// Back to the grid of the plan's first race, with no points.
    fn restart_plan(&mut self) {
        if self.event_index != 0 || self.world.course != self.config.plan[0] {
            self.event_index = 0;
            self.round = self.round.wrapping_add(1);
            self.load_course();
        }
        for e in self.entrants.iter_mut().flatten() {
            e.points = 0;
        }
        self.arrived = 0;
        self.world.restart();
    }

    /// Whether the race on the grid can start: everyone the lobby sent has
    /// arrived and every screen here is ready for this race (people who left
    /// don't count), or the grid has waited long enough.
    fn grid_done(&mut self) -> bool {
        let event = self.event_index as u8 + 1;
        let ready = self.arrived >= usize::from(self.config.humans)
            && self.players.iter().flatten().all(|p| p.ready >= event);
        if ready {
            return true;
        }
        let timed_out = self.world.race.elapsed(self.world.tick) >= GRID_TIMEOUT_TICKS;
        if timed_out {
            self.stats.grid_timeouts += 1;
        }
        timed_out
    }

    /// The results are over: on to the next race of the plan, or the plan is
    /// over after the last one.
    fn results_done(&mut self) {
        if self.event_index + 1 >= self.config.plan.len() {
            self.over = true;
            return;
        }
        self.event_index += 1;
        self.load_course();
    }

    /// A fresh world on the plan's current course (if it changed), with
    /// every seated rider on the grid.
    fn load_course(&mut self) {
        let course = self.config.plan[self.event_index];
        if course == self.world.course {
            return;
        }
        let tick = self.world.tick;
        let mut world =
            World::on_course(course, self.config.surface_kind, self.config.surface_seed);
        world.tick = tick;
        world.race = Race::new(tick);
        for slot in 0..MAX_RIDERS {
            if self.seats[slot] != Seat::Empty {
                world.spawn(slot);
            }
        }
        self.world = world;
        self.apply_setups();
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
        // Readiness only moves on (packets can arrive out of order).
        p.ready = p.ready.max(packet.ready);
        if let Some(trial) = &mut self.trial {
            trial.retries(packet.retry);
        }
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
        if self.world.race.phase == Phase::Grid && self.grid_done() {
            self.world.start_intro();
        }
        if let Some(trial) = &mut self.trial {
            trial.before_step(&mut self.world);
        }
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
        let phase_before = self.world.race.phase;
        let events = self.world.step(&inputs);
        if let Some(trial) = &mut self.trial
            && let Some(slot) = self.seats.iter().position(|s| *s == Seat::Human)
        {
            out.runs
                .extend(trial.after_step(&self.world, slot, &events));
        }
        match (phase_before, self.world.race.phase) {
            (Phase::Racing, Phase::Results) => self.race_ended(&mut out),
            (Phase::Results, Phase::Grid) => self.results_done(),
            _ => {}
        }

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
                    course: self.world.course,
                    event_index: self.event_index as u8,
                    event_count: self.config.plan.len() as u8,
                    race: self.world.race,
                    events: protocol::events_for_snapshot(&p.events),
                    riders: riders.clone(),
                };
                out.packets
                    .push((p.conn, ServerMsg::Snapshot(snap).encode()));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::race::tuning::{COUNTDOWN_TICKS, INTRO_TICKS};

    fn claims(pid: &str, events: Vec<u8>, bots: u8) -> JoinClaims {
        JoinClaims {
            v: 1,
            aud: "test".into(),
            room: "gp".into(),
            pid: pid.into(),
            name: pid.into(),
            exp: u64::MAX,
            iat: 0,
            bots,
            humans: 0,
            surface: SurfaceKind::Flat as u8,
            course: events[0],
            events,
            look: String::new(),
            setups: Vec::new(),
            trial: false,
            season: 0,
        }
    }

    /// An input packet from `conn`, its screen ready for race `ready` of
    /// the plan (None: still loading).
    fn send(room: &mut Room, conn: ConnId, now: u64, ready: Option<usize>) {
        let packet = InputPacket {
            event_ack: 0,
            last_snapshot_tick: 0,
            client_time: 0,
            ready: ready.map_or(0, |e| e as u8 + 1),
            retry: 0,
            first_tick: room.tick() + 1,
            inputs: vec![Input::default()],
        };
        room.handle_inputs(conn, &packet, now);
    }

    /// `ticks` ticks, each connection sending a packet before each one.
    fn run(room: &mut Room, now: &mut u64, ticks: u32, screens: &[(ConnId, Option<usize>)]) {
        for _ in 0..ticks {
            *now += 16;
            for &(conn, ready) in screens {
                send(room, conn, *now, ready);
            }
            room.step(*now);
        }
    }

    /// The player on connection 1 idles on the grid while the bots race
    /// (their screen ready for every race), until `done` (at most eight
    /// minutes). Returns the race reports.
    fn idle_until(room: &mut Room, now: &mut u64, done: impl Fn(&Room) -> bool) -> Vec<RaceReport> {
        let mut reports = Vec::new();
        for _ in 0..TICK_HZ * 60 * 8 {
            *now += 16;
            send(room, 1, *now, Some(room.event_index()));
            reports.extend(room.step(*now).reports);
            if done(room) {
                break;
            }
        }
        reports
    }

    #[test]
    fn a_grand_prix_scores_reports_and_moves_on() {
        let ana = claims("ana", vec![0, 1], 3);
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        let mut now = 0u64;
        room.join(1, &ana, 0, now).unwrap();
        let reports = idle_until(&mut room, &mut now, |r| {
            r.world().course == CourseId::Mountain
        });
        assert_eq!(room.world().course, CourseId::Mountain);
        assert_eq!(room.event_index(), 1);
        assert_eq!(room.world().race.phase, Phase::Grid);
        assert!(room.grand_prix_started());
        // The next race waits for Ana's screen to have the mountain loaded.
        run(&mut room, &mut now, 120, &[(1, Some(0))]);
        assert_eq!(room.world().race.phase, Phase::Grid);
        run(&mut room, &mut now, 2, &[(1, Some(1))]);
        assert_eq!(room.world().race.phase, Phase::Intro);

        let [report] = &reports[..] else {
            panic!("one race, one report: {reports:?}")
        };
        assert_eq!((report.round, report.event, report.course), (1, 0, 0));
        assert_eq!(report.entries.len(), 4);
        let mine = report
            .entries
            .iter()
            .find(|e| e.pid.as_deref() == Some("ana"))
            .unwrap();
        // Never left the grid: last place's points.
        assert_eq!(mine.time_ms, None);
        assert_eq!(mine.gp_points, Some(GP_POINTS[3]));
        let winner = report.entries.iter().find(|e| e.place == 1).unwrap();
        assert!(winner.time_ms.is_some());
        assert_eq!(winner.gp_points, Some(GP_POINTS[0]));

        // Nobody new joins a Tilt under way; Ana can come back.
        assert_eq!(
            room.join(2, &claims("bea", vec![0, 1], 3), 0, now).err(),
            Some(RejectReason::Started)
        );
        assert!(room.join(3, &ana, 0, now).is_ok());
    }

    #[test]
    fn a_plan_runs_once() {
        let ana = claims("ana", vec![0], 3);
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        let mut now = 0u64;
        room.join(1, &ana, 0, now).unwrap();
        let reports = idle_until(&mut room, &mut now, Room::is_over);
        assert!(room.is_over());
        assert_eq!(reports.len(), 1, "one race, one report");
        assert_eq!(room.event_index(), 0);
        assert_eq!(room.join(1, &ana, 0, now).err(), Some(RejectReason::Over));
        assert_eq!(
            room.join(2, &claims("bea", vec![0], 3), 0, now).err(),
            Some(RejectReason::Over)
        );
    }

    #[test]
    fn a_race_waits_on_the_grid_for_everyone_sent_and_every_screen() {
        let ana = JoinClaims {
            humans: 2,
            ..claims("ana", vec![0], 2)
        };
        let bea = JoinClaims {
            pid: "bea".into(),
            name: "bea".into(),
            ..ana.clone()
        };
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        let mut now = 0u64;
        room.join(1, &ana, 0, now).unwrap();
        // Ana's screen is ready, but Bea hasn't arrived yet...
        run(&mut room, &mut now, 120, &[(1, Some(0))]);
        assert_eq!(room.world().race.phase, Phase::Grid);
        // ...then she has, and her screen is still loading.
        room.join(2, &bea, 0, now).unwrap();
        run(&mut room, &mut now, 120, &[(1, Some(0)), (2, None)]);
        assert_eq!(room.world().race.phase, Phase::Grid);
        run(&mut room, &mut now, 2, &[(1, Some(0)), (2, Some(0))]);
        assert_eq!(room.world().race.phase, Phase::Intro);
        // Everyone lined up, held through the intro and the countdown.
        let both = [(1, Some(0)), (2, Some(0))];
        run(
            &mut room,
            &mut now,
            INTRO_TICKS + COUNTDOWN_TICKS - 4,
            &both,
        );
        assert_eq!(room.world().race.phase, Phase::Countdown);
        for conn in [1, 2] {
            let slot = room.slot_of(conn).unwrap();
            let r = room.world().riders[slot].unwrap();
            let spot = room.world().course().grid_spot(slot);
            assert!(r.race.racing && (r.pos.x - spot.x).abs() < 0.01);
        }
        run(&mut room, &mut now, 4, &both);
        assert_eq!(room.world().race.phase, Phase::Racing);
        assert_eq!(room.stats.grid_timeouts, 0);
    }

    #[test]
    fn a_screen_that_never_loads_holds_the_grid_only_so_long() {
        let ana = claims("ana", vec![0], 2);
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        let mut now = 0u64;
        room.join(1, &ana, 0, now).unwrap();
        room.join(2, &claims("bea", vec![0], 2), 0, now).unwrap();
        let screens = [(1, Some(0)), (2, None)];
        run(&mut room, &mut now, GRID_TIMEOUT_TICKS - 10, &screens);
        assert_eq!(room.world().race.phase, Phase::Grid);
        run(&mut room, &mut now, 20, &screens);
        assert_eq!(room.world().race.phase, Phase::Intro);
        assert_eq!(room.stats.grid_timeouts, 1);
    }

    #[test]
    fn people_who_leave_dont_hold_the_grid() {
        let ana = JoinClaims {
            humans: 2,
            ..claims("ana", vec![0], 2)
        };
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        let mut now = 0u64;
        room.join(1, &ana, 0, now).unwrap();
        room.join(2, &claims("bea", vec![0], 2), 0, now).unwrap();
        run(&mut room, &mut now, 60, &[(1, Some(0)), (2, None)]);
        assert_eq!(room.world().race.phase, Phase::Grid);
        room.leave(2);
        run(&mut room, &mut now, 2, &[(1, Some(0))]);
        assert_eq!(room.world().race.phase, Phase::Intro);
    }

    #[test]
    fn a_new_screen_for_the_same_seat_says_again_what_it_has_loaded() {
        let ana = claims("ana", vec![0], 0);
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        let mut now = 0u64;
        room.join(1, &ana, 0, now).unwrap();
        room.join(2, &claims("bea", vec![0], 0), 0, now).unwrap();
        run(&mut room, &mut now, 30, &[(1, None), (2, Some(0))]);
        // Bea reloads the page: her new screen is still loading.
        room.join(3, &claims("bea", vec![0], 0), 0, now).unwrap();
        run(&mut room, &mut now, 30, &[(1, Some(0)), (3, None)]);
        assert_eq!(room.world().race.phase, Phase::Grid);
        run(&mut room, &mut now, 2, &[(1, Some(0)), (3, Some(0))]);
        assert_eq!(room.world().race.phase, Phase::Intro);
    }
}
