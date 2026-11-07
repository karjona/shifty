//! Race rules: phases, gates, laps, the speed meter, trick points and
//! standings.
//!
//! A race starts with everyone lined up on the grid, held still, until every
//! screen has the course loaded (the server decides when: see
//! `World::start_intro`). Then an intro shows the course, a countdown runs,
//! the race, and a results screen. All of it is sim state, so clients
//! predict it like everything else and the server's copy is the official
//! one. Through the finish a rider's race is over: it rides on autopilot
//! (see `World::on_autopilot`) and scores nothing more.
//!
//! The start line, buoys or checkpoints, and the finish are "gates", met in
//! order (on a loop the start line is also the finish). In summer, passing a
//! buoy on the correct side fills the speed meter one step (a passive
//! top-speed bonus) and passing it on the wrong side empties it, and so does
//! a bail. In winter there is no meter. Tricks never make you faster: they
//! score points (half for a sketchy landing).

use crate::course::{Course, Gate, Keep};

pub mod tuning {
    use crate::TICK_HZ;
    pub const INTRO_TICKS: u32 = TICK_HZ * 7;
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

/// The phases of a race, in order: grid, intro, countdown, racing, results.
/// The numbers are wire values and never change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    /// Lined up and held still until every screen is ready. Never ends by
    /// itself: the server starts the intro.
    Grid = 0,
    Countdown = 1,
    Racing = 2,
    Results = 3,
    /// Still held on the grid while every screen shows the course.
    Intro = 4,
}

impl Phase {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Grid),
            1 => Some(Self::Countdown),
            2 => Some(Self::Racing),
            3 => Some(Self::Results),
            4 => Some(Self::Intro),
            _ => None,
        }
    }

    /// How long the phase lasts (None: until something ends it).
    pub fn duration(self) -> Option<u32> {
        match self {
            Self::Grid | Self::Racing => None,
            Self::Intro => Some(INTRO_TICKS),
            Self::Countdown => Some(COUNTDOWN_TICKS),
            Self::Results => Some(RESULTS_TICKS),
        }
    }

    /// Before the start: riders lined up for the race are held on the grid,
    /// and riders who arrive line up too.
    pub fn before_start(self) -> bool {
        matches!(self, Self::Grid | Self::Intro | Self::Countdown)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Race {
    pub phase: Phase,
    /// World tick at which the current phase began.
    pub phase_tick: u32,
}

impl Race {
    /// A race on the grid from `tick`, waiting to start.
    pub fn new(tick: u32) -> Self {
        Self {
            phase: Phase::Grid,
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
    /// Trick points scored in this race.
    pub points: u16,
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

/// A trick landed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Trick {
    /// Half turns of spin (+ = clockwise seen from above).
    pub spin: i8,
    /// Full flips (+ = backflip).
    pub flip: i8,
    /// Full barrel rolls (+ = to the right).
    pub roll: i8,
    /// Snowboard: the grab held (see `snowboard::grabs`; 0 = none).
    pub grab: u8,
    /// Jetski: the stunt held (see `jetski::stunts`; 0 = none).
    pub stunt: u8,
    /// How long the grab or stunt was held (ticks).
    pub grab_ticks: u8,
    pub points: u16,
}

/// How a jump ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Landing {
    Clean(Trick),
    /// Down, but crooked or hard: the rider wobbles, with the trick (if any).
    Sketchy(Option<Trick>),
    /// Too crooked (or still grabbing): the rider falls.
    Bail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// Passed a buoy (`ok` = on the correct side). `meter` is the new level.
    Buoy {
        buoy: u8,
        ok: bool,
        meter: u8,
    },
    /// Passed checkpoint `index` (0-based) of a run.
    Checkpoint {
        index: u8,
    },
    /// Started lap `lap` (1-based). On a run, lap 1 is the start.
    Lap {
        lap: u8,
    },
    Finish {
        ticks: u32,
    },
    /// Landed a trick (`sketchy`: not cleanly, for half the points).
    Trick {
        trick: Trick,
        sketchy: bool,
    },
    /// Landed a plain jump sketchy.
    Sketchy,
    /// Fell: crashed on landing (or into something). Off the board or the
    /// ski for a moment; the meter is emptied.
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
        // Everyone's race is frozen until the next grid.
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
    let live = race.phase == Phase::Racing && p.racing && !p.finished();
    let finish = |p: &mut Progress, events: &mut Vec<SimEvent>| {
        p.finish_ticks = race.elapsed(tick).max(1);
        events.push(SimEvent {
            slot,
            kind: EventKind::Finish {
                ticks: p.finish_ticks,
            },
        });
    };
    match course.gate(gate) {
        Gate::Start => {
            if !live {
                return;
            }
            if !course.looped() {
                if p.lap == 0 {
                    p.lap = 1;
                    events.push(SimEvent {
                        slot,
                        kind: EventKind::Lap { lap: 1 },
                    });
                }
            } else if p.lap >= course.laps {
                finish(p, events);
            } else {
                p.lap += 1;
                events.push(SimEvent {
                    slot,
                    kind: EventKind::Lap { lap: p.lap },
                });
            }
        }
        Gate::Finish => {
            if live && p.lap >= 1 {
                finish(p, events);
            }
        }
        Gate::Checkpoint(index) => events.push(SimEvent {
            slot,
            kind: EventKind::Checkpoint { index: index as u8 },
        }),
        Gate::Buoy(index) => {
            let buoy = &course.buoys[index];
            let ok = match buoy.keep {
                Keep::Right => offset < buoy.offset,
                Keep::Left => offset > buoy.offset,
            };
            if ok {
                p.meter = (p.meter + 1).min(METER_MAX);
            } else {
                p.meter = 0;
                if live {
                    p.misses = p.misses.saturating_add(1);
                }
            }
            events.push(SimEvent {
                slot,
                kind: EventKind::Buoy {
                    buoy: index as u8,
                    ok,
                    meter: p.meter,
                },
            });
        }
    }
}

/// Applies a landing to the race. A bail empties the meter. Tricks (and
/// their points) count toward the results only while racing.
pub fn landed(
    p: &mut Progress,
    race: &Race,
    slot: usize,
    landing: Landing,
    events: &mut Vec<SimEvent>,
) {
    let slot = slot as u8;
    let (trick, sketchy) = match landing {
        Landing::Clean(trick) => (trick, false),
        Landing::Sketchy(Some(trick)) => (trick, true),
        Landing::Sketchy(None) => {
            events.push(SimEvent {
                slot,
                kind: EventKind::Sketchy,
            });
            return;
        }
        Landing::Bail => {
            p.meter = 0;
            events.push(SimEvent {
                slot,
                kind: EventKind::Bail,
            });
            return;
        }
    };
    let trick = if sketchy {
        Trick {
            points: trick.points / 2,
            ..trick
        }
    } else {
        trick
    };
    if p.racing && race.phase == Phase::Racing && !p.finished() {
        p.tricks = p.tricks.saturating_add(1);
        p.points = p.points.saturating_add(trick.points);
    }
    events.push(SimEvent {
        slot,
        kind: EventKind::Trick { trick, sketchy },
    });
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
