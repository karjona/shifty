//! Courses: the racing line, the gates along it, and the solid things around
//! it. Each course belongs to one sport.
//!
//! A line is either a loop or an open run:
//! - The bay is a long oval ("stadium") around a rock breakwater: two
//!   straights joined by half circles, raced for laps.
//! - The cape is a loop of any shape (see [`crate::circuit`]) round a
//!   headland, raced for laps.
//! - The snowboard course is a run down the mountain (see [`crate::mountain`]),
//!   raced once from the start gate at the top to the finish at the bottom.
//!
//! Positions along a line are measured by arc length `s` from its start, and
//! sideways by `offset` from the centre line, positive to the right of the
//! direction of travel (on the oval, the inside).
//!
//! Everything here is static data plus pure functions, so the server and
//! every client agree on it without sending it over the network.

use crate::capsule::{Segment, apart, separate};
use crate::circuit::{Circuit, Corner};
use crate::conditions::Conditions;
use crate::math::{PI, Pcg32, TAU, Vec3, atan2, clamp, cos, sin, sqrt};
use crate::mountain::{GLADES, MOUNTAIN, Obstacle, Run};
use crate::surface::{SeaState, Shelter, Surface, SurfaceKind};

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
    /// Body radius for bumps against the course's limits, obstacles,
    /// buoys and ramps.
    pub fn rider_radius(self) -> f32 {
        match self {
            Self::Jetski => tuning::RIDER_RADIUS,
            Self::Snowboard => 0.45,
        }
    }

    /// A rider's body for bumps against other riders, land and moored
    /// boats: the hull, or the board ridden along its length.
    pub fn body(self) -> Body {
        match self {
            Self::Jetski => {
                Body::spanning(tuning::HULL_STERN, tuning::HULL_BOW, tuning::HULL_HALF_BEAM)
            }
            Self::Snowboard => Body::spanning(
                -tuning::BOARD_HALF_LENGTH,
                tuning::BOARD_HALF_LENGTH,
                tuning::BOARD_BODY_RADIUS,
            ),
        }
    }

    /// Whether clean gates fill the speed meter.
    pub fn has_meter(self) -> bool {
        self == Self::Jetski
    }
}

/// A capsule along a rider's heading: a segment `half` metres either side
/// of a point `ahead` metres forward of the rider's position, and a radius.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Body {
    pub ahead: f32,
    pub half: f32,
    pub radius: f32,
}

impl Body {
    /// The body from `stern` to `bow` (metres along the heading, the stern
    /// negative), `radius` either side.
    pub const fn spanning(stern: f32, bow: f32, radius: f32) -> Self {
        Self {
            ahead: (stern + bow) * 0.5,
            half: (bow - stern) * 0.5 - radius,
            radius,
        }
    }

    /// The body's segment for a rider at `(x, z)` heading `yaw`.
    pub fn segment(&self, x: f32, z: f32, yaw: f32) -> Segment {
        Segment::along(x, z, (sin(yaw), cos(yaw)), self.ahead, self.half)
    }

    /// How far its farthest point reaches from the rider's position.
    pub fn reach(&self) -> f32 {
        self.ahead.abs() + self.half + self.radius
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
    /// A headland: rock and cliffs, pines on top.
    Headland,
    /// The mainland's rocky coast.
    Coast,
    /// A sandy beach.
    Beach,
    /// A harbour's breakwater (a mole).
    Mole,
    /// A sea stack: a tall pillar of rock standing in the sea.
    Stack,
    /// A leg of a natural rock arch (the span over the water isn't solid).
    Arch,
    /// A jetty on piles, out from a quay (drawn with what it belongs to).
    Jetty,
}

/// What a moored boat is, for drawing it. To the sim every boat is the
/// same: a solid hull that stands still.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoatKind {
    /// A llaüt, the double-ended fishing boat of these waters.
    Llaut,
    Trawler,
    Yacht,
    Inflatable,
    /// A small sailing boat at a jetty (drawn with what it belongs to).
    Sailboat,
}

/// A boat at its mooring: a hull `length` long and `beam` wide, centred
/// on `(x, z)`, its bow toward `yaw`. It rocks on the swell as a look; to
/// the sim it is a capsule that never moves. `seed` picks how it looks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoatDef {
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
    pub length: f32,
    pub beam: f32,
    pub kind: BoatKind,
    pub seed: u16,
}

impl BoatDef {
    /// The hull: its segment and radius.
    pub fn hull(&self) -> (Segment, f32) {
        let radius = self.beam * 0.5;
        let half = (self.length * 0.5 - radius).max(0.0);
        (
            Segment::along(self.x, self.z, (sin(self.yaw), cos(self.yaw)), 0.0, half),
            radius,
        )
    }
}

const fn boat(
    x: f32,
    z: f32,
    yaw: f32,
    length: f32,
    beam: f32,
    kind: BoatKind,
    seed: u16,
) -> BoatDef {
    BoatDef {
        x,
        z,
        yaw,
        length,
        beam,
        kind,
        seed,
    }
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
    /// Costa Nevada bay: the jetski oval.
    Oval = 0,
    /// Costa Nevada mountain: the mountain run, from the summit to the village.
    Mountain = 1,
    /// Costa Nevada cape: a jetski loop round a rocky headland.
    Cape = 2,
    /// Costa Nevada mountain: the glades, from the ridge to the lake.
    Glades = 3,
}

impl CourseId {
    /// Every circuit, in id order. Each one here can be drawn for a race in
    /// any season its sport rides (see [`crate::conditions`]).
    pub const ALL: &'static [CourseId] = &[Self::Oval, Self::Mountain, Self::Cape, Self::Glades];

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Oval),
            1 => Some(Self::Mountain),
            2 => Some(Self::Cape),
            3 => Some(Self::Glades),
            _ => None,
        }
    }

    pub fn course(self) -> &'static Course {
        match self {
            Self::Oval => &OVAL,
            Self::Mountain => &MOUNTAIN,
            Self::Cape => &CAPE,
            Self::Glades => &GLADES,
        }
    }

    pub fn sport(self) -> Sport {
        self.course().sport
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
    /// Counts the changes to the circuit that change what a time on it
    /// means: a time trial's times and ghosts rank only against those of
    /// the same revision. Bump it with any change to the line, the gates,
    /// the obstacles or the ground a rider rides.
    pub revision: u8,
    /// Arc length of the start line (on a loop, also the finish line).
    pub start_s: f32,
    /// Buoys in the order they are met after the start line (on a loop, round
    /// to the ones before it).
    pub buoys: &'static [BuoyDef],
    pub ramps: &'static [RampDef],
    pub land: &'static [LandDef],
    /// Boats moored on the course's water.
    pub boats: &'static [BoatDef],
    /// The water, for courses on the sea.
    pub sea: SeaState,
}

#[derive(Debug)]
pub enum Line {
    /// A loop: two straights along X joined by half circles.
    Stadium(Stadium),
    /// A loop of straights and arcs round a polygon of corners.
    Loop(&'static Circuit),
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
    /// A jetski's hull for bumps, from the rider's position: the stern and
    /// the bow along it (m), and half its beam.
    pub const HULL_STERN: f32 = -1.5;
    pub const HULL_BOW: f32 = 1.7;
    pub const HULL_HALF_BEAM: f32 = 0.6;
    /// A snowboard's half length, and how far the rider stands out either
    /// side of it.
    pub const BOARD_HALF_LENGTH: f32 = 0.8;
    pub const BOARD_BODY_RADIUS: f32 = 0.3;
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
    revision: 1,
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
        // The country club's jetty, out from the quay's east end.
        LandDef {
            a: (151.5, 65.1),
            b: (151.5, 75.3),
            radius: 0.9,
            kind: LandKind::Jetty,
        },
    ],
    boats: &[
        // Alongside the town quay, bow to stern.
        boat(-114.0, 63.64, 1.59, 6.33, 2.2, BoatKind::Llaut, 355),
        boat(-99.3, 64.06, 1.61, 5.89, 2.2, BoatKind::Llaut, 419),
        boat(-88.81, 63.61, 4.69, 6.33, 2.2, BoatKind::Llaut, 720),
        boat(-79.3, 63.85, 4.7, 6.4, 2.2, BoatKind::Llaut, 700),
        boat(-69.48, 63.67, 4.71, 5.0, 2.1, BoatKind::Inflatable, 825),
        boat(-55.68, 63.73, 4.69, 6.18, 2.2, BoatKind::Llaut, 40),
        boat(-42.76, 63.92, 4.68, 5.0, 2.1, BoatKind::Inflatable, 436),
        boat(-27.38, 63.99, 4.75, 5.53, 2.2, BoatKind::Llaut, 38),
        boat(-10.86, 63.79, 1.61, 5.77, 2.2, BoatKind::Llaut, 333),
        boat(-0.51, 63.97, 1.62, 6.02, 2.2, BoatKind::Llaut, 399),
        boat(16.99, 63.92, 4.73, 5.0, 2.1, BoatKind::Inflatable, 206),
        boat(26.97, 63.8, 4.74, 6.75, 2.2, BoatKind::Llaut, 920),
        boat(36.38, 63.67, 1.58, 6.47, 2.2, BoatKind::Llaut, 615),
        boat(48.58, 63.68, 1.62, 6.27, 2.2, BoatKind::Llaut, 760),
        boat(61.52, 63.89, 1.53, 6.41, 2.2, BoatKind::Llaut, 648),
        boat(74.84, 64.1, 4.69, 5.0, 2.1, BoatKind::Inflatable, 54),
        boat(89.49, 64.09, 1.56, 5.43, 2.2, BoatKind::Llaut, 823),
        boat(103.35, 63.67, 4.76, 6.47, 2.2, BoatKind::Llaut, 119),
        boat(112.22, 63.94, 4.72, 6.34, 2.2, BoatKind::Llaut, 189),
        // At the country club's jetty, off the quay's east end.
        boat(153.6, 72.5, PI, 6.0, 2.0, BoatKind::Sailboat, 0),
        boat(149.4, 68.0, 0.0, 5.2, 1.73, BoatKind::Sailboat, 1),
        // At anchor off the quay's ends and out past the first straight,
        // heads to the swell.
        boat(228.0, 96.0, 1.55, 13.0, 4.2, BoatKind::Trawler, 45),
        boat(248.0, 124.0, 1.56, 9.0, 2.9, BoatKind::Yacht, 279),
        boat(212.0, 130.0, 1.5, 5.72, 2.2, BoatKind::Llaut, 981),
        boat(268.0, 88.0, 1.65, 9.0, 2.9, BoatKind::Yacht, 451),
        boat(-226.0, 100.0, 1.56, 9.0, 2.9, BoatKind::Yacht, 613),
        boat(-246.0, 128.0, 1.62, 13.0, 4.2, BoatKind::Trawler, 364),
        boat(-210.0, 134.0, 1.39, 5.61, 2.2, BoatKind::Llaut, 639),
        boat(-60.0, -128.0, 1.66, 9.0, 2.9, BoatKind::Yacht, 838),
        boat(48.0, -152.0, 1.6, 9.0, 2.9, BoatKind::Yacht, 766),
        boat(160.0, -134.0, 1.77, 5.44, 2.2, BoatKind::Llaut, 397),
        boat(-194.0, -112.0, 1.39, 9.0, 2.9, BoatKind::Yacht, 569),
    ],
    sea: SeaState {
        // Travelling toward -X: against the first straight.
        direction: Some(3.0 * HALF_PI),
        spread: 0.25,
        ..SeaState::OPEN_SEA
    },
};

static CAPE_LINE: Circuit = Circuit::new(
    &[
        // The harbour's head: right, toward the arch.
        Corner {
            x: -126.0,
            z: -90.0,
            radius: 27.0,
        },
        // Out of the arch into the beach cove: right, down the beach.
        Corner {
            x: 90.0,
            z: -90.0,
            radius: 34.2,
        },
        // Round the point under the watchtower: a long fast sweeper.
        Corner {
            x: 97.2,
            z: 162.0,
            radius: 64.8,
        },
        // Off the stacks: right, back up the west side.
        Corner {
            x: -144.0,
            z: 184.5,
            radius: 27.0,
        },
        // Through the stacks: left...
        Corner {
            x: -94.5,
            z: 117.0,
            radius: 23.4,
        },
        // ...and right, lined up for the harbour mouth.
        Corner {
            x: -126.0,
            z: 67.5,
            radius: 23.4,
        },
    ],
    42.0,
);

/// The cape: a 900 m loop round a rocky headland, three laps. Out of the
/// harbour, under the natural arch through the headland's neck, down the
/// beach cove (the start), round the point under the watchtower, west along
/// the open sea (the swell rolls in against you, with the ramps), weaving
/// through the sea stacks, and in through the narrow harbour mouth. The
/// harbour and the coves are sheltered; off the point takes the full swell.
pub static CAPE: Course = Course {
    sport: Sport::Jetski,
    line: Line::Loop(&CAPE_LINE),
    lane_half: 22.0,
    laps: 3,
    revision: 1,
    start_s: 270.0,
    buoys: &[
        // After the start, down the beach toward the ramp.
        BuoyDef {
            s: 330.0,
            offset: 0.0,
            keep: Keep::Right,
        },
        // Round the point: inside markers.
        BuoyDef {
            s: 423.0,
            offset: 10.0,
            keep: Keep::Right,
        },
        BuoyDef {
            s: 472.5,
            offset: 10.0,
            keep: Keep::Right,
        },
        // Off the point, between the ramps.
        BuoyDef {
            s: 548.0,
            offset: 2.0,
            keep: Keep::Left,
        },
        // The stacks: in, round, out.
        BuoyDef {
            s: 657.0,
            offset: 7.0,
            keep: Keep::Right,
        },
        BuoyDef {
            s: 711.0,
            offset: -4.0,
            keep: Keep::Left,
        },
        BuoyDef {
            s: 765.0,
            offset: 5.0,
            keep: Keep::Right,
        },
        // In the harbour, along the moored boats.
        BuoyDef {
            s: 841.5,
            offset: -5.0,
            keep: Keep::Left,
        },
        // The harbour's head: inside marker.
        BuoyDef {
            s: 18.0,
            offset: 9.0,
            keep: Keep::Right,
        },
        // Lines you up for the arch.
        BuoyDef {
            s: 94.5,
            offset: -6.0,
            keep: Keep::Left,
        },
        // Into the beach cove.
        BuoyDef {
            s: 214.2,
            offset: 9.0,
            keep: Keep::Right,
        },
    ],
    ramps: &[
        // Down the beach, toward the crowd.
        RampDef {
            s: 368.0,
            offset: -6.0,
            length: 9.0,
            width: 5.0,
            height: 2.6,
        },
        // Off the point, into the swell.
        RampDef {
            s: 510.0,
            offset: 8.0,
            length: 9.0,
            width: 5.0,
            height: 2.6,
        },
        RampDef {
            s: 596.0,
            offset: -7.0,
            length: 9.0,
            width: 5.0,
            height: 2.6,
        },
    ],
    land: &[
        // The arch through the headland's neck: its legs, 28 m apart.
        LandDef {
            a: (-5.4, -112.0),
            b: (5.4, -112.0),
            radius: 8.0,
            kind: LandKind::Arch,
        },
        LandDef {
            a: (-5.4, -68.0),
            b: (5.4, -68.0),
            radius: 8.0,
            kind: LandKind::Arch,
        },
        // The neck, from the mainland to the arch, and the headland beyond it.
        LandDef {
            a: (0.0, -135.0),
            b: (0.0, -126.0),
            radius: 16.2,
            kind: LandKind::Headland,
        },
        LandDef {
            a: (-19.8, -55.8),
            b: (19.8, -55.8),
            radius: 12.6,
            kind: LandKind::Headland,
        },
        LandDef {
            a: (-4.5, -49.5),
            b: (0.0, 9.0),
            radius: 27.0,
            kind: LandKind::Headland,
        },
        LandDef {
            a: (0.0, 9.0),
            b: (4.5, 81.0),
            radius: 37.8,
            kind: LandKind::Headland,
        },
        LandDef {
            a: (4.5, 81.0),
            b: (9.0, 112.5),
            radius: 23.4,
            kind: LandKind::Headland,
        },
        LandDef {
            a: (-45.0, 45.0),
            b: (-36.0, 99.0),
            radius: 25.2,
            kind: LandKind::Headland,
        },
        // The mainland round the bay: the coast behind the arch and the
        // hills behind it, the harbour town and the coast past it on the
        // west, the beach and the coast past it on the east.
        LandDef {
            a: (-700.0, -180.0),
            b: (700.0, -180.0),
            radius: 54.0,
            kind: LandKind::Coast,
        },
        LandDef {
            a: (-800.0, -420.0),
            b: (800.0, -420.0),
            radius: 200.0,
            kind: LandKind::Coast,
        },
        LandDef {
            a: (-420.0, -180.0),
            b: (-420.0, 300.0),
            radius: 150.0,
            kind: LandKind::Coast,
        },
        LandDef {
            a: (430.0, -180.0),
            b: (430.0, 300.0),
            radius: 120.0,
            kind: LandKind::Coast,
        },
        LandDef {
            a: (-226.8, -135.0),
            b: (-226.8, 108.0),
            radius: 54.0,
            kind: LandKind::Town,
        },
        LandDef {
            a: (229.5, -135.0),
            b: (235.8, 108.0),
            radius: 85.5,
            kind: LandKind::Beach,
        },
        // The harbour mole, and the beacon rock across the mouth from its head.
        LandDef {
            a: (-193.5, 37.8),
            b: (-147.6, 37.8),
            radius: 5.4,
            kind: LandKind::Mole,
        },
        LandDef {
            a: (-106.2, 36.0),
            b: (-106.2, 36.0),
            radius: 5.0,
            kind: LandKind::Rock,
        },
        // The sea stacks off the headland's south-west.
        LandDef {
            a: (-95.4, 156.6),
            b: (-95.4, 156.6),
            radius: 6.0,
            kind: LandKind::Stack,
        },
        LandDef {
            a: (-117.0, 119.0),
            b: (-117.0, 119.0),
            radius: 6.0,
            kind: LandKind::Stack,
        },
        LandDef {
            a: (-136.8, 104.4),
            b: (-136.8, 104.4),
            radius: 5.0,
            kind: LandKind::Stack,
        },
        LandDef {
            a: (-105.0, 64.0),
            b: (-105.0, 64.0),
            radius: 5.0,
            kind: LandKind::Stack,
        },
        LandDef {
            a: (-184.5, 216.0),
            b: (-184.5, 216.0),
            radius: 8.0,
            kind: LandKind::Stack,
        },
    ],
    boats: &[
        // Stern to the town's quay, from the harbour's head to the mole.
        boat(-169.17, -106.57, 1.52, 6.59, 2.2, BoatKind::Llaut, 908),
        boat(-169.17, -100.86, 1.58, 6.27, 2.2, BoatKind::Llaut, 99),
        boat(-169.17, -94.01, 1.52, 5.62, 2.2, BoatKind::Llaut, 221),
        boat(-169.08, -89.47, 1.59, 5.79, 2.2, BoatKind::Llaut, 35),
        boat(-169.0, -83.26, 1.52, 6.13, 2.2, BoatKind::Llaut, 558),
        boat(-168.8, -72.63, 1.55, 6.0, 2.2, BoatKind::Llaut, 479),
        boat(-169.17, -66.67, 1.6, 5.88, 2.2, BoatKind::Llaut, 349),
        boat(-168.71, -59.36, 1.59, 5.93, 2.2, BoatKind::Llaut, 766),
        boat(-168.72, -53.45, 1.51, 5.49, 2.2, BoatKind::Llaut, 512),
        boat(-168.79, -47.17, 1.59, 5.0, 2.1, BoatKind::Inflatable, 977),
        boat(-168.81, -42.72, 1.62, 6.34, 2.2, BoatKind::Llaut, 394),
        boat(-169.18, -31.07, 1.52, 5.91, 2.2, BoatKind::Llaut, 655),
        boat(-168.98, -25.11, 1.62, 6.46, 2.2, BoatKind::Llaut, 372),
        boat(-169.17, -18.55, 1.6, 5.0, 2.1, BoatKind::Inflatable, 891),
        boat(-169.07, -12.7, 1.59, 6.32, 2.2, BoatKind::Llaut, 259),
        boat(-165.11, -5.44, 1.62, 13.0, 4.2, BoatKind::Trawler, 223),
        boat(-168.73, 2.08, 1.61, 6.45, 2.2, BoatKind::Llaut, 872),
        boat(-168.86, 8.78, 1.61, 6.46, 2.2, BoatKind::Llaut, 421),
        boat(-168.73, 23.64, 1.56, 5.0, 2.1, BoatKind::Inflatable, 921),
        // Alongside, inside the mole.
        boat(-187.5, 30.5, 1.57, 5.95, 2.2, BoatKind::Llaut, 804),
        boat(-178.93, 30.5, 1.57, 6.56, 2.2, BoatKind::Llaut, 846),
        boat(-170.44, 30.5, 4.71, 6.32, 2.2, BoatKind::Llaut, 741),
        boat(-162.17, 30.5, 1.57, 6.25, 2.2, BoatKind::Llaut, 656),
    ],
    sea: SeaState {
        // Rolling in from the south-west: against you off the point.
        direction: Some(2.5),
        spread: 0.25,
        shelter: &[
            // The harbour, behind its mole.
            Shelter {
                x: -135.0,
                z: -36.0,
                inner: 40.0,
                outer: 90.0,
                calm: 0.2,
            },
            // The arch, in the headland's lee.
            Shelter {
                x: 0.0,
                z: -90.0,
                inner: 36.0,
                outer: 99.0,
                calm: 0.35,
            },
            // The beach cove.
            Shelter {
                x: 117.0,
                z: -72.0,
                inner: 36.0,
                outer: 126.0,
                calm: 0.55,
            },
        ],
        ..SeaState::OPEN_SEA
    },
};

impl Course {
    /// Length of the centre line (one lap of a loop).
    pub fn length(&self) -> f32 {
        match &self.line {
            Line::Stadium(st) => st.length(),
            Line::Loop(c) => c.length(),
            Line::Run(run) => run.length(),
        }
    }

    /// Whether the line is a loop raced for laps (or an open run).
    pub fn looped(&self) -> bool {
        matches!(self.line, Line::Stadium(_) | Line::Loop(_))
    }

    /// Whether the course is on the water (a loop), or on the snow (a run).
    pub fn afloat(&self) -> bool {
        self.looped()
    }

    pub fn stadium(&self) -> Option<&Stadium> {
        match &self.line {
            Line::Stadium(st) => Some(st),
            Line::Loop(_) | Line::Run(_) => None,
        }
    }

    pub fn circuit(&self) -> Option<&'static Circuit> {
        match self.line {
            Line::Loop(c) => Some(c),
            Line::Stadium(_) | Line::Run(_) => None,
        }
    }

    pub fn run(&self) -> Option<&'static Run> {
        match self.line {
            Line::Stadium(_) | Line::Loop(_) => None,
            Line::Run(run) => Some(run),
        }
    }

    /// The sea this course is raced on (flat calm for courses on land).
    pub fn surface(&self, kind: SurfaceKind, seed: u32) -> Surface {
        match self.line {
            Line::Stadium(_) | Line::Loop(_) => Surface::with_sea(kind, seed, &self.sea),
            Line::Run(_) => Surface::flat(),
        }
    }

    /// The sea this course is raced on in some conditions. Only the sea as
    /// designed (`SurfaceKind::Swells`) follows them: flat, calm and rough
    /// seas (dev) stay as they are.
    pub fn surface_in(&self, kind: SurfaceKind, seed: u32, conditions: Conditions) -> Surface {
        match self.line {
            Line::Stadium(_) | Line::Loop(_) if kind == SurfaceKind::Swells => {
                let veer = Pcg32::new(u64::from(seed) ^ 0x0BEE_7000).range(-1.0, 1.0);
                Surface::turning(kind, seed, &self.sea, conditions.sea(veer))
            }
            _ => self.surface(kind, seed),
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
            Line::Loop(c) => c.centerline(self.wrap_s(s)),
            Line::Run(run) => run.centerline(s),
        }
    }

    /// Arc length and offset of the closest point on the centre line.
    pub fn project(&self, x: f32, z: f32) -> (f32, f32) {
        match &self.line {
            Line::Stadium(st) => st.project(x, z),
            Line::Loop(c) => c.project(x, z),
            Line::Run(run) => run.project(x, z),
        }
    }

    pub fn gate_count(&self) -> usize {
        match &self.line {
            Line::Stadium(_) | Line::Loop(_) => self.buoys.len() + 1,
            Line::Run(run) => run.checkpoints.len() + 2,
        }
    }

    pub fn gate(&self, i: usize) -> Gate {
        if i == 0 {
            return Gate::Start;
        }
        match &self.line {
            Line::Stadium(_) | Line::Loop(_) => Gate::Buoy(i - 1),
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

    /// Keeps a rider at `pos` heading `yaw` with velocity `vel` on the
    /// course: its body (see [`Sport::body`]) out of the breakwater, the
    /// land and the moored boats, clear of the sides of the ramps, inside
    /// the outer limit (on the cape, as far either side of the centre line),
    /// and (on a run) between its edges and clear of what stands on it.
    /// Returns the hardest impact (speed into the wall, m/s) on any contact.
    pub fn collide(
        &self,
        pos: &mut Vec3,
        vel: &mut Vec3,
        yaw: f32,
        surface: &Surface,
        tick: u32,
    ) -> Option<f32> {
        let radius = self.sport.rider_radius();
        let body = self.sport.body();
        let mut hit: Option<f32> = None;
        let mut note = |impact: f32| hit = Some(hit.map_or(impact, |h| h.max(impact)));
        match &self.line {
            Line::Stadium(st) => {
                let (d, nx, nz) = st.axis_distance(pos.x, pos.z);
                let outer = st.outer_limit - radius;
                if d > outer {
                    note(push(pos, vel, -nx, -nz, d - outer));
                }
                let axis = Segment::new((-st.straight_half, 0.0), (st.straight_half, 0.0));
                if let Some(i) = solid(pos, vel, yaw, body, axis, st.breakwater_radius) {
                    note(i);
                }
            }
            Line::Loop(c) => {
                let (s, offset) = c.project(pos.x, pos.z);
                let limit = c.limit - radius;
                if offset.abs() > limit {
                    let (rx, rz) = c.centerline(s).right();
                    let sign = if offset > 0.0 { -1.0 } else { 1.0 };
                    note(push(pos, vel, rx * sign, rz * sign, offset.abs() - limit));
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
                if let Some(impact) =
                    collide_obstacles(pos, vel, run.obstacles().iter().copied(), radius, false)
                {
                    note(impact);
                }
            }
        }

        for land in self.land {
            let spine = Segment::new(land.a, land.b);
            if let Some(i) = solid(pos, vel, yaw, body, spine, land.radius) {
                note(i);
            }
        }
        for b in self.boats {
            let (dx, dz) = (pos.x - b.x, pos.z - b.z);
            let reach = b.length * 0.5 + body.reach();
            if dx * dx + dz * dz >= reach * reach {
                continue;
            }
            let (hull, beam) = b.hull();
            if let Some(i) = solid(pos, vel, yaw, body, hull, beam) {
                note(i);
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

/// Keeps a rider's body (at `pos`, heading `yaw`) out of a solid capsule
/// round `spine`: moves it out the way the closest points of the two face
/// and bounces it off like a wall (see [`push`]). Returns the impact, if
/// they touch.
fn solid(
    pos: &mut Vec3,
    vel: &mut Vec3,
    yaw: f32,
    body: Body,
    spine: Segment,
    radius: f32,
) -> Option<f32> {
    let hull = body.segment(pos.x, pos.z, yaw);
    // Lying across the spine: out the way the rider's middle is from it.
    let middle = spine.closest_to(pos.x, pos.z);
    let across = apart(middle, (pos.x, pos.z), (0.0, 1.0));
    let (nx, nz, depth) = separate(&spine, &hull, radius + body.radius, (across.1, across.2))?;
    Some(push(pos, vel, nx, nz, depth))
}

/// Keeps a body of `radius` out of obstacles standing on a run (it slides
/// along them, or clears them in the air). Returns the hardest impact.
/// `rounded` obstacles (rocks through the snow) shed you without holding
/// you back: pressed against one, you slip round it.
pub fn collide_obstacles(
    pos: &mut Vec3,
    vel: &mut Vec3,
    obstacles: impl IntoIterator<Item = Obstacle>,
    radius: f32,
    rounded: bool,
) -> Option<f32> {
    let mut hit: Option<f32> = None;
    for o in obstacles {
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
            let impact = if rounded {
                glance(pos, vel, nx, nz, min - dist)
            } else {
                slide(pos, vel, nx, nz, min - dist)
            };
            hit = Some(hit.map_or(impact, |h: f32| h.max(impact)));
        }
    }
    hit
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

/// Moves a body out of something round and takes away the speed into it,
/// keeping the rest. Returns the speed into it.
fn glance(pos: &mut Vec3, vel: &mut Vec3, nx: f32, nz: f32, depth: f32) -> f32 {
    pos.x += nx * depth;
    pos.z += nz * depth;
    let vn = vel.x * nx + vel.z * nz;
    if vn >= 0.0 {
        return 0.0;
    }
    vel.x -= nx * vn;
    vel.z -= nz * vn;
    -vn
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
        for c in [&OVAL, &CAPE] {
            line_and_projection_agree(c);
        }
    }

    fn line_and_projection_agree(c: &Course) {
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
        for c in [&OVAL, &CAPE] {
            land_clear(c);
        }
    }

    fn land_clear(c: &Course) {
        for land in c.land {
            let (cx, cz) = land.a;
            let mut pos = Vec3::new(cx + 0.5, 0.0, cz + 0.5);
            let mut vel = Vec3::new(0.0, 0.0, -10.0);
            assert!(
                c.collide(&mut pos, &mut vel, 0.0, &Surface::flat(), 0)
                    .is_some()
            );
            let body = c.sport.body();
            let (on_hull, on_land) = body
                .segment(pos.x, pos.z, 0.0)
                .closest(&Segment::new(land.a, land.b));
            let gap = apart(on_land, on_hull, (0.0, 1.0)).0;
            assert!(gap >= land.radius + body.radius - 1e-3);
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
        for c in [&OVAL, &CAPE] {
            // In the order met after the start line.
            let mut last = 0.0;
            for b in c.buoys {
                let after = c.wrap_s(b.s - c.start_s);
                assert!(after > last && b.s < c.length());
                assert!(b.offset.abs() < c.lane_half);
                last = after;
            }
        }
    }

    #[test]
    fn the_cape_loops_without_kinks() {
        let c = &CAPE;
        let l = c.length();
        assert!((850.0..950.0).contains(&l), "{l}");
        // The line closes on itself, heading the same way.
        let a = c.centerline(0.0);
        let b = c.centerline(l - 0.01);
        assert!((a.x - b.x).abs() < 0.05 && (a.z - b.z).abs() < 0.05);
        assert!(crate::math::angle_diff(a.yaw, b.yaw).abs() < 0.01);
        // Its pieces meet without a step.
        let mut s = 0.0;
        while s < l {
            let f = c.centerline(s);
            let g = c.centerline(s + 0.5);
            assert!((f.x - g.x).hypot(f.z - g.z) < 0.51, "step at {s}");
            s += 0.5;
        }
    }

    #[test]
    fn the_arch_is_the_only_way_through_the_headland() {
        let c = &CAPE;
        let s = Surface::flat();
        // Riding straight through the arch, on the centre line or near its legs.
        for off in [-9.0, 0.0, 9.0] {
            let f = c.centerline(150.0);
            let (x, z) = f.at_offset(off);
            let mut pos = Vec3::new(x, 0.0, z);
            let mut vel = Vec3::new(20.0, 0.0, 0.0);
            assert!(c.collide(&mut pos, &mut vel, 0.0, &s, 0).is_none(), "{off}");
        }
        // Either side of the arch, the rock stops you.
        for z in [-120.0, -60.0] {
            let mut pos = Vec3::new(0.0, 0.0, z);
            let mut vel = Vec3::new(20.0, 0.0, 0.0);
            assert!(c.collide(&mut pos, &mut vel, 0.0, &s, 0).is_some(), "{z}");
        }
    }

    #[test]
    fn the_harbour_is_sheltered_and_the_point_is_not() {
        let sea = CAPE.surface(SurfaceKind::Swells, 3);
        let (harbour, _, _) = sea.exposure(-130.0, -30.0);
        let (point, _, _) = sea.exposure(20.0, 190.0);
        assert!(harbour < 0.3, "{harbour}");
        assert!((point - 1.0).abs() < 1e-6, "{point}");
        // The swell's slope matches its height, sheltered or not.
        for (x, z) in [
            (-130.0, -30.0),
            (-120.0, 30.0),
            (60.0, -80.0),
            (20.0, 190.0),
        ] {
            for tick in [0, 77, 400] {
                let h = 0.05;
                let a = sea.sample(x, z, tick);
                let dx = (sea.height(x + h, z, tick) - sea.height(x - h, z, tick)) / (2.0 * h);
                let dz = (sea.height(x, z + h, tick) - sea.height(x, z - h, tick)) / (2.0 * h);
                assert!(
                    (a.dhdx - dx).abs() < 0.02 && (a.dhdz - dz).abs() < 0.02,
                    "{x} {z} {tick}: {a:?} {dx} {dz}"
                );
                assert!((a.height - sea.height(x, z, tick)).abs() < 1e-5);
            }
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
        assert!(c.collide(&mut pos, &mut vel, 0.0, &s, 0).is_some());
        assert!(pos.z <= -(st.breakwater_radius + RIDER_RADIUS) + 1e-3);
        assert!(vel.z < 0.0);
        // And so does the outer limit.
        let mut pos = Vec3::new(0.0, 0.0, -100.0);
        let mut vel = Vec3::new(0.0, 0.0, -10.0);
        assert!(c.collide(&mut pos, &mut vel, 0.0, &s, 0).is_some());
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

    /// The gap between a rider's body at `(x, z)` heading `yaw` and a
    /// capsule round `spine`.
    fn gap(c: &Course, x: f32, z: f32, yaw: f32, spine: Segment, radius: f32) -> f32 {
        let body = c.sport.body();
        let (on_hull, on_spine) = body.segment(x, z, yaw).closest(&spine);
        apart(on_spine, on_hull, (0.0, 1.0)).0 - radius - body.radius
    }

    /// Every solid capsule on a course but the one at `except` (land, then boats).
    fn solids(c: &Course) -> Vec<(Segment, f32)> {
        let land = c.land.iter().map(|l| (Segment::new(l.a, l.b), l.radius));
        land.chain(c.boats.iter().map(BoatDef::hull)).collect()
    }

    #[test]
    fn moored_boats_and_jetties_are_solid() {
        for c in [&OVAL, &CAPE] {
            let all = solids(c);
            for (k, &(spine, radius)) in all.iter().enumerate() {
                let is_boat = k >= c.land.len();
                let jetty = !is_boat && c.land[k].kind == LandKind::Jetty;
                if !is_boat && !jetty {
                    continue;
                }
                let (dx, dz) = (spine.b.0 - spine.a.0, spine.b.1 - spine.a.1);
                let len = dx.hypot(dz).max(1e-3);
                let (fx, fz) = (dx / len, dz / len);
                let mid = spine.at(0.5);
                let mut tried = 0;
                // Nose first into its middle from either side, and into each end.
                for (ax, az, extent) in [
                    (-fz, fx, radius),
                    (fz, -fx, radius),
                    (fx, fz, len * 0.5 + radius),
                    (-fx, -fz, len * 0.5 + radius),
                ] {
                    let body = c.sport.body();
                    let back = extent + body.ahead + body.half + body.radius - 0.3;
                    let (x, z) = (mid.0 + ax * back, mid.1 + az * back);
                    let yaw = atan2(-ax, -az);
                    let others_clear = all
                        .iter()
                        .enumerate()
                        .all(|(j, &(o, r))| j == k || gap(c, x, z, yaw, o, r) > 0.5);
                    let inside = match &c.line {
                        Line::Stadium(st) => {
                            st.axis_distance(x, z).0 < st.outer_limit - RIDER_RADIUS
                        }
                        Line::Loop(l) => c.project(x, z).1.abs() < l.limit - RIDER_RADIUS,
                        Line::Run(_) => false,
                    };
                    if !others_clear || !inside {
                        continue;
                    }
                    tried += 1;
                    let mut pos = Vec3::new(x, 0.0, z);
                    let mut vel = Vec3::new(-ax * 12.0, 0.0, -az * 12.0);
                    let hit = c.collide(&mut pos, &mut vel, yaw, &Surface::flat(), 0);
                    assert!(hit.is_some_and(|h| h > 10.0), "solid {k}: {hit:?}");
                    assert!(
                        gap(c, pos.x, pos.z, yaw, spine, radius) > -1e-3,
                        "solid {k}"
                    );
                    assert!(vel.x * ax + vel.z * az >= 0.0, "solid {k} bounces");
                }
                // (Boats at anchor outside the course can't be reached.)
                let reachable = [spine.a, mid, spine.b].iter().any(|&(x, z)| match &c.line {
                    Line::Stadium(st) => st.axis_distance(x, z).0 < st.outer_limit,
                    _ => c.project(x, z).1.abs() < c.circuit().map_or(0.0, |l| l.limit),
                });
                assert!(tried > 0 || !reachable, "solid {k} can be ridden into");
            }
        }
    }

    #[test]
    fn moored_boats_and_jetties_leave_the_racing_line_clear() {
        for c in [&OVAL, &CAPE] {
            let all = solids(c);
            let moored: Vec<_> = all
                .iter()
                .enumerate()
                .filter(|&(k, _)| k >= c.land.len() || c.land[k].kind == LandKind::Jetty)
                .map(|(_, &solid)| solid)
                .collect();
            let clear = |x: f32, z: f32, what: &str| {
                for &(spine, radius) in &moored {
                    let (sx, sz) = spine.closest_to(x, z);
                    let d = (x - sx).hypot(z - sz) - radius;
                    assert!(d >= 8.0, "{what}: {d} m from a boat or jetty");
                }
            };
            let mut s = 0.0;
            while s < c.length() {
                let f = c.centerline(s);
                clear(f.x, f.z, &format!("centre line at {s}"));
                s += 1.0;
            }
            for (i, b) in c.buoys.iter().enumerate() {
                // Where riders pass it: 3 m out on its correct side.
                let side = match b.keep {
                    Keep::Right => -3.0,
                    Keep::Left => 3.0,
                };
                let (x, z) = c.centerline(b.s).at_offset(b.offset + side);
                clear(x, z, &format!("buoy {i}"));
            }
            for i in 0..c.ramps.len() {
                let (f, _) = c.ramp_frame(i, &Surface::flat(), 0);
                clear(f.x, f.z, &format!("ramp {i}"));
            }
        }
    }
}
