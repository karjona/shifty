use crate::MAX_RIDERS;
use crate::conditions::{Conditions, Event};
use crate::course::{Course, CourseId, Frame, Line, Sport};
use crate::input::Input;
use crate::math::{Vec3, clamp, cos, sin};
use crate::quant;
use crate::race::{self, Phase, Progress, Race, SimEvent, Standing};
use crate::setup::Setup;
use crate::surface::{Surface, SurfaceKind};
use crate::{bot, buoy, jetski, snowboard};

/// World-level tuning shared by every sport.
pub mod tuning {
    pub const RIDER_HALF_HEIGHT: f32 = 0.8;
    pub const BUMP_RESTITUTION: f32 = 0.35;
}

use tuning::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rider {
    /// Bottom of the hull, centred.
    pub pos: Vec3,
    pub vel: Vec3,
    /// Heading in radians, `[0, TAU)`. Yaw 0 faces +Z.
    pub yaw: f32,
    /// Nose up positive.
    pub pitch: f32,
    /// Left side up positive (banked right).
    pub roll: f32,
    pub yaw_rate: f32,
    pub pitch_rate: f32,
    pub roll_rate: f32,
    /// Touching the water (or ground) this tick.
    pub grounded: bool,
    /// Ticks spent in the current state (grounded or airborne), saturating.
    pub state_ticks: u16,
    /// Heading change since leaving the water (spins), radians. Pitch and
    /// roll are not wrapped in the air either, so flips and rolls add up.
    pub air_spin: f32,
    /// Ticks left down after a bail (0 = riding).
    pub bail_ticks: u8,
    /// Snowboard: ticks the jump has been loaded (crouched) for. Jetski:
    /// how far into a stunt the rider is (0 = riding, up to
    /// `jetski::tuning::STUNT_FULL`).
    pub charge: u8,
    /// Snowboard: the grab of this jump (see `snowboard::grabs`; 0 = none
    /// yet), and how long grabs have been held in it. Jetski: the stunt of
    /// this jump (see `jetski::stunts`), and how long it has been held all
    /// the way in.
    pub grab: u8,
    pub grab_ticks: u8,
    /// Snowboard: ticks left wobbling after a sketchy landing (0 = steady).
    pub wobble: u8,
    /// The input applied on the last tick. Part of the state: it drives
    /// button edge detection and lets clients extrapolate other riders.
    pub last_input: Input,
    pub race: Progress,
}

impl Rider {
    /// A rider at rest at `spot`, with `y` the hull bottom.
    pub fn at(spot: Frame, y: f32) -> Self {
        let mut r = Self {
            pos: Vec3::new(spot.x, y, spot.z),
            vel: Vec3::ZERO,
            yaw: spot.yaw,
            pitch: 0.0,
            roll: 0.0,
            yaw_rate: 0.0,
            pitch_rate: 0.0,
            roll_rate: 0.0,
            grounded: true,
            state_ticks: 0,
            air_spin: 0.0,
            bail_ticks: 0,
            charge: 0,
            grab: 0,
            grab_ticks: 0,
            wobble: 0,
            last_input: Input::default(),
            race: Progress::default(),
        };
        r.quantize();
        r
    }

    pub fn forward(&self) -> Vec3 {
        Vec3::new(sin(self.yaw), 0.0, cos(self.yaw))
    }

    pub fn right(&self) -> Vec3 {
        let f = self.forward();
        Vec3::new(-f.z, 0.0, f.x)
    }

    pub fn speed(&self) -> f32 {
        self.vel.horizontal().length()
    }

    /// Snap all state onto the network grid. The server does this after every
    /// tick, so a snapshot is an exact copy of the authoritative state and
    /// client re-simulation does not drift.
    pub fn quantize(&mut self) {
        self.pos = quant::pos_roundtrip(self.pos);
        self.vel = quant::vel_roundtrip(self.vel);
        self.yaw = quant::yaw_from_wire(quant::yaw_to_wire(self.yaw));
        self.pitch = quant::angle_roundtrip(self.pitch);
        self.roll = quant::angle_roundtrip(self.roll);
        self.yaw_rate = quant::rate_roundtrip(self.yaw_rate);
        self.pitch_rate = quant::rate_roundtrip(self.pitch_rate);
        self.roll_rate = quant::rate_roundtrip(self.roll_rate);
        self.air_spin = quant::angle_roundtrip(self.air_spin);
    }

    pub fn bailing(&self) -> bool {
        self.bail_ticks > 0
    }
}

/// The whole simulated world. Pure data + pure functions: no clocks, no I/O,
/// no randomness that is not seeded. The server and the client run this
/// exact code.
#[derive(Clone, Debug, PartialEq)]
pub struct World {
    /// Number of ticks simulated so far. The state stored here is the state
    /// *after* tick `tick` (tick 0 = initial state).
    pub tick: u32,
    pub course: CourseId,
    /// The season, weather and time of day the race is run in. Not part of
    /// snapshots' rider state: it is set with the course for each race.
    pub conditions: Conditions,
    pub surface: Surface,
    pub race: Race,
    pub riders: [Option<Rider>; MAX_RIDERS],
    /// Each seat's setup for this course's sport. Not part of snapshots:
    /// it is set when a rider joins and stays for the whole room plan.
    pub setups: [Setup; MAX_RIDERS],
    /// A time trial: the results stay up until the run starts over (see
    /// `retry`). Set when the world is made, like the course.
    pub trial: bool,
}

pub type Inputs = [Option<Input>; MAX_RIDERS];

impl World {
    /// A world on a course in its sport's home conditions.
    pub fn new(course: CourseId, surface: Surface) -> Self {
        Self {
            tick: 0,
            course,
            conditions: Conditions::home(course.sport()),
            surface,
            race: Race::new(0),
            riders: [None; MAX_RIDERS],
            setups: [Setup::BALANCED; MAX_RIDERS],
            trial: false,
        }
    }

    /// A world on a course, with the course's sea, in its sport's home
    /// conditions.
    pub fn on_course(course: CourseId, kind: SurfaceKind, seed: u32) -> Self {
        Self::new(course, course.course().surface(kind, seed))
    }

    /// A world for one race of a plan: its course, its sea and its conditions.
    pub fn for_event(event: Event, kind: SurfaceKind, seed: u32) -> Self {
        let mut w = Self::on_course(event.course, kind, seed);
        w.conditions = event.conditions;
        w
    }

    /// The race raced in this world.
    pub fn event(&self) -> Event {
        Event {
            course: self.course,
            conditions: self.conditions,
        }
    }

    /// How far along the race its weather has come, 0 at the start to 1 at
    /// the finish: on a loop by the race clock against a par pace (the
    /// weather is the same all round the loop), on a run by where `(x, z)`
    /// is down it.
    pub fn weather_progress(&self, x: f32, z: f32) -> f32 {
        let course = self.course();
        if course.looped() {
            let racing = match self.race.phase {
                Phase::Racing => self.race.elapsed(self.tick),
                Phase::Results => return 1.0,
                Phase::Grid | Phase::Intro | Phase::Countdown => 0,
            };
            let par = f32::from(course.laps) * course.length() / crate::conditions::LOOP_PAR_SPEED;
            return clamp(racing as f32 * crate::DT / par, 0.0, 1.0);
        }
        let Some(run) = course.run() else {
            return 0.0;
        };
        let s = course.project(x, z).0;
        clamp(
            (s - course.start_s) / (run.finish_s - course.start_s),
            0.0,
            1.0,
        )
    }

    /// How far the weather has turned at `(x, z)` now (0 = `weather`,
    /// 1 = `turns`).
    pub fn weather_turn(&self, x: f32, z: f32) -> f32 {
        let course = self.course();
        crate::conditions::turn_blend(self.weather_progress(x, z), course.looped(), course.laps)
    }

    pub fn course(&self) -> &'static Course {
        self.course.course()
    }

    /// Where a rider at rest at `(x, z)` sits: floating, or standing on the snow.
    fn rest_height(&self, x: f32, z: f32) -> f32 {
        match self.course().line {
            Line::Run(run) => snowboard::rest_height(run, x, z),
            Line::Stadium(_) => jetski::rest_height(self.surface.height(x, z, self.tick)),
        }
    }

    /// Places a rider at its grid spot, at rest. Riders who arrive before
    /// the start (on the grid, in the intro or the countdown) line up for
    /// the race; during the race or its results they ride free until the
    /// next one.
    pub fn spawn(&mut self, slot: usize) {
        let spot = self.course().grid_spot(slot);
        let y = self.rest_height(spot.x, spot.z);
        let mut r = Rider::at(spot, y);
        if self.race.phase.before_start() {
            r.race = Progress::lined_up();
        }
        self.riders[slot] = Some(r);
    }

    pub fn remove(&mut self, slot: usize) {
        self.riders[slot] = None;
    }

    /// Starts the race over from now: everyone back on the grid, waiting
    /// for the intro (see `start_intro`).
    pub fn restart(&mut self) {
        self.race = Race::new(self.tick);
        self.line_up();
    }

    /// Ends the wait on the grid (every screen is ready, or the wait is
    /// over): the intro starts now, then the countdown and the race follow
    /// by themselves. Only the server calls this; clients learn it from
    /// snapshots.
    pub fn start_intro(&mut self) {
        if self.race.phase == Phase::Grid {
            self.race = Race {
                phase: Phase::Intro,
                phase_tick: self.tick,
            };
        }
    }

    /// Starts the run over straight from the countdown, everyone back on
    /// the grid (a time trial's retry: the intro has been seen). Only the
    /// server calls this; clients learn it from snapshots.
    pub fn retry(&mut self) {
        self.race = Race {
            phase: Phase::Countdown,
            phase_tick: self.tick,
        };
        self.line_up();
    }

    /// Takes every rider out of the race to ride free: not held on the grid,
    /// and nothing they do counts (tools and tests).
    pub fn ride_free(&mut self) {
        for r in self.riders.iter_mut().flatten() {
            r.race = Progress {
                meter: r.race.meter,
                ..Progress::default()
            };
        }
    }

    /// Whether a seat's rider rides on autopilot: out of the race, its
    /// inputs come from `bot` instead of its player, and it passes through
    /// riders still racing. That is a rider through the finish (for the
    /// rest of the race), one who joined mid-race (until the next one), and
    /// everyone on the results.
    pub fn on_autopilot(&self, slot: usize) -> bool {
        let Some(r) = &self.riders[slot] else {
            return false;
        };
        match self.race.phase {
            Phase::Racing => r.race.finished() || !r.race.racing,
            Phase::Results => true,
            Phase::Grid | Phase::Intro | Phase::Countdown => false,
        }
    }

    /// Advance one fixed tick. Riders without an input repeat their last
    /// one; riders on autopilot ignore theirs. Returns what happened worth
    /// telling players about (buoys, laps...).
    pub fn step(&mut self, inputs: &Inputs) -> Vec<SimEvent> {
        let tick = self.tick;
        let next = tick.wrapping_add(1);
        let course = self.course();
        let mut events = Vec::new();
        let mut s_prev = [0.0f32; MAX_RIDERS];
        let mut auto = [false; MAX_RIDERS];
        let mut auto_inputs: Inputs = [None; MAX_RIDERS];
        for slot in 0..MAX_RIDERS {
            if self.on_autopilot(slot) {
                auto[slot] = true;
                auto_inputs[slot] = Some(bot::bot_input(self, slot));
            }
        }
        for (slot, rider) in self.riders.iter_mut().enumerate() {
            if let Some(r) = rider {
                s_prev[slot] = course.project(r.pos.x, r.pos.z).0;
                let input = auto_inputs[slot]
                    .or(inputs[slot])
                    .map_or(r.last_input, Input::sanitized);
                let setup = self.setups[slot].sanitized();
                let landing = match course.line {
                    Line::Stadium(_) => {
                        jetski::integrate(r, input, setup, &self.surface, course, tick)
                    }
                    Line::Run(run) => snowboard::integrate(r, input, setup, run),
                };
                if let Some(landing) = landing {
                    race::landed(&mut r.race, &self.race, slot, landing, &mut events);
                }
            }
        }
        self.resolve_collisions(&auto);
        let holding = self.race.phase.before_start();
        for (slot, rider) in self.riders.iter_mut().enumerate() {
            let Some(r) = rider else { continue };
            buoy::bump(r, course, &self.surface, next);
            let impact = course.collide(&mut r.pos, &mut r.vel, &self.surface, next);
            if course.sport == Sport::Snowboard
                && impact.is_some_and(|i| {
                    i > snowboard::tuning::CRASH_SPEED * self.setups[slot].sanitized().stability()
                })
                && !r.bailing()
            {
                snowboard::fall(r);
                race::landed(
                    &mut r.race,
                    &self.race,
                    slot,
                    race::Landing::Bail,
                    &mut events,
                );
            }
            if holding && r.race.racing {
                // On the grid: nobody moves (engines rev, hulls bob).
                let spot = course.grid_spot(slot);
                match course.line {
                    Line::Run(run) => snowboard::hold(r, spot, run),
                    Line::Stadium(_) => {
                        r.pos.x = spot.x;
                        r.pos.z = spot.z;
                        r.yaw = spot.yaw;
                        r.yaw_rate = 0.0;
                        r.vel.x = 0.0;
                        r.vel.z = 0.0;
                    }
                }
            }
            // Gates are judged on the final (grid) position, which is where
            // the next tick starts from, so crossings can't fall in a gap.
            r.quantize();
            let (s, offset) = course.project(r.pos.x, r.pos.z);
            race::pass_gates(
                course,
                &mut r.race,
                slot,
                s_prev[slot],
                s,
                offset,
                &self.race,
                next,
                &mut events,
            );
        }
        self.tick = next;
        self.advance_phase();
        events
    }

    fn advance_phase(&mut self) {
        let elapsed = self.race.elapsed(self.tick);
        let done = match self.race.phase {
            Phase::Racing => {
                let racers = self.riders.iter().flatten().filter(|r| r.race.racing);
                let mut any = false;
                let mut all_done = true;
                let mut first = u32::MAX;
                for r in racers {
                    any = true;
                    if r.race.finished() {
                        first = first.min(r.race.finish_ticks);
                    } else {
                        all_done = false;
                    }
                }
                !any || all_done
                    || (first != u32::MAX && elapsed >= first + race::tuning::FINISH_GRACE_TICKS)
                    || elapsed >= race::tuning::MAX_RACE_TICKS
            }
            Phase::Results if self.trial => false,
            phase => phase.duration().is_some_and(|d| elapsed >= d),
        };
        if !done {
            return;
        }
        let next = match self.race.phase {
            Phase::Grid => Phase::Intro,
            Phase::Intro => Phase::Countdown,
            Phase::Countdown => Phase::Racing,
            Phase::Racing => Phase::Results,
            Phase::Results => Phase::Grid,
        };
        self.race = Race {
            phase: next,
            phase_tick: self.tick,
        };
        // The countdown starts everyone clean from their spot, whatever they
        // did while held.
        if matches!(next, Phase::Grid | Phase::Countdown) {
            self.line_up();
        }
    }

    /// Everyone to the grid, lined up for the race.
    fn line_up(&mut self) {
        let course = self.course();
        for slot in 0..MAX_RIDERS {
            if self.riders[slot].is_some() {
                let spot = course.grid_spot(slot);
                let y = self.rest_height(spot.x, spot.z);
                let mut r = Rider::at(spot, y);
                r.race = Progress::lined_up();
                self.riders[slot] = Some(r);
            }
        }
    }

    /// Racing riders in race order: finishers by time, then by distance
    /// covered. Riding free (joined mid-race) are left out.
    pub fn standings(&self) -> Vec<Standing> {
        let course = self.course();
        let mut list: Vec<(u8, Progress, f32)> = self
            .riders
            .iter()
            .enumerate()
            .filter_map(|(slot, r)| {
                let r = r.as_ref()?;
                r.race.racing.then(|| {
                    // On the results screen, unfinished riders are ranked by
                    // where the race left them, not where they ride now.
                    let s = if self.race.phase == Phase::Results {
                        let gate = usize::from(r.race.next_gate) % course.gate_count();
                        course.gate_s(gate) - 0.01
                    } else {
                        course.project(r.pos.x, r.pos.z).0
                    };
                    (slot as u8, r.race, race::distance(course, &r.race, s))
                })
            })
            .collect();
        list.sort_by(|a, b| match (a.1.finished(), b.1.finished()) {
            (true, true) => a.1.finish_ticks.cmp(&b.1.finish_ticks).then(a.0.cmp(&b.0)),
            (true, false) => core::cmp::Ordering::Less,
            (false, true) => core::cmp::Ordering::Greater,
            (false, false) => b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)),
        });
        list.iter()
            .enumerate()
            .map(|(i, (slot, progress, _))| Standing {
                slot: *slot,
                place: (i + 1) as u8,
                progress: *progress,
            })
            .collect()
    }

    /// Rider-vs-rider bumps: equal-mass spheres in the XZ plane, resolved in
    /// slot order so every machine gets the same result. Riders on autopilot
    /// (`auto`) only bump each other.
    fn resolve_collisions(&mut self, auto: &[bool; MAX_RIDERS]) {
        let radius = self.course().sport.rider_radius();
        for i in 0..MAX_RIDERS {
            for j in (i + 1)..MAX_RIDERS {
                if auto[i] != auto[j] {
                    continue;
                }
                let (Some(a), Some(b)) = (self.riders[i], self.riders[j]) else {
                    continue;
                };
                if (a.pos.y - b.pos.y).abs() > RIDER_HALF_HEIGHT * 2.0 {
                    continue;
                }
                let d = (b.pos - a.pos).horizontal();
                let dist = d.length();
                let min_dist = radius * 2.0;
                if dist >= min_dist {
                    continue;
                }
                // Exactly overlapping: push apart along a fixed axis.
                let n = if dist > 1e-4 {
                    d * (1.0 / dist)
                } else {
                    Vec3::new(1.0, 0.0, 0.0)
                };
                let push = n * ((min_dist - dist) * 0.5);
                let mut a2 = a;
                let mut b2 = b;
                a2.pos -= push;
                b2.pos += push;
                let rel = (b.vel - a.vel).horizontal().dot(n);
                if rel < 0.0 {
                    let impulse = -(1.0 + BUMP_RESTITUTION) * rel * 0.5;
                    a2.vel -= n * impulse;
                    b2.vel += n * impulse;
                }
                self.riders[i] = Some(a2);
                self.riders[j] = Some(b2);
            }
        }
    }

    /// FNV-1a over the exact bits of the state. Used to prove that native and
    /// WASM builds stay bit-identical.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |v: u32| {
            for b in v.to_le_bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        };
        eat(self.tick);
        eat(self.race.phase as u32);
        eat(self.race.phase_tick);
        for (slot, r) in self.riders.iter().enumerate() {
            let Some(r) = r else { continue };
            eat(slot as u32);
            eat(u32::from_le_bytes(self.setups[slot].to_bytes()));
            for v in [
                r.pos.x,
                r.pos.y,
                r.pos.z,
                r.vel.x,
                r.vel.y,
                r.vel.z,
                r.yaw,
                r.pitch,
                r.roll,
                r.yaw_rate,
                r.pitch_rate,
                r.roll_rate,
                r.air_spin,
            ] {
                eat(v.to_bits());
            }
            eat(u32::from(r.grounded)
                | (u32::from(r.state_ticks) << 8)
                | (u32::from(r.bail_ticks) << 24));
            eat(u32::from_le_bytes([
                r.charge,
                r.grab,
                r.grab_ticks,
                r.wobble,
            ]));
            eat(u32::from_le_bytes([
                r.last_input.steer as u8,
                r.last_input.throttle as u8,
                r.last_input.lean as u8,
                r.last_input.buttons,
            ]));
            let p = r.race;
            eat(u32::from_le_bytes([
                u8::from(p.racing),
                p.next_gate,
                p.lap,
                p.meter,
            ]));
            eat(u32::from(p.misses) | (u32::from(p.tricks) << 8) | (u32::from(p.points) << 16));
            eat(p.finish_ticks);
        }
        h
    }
}
