//! Browser bridge: the shared sim + client netcode, compiled to WASM.
//!
//! Data crosses the JS boundary in bulk, through typed-array views on WASM
//! memory (render state, stats, wave parameters) and one packed buffer of
//! outgoing packets per frame, never through many tiny calls.

use client_core::{Client, Phase};
use serde_json::json;
use sim::course::{Keep, tuning as course_tuning};
use sim::race::{EventKind, tuning as race_tuning};
use sim::{Input, MAX_RIDERS};
use wasm_bindgen::prelude::*;

/// Floats per rider in the render buffer: `[slot, x, y, z, yaw, pitch, roll,
/// speed, grounded, is_me, is_bot, vx, vy, vz, bailing, _]`.
pub const RENDER_STRIDE: usize = 16;
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
pub const RACE_FIELDS: [&str; 15] = [
    "phase",
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
                0.0,
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

    /// Roster as JSON: `[{slot, name, bot}]`. Call only when `rosterVersion` changes.
    #[wasm_bindgen(js_name = rosterJson)]
    pub fn roster_json(&self) -> String {
        let entries: Vec<serde_json::Value> = self
            .inner
            .roster()
            .iter()
            .enumerate()
            .filter_map(|(slot, e)| {
                e.as_ref().map(|e| serde_json::json!({ "slot": slot, "name": e.name, "bot": e.kind == protocol::RiderKind::Bot }))
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
        ];
        self.race_buf.copy_from_slice(&v);
        self.race_buf.as_ptr()
    }

    /// Race order as JSON: `[{slot, place, lap, finishTicks, misses, tricks}]`.
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
                })
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// New race events as JSON: `[{tick, slot, kind, ...}]` where kind is
    /// `buoy` (`buoy`, `ok`, `meter`), `lap` (`lap`), `finish` (`ticks`),
    /// `trick` (`spin`, `flip`, `roll`, `meter`) or `bail`.
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
                EventKind::Lap { lap } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "lap", "lap": lap })
                }
                EventKind::Finish { ticks } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "finish", "ticks": ticks })
                }
                EventKind::Trick {
                    spin,
                    flip,
                    roll,
                    meter,
                } => {
                    json!({ "tick": e.tick, "slot": e.slot, "kind": "trick", "spin": spin, "flip": flip, "roll": roll, "meter": meter })
                }
                EventKind::Bail => json!({ "tick": e.tick, "slot": e.slot, "kind": "bail" }),
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// The course, for drawing it (positions in metres, angles in radians).
    #[wasm_bindgen(js_name = courseJson)]
    pub fn course_json(&self) -> String {
        let c = self.inner.predicted_world().course();
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
        let start = c.centerline(c.start_s);
        json!({
            "length": c.length(),
            "laps": c.laps,
            "straightHalf": c.straight_half,
            "radius": c.radius,
            "laneHalf": c.lane_half,
            "breakwaterRadius": c.breakwater_radius,
            "outerLimit": c.outer_limit,
            "rampSink": course_tuning::RAMP_SINK,
            "start": { "x": start.x, "z": start.z, "yaw": start.yaw },
            "buoys": buoys,
            "ramps": ramps,
        })
        .to_string()
    }

    /// Surface height at a point and fractional tick (for placing things on water).
    #[wasm_bindgen(js_name = surfaceHeight)]
    pub fn surface_height(&self, x: f32, z: f32, tick: u32) -> f32 {
        self.inner.surface().height(x, z, tick)
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
