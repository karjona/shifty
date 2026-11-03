//! Race rules: phases, buoys, laps, the speed meter and standings.
//!
//! A room loops through warm-up (free riding), a countdown on the grid, the
//! race, and a results screen. All of it is sim state, so clients predict
//! it like everything else and the server's copy is the official one.
//!
//! Buoys and the finish line are "gates", met in order. Passing a buoy on
//! the correct side fills the speed meter one step (a passive top-speed
//! bonus); passing it on the wrong side empties it.

use crate::course::{Course, Keep};
use crate::jetski::Landing;

pub mod tuning {
    use crate::TICK_HZ;
    pub const WARMUP_TICKS: u32 = TICK_HZ * 12;
    pub const COUNTDOWN_TICKS: u32 = TICK_HZ * 4;
    /// After the first finisher, the others get this long to finish.
    pub const FINISH_GRACE_TICKS: u32 = TICK_HZ * 30;
    pub const MAX_RACE_TICKS: u32 = TICK_HZ * 60 * 6;
    pub const RESULTS_TICKS: u32 = TICK_HZ * 12;
    pub const METER_MAX: u8 = 5;
    /// Top speed bonus per meter step.
    pub const METER_BONUS: f32 = 0.03;
    /// Movement along the course bigger than this in one tick is a teleport,
    /// not a gate crossing.
    pub const MAX_GATE_STEP: f32 = 20.0;
}

use tuning::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    Warmup = 0,
    Countdown = 1,
    Racing = 2,
    Results = 3,
}

impl Phase {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Warmup),
            1 => Some(Self::Countdown),
            2 => Some(Self::Racing),
            3 => Some(Self::Results),
            _ => None,
        }
    }

    pub fn duration(self) -> Option<u32> {
        match self {
            Self::Warmup => Some(WARMUP_TICKS),
            Self::Countdown => Some(COUNTDOWN_TICKS),
            Self::Racing => None,
            Self::Results => Some(RESULTS_TICKS),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Race {
    pub phase: Phase,
    /// World tick at which the current phase began.
    pub phase_tick: u32,
}

impl Race {
    pub fn new(tick: u32) -> Self {
        Self {
            phase: Phase::Warmup,
            phase_tick: tick,
        }
    }

    pub fn elapsed(&self, tick: u32) -> u32 {
        tick.wrapping_sub(self.phase_tick)
    }
}

/// One rider's race.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    /// Lined up for the current race (riders who join mid-race ride free).
    pub racing: bool,
    /// The next gate to pass: 0 = the start/finish line, `i` = buoy `i - 1`.
    pub next_gate: u8,
    /// Current lap (1-based) once over the start line; 0 before.
    pub lap: u8,
    pub meter: u8,
    pub misses: u8,
    /// Tricks landed clean in this race.
    pub tricks: u8,
    /// Race ticks at the finish; 0 = not finished.
    pub finish_ticks: u32,
}

impl Progress {
    pub fn finished(&self) -> bool {
        self.finish_ticks != 0
    }

    /// Top speed multiplier from the meter.
    pub fn speed_bonus(&self) -> f32 {
        1.0 + METER_BONUS * f32::from(self.meter)
    }

    /// Fresh progress for a new race.
    pub fn lined_up() -> Self {
        Self {
            racing: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// Passed a buoy (`ok` = on the correct side). `meter` is the new level.
    Buoy {
        buoy: u8,
        ok: bool,
        meter: u8,
    },
    /// Started lap `lap` (1-based).
    Lap {
        lap: u8,
    },
    Finish {
        ticks: u32,
    },
    /// Landed clean with full rotations: spins (+ = clockwise), flips
    /// (+ = backflip), barrel rolls (+ = to the right). `meter` is the new level.
    Trick {
        spin: i8,
        flip: i8,
        roll: i8,
        meter: u8,
    },
    /// Crashed on landing: off the ski for a moment, meter emptied.
    Bail,
}

/// Something worth telling the player about, produced by a tick. Not state:
/// the world's state already reflects it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SimEvent {
    pub slot: u8,
    pub kind: EventKind,
}

/// Checks whether a rider moving from `s_prev` to `s_now` (at `offset`)
/// passed its next gate, and applies the result.
#[allow(clippy::too_many_arguments)]
pub fn pass_gates(
    course: &Course,
    p: &mut Progress,
    slot: usize,
    s_prev: f32,
    s_now: f32,
    offset: f32,
    race: &Race,
    tick: u32,
    events: &mut Vec<SimEvent>,
) {
    if race.phase == Phase::Results {
        // Everyone's race is frozen until the next warm-up.
        return;
    }
    let moved = course.delta_s(s_prev, s_now);
    if moved <= 0.0 || moved > MAX_GATE_STEP {
        return;
    }
    let gate = usize::from(p.next_gate) % course.gate_count();
    let ahead = course.delta_s(s_prev, course.gate_s(gate));
    if ahead <= 0.0 || ahead > moved {
        return;
    }
    p.next_gate = ((gate + 1) % course.gate_count()) as u8;
    let slot = slot as u8;
    if gate == 0 {
        if race.phase != Phase::Racing || !p.racing || p.finished() {
            return;
        }
        if p.lap >= course.laps {
            p.finish_ticks = race.elapsed(tick).max(1);
            events.push(SimEvent {
                slot,
                kind: EventKind::Finish {
                    ticks: p.finish_ticks,
                },
            });
        } else {
            p.lap += 1;
            events.push(SimEvent {
                slot,
                kind: EventKind::Lap { lap: p.lap },
            });
        }
        return;
    }
    let buoy = &course.buoys[gate - 1];
    let ok = match buoy.keep {
        Keep::Right => offset < buoy.offset,
        Keep::Left => offset > buoy.offset,
    };
    if ok {
        p.meter = (p.meter + 1).min(METER_MAX);
    } else {
        p.meter = 0;
        if p.racing && race.phase == Phase::Racing && !p.finished() {
            p.misses = p.misses.saturating_add(1);
        }
    }
    events.push(SimEvent {
        slot,
        kind: EventKind::Buoy {
            buoy: (gate - 1) as u8,
            ok,
            meter: p.meter,
        },
    });
}

/// Applies a landing to the race: clean tricks fill the meter (two steps
/// for two rotations or more), a bail empties it. Tricks count toward the
/// results only while racing.
pub fn landed(
    p: &mut Progress,
    race: &Race,
    slot: usize,
    landing: Landing,
    events: &mut Vec<SimEvent>,
) {
    let slot = slot as u8;
    match landing {
        Landing::Clean { spin, flip, roll } => {
            let turns = spin.unsigned_abs() + flip.unsigned_abs() + roll.unsigned_abs();
            let gain = if turns >= 2 { 2 } else { 1 };
            p.meter = (p.meter + gain).min(METER_MAX);
            if p.racing && race.phase == Phase::Racing && !p.finished() {
                p.tricks = p.tricks.saturating_add(1);
            }
            events.push(SimEvent {
                slot,
                kind: EventKind::Trick {
                    spin,
                    flip,
                    roll,
                    meter: p.meter,
                },
            });
        }
        Landing::Bail => {
            p.meter = 0;
            events.push(SimEvent {
                slot,
                kind: EventKind::Bail,
            });
        }
    }
}

/// Distance covered in the race so far (for ranking riders still racing).
pub fn distance(course: &Course, p: &Progress, s: f32) -> f32 {
    let l = course.length();
    let mut d = course.wrap_s(s - course.start_s);
    // Just over the line but nudged back behind it: still at the start.
    if p.next_gate == 1 && d > l * 0.5 {
        d -= l;
    }
    (f32::from(p.lap) - 1.0) * l + d
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Standing {
    pub slot: u8,
    /// 1-based.
    pub place: u8,
    pub progress: Progress,
}
