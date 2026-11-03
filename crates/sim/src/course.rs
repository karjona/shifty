//! Courses: the racing line, the gates along it, and the solid things around
//! it. Each course belongs to one sport.
//!
//! A line is either a loop or an open run:
//! - The jetski course is a long oval ("stadium") around a rock breakwater:
//!   two straights joined by half circles, raced for laps.
//! - The snowboard course is a run down the mountain (see [`crate::mountain`]),
//!   raced once from the start gate at the top to the finish at the bottom.
//!
//! Positions along a line are measured by arc length `s` from its start, and
//! sideways by `offset` from the centre line, positive to the right of the
//! direction of travel (on the oval, the inside).
//!
//! Everything here is static data plus pure functions, so the server and
//! every client agree on it without sending it over the network.

use crate::math::{PI, TAU, Vec3, atan2, clamp, cos, sin, sqrt};
use crate::mountain::{MOUNTAIN, Run};
use crate::surface::{SeaState, Surface, SurfaceKind};

/// The sport a course is raced in. It picks the physics, the rules and how
/// riders are drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sport {
    /// Summer: a jetski on the swell.
    Jetski,
    /// Winter: a snowboard down the mountain.
    Snowboard,
}

impl Sport {
    /// Body radius for bumps between riders and against obstacles.
    pub fn rider_radius(self) -> f32 {
        match self {
            Self::Jetski => tuning::RIDER_RADIUS,
            Self::Snowboard => 0.45,
        }
    }

    /// Whether clean gates fill the speed meter.
    pub fn has_meter(self) -> bool {
        self == Self::Jetski
    }
}

/// Which side of you a buoy must be on as you pass it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    /// Keep it on your left (pass on its right side).
    Left,
    /// Keep it on your right (pass on its left side).
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BuoyDef {
    pub s: f32,
    pub offset: f32,
    pub keep: Keep,
}

/// A floating kicker ramp, facing the direction of travel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampDef {
    /// Arc length of the ramp's low edge.
    pub s: f32,
    pub offset: f32,
    pub length: f32,
    pub width: f32,
    /// Height of the lip above the low edge.
    pub height: f32,
}

/// What a piece of land is, for drawing it. To the sim all land is the same:
/// solid, and too high to jump onto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LandKind {
    /// A stone quay with a waterfront town on it.
    Town,
    /// A small rocky island with trees.
    Island,
    /// A rock sticking out of the water.
    Rock,
}

/// Land: a capsule around the segment from `a` to `b` (world x, z) with
/// this radius (`a == b` makes a round island).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LandDef {
    pub a: (f32, f32),
    pub b: (f32, f32),
    pub radius: f32,
    pub kind: LandKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CourseId {
    /// Costa Nevada bay: the summer jetski oval.
    Oval = 0,
    /// Costa Nevada mountain: the winter snowboard run.
    Mountain = 1,
}

impl CourseId {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Oval),
            1 => Some(Self::Mountain),
            _ => None,
        }
    }

    pub fn course(self) -> &'static Course {
        match self {
            Self::Oval => &OVAL,
            Self::Mountain => &MOUNTAIN,
        }
    }
}

#[derive(Debug)]
pub struct Course {
    pub sport: Sport,
    pub line: Line,
    /// Half width of the marked racing lane (for bots and markers).
    pub lane_half: f32,
    /// Laps of a loop. An open run is ridden once.
    pub laps: u8,
    /// Arc length of the start line (on a loop, also the finish line).
    pub start_s: f32,
    /// Buoys in the order they are met after the start line.
    pub buoys: &'static [BuoyDef],
    pub ramps: &'static [RampDef],
    pub land: &'static [LandDef],
    /// The water, for courses on the sea.
    pub sea: SeaState,
}

#[derive(Debug)]
pub enum Line {
    /// A loop: two straights along X joined by half circles.
    Stadium(Stadium),
    /// An open run down the mountain.
    Run(&'static Run),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stadium {
    /// Half the length of each straight. The straights run along X.
    pub straight_half: f32,
    /// Radius of the turns: distance from the breakwater axis to the centre line.
    pub radius: f32,
    /// The breakwater: a capsule around the segment `(-straight_half, 0)` to
    /// `(straight_half, 0)` with this radius. Nobody gets through or over it.
    pub breakwater_radius: f32,
    /// Outer limit, as a distance from the breakwater axis.
    pub outer_limit: f32,
}

/// The gates of a course, met in order: the start line, then buoys or
/// checkpoints, then (on an open run) the finish line. On a loop the start
/// line is also the finish.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Start,
    /// Buoy `i` of `Course::buoys`.
    Buoy(usize),
    /// Checkpoint `i` of the run: a line across it, which you can't miss.
    Checkpoint(usize),
    Finish,
}

/// A point on the centre line and the direction of travel there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
}

impl Frame {
    pub fn forward(&self) -> (f32, f32) {
        (sin(self.yaw), cos(self.yaw))
    }

    /// Unit vector toward positive offsets (the inside of the oval).
    pub fn right(&self) -> (f32, f32) {
        (-cos(self.yaw), sin(self.yaw))
    }

    pub fn at_offset(&self, offset: f32) -> (f32, f32) {
        let (rx, rz) = self.right();
        (self.x + rx * offset, self.z + rz * offset)
    }
}

/// The ramp surface under a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampSurface {
    pub top: f32,
    /// Rise per metre travelled along `yaw`.
    pub slope: f32,
    pub yaw: f32,
}

pub mod tuning {
    pub const BUOY_RADIUS: f32 = 0.6;
    /// How far a ramp's low edge sits below the water.
    pub const RAMP_SINK: f32 = 0.3;
    /// Below the ramp deck by more than this, you hit its side instead.
    pub const RAMP_STEP: f32 = 0.9;
    pub const WALL_BOUNCE: f32 = 0.3;
    /// Speed kept along a wall after hitting it.
    pub const WALL_FRICTION: f32 = 0.85;
    /// On a run: speed lost along a wall per m/s of impact, and how much of
    /// an impact against the run's edge counts (fences give).
    pub const SLIDE_FRICTION: f32 = 0.5;
    pub const SOFT_WALL: f32 = 0.6;
    pub const RIDER_RADIUS: f32 = 0.9;
    /// Riders this far above the water clear buoys.
    pub const BUOY_HEIGHT: f32 = 1.4;
}

use tuning::*;

const HALF_PI: f32 = PI * 0.5;

/// Summer: an 860 m oval in the bay, three laps. The swell rolls in along
/// the course: the first straight heads into it (crests launch you) past a
/// small island, the back straight runs with it along the town quay and has
/// the floating ramps.
pub static OVAL: Course = Course {
    sport: Sport::Jetski,
    line: Line::Stadium(Stadium {
        straight_half: 150.0,
        radius: 42.0,
        breakwater_radius: 14.0,
        outer_limit: 84.0,
    }),
    lane_half: 22.0,
    laps: 3,
    start_s: 60.0,
    buoys: &[
        // First straight, into the swell: slalom.
        BuoyDef {
            s: 130.0,
            offset: -5.0,
            keep: Keep::Right,
        },
        // Leads you along the island's shore.
        BuoyDef {
            s: 225.0,
            offset: -8.0,
            keep: Keep::Left,
        },
        BuoyDef {
            s: 265.0,
            offset: -3.0,
            keep: Keep::Right,
        },
        // East turn: inside markers.
        BuoyDef {
            s: 344.0,
            offset: 9.0,
            keep: Keep::Right,
        },
        BuoyDef {
            s: 388.0,
            offset: 9.0,
            keep: Keep::Right,
        },
        // Back straight, with the swell, between the ramps.
        BuoyDef {
            s: 485.0,
            offset: -4.0,
            keep: Keep::Right,
        },
        BuoyDef {
            s: 600.0,
            offset: 4.0,
            keep: Keep::Left,
        },
        BuoyDef {
            s: 700.0,
            offset: -3.0,
            keep: Keep::Right,
        },
        // West turn.
        BuoyDef {
            s: 776.0,
            offset: 9.0,
            keep: Keep::Right,
        },
        BuoyDef {
            s: 820.0,
            offset: 9.0,
            keep: Keep::Right,
        },
    ],
    ramps: &[
        RampDef {
            s: 540.0,
            offset: 8.0,
            length: 9.0,
            width: 5.0,
            height: 2.6,
        },
        RampDef {
            s: 650.0,
            offset: -8.0,
            length: 9.0,
            width: 5.0,
            height: 2.6,
        },
    ],
    land: &[
        // The town quay, 24 m outside the back straight.
        LandDef {
            a: (-120.0, 126.0),
            b: (120.0, 126.0),
            radius: 60.0,
            kind: LandKind::Town,
        },
        // A small island off the first straight, and rocks around it.
        LandDef {
            a: (80.0, -63.0),
            b: (80.0, -63.0),
            radius: 8.0,
            kind: LandKind::Island,
        },
        LandDef {
            a: (64.0, -58.0),
            b: (64.0, -58.0),
            radius: 2.0,
            kind: LandKind::Rock,
        },
        LandDef {
            a: (97.0, -60.0),
            b: (97.0, -60.0),
            radius: 2.5,
            kind: LandKind::Rock,
        },
        // Rocks on the outside of the turns.
        LandDef {
            a: (200.0, -29.0),
            b: (200.0, -29.0),
            radius: 3.0,
            kind: LandKind::Rock,
        },
        LandDef {
            a: (197.0, 33.0),
            b: (197.0, 33.0),
            radius: 2.5,
            kind: LandKind::Rock,
        },
        LandDef {
            a: (-203.0, 20.0),
            b: (-203.0, 20.0),
            radius: 3.0,
            kind: LandKind::Rock,
        },
    ],
    sea: SeaState {
        // Travelling toward -X: against the first straight.
        direction: Some(3.0 * HALF_PI),
        spread: 0.25,
        ..SeaState::OPEN_SEA
    },
};

impl Course {
    /// Length of the centre line (one lap of a loop).
    pub fn length(&self) -> f32 {
        match &self.line {
            Line::Stadium(st) => st.length(),
            Line::Run(run) => run.length(),
        }
    }

    /// Whether the line is a loop raced for laps (or an open run).
    pub fn looped(&self) -> bool {
        matches!(self.line, Line::Stadium(_))
    }

    pub fn stadium(&self) -> Option<&Stadium> {
        match &self.line {
            Line::Stadium(st) => Some(st),
            Line::Run(_) => None,
        }
    }

    pub fn run(&self) -> Option<&'static Run> {
        match self.line {
            Line::Stadium(_) => None,
            Line::Run(run) => Some(run),
        }
    }

    /// The sea this course is raced on (flat calm for courses on land).
    pub fn surface(&self, kind: SurfaceKind, seed: u32) -> Surface {
        match self.line {
            Line::Stadium(_) => Surface::with_sea(kind, seed, &self.sea),
            Line::Run(_) => Surface::flat(),
        }
    }

    /// Wraps an arc length into `[0, length)` on a loop; unchanged on a run.
    pub fn wrap_s(&self, s: f32) -> f32 {
        if !self.looped() {
            return s;
        }
        let l = self.length();
        let w = s - l * libm::floorf(s / l);
        if w >= l { 0.0 } else { w }
    }

    /// Signed distance from `a` to `b` along the line (on a loop, the short
    /// way round: in `(-L/2, L/2]`).
    pub fn delta_s(&self, a: f32, b: f32) -> f32 {
        if !self.looped() {
            return b - a;
        }
        let l = self.length();
        let d = self.wrap_s(b - a);
        if d > l * 0.5 { d - l } else { d }
    }

    pub fn centerline(&self, s: f32) -> Frame {
        match &self.line {
            Line::Stadium(st) => st.centerline(self.wrap_s(s)),
            Line::Run(run) => run.centerline(s),
        }
    }

    /// Arc length and offset of the closest point on the centre line.
    pub fn project(&self, x: f32, z: f32) -> (f32, f32) {
        match &self.line {
            Line::Stadium(st) => st.project(x, z),
            Line::Run(run) => run.project(x, z),
        }
    }

    pub fn gate_count(&self) -> usize {
        match &self.line {
            Line::Stadium(_) => self.buoys.len() + 1,
            Line::Run(run) => run.checkpoints.len() + 2,
        }
    }

    pub fn gate(&self, i: usize) -> Gate {
        if i == 0 {
            return Gate::Start;
        }
        match &self.line {
            Line::Stadium(_) => Gate::Buoy(i - 1),
            Line::Run(run) if i <= run.checkpoints.len() => Gate::Checkpoint(i - 1),
            Line::Run(_) => Gate::Finish,
        }
    }

    pub fn gate_s(&self, i: usize) -> f32 {
        match (self.gate(i), &self.line) {
            (Gate::Start, _) => self.start_s,
            (Gate::Buoy(b), _) => self.buoys[b].s,
            (Gate::Checkpoint(c), Line::Run(run)) => run.checkpoints[c],
            (Gate::Finish, Line::Run(run)) => run.finish_s,
            _ => self.start_s,
        }
    }

    pub fn buoy_pos(&self, i: usize) -> (f32, f32) {
        let b = &self.buoys[i];
        self.centerline(b.s).at_offset(b.offset)
    }

    /// Starting spot for a slot: two rows of four behind the start line.
    pub fn grid_spot(&self, slot: usize) -> Frame {
        let (back, rows, cols) = match self.sport {
            Sport::Jetski => (10.0, 8.0, 6.0),
            Sport::Snowboard => (5.0, 5.0, 3.5),
        };
        let row = (slot / 4) as f32;
        let col = (slot % 4) as f32;
        let f = self.centerline(self.start_s - back - row * rows);
        let (x, z) = f.at_offset((col - 1.5) * cols);
        Frame { x, z, yaw: f.yaw }
    }

    /// Centre of a ramp's footprint, its yaw, and its floating base height.
    pub fn ramp_frame(&self, i: usize, surface: &Surface, tick: u32) -> (Frame, f32) {
        let d = &self.ramps[i];
        let f = self.centerline(d.s + d.length * 0.5);
        let (x, z) = f.at_offset(d.offset);
        let base = surface.height(x, z, tick) - RAMP_SINK;
        (Frame { x, z, yaw: f.yaw }, base)
    }

    /// Ramp-local coordinates of a point: `(along, across)` from the low
    /// edge's centre.
    fn ramp_local(&self, i: usize, frame: &Frame, x: f32, z: f32) -> (f32, f32) {
        let d = &self.ramps[i];
        let (fx, fz) = frame.forward();
        let (rx, rz) = frame.right();
        let dx = x - frame.x;
        let dz = z - frame.z;
        (dx * fx + dz * fz + d.length * 0.5, dx * rx + dz * rz)
    }

    /// The ramp deck under `(x, z)`, if there is one.
    pub fn ramp_under(&self, x: f32, z: f32, surface: &Surface, tick: u32) -> Option<RampSurface> {
        for (i, d) in self.ramps.iter().enumerate() {
            let (frame, base) = self.ramp_frame(i, surface, tick);
            let (u, v) = self.ramp_local(i, &frame, x, z);
            if (0.0..=d.length).contains(&u) && v.abs() <= d.width * 0.5 {
                let slope = d.height / d.length;
                return Some(RampSurface {
                    top: base + slope * u,
                    slope,
                    yaw: frame.yaw,
                });
            }
        }
        None
    }

    /// Keeps a body at `pos` with velocity `vel` on the course: out of the
    /// breakwater, the buoys, the land and the sides of the ramps, inside the
    /// outer limit, and (on a run) between its edges and clear of what stands
    /// on it. Returns the hardest impact (speed into the wall, m/s) on any
    /// contact.
    pub fn collide(
        &self,
        pos: &mut Vec3,
        vel: &mut Vec3,
        surface: &Surface,
        tick: u32,
    ) -> Option<f32> {
        let radius = self.sport.rider_radius();
        let mut hit: Option<f32> = None;
        let mut note = |impact: f32| hit = Some(hit.map_or(impact, |h| h.max(impact)));
        match &self.line {
            Line::Stadium(st) => {
                let (d, nx, nz) = st.axis_distance(pos.x, pos.z);
                let inner = st.breakwater_radius + radius;
                let outer = st.outer_limit - radius;
                if d < inner {
                    note(push(pos, vel, nx, nz, inner - d));
                } else if d > outer {
                    note(push(pos, vel, -nx, -nz, d - outer));
                }
            }
            Line::Run(run) => {
                let (s, offset) = run.project(pos.x, pos.z);
                let limit = run.limit(s) - radius;
                if offset.abs() > limit {
                    let (rx, rz) = run.centerline(s).right();
                    let sign = if offset > 0.0 { -1.0 } else { 1.0 };
                    let depth = offset.abs() - limit;
                    // Fences and netting give: glancing along them costs
                    // little, and hits count for less.
                    note(slide(pos, vel, rx * sign, rz * sign, depth) * SOFT_WALL);
                }
                for o in run.obstacles() {
                    let dx = pos.x - o.x;
                    let dz = pos.z - o.z;
                    let min = o.radius + radius;
                    let dd = dx * dx + dz * dz;
                    if dd < min * min && pos.y < o.y + o.height {
                        let dist = sqrt(dd);
                        let (nx, nz) = if dist > 1e-4 {
                            (dx / dist, dz / dist)
                        } else {
                            (1.0, 0.0)
                        };
                        note(slide(pos, vel, nx, nz, min - dist));
                    }
                }
            }
        }

        for i in 0..self.buoys.len() {
            let (bx, bz) = self.buoy_pos(i);
            let dx = pos.x - bx;
            let dz = pos.z - bz;
            let min = BUOY_RADIUS + radius;
            let dd = dx * dx + dz * dz;
            if dd < min * min && pos.y < surface.height(bx, bz, tick) + BUOY_HEIGHT {
                let dist = sqrt(dd);
                let (nx, nz) = if dist > 1e-4 {
                    (dx / dist, dz / dist)
                } else {
                    (1.0, 0.0)
                };
                note(push(pos, vel, nx, nz, min - dist));
            }
        }

        for land in self.land {
            let (d, nx, nz) = land.distance(pos.x, pos.z);
            let min = land.radius + radius;
            if d < min {
                note(push(pos, vel, nx, nz, min - d));
            }
        }

        for (i, rd) in self.ramps.iter().enumerate() {
            let (frame, base) = self.ramp_frame(i, surface, tick);
            let (u, v) = self.ramp_local(i, &frame, pos.x, pos.z);
            let half = rd.width * 0.5 + radius;
            if u < 0.0 || u > rd.length + radius || v.abs() > half {
                continue;
            }
            let top = base + rd.height / rd.length * clamp(u, 0.0, rd.length);
            if pos.y >= top - RAMP_STEP {
                continue;
            }
            // Below the deck: you hit a side or the back. Leave by the nearest one.
            let (fx, fz) = frame.forward();
            let (rx, rz) = frame.right();
            let back = rd.length + radius - u;
            let side = half - v.abs();
            if back < side {
                note(push(pos, vel, fx, fz, back));
            } else {
                let sign = if v >= 0.0 { 1.0 } else { -1.0 };
                note(push(pos, vel, rx * sign, rz * sign, side));
            }
        }
        hit
    }
}

impl Stadium {
    pub fn length(&self) -> f32 {
        4.0 * self.straight_half + TAU * self.radius
    }

    /// The centre line at `s`, already wrapped into one lap.
    fn centerline(&self, s: f32) -> Frame {
        let sh = self.straight_half;
        let r = self.radius;
        let turn = PI * r;
        if s < 2.0 * sh {
            Frame {
                x: s - sh,
                z: -r,
                yaw: HALF_PI,
            }
        } else if s < 2.0 * sh + turn {
            let th = (s - 2.0 * sh) / r - HALF_PI;
            Frame {
                x: sh + r * cos(th),
                z: r * sin(th),
                yaw: crate::math::wrap_angle(-th),
            }
        } else if s < 4.0 * sh + turn {
            let d = s - 2.0 * sh - turn;
            Frame {
                x: sh - d,
                z: r,
                yaw: 3.0 * HALF_PI,
            }
        } else {
            let th = (s - 4.0 * sh - turn) / r + HALF_PI;
            Frame {
                x: -sh + r * cos(th),
                z: r * sin(th),
                yaw: crate::math::wrap_angle(3.0 * HALF_PI - (th - HALF_PI)),
            }
        }
    }

    fn project(&self, x: f32, z: f32) -> (f32, f32) {
        let sh = self.straight_half;
        let r = self.radius;
        let turn = PI * r;
        if x >= -sh && x <= sh {
            if z < 0.0 {
                (x + sh, z + r)
            } else {
                (2.0 * sh + turn + (sh - x), r - z)
            }
        } else if x > sh {
            let th = atan2(z, x - sh);
            let d = sqrt((x - sh) * (x - sh) + z * z);
            (2.0 * sh + r * (th + HALF_PI), r - d)
        } else {
            let mut th = atan2(z, x + sh);
            if th < 0.0 {
                th += TAU;
            }
            let d = sqrt((x + sh) * (x + sh) + z * z);
            (4.0 * sh + turn + r * (th - HALF_PI), r - d)
        }
    }

    /// Distance from the breakwater axis, and the unit direction away from it.
    fn axis_distance(&self, x: f32, z: f32) -> (f32, f32, f32) {
        let cx = clamp(x, -self.straight_half, self.straight_half);
        let dx = x - cx;
        let d = sqrt(dx * dx + z * z);
        if d > 1e-4 {
            (d, dx / d, z / d)
        } else {
            (0.0, 0.0, 1.0)
        }
    }
}

impl LandDef {
    /// Distance from the land's spine (the segment `a`–`b`), and the unit
    /// direction away from it.
    pub fn distance(&self, x: f32, z: f32) -> (f32, f32, f32) {
        let (ax, az) = self.a;
        let (abx, abz) = (self.b.0 - ax, self.b.1 - az);
        let len2 = abx * abx + abz * abz;
        let t = if len2 > 1e-6 {
            clamp(((x - ax) * abx + (z - az) * abz) / len2, 0.0, 1.0)
        } else {
            0.0
        };
        let dx = x - (ax + abx * t);
        let dz = z - (az + abz * t);
        let d = sqrt(dx * dx + dz * dz);
        if d > 1e-4 {
            (d, dx / d, dz / d)
        } else {
            (0.0, 0.0, 1.0)
        }
    }
}

/// Moves `pos` by `depth` along `(nx, nz)` and bounces the velocity off
/// that wall. Returns the speed of the impact (into the wall).
fn push(pos: &mut Vec3, vel: &mut Vec3, nx: f32, nz: f32, depth: f32) -> f32 {
    pos.x += nx * depth;
    pos.z += nz * depth;
    let vn = vel.x * nx + vel.z * nz;
    if vn < 0.0 {
        let tx = vel.x - nx * vn;
        let tz = vel.z - nz * vn;
        vel.x = tx * WALL_FRICTION - nx * vn * WALL_BOUNCE;
        vel.z = tz * WALL_FRICTION - nz * vn * WALL_BOUNCE;
        -vn
    } else {
        0.0
    }
}

/// Like [`push`], but friction along the wall grows with the impact, so
/// sliding along it barely slows you. Returns the speed of the impact.
fn slide(pos: &mut Vec3, vel: &mut Vec3, nx: f32, nz: f32, depth: f32) -> f32 {
    pos.x += nx * depth;
    pos.z += nz * depth;
    let vn = vel.x * nx + vel.z * nz;
    if vn >= 0.0 {
        return 0.0;
    }
    let tx = vel.x - nx * vn;
    let tz = vel.z - nz * vn;
    let t = sqrt(tx * tx + tz * tz);
    let keep = if t > 1e-4 {
        1.0 - (SLIDE_FRICTION * -vn).min(t) / t
    } else {
        0.0
    };
    vel.x = tx * keep - nx * vn * WALL_BOUNCE;
    vel.z = tz * keep - nz * vn * WALL_BOUNCE;
    -vn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centre_line_and_projection_agree() {
        let c = &OVAL;
        let mut s = 0.5;
        while s < c.length() {
            let f = c.centerline(s);
            for off in [-20.0, 0.0, 15.0] {
                let (x, z) = f.at_offset(off);
                let (ps, po) = c.project(x, z);
                assert!(c.delta_s(s, ps).abs() < 0.05, "s {s} off {off} -> {ps}");
                assert!((po - off).abs() < 0.05, "s {s} off {off} -> {po}");
            }
            // Heading matches the direction the centre line moves in.
            let g = c.centerline(s + 0.1);
            let heading = atan2(g.x - f.x, g.z - f.z);
            assert!(
                crate::math::angle_diff(f.yaw, heading).abs() < 0.01,
                "s {s}: yaw {} vs {heading}",
                f.yaw
            );
            s += 7.3;
        }
    }

    #[test]
    fn land_is_solid_and_clear_of_the_racing_line() {
        let c = &OVAL;
        for land in c.land {
            let (cx, cz) = land.a;
            let mut pos = Vec3::new(cx + 0.5, 0.0, cz + 0.5);
            let mut vel = Vec3::new(0.0, 0.0, -10.0);
            assert!(c.collide(&mut pos, &mut vel, &Surface::flat(), 0).is_some());
            assert!(land.distance(pos.x, pos.z).0 >= land.radius + RIDER_RADIUS - 1e-3);
        }
        // Bots ride within a few metres of the centre line and of the buoys.
        let mut s = 0.0;
        while s < c.length() {
            let (x, z) = c.centerline(s).at_offset(0.0);
            for land in c.land {
                assert!(
                    land.distance(x, z).0 - land.radius > 10.0,
                    "land at s = {s}"
                );
            }
            s += 1.0;
        }
        for i in 0..c.buoys.len() {
            let (x, z) = c.buoy_pos(i);
            for land in c.land {
                assert!(land.distance(x, z).0 - land.radius > 4.0, "buoy {i}");
            }
        }
    }

    #[test]
    fn buoys_are_in_order_and_in_the_lane() {
        let c = &OVAL;
        let mut last = c.start_s;
        for b in c.buoys {
            assert!(b.s > last && b.s < c.length());
            assert!(b.offset.abs() < c.lane_half);
            last = b.s;
        }
    }

    #[test]
    fn walls_keep_riders_on_the_water() {
        let c = &OVAL;
        let s = Surface::flat();
        // Driving straight at the breakwater stops at its edge.
        let mut pos = Vec3::new(0.0, 0.0, -5.0);
        let mut vel = Vec3::new(0.0, 0.0, 10.0);
        let st = c.stadium().unwrap();
        assert!(c.collide(&mut pos, &mut vel, &s, 0).is_some());
        assert!(pos.z <= -(st.breakwater_radius + RIDER_RADIUS) + 1e-3);
        assert!(vel.z < 0.0);
        // And so does the outer limit.
        let mut pos = Vec3::new(0.0, 0.0, -100.0);
        let mut vel = Vec3::new(0.0, 0.0, -10.0);
        assert!(c.collide(&mut pos, &mut vel, &s, 0).is_some());
        assert!(pos.z >= -st.outer_limit);
    }

    #[test]
    fn ramps_rise_along_the_course() {
        let c = &OVAL;
        let s = Surface::flat();
        let d = c.ramps[0];
        let f = c.centerline(d.s + 1.0);
        let (x0, z0) = f.at_offset(d.offset);
        let f = c.centerline(d.s + d.length - 1.0);
        let (x1, z1) = f.at_offset(d.offset);
        let a = c.ramp_under(x0, z0, &s, 0).unwrap();
        let b = c.ramp_under(x1, z1, &s, 0).unwrap();
        assert!(b.top > a.top + d.height * 0.6, "{a:?} {b:?}");
        assert!(c.ramp_under(x1 + 30.0, z1, &s, 0).is_none());
    }
}
