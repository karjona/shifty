//! Time trials: one rider alone, the run started over on request, and every
//! run to the finish recorded for the lobby (the rider's best becomes a
//! ghost others race).
//!
//! The recording is the rider's authoritative state at snapshot rate, from
//! the start signal to the finish (see `protocol::ghost`). Runs that don't
//! finish are dropped.

use protocol::ghost::{FRAME_TICKS, Ghost, GhostFrame};
use protocol::token::b64;
use serde::Serialize;
use sim::race::EventKind;
use sim::race::tuning::MAX_RACE_TICKS;
use sim::{Phase, SimEvent, TICK_HZ, World};

/// A finished run, for the lobby (JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub room: String,
    /// Counts runs started in the room: with the room, it names the run.
    pub run: u16,
    pub pid: String,
    pub course: u8,
    pub season: u8,
    pub time_ms: u32,
    /// The recording (`protocol::ghost`), base64url.
    pub ghost: String,
}

/// A run being recorded.
struct Take {
    /// World tick of the start signal (race tick 0).
    start: u32,
    ghost: Ghost,
}

/// A time trial room's runs.
pub struct Trial {
    room: String,
    season: u8,
    /// Who rides: account id and appearance bytes.
    pid: String,
    look: Vec<u8>,
    /// The retry count the player's screen last sent (None: nothing yet).
    retries: Option<u8>,
    /// A retry was asked for and not yet done.
    pending: bool,
    runs: u16,
    take: Option<Take>,
}

impl Trial {
    pub fn new(room: &str, season: u8) -> Self {
        Self {
            room: room.to_owned(),
            season,
            pid: String::new(),
            look: Vec::new(),
            retries: None,
            pending: false,
            runs: 0,
            take: None,
        }
    }

    /// The rider who rides here; a new screen's retry count starts afresh.
    pub fn seat(&mut self, pid: &str, look: &[u8]) {
        pid.clone_into(&mut self.pid);
        self.look = look.to_vec();
        self.retries = None;
    }

    /// The retry count from an input packet: a new one asks for a retry.
    pub fn retries(&mut self, count: u8) {
        if self.retries.is_some_and(|seen| seen != count) {
            self.pending = true;
        }
        self.retries = Some(count);
    }

    /// Before a tick: starts the run over from the countdown if asked (not
    /// while the grid still waits for the screen).
    pub fn before_step(&mut self, world: &mut World) {
        if !std::mem::take(&mut self.pending) || world.race.phase == Phase::Grid {
            return;
        }
        world.retry();
        self.take = None;
    }

    /// After a tick: records the rider in `slot`, and hands back the run
    /// once it is through the finish.
    pub fn after_step(
        &mut self,
        world: &World,
        slot: usize,
        events: &[SimEvent],
    ) -> Option<RunReport> {
        let race = world.race;
        if race.phase == Phase::Racing && race.elapsed(world.tick) == 0 {
            self.runs = self.runs.wrapping_add(1);
            self.take = Some(Take {
                start: world.tick,
                ghost: Ghost {
                    course: world.course as u8,
                    season: self.season,
                    look: self.look.clone(),
                    ..Ghost::default()
                },
            });
        }
        let take = self.take.as_mut()?;
        let at = world.tick.wrapping_sub(take.start);
        let Some(r) = world.riders[slot].filter(|r| r.race.racing) else {
            self.take = None;
            return None;
        };
        if at > MAX_RACE_TICKS {
            self.take = None;
            return None;
        }
        for e in events.iter().filter(|e| usize::from(e.slot) == slot) {
            if let EventKind::Checkpoint { .. } | EventKind::Lap { lap: 2.. } = e.kind {
                take.ghost.splits.push(at);
            }
        }
        let sport = world.course().sport;
        if r.race.finished() {
            let mut take = self.take.take()?;
            take.ghost.frames.push(GhostFrame::of(&r, sport));
            take.ghost.finish_ticks = r.race.finish_ticks;
            take.ghost.splits.push(r.race.finish_ticks);
            return Some(RunReport {
                room: self.room.clone(),
                run: self.runs,
                pid: self.pid.clone(),
                course: take.ghost.course,
                season: self.season,
                time_ms: r.race.finish_ticks * 1000 / TICK_HZ,
                ghost: b64(&take.ghost.encode()),
            });
        }
        if at.is_multiple_of(FRAME_TICKS) {
            take.ghost.frames.push(GhostFrame::of(&r, sport));
        }
        None
    }
}
