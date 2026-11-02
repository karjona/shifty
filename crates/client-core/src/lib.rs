//! Client-side netcode, shared by the browser (through `sim-wasm`) and by
//! headless bots/tests (natively). Pure: the caller passes the time in and
//! ships the packets out, so every behaviour can be tested with a simulated
//! network.
//!
//! - **Prediction:** the client runs the sim ahead of the server, applying
//!   its own inputs immediately. Other humans are extrapolated by repeating
//!   their last known input; bots are predicted exactly (their AI is
//!   deterministic). So rider-vs-rider bumps are predicted too.
//! - **Reconciliation:** every snapshot resets the world to the
//!   authoritative state and re-simulates up to the present with the inputs
//!   not yet confirmed. Visual error is smoothed out over ~100 ms.
//! - **Clock sync:** the server reports how early our inputs arrive; we
//!   speed up or slow down our tick clock by up to 6% to keep a small lead.
//! - **Interpolation:** other riders can be drawn ~100 ms in the past between
//!   two real snapshots (smooth and correct), or from the predicted world
//!   (current, but can wobble). `RemoteMode` picks.

use std::collections::VecDeque;

use protocol::{
    ClientMsg, Event, EventBody, InputPacket, MAX_INPUTS_PER_PACKET, PROTOCOL_VERSION,
    RejectReason, RiderKind, ServerMsg, Snapshot,
};
use sim::bot::bot_input;
use sim::math::{Vec3, angle_diff, wrap_angle};
use sim::{Input, Inputs, MAX_RIDERS, Rider, Surface, TICK_HZ, World};

pub const TICK_MS: f64 = 1000.0 / TICK_HZ as f64;
/// How far in the past remote riders are drawn in interpolated mode.
pub const INTERP_DELAY_TICKS: f64 = 6.0;
/// How many ticks early we want our inputs to reach the server.
pub const TARGET_LEAD: f64 = 2.0;
const HISTORY: usize = 256;
const HELLO_RESEND_MS: f64 = 300.0;
const SNAP_BUFFER: usize = 64;
/// Corrections bigger than this snap instead of smoothing (teleports).
const SNAP_DISTANCE: f32 = 3.0;
/// Half-life of visual error smoothing.
const SMOOTH_HALF_LIFE_MS: f64 = 60.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    Joined,
    Rejected(RejectReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteMode {
    Interpolated,
    Predicted,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub rtt_ms: f64,
    pub input_lead: i8,
    pub time_scale: f64,
    pub predicted_tick: u32,
    pub snapshot_tick: u32,
    /// Size of the latest own-rider correction, metres.
    pub last_correction_m: f32,
    /// Corrections bigger than 1 mm.
    pub mispredictions: u32,
    pub snapshots: u32,
    pub stale_snapshots: u32,
    pub resyncs: u32,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub packets_in: u64,
    pub packets_out: u64,
    pub last_snapshot_bytes: u32,
    pub last_input_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RenderRider {
    pub slot: u8,
    pub pos: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    pub speed: f32,
    pub grounded: bool,
    pub is_me: bool,
    pub is_bot: bool,
}

#[derive(Clone, Debug)]
pub struct RosterEntry {
    pub kind: RiderKind,
    pub name: String,
}

type Riders = [Option<Rider>; MAX_RIDERS];

pub struct Client {
    token: String,
    phase: Phase,
    last_hello_ms: f64,
    slot: usize,
    surface: Surface,
    /// Predicted world, at `world.tick`.
    world: World,
    /// Rider states one tick before `world`, for smooth frame interpolation.
    prev_riders: Riders,
    history: [Option<(u32, Input)>; HISTORY],
    input_ack: u32,
    current_input: Input,
    accum_ms: f64,
    last_update_ms: Option<f64>,
    time_scale: f64,
    rtt_ms: Option<f64>,
    resync_cooldown_until: u32,
    last_snapshot_tick: Option<u32>,
    next_event_id: u16,
    pending_events: Vec<Event>,
    roster: [Option<RosterEntry>; MAX_RIDERS],
    roster_version: u32,
    snaps: VecDeque<(u32, Riders)>,
    interp_offset: Option<f64>,
    render_offset: [Vec3; MAX_RIDERS],
    yaw_offset: [f32; MAX_RIDERS],
    outbox: Vec<Vec<u8>>,
    stats: Stats,
}

impl Client {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            phase: Phase::Connecting,
            last_hello_ms: f64::NEG_INFINITY,
            slot: 0,
            surface: Surface::flat(),
            world: World::new(Surface::flat()),
            prev_riders: [None; MAX_RIDERS],
            history: [None; HISTORY],
            input_ack: 0,
            current_input: Input::default(),
            accum_ms: 0.0,
            last_update_ms: None,
            time_scale: 1.0,
            rtt_ms: None,
            resync_cooldown_until: 0,
            last_snapshot_tick: None,
            next_event_id: 0,
            pending_events: Vec::new(),
            roster: Default::default(),
            roster_version: 0,
            snaps: VecDeque::with_capacity(SNAP_BUFFER),
            interp_offset: None,
            render_offset: [Vec3::ZERO; MAX_RIDERS],
            yaw_offset: [0.0; MAX_RIDERS],
            outbox: Vec::new(),
            stats: Stats {
                time_scale: 1.0,
                ..Stats::default()
            },
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn slot(&self) -> Option<usize> {
        (self.phase == Phase::Joined).then_some(self.slot)
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn surface(&self) -> &Surface {
        &self.surface
    }

    pub fn roster(&self) -> &[Option<RosterEntry>; MAX_RIDERS] {
        &self.roster
    }

    /// Bumps every time the roster changes, so UIs can refresh cheaply.
    pub fn roster_version(&self) -> u32 {
        self.roster_version
    }

    pub fn predicted_world(&self) -> &World {
        &self.world
    }

    /// Fractional predicted tick, for animating time-based things (water).
    pub fn render_tick(&self) -> f64 {
        f64::from(self.world.tick) - 1.0 + self.accum_ms / TICK_MS
    }

    /// Packets to send, oldest first.
    pub fn take_outgoing(&mut self) -> Vec<Vec<u8>> {
        let out = std::mem::take(&mut self.outbox);
        for p in &out {
            self.stats.bytes_out += p.len() as u64;
            self.stats.packets_out += 1;
        }
        out
    }

    fn send(&mut self, msg: &ClientMsg) {
        self.outbox.push(msg.encode());
    }

    fn time16(now_ms: f64) -> u16 {
        (now_ms as u64 & 0xFFFF) as u16
    }

    fn rtt_sample(&mut self, now_ms: f64, echo: u16, hold_ms: u16) {
        let elapsed = Self::time16(now_ms).wrapping_sub(echo);
        let sample = f64::from(elapsed) - f64::from(hold_ms);
        if (0.0..5000.0).contains(&sample) {
            let rtt = match self.rtt_ms {
                None => sample,
                Some(r) => r + (sample - r) * 0.1,
            };
            self.rtt_ms = Some(rtt);
            self.stats.rtt_ms = rtt;
        }
    }

    /// Advance the client clock. Call once per frame with the current input.
    pub fn update(&mut self, now_ms: f64, input: Input) {
        self.current_input = input;
        match self.phase {
            Phase::Rejected(_) => return,
            Phase::Connecting => {
                if now_ms - self.last_hello_ms >= HELLO_RESEND_MS {
                    self.last_hello_ms = now_ms;
                    let hello = ClientMsg::Hello {
                        version: PROTOCOL_VERSION,
                        token: self.token.clone(),
                        client_time: Self::time16(now_ms),
                    };
                    self.send(&hello);
                }
                return;
            }
            Phase::Joined => {}
        }

        let dt = self
            .last_update_ms
            .map_or(0.0, |last| (now_ms - last).clamp(0.0, 250.0));
        self.last_update_ms = Some(now_ms);
        self.accum_ms += dt * self.time_scale;
        let mut steps = 0;
        while self.accum_ms >= TICK_MS {
            self.accum_ms -= TICK_MS;
            self.predict_tick(input);
            steps += 1;
            if steps >= 8 {
                // Way behind (tab was hidden?). Clock sync will resync us.
                self.accum_ms = self.accum_ms.min(TICK_MS - 0.001);
                break;
            }
        }
        if steps > 0 {
            self.send_inputs(now_ms);
        }

        let decay = 0.5f64.powf(dt / SMOOTH_HALF_LIFE_MS) as f32;
        for slot in 0..MAX_RIDERS {
            self.render_offset[slot] = self.render_offset[slot] * decay;
            self.yaw_offset[slot] *= decay;
        }
    }

    fn inputs_for(&self, world: &World, tick: u32) -> Inputs {
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for (slot, input) in inputs.iter_mut().enumerate() {
            if world.riders[slot].is_none() {
                continue;
            }
            if slot == self.slot {
                *input = Some(match self.history[tick as usize % HISTORY] {
                    Some((t, i)) if t == tick => i,
                    _ => self.current_input,
                });
            } else if matches!(
                self.roster[slot],
                Some(RosterEntry {
                    kind: RiderKind::Bot,
                    ..
                })
            ) {
                *input = Some(bot_input(world, slot));
            }
            // Other humans: None = repeat their last known input.
        }
        inputs
    }

    fn predict_tick(&mut self, input: Input) {
        let tick = self.world.tick.wrapping_add(1);
        self.history[tick as usize % HISTORY] = Some((tick, input));
        self.prev_riders = self.world.riders;
        let inputs = self.inputs_for(&self.world, tick);
        self.world.step(&inputs);
        self.stats.predicted_tick = self.world.tick;
    }

    fn send_inputs(&mut self, now_ms: f64) {
        let last = self.world.tick;
        let oldest_allowed = last.saturating_sub(MAX_INPUTS_PER_PACKET as u32 - 1);
        let first = self.input_ack.wrapping_add(1).max(oldest_allowed).min(last);
        let inputs: Vec<Input> = (first..=last)
            .map(|t| match self.history[t as usize % HISTORY] {
                Some((ht, i)) if ht == t => i,
                _ => self.current_input,
            })
            .collect();
        self.stats.last_input_count = inputs.len() as u32;
        let packet = InputPacket {
            event_ack: self.next_event_id,
            last_snapshot_tick: self.last_snapshot_tick.unwrap_or(0),
            client_time: Self::time16(now_ms),
            first_tick: first,
            inputs,
        };
        self.send(&ClientMsg::Inputs(packet));
    }

    pub fn handle_packet(&mut self, bytes: &[u8], now_ms: f64) {
        self.stats.bytes_in += bytes.len() as u64;
        self.stats.packets_in += 1;
        let Ok(msg) = ServerMsg::decode(bytes) else {
            return;
        };
        match msg {
            ServerMsg::Welcome(w) => {
                if self.phase != Phase::Connecting || w.version != PROTOCOL_VERSION {
                    return;
                }
                self.rtt_sample(now_ms, w.echo_client_time, 0);
                let rtt_ticks = self.rtt_ms.unwrap_or(100.0) / TICK_MS;
                self.phase = Phase::Joined;
                self.slot = w.slot as usize;
                self.surface = Surface::new(w.surface_kind, w.surface_seed);
                self.world = World::new(self.surface.clone());
                // Run ahead of the server by the trip time plus a small lead.
                self.world.tick = w.server_tick + (rtt_ticks + TARGET_LEAD + 1.0).ceil() as u32;
                self.input_ack = self.world.tick;
                self.last_update_ms = Some(now_ms);
                self.accum_ms = 0.0;
            }
            ServerMsg::Reject(reason) => {
                self.phase = Phase::Rejected(reason);
            }
            ServerMsg::Snapshot(s) => {
                if self.phase != Phase::Joined {
                    return;
                }
                self.stats.last_snapshot_bytes = bytes.len() as u32;
                self.apply_events(&s.events);
                if self.last_snapshot_tick.is_some_and(|t| s.tick <= t) {
                    self.stats.stale_snapshots += 1;
                    return;
                }
                self.apply_snapshot(&s, now_ms);
            }
        }
    }

    fn apply_events(&mut self, events: &[Event]) {
        for e in events {
            let ahead = e.id.wrapping_sub(self.next_event_id);
            if ahead >= 0x8000 {
                continue; // already applied
            }
            if !self.pending_events.iter().any(|p| p.id == e.id) {
                self.pending_events.push(e.clone());
            }
        }
        while let Some(i) = self
            .pending_events
            .iter()
            .position(|e| e.id == self.next_event_id)
        {
            let e = self.pending_events.swap_remove(i);
            match e.body {
                EventBody::RiderJoined { slot, kind, name } => {
                    self.roster[slot as usize] = Some(RosterEntry { kind, name });
                }
                EventBody::RiderLeft { slot } => self.roster[slot as usize] = None,
            }
            self.next_event_id = self.next_event_id.wrapping_add(1);
            self.roster_version = self.roster_version.wrapping_add(1);
        }
    }

    fn apply_snapshot(&mut self, s: &Snapshot, now_ms: f64) {
        self.last_snapshot_tick = Some(s.tick);
        self.stats.snapshots += 1;
        self.stats.snapshot_tick = s.tick;
        self.rtt_sample(now_ms, s.echo_client_time, s.echo_hold_ms);
        if s.input_ack > self.input_ack && s.input_ack <= self.world.tick {
            self.input_ack = s.input_ack;
        }

        // Clock sync from the server's report of how early our inputs arrive.
        let mut target_tick = self.world.tick.max(s.tick);
        self.stats.input_lead = s.input_lead;
        if s.tick >= self.resync_cooldown_until {
            let error = f64::from(s.input_lead) - TARGET_LEAD;
            if !(-6.0..=24.0).contains(&error) {
                // Far off: jump the clock instead of drifting for seconds.
                let shift = (-error).round() as i64;
                target_tick = (i64::from(self.world.tick) + shift).max(i64::from(s.tick)) as u32;
                self.time_scale = 1.0;
                self.resync_cooldown_until = s.tick + 90;
                self.stats.resyncs += 1;
            } else {
                self.time_scale = 1.0 + (-error * 0.02).clamp(-0.06, 0.06);
            }
        }
        self.stats.time_scale = self.time_scale;

        let mut riders: Riders = [None; MAX_RIDERS];
        for rs in &s.riders {
            riders[rs.slot as usize] = Some(rs.rider);
        }

        // Interpolation buffer and server-clock estimate.
        if self.snaps.len() == SNAP_BUFFER {
            self.snaps.pop_front();
        }
        self.snaps.push_back((s.tick, riders));
        let sample = f64::from(s.tick) - now_ms / TICK_MS;
        self.interp_offset = Some(match self.interp_offset {
            Some(est) if (sample - est).abs() < 30.0 => {
                if sample > est {
                    est + (sample - est) * 0.3
                } else {
                    est + (sample - est) * 0.02
                }
            }
            _ => sample,
        });

        // Reconcile: authoritative state at s.tick, re-simulated to the present.
        let before = self.world.riders;
        let mut world = World {
            tick: s.tick,
            surface: self.surface.clone(),
            riders,
        };
        let mut prev = world.riders;
        if target_tick.wrapping_sub(s.tick) as usize >= HISTORY - 8 {
            target_tick = s.tick;
        }
        while world.tick < target_tick {
            let tick = world.tick + 1;
            prev = world.riders;
            let inputs = self.inputs_for(&world, tick);
            world.step(&inputs);
        }
        self.world = world;
        self.prev_riders = prev;
        self.stats.predicted_tick = self.world.tick;

        for slot in 0..MAX_RIDERS {
            match (before[slot], self.world.riders[slot]) {
                (Some(old), Some(new)) => {
                    let d = old.pos - new.pos;
                    if slot == self.slot {
                        let err = d.length();
                        self.stats.last_correction_m = err;
                        if err > 0.001 {
                            self.stats.mispredictions += 1;
                        }
                    }
                    if d.length() > SNAP_DISTANCE {
                        self.render_offset[slot] = Vec3::ZERO;
                        self.yaw_offset[slot] = 0.0;
                    } else {
                        self.render_offset[slot] += d;
                        self.yaw_offset[slot] += angle_diff(new.yaw, old.yaw);
                    }
                }
                _ => {
                    self.render_offset[slot] = Vec3::ZERO;
                    self.yaw_offset[slot] = 0.0;
                }
            }
        }
    }

    /// Where to draw every rider right now.
    pub fn render(&self, now_ms: f64, mode: RemoteMode) -> Vec<RenderRider> {
        let mut out = Vec::with_capacity(MAX_RIDERS);
        if self.phase != Phase::Joined {
            return out;
        }
        let alpha = (self.accum_ms / TICK_MS).clamp(0.0, 1.0) as f32;
        let interp_tick = self
            .interp_offset
            .map(|o| now_ms / TICK_MS + o - INTERP_DELAY_TICKS);
        for slot in 0..MAX_RIDERS {
            let is_me = slot == self.slot;
            let is_bot = matches!(
                self.roster[slot],
                Some(RosterEntry {
                    kind: RiderKind::Bot,
                    ..
                })
            );
            let drawn = if is_me || mode == RemoteMode::Predicted {
                self.world.riders[slot].map(|cur| {
                    let prev = self.prev_riders[slot].unwrap_or(cur);
                    let pos = lerp(prev.pos, cur.pos, alpha) + self.render_offset[slot];
                    let yaw = wrap_angle(
                        prev.yaw + angle_diff(prev.yaw, cur.yaw) * alpha + self.yaw_offset[slot],
                    );
                    (cur, pos, yaw)
                })
            } else {
                interp_tick.and_then(|t| self.interpolate(slot, t))
            };
            if let Some((r, pos, yaw)) = drawn {
                let (pitch, roll) = r.visual_tilt(&self.surface, self.world.tick);
                out.push(RenderRider {
                    slot: slot as u8,
                    pos,
                    yaw,
                    pitch,
                    roll,
                    speed: r.speed(),
                    grounded: r.grounded,
                    is_me,
                    is_bot,
                });
            }
        }
        out
    }

    fn interpolate(&self, slot: usize, t: f64) -> Option<(Rider, Vec3, f32)> {
        let mut older: Option<(u32, Rider)> = None;
        for (tick, riders) in &self.snaps {
            let Some(r) = riders[slot] else { continue };
            if f64::from(*tick) <= t {
                older = Some((*tick, r));
            } else {
                return Some(match older {
                    Some((t0, a)) => {
                        let f = ((t - f64::from(t0)) / f64::from(tick - t0)) as f32;
                        let yaw = wrap_angle(a.yaw + angle_diff(a.yaw, r.yaw) * f);
                        (r, lerp(a.pos, r.pos, f), yaw)
                    }
                    None => (r, r.pos, r.yaw),
                });
            }
        }
        older.map(|(_, r)| (r, r.pos, r.yaw))
    }
}

fn lerp(a: Vec3, b: Vec3, t: f32) -> Vec3 {
    a + (b - a) * t
}
