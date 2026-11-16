//! Time trials: one rider alone lapping a circuit (`sim::World::trial`), a
//! lap started over on request, and every lap recorded. A lap goes to the
//! lobby only when it ranks: clean, in clear weather, and the session's
//! best so far (the rider's best becomes a ghost others race). Any other
//! weather is practice: timed, never reported.
//!
//! The recording is the rider's authoritative state at snapshot rate, from
//! the lap's start to its end (see `protocol::ghost`). Laps that don't end,
//! or end void, are dropped.

use protocol::ghost::{LapRecorder, MAX_GHOST_BYTES};
use protocol::token::b64;
use serde::Serialize;
use sim::{Phase, SimEvent, TICK_HZ, Weather, World};

/// A lap that ranks, for the lobby (JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub room: String,
    /// Counts laps ended in the room: with the room, it names the lap.
    pub run: u16,
    pub pid: String,
    pub course: u8,
    pub season: u8,
    /// The circuit's revision (`sim::Course::revision`).
    pub revision: u8,
    /// The weather it was ridden in (`sim::Weather`; always clear).
    pub weather: u8,
    pub time_ms: u32,
    /// The recording (`protocol::ghost`), base64url.
    pub ghost: String,
}

/// A time trial room's laps.
pub struct Trial {
    room: String,
    /// Who rides: account id; the recorder keeps their appearance.
    pid: String,
    /// The retry count the player's screen last sent (None: nothing yet).
    retries: Option<u8>,
    /// A retry was asked for and not yet done.
    pending: bool,
    /// Laps ended in the room.
    laps: u16,
    recorder: LapRecorder,
}

impl Trial {
    pub fn new(room: &str) -> Self {
        Self {
            room: room.to_owned(),
            pid: String::new(),
            retries: None,
            pending: false,
            laps: 0,
            recorder: LapRecorder::default(),
        }
    }

    /// The rider who rides here; a new screen's retry count starts afresh.
    pub fn seat(&mut self, pid: &str, look: &[u8]) {
        pid.clone_into(&mut self.pid);
        self.recorder.look = look.to_vec();
        self.retries = None;
    }

    /// The retry count from an input packet: a new one asks for a retry.
    /// Whether it did.
    pub fn retries(&mut self, count: u8) -> bool {
        let asked = self.retries.is_some_and(|seen| seen != count);
        if asked {
            self.pending = true;
        }
        self.retries = Some(count);
        asked
    }

    /// Before a tick: starts the lap over from the countdown if asked (not
    /// while the grid still waits for the screen, nor once the session is
    /// over).
    pub fn before_step(&mut self, world: &mut World) {
        if !std::mem::take(&mut self.pending)
            || matches!(world.race.phase, Phase::Grid | Phase::Results)
        {
            return;
        }
        world.retry();
    }

    /// After a tick: records the rider in `slot`, and hands back the lap
    /// that ended on it if it ranks.
    pub fn after_step(
        &mut self,
        world: &World,
        slot: usize,
        events: &[SimEvent],
    ) -> Option<RunReport> {
        let end = self.recorder.after_step(world, slot, events)?;
        self.laps = self.laps.wrapping_add(1);
        if !end.clean || !end.best || world.conditions.weather != Weather::Clear {
            return None;
        }
        let ghost = end.ghost?;
        let bytes = ghost.encode();
        if bytes.len() > MAX_GHOST_BYTES {
            return None;
        }
        Some(RunReport {
            room: self.room.clone(),
            run: self.laps,
            pid: self.pid.clone(),
            course: ghost.course,
            season: ghost.season,
            revision: ghost.revision,
            weather: world.conditions.weather as u8,
            time_ms: end.ticks * 1000 / TICK_HZ,
            ghost: b64(&bytes),
        })
    }
}
