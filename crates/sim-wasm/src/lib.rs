//! Browser bridge: the shared sim + client netcode, compiled to WASM.
//!
//! Data crosses the JS boundary in bulk, through typed-array views on WASM
//! memory (render state, stats, wave parameters) and one packed buffer of
//! outgoing packets per frame, never through many tiny calls.

use client_core::{Client, Phase};
use serde_json::json;
use sim::course::{Keep, LandKind, Line, Sport, tuning as course_tuning};
use sim::mountain::{Feature, ObstacleKind, Run};
use sim::race::{EventKind, tuning as race_tuning};
use sim::{CourseId, Input, MAX_RIDERS, SurfaceKind, World};
use wasm_bindgen::prelude::*;

/// Floats per rider in the render buffer: `[slot, x, y, z, yaw, pitch, roll,
/// speed, grounded, is_me, is_bot, vx, vy, vz, bailing, charge, grab, lean,
/// steer, wobble]`.
pub const RENDER_STRIDE: usize = 20;
/// Layout of the stats buffer (f64).
pub const STATS_FIELDS: [&str; 17] = [
    "rttMs",
    "inputLead",
    "timeScale",
    "predictedTick",
    "snapshotTick",
    "lastCorrectionM",
    "mispredictions",
    "snapshots",
    "staleSnapshots",
    "resyncs",
    "bytesIn",
    "bytesOut",
    "packetsIn",
    "packetsOut",
    "lastSnapshotBytes",
    "lastInputCount",
    "targetLead",
];

/// Layout of the race buffer (f64), for the HUD.
pub const RACE_FIELDS: [&str; 23] = [
    "phase",
    "phaseStart",
    "phaseTicks",
    "phaseLength",
    "laps",
    "racing",
    "lap",
    "meter",
    "meterMax",
    "nextGate",
    "finishTicks",
    "place",
    "racers",
    "misses",
    "tickHz",
    "wrongWay",
    "points",
    "gates",
    "looped",
    "course",
    "eventIndex",
    "eventCount",
    "gpVersion",
];

#[wasm_bindgen]
pub struct WasmClient {
    inner: Client,
    render_buf: Vec<f32>,
    race_buf: Vec<f64>,
    stats_buf: Vec<f64>,
    wave_buf: Vec<f32>,
    out_buf: Vec<u8>,
}

#[wasm_bindgen]
impl WasmClient {
    #[wasm_bindgen(constructor)]
    pub fn new(token: String) -> Self {
        Self {
            inner: Client::new(token),
            render_buf: vec![0.0; MAX_RIDERS * RENDER_STRIDE],
            race_buf: vec![0.0; RACE_FIELDS.len()],
            stats_buf: vec![0.0; STATS_FIELDS.len()],
            wave_buf: Vec::new(),
            out_buf: Vec::with_capacity(2048),
        }
    }

    #[wasm_bindgen(js_name = handlePacket)]
    pub fn handle_packet(&mut self, bytes: &[u8], now_ms: f64) {
        self.inner.handle_packet(bytes, now_ms);
    }

    /// This screen has race `event` of the room's plan loaded and on show
    /// (negative: not yet). The race waits on the grid for every screen.
    #[wasm_bindgen(js_name = setReady)]
    pub fn set_ready(&mut self, event: i32) {
        self.inner.set_ready(u8::try_from(event).ok());
    }

    /// Advance the clock with this frame's input (analog values in [-1, 1]).
    pub fn update(&mut self, now_ms: f64, steer: f32, throttle: f32, lean: f32, buttons: u8) {
        self.inner
            .update(now_ms, Input::from_analog(steer, throttle, lean, buttons));
    }

    /// Packs all pending outgoing packets as `[u16 len LE][bytes]...` and
    /// returns them in one array (empty when there is nothing to send).
    #[wasm_bindgen(js_name = takeOutgoing)]
    pub fn take_outgoing(&mut self) -> Vec<u8> {
        self.out_buf.clear();
        for p in self.inner.take_outgoing() {
            self.out_buf
                .extend_from_slice(&(p.len() as u16).to_le_bytes());
            self.out_buf.extend_from_slice(&p);
        }
        self.out_buf.clone()
    }

    /// Fills the render buffer; returns how many riders are in it.
    pub fn render(&mut self) -> usize {
        let riders = self.inner.render();
        for (i, r) in riders.iter().enumerate() {
            let o = i * RENDER_STRIDE;
            self.render_buf[o..o + RENDER_STRIDE].copy_from_slice(&[
                f32::from(r.slot),
                r.pos.x,
                r.pos.y,
                r.pos.z,
                r.yaw,
                r.pitch,
                r.roll,
                r.speed,
                f32::from(u8::from(r.grounded)),
                f32::from(u8::from(r.is_me)),
                f32::from(u8::from(r.is_bot)),
                r.vel.x,
                r.vel.y,
                r.vel.z,
                f32::from(u8::from(r.bailing)),
                r.charge,
                f32::from(r.grab),
                r.lean,
                r.steer,
                r.wobble,
            ]);
        }
        riders.len()
    }

    #[wasm_bindgen(js_name = renderPtr)]
    pub fn render_ptr(&self) -> *const f32 {
        self.render_buf.as_ptr()
    }

    #[wasm_bindgen(js_name = renderLen)]
    pub fn render_len(&self) -> usize {
        self.render_buf.len()
    }

    /// Refreshes the stats buffer (see `statsFields()` for the layout).
    #[wasm_bindgen(js_name = updateStats)]
    pub fn update_stats(&mut self) -> *const f64 {
        let s = self.inner.stats();
        let v = [
            s.rtt_ms,
            f64::from(s.input_lead),
            s.time_scale,
            f64::from(s.predicted_tick),
            f64::from(s.snapshot_tick),
            f64::from(s.last_correction_m),
            f64::from(s.mispredictions),
            f64::from(s.snapshots),
            f64::from(s.stale_snapshots),
            f64::from(s.resyncs),
            s.bytes_in as f64,
            s.bytes_out as f64,
            s.packets_in as f64,
            s.packets_out as f64,
            f64::from(s.last_snapshot_bytes),
            f64::from(s.last_input_count),
            s.target_lead,
        ];
        self.stats_buf.copy_from_slice(&v);
        self.stats_buf.as_ptr()
    }

    /// 0 = connecting, 1 = joined, 2+ = rejected (2 + reason code).
    pub fn phase(&self) -> u8 {
        match self.inner.phase() {
            Phase::Connecting => 0,
            Phase::Joined => 1,
            Phase::Rejected(r) => 2 + r as u8,
        }
    }

    pub fn slot(&self) -> i32 {
        self.inner.slot().map_or(-1, |s| s as i32)
    }

    #[wasm_bindgen(js_name = renderTick)]
    pub fn render_tick(&self) -> f64 {
        self.inner.render_tick()
    }

    #[wasm_bindgen(js_name = surfaceKind)]
    pub fn surface_kind(&self) -> u8 {
        self.inner.surface().kind as u8
    }

    /// Wave parameters for the water shader: `[dir_x, dir_z, k, amplitude,
    /// omega, phase, sharpness, 0]` per wave, `sim::surface::MAX_WAVES` waves.
    #[wasm_bindgen(js_name = waveParams)]
    pub fn wave_params(&mut self) -> Vec<f32> {
        self.wave_buf = self.inner.surface().wave_params().to_vec();
        self.wave_buf.clone()
    }

    #[wasm_bindgen(js_name = rosterVersion)]
    pub fn roster_version(&self) -> u32 {
        self.inner.roster_version()
    }

    /// Roster as JSON: `[{slot, name, bot, look}]` (`look`: appearance bytes,
    /// empty for bots). Call only when `rosterVersion` changes.
    #[wasm_bindgen(js_name = rosterJson)]
    pub fn roster_json(&self) -> String {
        let entries: Vec<serde_json::Value> = self
            .inner
            .roster()
            .iter()
            .enumerate()
            .filter_map(|(slot, e)| {
                e.as_ref().map(|e| {
                    serde_json::json!({
                        "slot": slot,
                        "name": e.name,
                        "bot": e.kind == protocol::RiderKind::Bot,
                        "look": e.look,
                    })
                })
            })
            .collect();
        serde_json::Value::Array(entries).to_string()
    }

    /// Refreshes the race buffer (see `raceFields()` for the layout).
    #[wasm_bindgen(js_name = updateRace)]
    pub fn update_race(&mut self) -> *const f64 {
        let world = self.inner.predicted_world();
        let race = world.race;
        let me = self.inner.slot().and_then(|s| world.riders[s]);
        let standings = world.standings();
        let place = self
            .inner
            .slot()
            .and_then(|s| standings.iter().find(|st| usize::from(st.slot) == s))
            .map_or(0, |st| st.place);
        let p = me.map(|r| r.race).unwrap_or_default();
        // Moving against the course (not just pointing: spins don't count).
        let wrong_way = me.is_some_and(|r| {
            let course = world.course();
            let s = course.project(r.pos.x, r.pos.z).0;
            let heading = sim::math::atan2(r.vel.x, r.vel.z);
            r.speed() > 4.0 && sim::math::angle_diff(course.centerline(s).yaw, heading).abs() > 2.0
        });
        let v = [
            f64::from(race.phase as u8),
            f64::from(race.phase_tick),
            f64::from(race.elapsed(world.tick)),
            f64::from(race.phase.duration().unwrap_or(0)),
            f64::from(world.course().laps),
            f64::from(u8::from(p.racing)),
            f64::from(p.lap),
            f64::from(p.meter),
            f64::from(race_tuning::METER_MAX),
            f64::from(p.next_gate),
            f64::from(p.finish_ticks),
            f64::from(place),
            standings.len() as f64,
            f64::from(p.misses),
            f64::from(sim::TICK_HZ),
            f64::from(u8::from(wrong_way)),
            f64::from(p.points),
            world.course().gate_count() as f64,
            f64::from(u8::from(world.course().looped())),
            f64::from(self.inner.course() as u8),
            f64::from(self.inner.event_index()),
            f64::from(self.inner.event_count()),
            f64::from(self.inner.gp_version()),
        ];
        self.race_buf.copy_from_slice(&v);
        self.race_buf.as_ptr()
    }

    /// Tilt points as JSON: `[{slot, points}]` (seats with a rider).
    #[wasm_bindgen(js_name = grandPrixJson)]
    pub fn grand_prix_json(&self) -> String {
        let list: Vec<serde_json::Value> = self
            .inner
            .gp_points()
            .iter()
            .enumerate()
            .filter_map(|(slot, p)| p.map(|points| json!({ "slot": slot, "points": points })))
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// Race order as JSON: `[{slot, place, lap, finishTicks, misses, tricks, points}]`.
    #[wasm_bindgen(js_name = standingsJson)]
    pub fn standings_json(&self) -> String {
        let list: Vec<serde_json::Value> = self
            .inner
            .standings()
            .iter()
            .map(|st| {
                json!({
                    "slot": st.slot,
                    "place": st.place,
                    "lap": st.progress.lap,
                    "finishTicks": st.progress.finish_ticks,
                    "misses": st.progress.misses,
                    "tricks": st.progress.tricks,
                    "points": st.progress.points,
                })
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// New race events as JSON: `[{tick, slot, kind, ...}]` where kind is
    /// `buoy` (`buoy`, `ok`, `meter`), `checkpoint` (`index`), `lap` (`lap`),
    /// `finish` (`ticks`), `trick` (`spin` in half turns, `flip`, `roll`,
    /// `grab`, `stunt`, `grabTicks`, `points`, `sketchy`), `sketchy` (a
    /// plain jump landed badly) or `bail`.
    #[wasm_bindgen(js_name = takeEventsJson)]
    pub fn take_events_json(&mut self) -> String {
        let list: Vec<serde_json::Value> = self
            .inner
            .take_events()
            .iter()
            .map(|e| match e.kind {
                EventKind::Buoy { buoy, ok, meter } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "buoy", "buoy": buoy, "ok": ok, "meter": meter })
                }
                EventKind::Checkpoint { index } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "checkpoint", "index": index })
                }
                EventKind::Lap { lap } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "lap", "lap": lap })
                }
                EventKind::Finish { ticks } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "finish", "ticks": ticks })
                }
                EventKind::Trick { trick: t, sketchy } => json!({
                    "tick": e.tick,
                    "slot": e.slot,
                    "kind": "trick",
                    "spin": t.spin,
                    "flip": t.flip,
                    "roll": t.roll,
                    "grab": t.grab,
                    "stunt": t.stunt,
                    "grabTicks": t.grab_ticks,
                    "points": t.points,
                    "sketchy": sketchy,
                }),
                EventKind::Sketchy => json!({ "tick": e.tick, "slot": e.slot, "kind": "sketchy" }),
                EventKind::Bail => json!({ "tick": e.tick, "slot": e.slot, "kind": "bail" }),
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// 0 = jetski (summer), 1 = snowboard (winter).
    pub fn sport(&self) -> u8 {
        match self.inner.predicted_world().course().sport {
            Sport::Jetski => 0,
            Sport::Snowboard => 1,
        }
    }

    /// Top speed (m/s) for speed-driven effects: the jetski's before the
    /// meter's bonus, or a fast tuck down a steep pitch.
    #[wasm_bindgen(js_name = topSpeed)]
    pub fn top_speed(&self) -> f32 {
        top_speed_on(self.inner.predicted_world())
    }

    /// The course, for drawing it (positions in metres, angles in radians).
    /// Bay courses carry `stadium`, buoys, ramps and land; mountain runs
    /// carry `run`.
    #[wasm_bindgen(js_name = courseJson)]
    pub fn course_json(&self) -> String {
        course_json_on(self.inner.predicted_world())
    }

    /// Mountain only: the snow along the run, as a ribbon of vertices
    /// `[x, y, z]`: one row per arc length in `rows`, one column per entry of
    /// `offsets` (metres right of the centre line). Empty on a bay course.
    #[wasm_bindgen(js_name = runRibbon)]
    pub fn run_ribbon(&self, rows: &[f32], offsets: &[f32]) -> Vec<f32> {
        run_ribbon_on(self.inner.predicted_world(), rows, offsets)
    }

    /// Mountain only: the snow on a regular grid, row by row (`nx` per row,
    /// `nz` rows, `step` metres apart, from `(x0, z0)`): `[height, distance
    /// from the run's centre line]` per point (the distance is huge far from
    /// the run).
    #[wasm_bindgen(js_name = terrainGrid)]
    pub fn terrain_grid(&self, x0: f32, z0: f32, step: f32, nx: u32, nz: u32) -> Vec<f32> {
        terrain_grid_on(self.inner.predicted_world(), x0, z0, step, nx, nz)
    }

    /// Mountain only: snow heights at points `[x0, z0, x1, z1, ...]`.
    #[wasm_bindgen(js_name = heightsAt)]
    pub fn heights_at(&self, points: &[f32]) -> Vec<f32> {
        heights_at_on(self.inner.predicted_world(), points)
    }

    /// Dev: what a bot would do in my place right now, as analog
    /// `[steer, throttle, lean, buttons]` (for `?autopilot=1`).
    #[wasm_bindgen(js_name = autoInput)]
    pub fn auto_input(&self) -> Vec<f32> {
        let Some(slot) = self.inner.slot() else {
            return vec![0.0; 4];
        };
        let i = sim::bot::bot_input(self.inner.predicted_world(), slot);
        vec![
            i.steer_f(),
            i.throttle_f(),
            i.lean_f(),
            f32::from(i.buttons),
        ]
    }

    /// Mountain only: where `(x, z)` is along the run: `[s, offset]`.
    #[wasm_bindgen(js_name = runProject)]
    pub fn run_project(&self, x: f32, z: f32) -> Vec<f32> {
        self.inner
            .predicted_world()
            .course()
            .run()
            .map_or_else(Vec::new, |run| {
                let (s, o) = run.project(x, z);
                vec![s, o]
            })
    }

    /// Surface height at a point and fractional tick (for placing things on water).
    #[wasm_bindgen(js_name = surfaceHeight)]
    pub fn surface_height(&self, x: f32, z: f32, tick: u32) -> f32 {
        self.inner.surface().height(x, z, tick)
    }
}

/// The run, for drawing it: its centre line every 4 m (with half width,
/// walls and riding limit), gates, obstacles and what is built on it.
fn run_json(c: &sim::Course, run: &Run) -> serde_json::Value {
    let length = run.length();
    let mut path = Vec::new();
    let mut s = 0.0;
    while s <= length {
        let f = run.centerline(s);
        let w = run.width_at(s);
        path.push(json!({
            "s": s, "x": f.x, "z": f.z, "yaw": f.yaw,
            "half": w.half, "wall": w.wall, "limit": run.limit(s),
            "y": run.height(f.x, f.z),
        }));
        s += 4.0;
    }
    let gate = |s: f32| {
        let f = run.centerline(s);
        json!({ "s": s, "x": f.x, "z": f.z, "yaw": f.yaw, "half": run.width_at(s).half, "limit": run.limit(s), "y": run.height(f.x, f.z) })
    };
    let obstacles: Vec<serde_json::Value> = run
        .obstacles()
        .iter()
        .map(|o| {
            let kind = match o.kind {
                ObstacleKind::Pine => "pine",
                ObstacleKind::Rock => "rock",
                ObstacleKind::Tower => "tower",
            };
            json!({ "x": o.x, "y": o.y, "z": o.z, "radius": o.radius, "height": o.height, "kind": kind })
        })
        .collect();
    let tables: Vec<serde_json::Value> = run
        .features
        .iter()
        .filter_map(|f| match *f {
            Feature::Table {
                s,
                offset,
                half_width,
                ramp,
                ..
            } => Some(json!({
                "s": s,
                "lip": s + ramp,
                "offset": offset,
                "halfWidth": if half_width.is_finite() { half_width } else { -1.0 },
            })),
            _ => None,
        })
        .collect();
    json!({
        "length": length,
        "startS": c.start_s,
        "finishS": run.finish_s,
        "finish": gate(run.finish_s),
        "startGate": gate(c.start_s),
        "checkpoints": run.checkpoints.iter().map(|&s| gate(s)).collect::<Vec<_>>(),
        "path": path,
        "obstacles": obstacles,
        "tables": tables,
    })
}

fn top_speed_on(world: &World) -> f32 {
    match world.course().sport {
        Sport::Jetski => sim::jetski::tuning::MAX_SPEED,
        Sport::Snowboard => 32.0,
    }
}

fn course_json_on(world: &World) -> String {
    let c = world.course();
    let start = c.centerline(c.start_s);
    let mut out = json!({
        "sport": if c.sport == Sport::Snowboard { "snow" } else { "jetski" },
        "length": c.length(),
        "laps": c.laps,
        "laneHalf": c.lane_half,
        "rampSink": course_tuning::RAMP_SINK,
        "start": { "x": start.x, "z": start.z, "yaw": start.yaw },
    });
    match c.line {
        Line::Stadium(st) => {
            let buoys: Vec<serde_json::Value> = (0..c.buoys.len())
                .map(|i| {
                    let (x, z) = c.buoy_pos(i);
                    let b = &c.buoys[i];
                    json!({
                        "x": x,
                        "z": z,
                        "yaw": c.centerline(b.s).yaw,
                        "keep": if b.keep == Keep::Left { "left" } else { "right" },
                    })
                })
                .collect();
            let ramps: Vec<serde_json::Value> = c
                    .ramps
                    .iter()
                    .map(|d| {
                        let f = c.centerline(d.s + d.length * 0.5);
                        let (x, z) = f.at_offset(d.offset);
                        json!({ "x": x, "z": z, "yaw": f.yaw, "length": d.length, "width": d.width, "height": d.height })
                    })
                    .collect();
            let land: Vec<serde_json::Value> = c
                    .land
                    .iter()
                    .map(|l| {
                        let kind = match l.kind {
                            LandKind::Town => "town",
                            LandKind::Island => "island",
                            LandKind::Rock => "rock",
                        };
                        json!({ "ax": l.a.0, "az": l.a.1, "bx": l.b.0, "bz": l.b.1, "radius": l.radius, "kind": kind })
                    })
                    .collect();
            out["straightHalf"] = json!(st.straight_half);
            out["radius"] = json!(st.radius);
            out["breakwaterRadius"] = json!(st.breakwater_radius);
            out["outerLimit"] = json!(st.outer_limit);
            out["buoyRadius"] = json!(sim::buoy::tuning::RADIUS);
            out["buoyHeight"] = json!(sim::buoy::tuning::HEIGHT);
            out["riderRadius"] = json!(c.sport.rider_radius());
            out["buoys"] = json!(buoys);
            out["ramps"] = json!(ramps);
            out["land"] = json!(land);
        }
        Line::Run(run) => out["run"] = run_json(c, run),
    }
    out.to_string()
}

fn run_ribbon_on(world: &World, rows: &[f32], offsets: &[f32]) -> Vec<f32> {
    let Some(run) = world.course().run() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(rows.len() * offsets.len() * 3);
    for &s in rows {
        let f = run.centerline(s);
        for &o in offsets {
            let (x, z) = f.at_offset(o);
            out.extend_from_slice(&[x, run.height(x, z), z]);
        }
    }
    out
}

fn terrain_grid_on(world: &World, x0: f32, z0: f32, step: f32, nx: u32, nz: u32) -> Vec<f32> {
    let Some(run) = world.course().run() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity((nx * nz * 2) as usize);
    for j in 0..nz {
        for i in 0..nx {
            let (x, z) = (x0 + i as f32 * step, z0 + j as f32 * step);
            out.push(run.height(x, z));
            out.push(run.project(x, z).1.abs());
        }
    }
    out
}

fn heights_at_on(world: &World, points: &[f32]) -> Vec<f32> {
    let Some(run) = world.course().run() else {
        return Vec::new();
    };
    points
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[x, z]| run.height(x, z))
        .collect()
}

/// A course without a race: what the menus draw (the bay for the fly-over
/// and the club, the mountain), from the same sim data the races use.
#[wasm_bindgen]
pub struct Scenery {
    world: World,
}

#[wasm_bindgen]
impl Scenery {
    /// `course`: 0 = the summer bay, 1 = the winter mountain.
    #[wasm_bindgen(constructor)]
    pub fn new(course: u8, surface_kind: u8, seed: u32) -> Self {
        let course = CourseId::from_u8(course).unwrap_or(CourseId::Oval);
        let kind = SurfaceKind::from_u8(surface_kind).unwrap_or(SurfaceKind::Swells);
        Self {
            world: World::on_course(course, kind, seed),
        }
    }

    #[wasm_bindgen(js_name = courseJson)]
    pub fn course_json(&self) -> String {
        course_json_on(&self.world)
    }

    #[wasm_bindgen(js_name = waveParams)]
    pub fn wave_params(&self) -> Vec<f32> {
        self.world.surface.wave_params().to_vec()
    }

    #[wasm_bindgen(js_name = topSpeed)]
    pub fn top_speed(&self) -> f32 {
        top_speed_on(&self.world)
    }

    #[wasm_bindgen(js_name = runRibbon)]
    pub fn run_ribbon(&self, rows: &[f32], offsets: &[f32]) -> Vec<f32> {
        run_ribbon_on(&self.world, rows, offsets)
    }

    #[wasm_bindgen(js_name = terrainGrid)]
    pub fn terrain_grid(&self, x0: f32, z0: f32, step: f32, nx: u32, nz: u32) -> Vec<f32> {
        terrain_grid_on(&self.world, x0, z0, step, nx, nz)
    }

    #[wasm_bindgen(js_name = heightsAt)]
    pub fn heights_at(&self, points: &[f32]) -> Vec<f32> {
        heights_at_on(&self.world, points)
    }

    /// Height of the water (or snow) at `(x, z)` at sim tick `tick`.
    #[wasm_bindgen(js_name = surfaceHeight)]
    pub fn surface_height(&self, x: f32, z: f32, tick: u32) -> f32 {
        match self.world.course().run() {
            Some(run) => run.height(x, z),
            None => self.world.surface.height(x, z, tick),
        }
    }
}

#[wasm_bindgen(js_name = statsFields)]
pub fn stats_fields() -> Vec<String> {
    STATS_FIELDS.iter().map(|s| (*s).to_owned()).collect()
}

#[wasm_bindgen(js_name = raceFields)]
pub fn race_fields() -> Vec<String> {
    RACE_FIELDS.iter().map(|s| (*s).to_owned()).collect()
}

#[wasm_bindgen(js_name = renderStride)]
pub fn render_stride() -> usize {
    RENDER_STRIDE
}

/// Runs the fixed determinism scenario and returns the state hash as a hex
/// string. Must equal the native build's hash, bit for bit.
#[wasm_bindgen(js_name = determinismHash)]
pub fn determinism_hash(ticks: u32) -> String {
    format!("{:016x}", sim::determinism_scenario(ticks))
}
