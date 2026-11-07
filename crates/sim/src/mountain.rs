//! The runs down the Costa Nevada mountain, and the snow they are ridden on.
//!
//! A run is data ([`Run`]): its centre line, widths, slope bands, valley,
//! what is built on it and what stands on it. One generator turns that into
//! one height function of position, the same on the server and on every
//! client:
//! - The slope falls toward +Z in bands: steep pitches, flatter benches and
//!   cliff bands. The run goes down the fall line (it crosses every Z once),
//!   so how fast it rides comes from where it goes.
//! - A valley follows the run: the mountain rises on both sides of it (or
//!   falls away, on a ridge), wide and gentle or close and steep as rock.
//! - Gentle noise rolls it, like any snowfield.
//!
//! The run is carved into it: a bench as wide as the run (level across,
//! banked in turns, dished in a bowl), with tables, rollers, lips and spines
//! on it and gullies dug into it. Over the run's walls the carving fades back
//! into the mountain, so a wall is as steep as the step it closes. Walls
//! always rise: where the mountain falls away beside the run, a berm holds
//! riders in.
//!
//! The centre line is built from pieces (straights and arcs joined
//! smoothly), so any position projects exactly onto `(s, offset)`.
//!
//! The runs: [`MOUNTAIN`] (the mountain run, from the summit to the village)
//! and [`glades::GLADES`] (the glades, from the ridge to the lake).

pub mod glades;

pub use glades::{GLADES, GLADES_RUN};

use std::sync::OnceLock;

use crate::course::{Course, Frame, Line, Sport};
use crate::math::{
    PI, Vec3, atan2, clamp, cos, sin, smoothstep, sqrt, value_noise, wrap_angle, wrap_pi,
};
use crate::surface::SeaState;

pub mod tuning {
    /// Banking: the run's cross slope per unit of curvature (rad/m), and its limit.
    pub const BANK_GAIN: f32 = 16.0;
    pub const MAX_BANK: f32 = 0.4;
    /// Curvature is averaged over this far either side, so banks ease in.
    pub const BANK_WINDOW: f32 = 14.0;
    /// The usual valley (see [`super::Valley`]): its floor this wide either
    /// side of the run (horizontally), then its sides rise, steepening toward
    /// `VALLEY_RISE` (rise per metre).
    pub const VALLEY_FLAT: f32 = 50.0;
    pub const VALLEY_RISE: f32 = 0.45;
    pub const VALLEY_SOFT: f32 = 60.0;
    /// Riders can ride this far up a wall (at most half of it).
    pub const WALL_RIDE: f32 = 3.0;
    /// The run's walls always rise at least this far above its edge: where
    /// the mountain falls away beside the run (a bench across a slope), a
    /// berm holds riders in, and fades into the slope over `BERM_FADE`.
    pub const BERM: f32 = 1.5;
    pub const BERM_FADE: f32 = 20.0;
    /// Step for terrain slopes (finite differences), metres.
    pub const SLOPE_STEP: f32 = 0.05;
    /// Points farther than this from every piece of the run are plain mountain.
    pub const REACH: f32 = 60.0;
}

use tuning::*;

/// A piece of the run's centre line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Piece {
    Straight(f32),
    /// An arc turning `degrees` (positive = left) at this radius.
    Turn {
        radius: f32,
        degrees: f32,
    },
}

/// The run's half width (groomed bench) and the width of the walls beside
/// it, from arc length `s` on (linear in between).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Width {
    pub s: f32,
    pub half: f32,
    pub wall: f32,
}

/// The mountain's fall-line slope (drop per metre of Z) where the run is at
/// arc length `s` (linear in between).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slope {
    pub s: f32,
    pub slope: f32,
}

/// The valley the run lies in, from arc length `s` on (linear in between,
/// placed in Z): its floor is level `flat` m either side of the centre line
/// (horizontally), then its sides rise, steepening toward `rise` per metre
/// over about `soft` m. A negative `rise` falls away: a ridge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Valley {
    pub s: f32,
    pub flat: f32,
    pub rise: f32,
    pub soft: f32,
}

/// What a natural lip is, for drawing it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LipKind {
    /// A wind lip: a drift with a sharp crest.
    Wind,
    /// A fallen log under the snow: round over the top.
    Log,
    /// A rock under the snow, its face kicking up.
    Rock,
}

/// Something built on (or dug into) the run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Feature {
    /// A table-top jump: up a ramp that steepens to the lip (`height` over
    /// `ramp` metres), a flat table, then a landing down to `dig` below the
    /// run and a runout back up to it over `recover`. Centred at `offset`, `half_width`
    /// either side, with sloped sides (infinite = the whole run).
    Table {
        s: f32,
        offset: f32,
        half_width: f32,
        height: f32,
        ramp: f32,
        table: f32,
        landing: f32,
        dig: f32,
        recover: f32,
    },
    /// `count` smooth bumps across the run, each `length` long.
    Rollers {
        s: f32,
        count: u32,
        length: f32,
        height: f32,
    },
    /// The run dug `depth` into the mountain from `s` for `length` metres,
    /// easing in and out over `ease`: a gully between its walls.
    Gully {
        s: f32,
        length: f32,
        depth: f32,
        ease: f32,
    },
    /// The run dished across from `s` for `length` metres (easing in and out
    /// over `ease`): its sides rise `depth` by the run's edges.
    Bowl {
        s: f32,
        length: f32,
        depth: f32,
        ease: f32,
    },
    /// A ridge down the run at `offset`, `height` at its sharp crest, its
    /// concave faces down to the run `half_width` either side. It rises from
    /// `s` over `ease`, runs `length` and sinks back over `ease`: ride across
    /// it and the crest throws you.
    Spine {
        s: f32,
        length: f32,
        ease: f32,
        offset: f32,
        half_width: f32,
        height: f32,
    },
    /// A natural lip across part of the run, centred at `offset`,
    /// `half_width` either side (sloped sides): the snow rises over `ramp`
    /// metres to a crest `height` up and falls back to the run over `fall`
    /// behind it. A wind lip or a rock kicks up to its crest; a log is round.
    Lip {
        s: f32,
        offset: f32,
        half_width: f32,
        height: f32,
        ramp: f32,
        fall: f32,
        kind: LipKind,
    },
}

/// What stands on the run. To the sim all of it is solid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObstacleKind {
    Pine,
    Rock,
    /// A chairlift tower.
    Tower,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ObstacleDef {
    pub s: f32,
    pub offset: f32,
    pub radius: f32,
    pub height: f32,
    pub kind: ObstacleKind,
}

/// An obstacle placed on the mountain: `y` is the ground at its foot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Obstacle {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub radius: f32,
    pub height: f32,
    pub kind: ObstacleKind,
}

#[derive(Debug)]
pub struct Run {
    /// Top of the centre line: x, z and heading.
    pub start: (f32, f32, f32),
    pub pieces: &'static [Piece],
    pub width: &'static [Width],
    /// Height of the mountain where the run starts.
    pub top: f32,
    pub slope: &'static [Slope],
    pub valley: &'static [Valley],
    pub features: &'static [Feature],
    /// Arc lengths of the checkpoints, in order.
    pub checkpoints: &'static [f32],
    pub finish_s: f32,
    pub obstacles: &'static [ObstacleDef],
    pub seed: u32,
    geometry: OnceLock<Geometry>,
    placed: OnceLock<Vec<Obstacle>>,
}

#[derive(Debug)]
enum SegKind {
    Straight {
        fx: f32,
        fz: f32,
    },
    Arc {
        radius: f32,
        sign: f32,
        cx: f32,
        cz: f32,
    },
}

/// One piece, placed.
#[derive(Debug)]
struct Seg {
    s0: f32,
    len: f32,
    x0: f32,
    z0: f32,
    /// Heading at the start, unwrapped along the run.
    yaw0: f32,
    kind: SegKind,
    min: (f32, f32),
    max: (f32, f32),
}

#[derive(Debug)]
struct Geometry {
    segs: Vec<Seg>,
    length: f32,
    /// The centre line's x on a regular grid in z (it crosses each z once).
    x_at_z: Vec<f32>,
    /// And its arc length, on the same grid.
    s_at_z: Vec<f32>,
    z_first: f32,
    /// Slope bands placed in z: `(z, slope, fall at z)`.
    bands: Vec<(f32, f32, f32)>,
}

const X_AT_Z_STEP: f32 = 2.0;

impl Seg {
    /// Position and unwrapped heading at `u` metres into the piece (straights
    /// extend past their ends).
    fn at(&self, u: f32) -> (f32, f32, f32) {
        match self.kind {
            SegKind::Straight { fx, fz } => (self.x0 + fx * u, self.z0 + fz * u, self.yaw0),
            SegKind::Arc {
                radius,
                sign,
                cx,
                cz,
            } => {
                let yaw = self.yaw0 + sign * u / radius;
                (
                    cx - sign * radius * cos(yaw),
                    cz + sign * radius * sin(yaw),
                    yaw,
                )
            }
        }
    }

    /// `(u, offset)` of a point relative to this piece.
    fn local(&self, x: f32, z: f32) -> Option<(f32, f32)> {
        match self.kind {
            SegKind::Straight { fx, fz } => {
                let dx = x - self.x0;
                let dz = z - self.z0;
                Some((dx * fx + dz * fz, -dx * fz + dz * fx))
            }
            SegKind::Arc {
                radius,
                sign,
                cx,
                cz,
            } => {
                let dx = x - cx;
                let dz = z - cz;
                let dist = sqrt(dx * dx + dz * dz);
                if dist < 1e-3 {
                    return None;
                }
                // The heading whose right-hand side points from the centre to here.
                let yaw = atan2(sign * dz, -sign * dx);
                let u = sign * wrap_pi(yaw - self.yaw0) * radius;
                Some((u, sign * (dist - radius)))
            }
        }
    }
}

impl Run {
    #[allow(clippy::too_many_arguments)]
    pub const fn new(
        start: (f32, f32, f32),
        pieces: &'static [Piece],
        width: &'static [Width],
        top: f32,
        slope: &'static [Slope],
        valley: &'static [Valley],
        features: &'static [Feature],
        checkpoints: &'static [f32],
        finish_s: f32,
        obstacles: &'static [ObstacleDef],
        seed: u32,
    ) -> Self {
        Self {
            start,
            pieces,
            width,
            top,
            slope,
            valley,
            features,
            checkpoints,
            finish_s,
            obstacles,
            seed,
            geometry: OnceLock::new(),
            placed: OnceLock::new(),
        }
    }

    fn geo(&self) -> &Geometry {
        self.geometry.get_or_init(|| self.build())
    }

    fn build(&self) -> Geometry {
        let (mut x, mut z, mut yaw) = self.start;
        let mut s = 0.0;
        let mut segs = Vec::with_capacity(self.pieces.len());
        for piece in self.pieces {
            let (len, kind) = match *piece {
                Piece::Straight(len) => (
                    len,
                    SegKind::Straight {
                        fx: sin(yaw),
                        fz: cos(yaw),
                    },
                ),
                Piece::Turn { radius, degrees } => {
                    let sign = if degrees >= 0.0 { 1.0 } else { -1.0 };
                    let angle = degrees.abs() * (PI / 180.0);
                    (
                        radius * angle,
                        SegKind::Arc {
                            radius,
                            sign,
                            cx: x + sign * radius * cos(yaw),
                            cz: z - sign * radius * sin(yaw),
                        },
                    )
                }
            };
            let mut seg = Seg {
                s0: s,
                len,
                x0: x,
                z0: z,
                yaw0: yaw,
                kind,
                min: (x, z),
                max: (x, z),
            };
            let steps = (len / 4.0) as u32 + 1;
            for i in 0..=steps {
                let (px, pz, _) = seg.at(len * i as f32 / steps as f32);
                seg.min = (seg.min.0.min(px), seg.min.1.min(pz));
                seg.max = (seg.max.0.max(px), seg.max.1.max(pz));
            }
            (x, z, yaw) = seg.at(len);
            s += len;
            segs.push(seg);
        }
        let mut geo = Geometry {
            segs,
            length: s,
            x_at_z: Vec::new(),
            s_at_z: Vec::new(),
            z_first: 0.0,
            bands: Vec::new(),
        };

        // The centre line's x (and arc length) by z, for the valley.
        let samples: Vec<(f32, f32)> = (0..=(geo.length as u32))
            .map(|i| {
                let (x, z, _) = geo.at(i as f32);
                (z, x)
            })
            .collect();
        geo.z_first = samples[0].0;
        let z_last = samples[samples.len() - 1].0;
        let n = ((z_last - geo.z_first) / X_AT_Z_STEP) as usize + 2;
        let mut j = 0;
        for i in 0..n {
            let zq = geo.z_first + i as f32 * X_AT_Z_STEP;
            while j + 2 < samples.len() && samples[j + 1].0 < zq {
                j += 1;
            }
            let (za, xa) = samples[j];
            let (zb, xb) = samples[j + 1];
            let t = if zb > za {
                clamp((zq - za) / (zb - za), 0.0, 1.0)
            } else {
                0.0
            };
            geo.x_at_z.push(xa + (xb - xa) * t);
            geo.s_at_z.push(j as f32 + t);
        }

        // Slope bands, placed in z, with the fall accumulated band by band.
        let mut fall = 0.0;
        for (i, b) in self.slope.iter().enumerate() {
            let (_, bz, _) = geo.at(b.s);
            if let Some(&(pz, pslope, pfall)) = geo.bands.last() {
                let dz = bz - pz;
                fall = pfall + (pslope + b.slope) * 0.5 * dz;
            } else {
                debug_assert_eq!(i, 0);
            }
            geo.bands.push((bz, b.slope, fall));
        }
        geo
    }

    pub fn length(&self) -> f32 {
        self.geo().length
    }

    pub fn centerline(&self, s: f32) -> Frame {
        let (x, z, yaw) = self.geo().at(s);
        Frame {
            x,
            z,
            yaw: wrap_angle(yaw),
        }
    }

    /// Heading of the centre line, unwrapped along the run.
    fn heading(&self, s: f32) -> f32 {
        self.geo().at(s).2
    }

    /// Arc length and offset (right of the direction of travel) of the
    /// closest point on the centre line. Points out of reach of the run get
    /// a huge offset.
    pub fn project(&self, x: f32, z: f32) -> (f32, f32) {
        let geo = self.geo();
        let last = geo.segs.len() - 1;
        let mut best = (0.0, f32::MAX);
        for (i, seg) in geo.segs.iter().enumerate() {
            if x < seg.min.0 - REACH
                || x > seg.max.0 + REACH
                || z < seg.min.1 - REACH
                || z > seg.max.1 + REACH
            {
                continue;
            }
            let Some((u, offset)) = seg.local(x, z) else {
                continue;
            };
            // The first and last pieces (straights) reach on past the ends.
            if (u < -0.01 && i != 0) || (u > seg.len + 0.01 && i != last) {
                continue;
            }
            if offset.abs() < best.1.abs() {
                best = (seg.s0 + u, offset);
            }
        }
        if best.1 == f32::MAX {
            best = (0.0, 1.0e6);
        }
        best
    }

    /// Half width and walls at `s`.
    pub fn width_at(&self, s: f32) -> Width {
        piecewise(
            self.width,
            s,
            |w| w.s,
            |a, b, t| Width {
                s,
                half: a.half + (b.half - a.half) * t,
                wall: a.wall + (b.wall - a.wall) * t,
            },
        )
    }

    /// How far from the centre line riders can go: the run plus a little way
    /// up its walls.
    pub fn limit(&self, s: f32) -> f32 {
        let w = self.width_at(s);
        w.half + (w.wall * 0.5).min(WALL_RIDE)
    }

    /// The valley where the run is at arc length `s`.
    pub fn valley_at(&self, s: f32) -> Valley {
        piecewise(
            self.valley,
            s,
            |v| v.s,
            |a, b, t| Valley {
                s,
                flat: a.flat + (b.flat - a.flat) * t,
                rise: a.rise + (b.rise - a.rise) * t,
                soft: a.soft + (b.soft - a.soft) * t,
            },
        )
    }

    /// The mountain without the run carved into it.
    pub fn mountain(&self, x: f32, z: f32) -> f32 {
        let geo = self.geo();
        let fall = geo.fall(z);
        let dx = (x - geo.x_at(z)).abs();
        let v = match self.valley {
            [one] => *one,
            _ => self.valley_at(geo.s_at(z)),
        };
        let d = (dx - v.flat).max(0.0);
        let valley = v.rise * d * d / (d + v.soft);
        let noise = 0.35 * value_noise(x * (1.0 / 34.0), z * (1.0 / 34.0), self.seed)
            + 0.12 * value_noise(x * (1.0 / 11.0), z * (1.0 / 11.0), self.seed ^ 0x9E37_79B9);
        self.top - fall + valley + noise
    }

    /// Cross slope of the run at `s` (rise per metre to the right): banked
    /// into turns, the outside higher.
    pub fn bank(&self, s: f32) -> f32 {
        let turn = self.heading(s + BANK_WINDOW) - self.heading(s - BANK_WINDOW);
        clamp(
            turn * (BANK_GAIN / (2.0 * BANK_WINDOW)),
            -MAX_BANK,
            MAX_BANK,
        )
    }

    /// Height of what is built on (or dug into) the run at `(s, offset)`.
    pub fn features_at(&self, s: f32, offset: f32) -> f32 {
        let mut h = 0.0;
        for f in self.features {
            h += match *f {
                Feature::Table {
                    s: s0,
                    offset: c,
                    half_width,
                    height,
                    ramp,
                    table,
                    landing,
                    dig,
                    recover,
                } => {
                    let u = s - s0;
                    if u <= 0.0 || u >= ramp + table + landing + recover {
                        continue;
                    }
                    let side = if half_width.is_finite() {
                        smoothstep(half_width + 2.0, half_width, (offset - c).abs())
                    } else {
                        1.0
                    };
                    let profile = if u < ramp {
                        let t = u / ramp;
                        height * t * t
                    } else if u < ramp + table {
                        height
                    } else if u < ramp + table + landing {
                        height - (height + dig) * smoothstep(0.0, landing, u - ramp - table)
                    } else {
                        // Back up to the run, concave all the way: it only
                        // ever presses you into the snow.
                        let t = 1.0 - (u - ramp - table - landing) / recover;
                        -dig * t * t
                    };
                    profile * side
                }
                Feature::Rollers {
                    s: s0,
                    count,
                    length,
                    height,
                } => {
                    let u = s - s0;
                    if u <= 0.0 || u >= length * count as f32 {
                        continue;
                    }
                    height * 0.5 * (1.0 - cos(u * (2.0 * PI / length)))
                }
                Feature::Gully {
                    s: s0,
                    length,
                    depth,
                    ease,
                } => {
                    let open = smoothstep(s0 - ease, s0, s)
                        * smoothstep(s0 + length + ease, s0 + length, s);
                    -depth * open
                }
                Feature::Bowl {
                    s: s0,
                    length,
                    depth,
                    ease,
                } => {
                    let open = smoothstep(s0 - ease, s0, s)
                        * smoothstep(s0 + length + ease, s0 + length, s);
                    if open <= 0.0 {
                        continue;
                    }
                    let k = offset / self.width_at(s).half;
                    depth * k * k * open
                }
                Feature::Spine {
                    s: s0,
                    length,
                    ease,
                    offset: c,
                    half_width,
                    height,
                } => {
                    let t = 1.0 - (offset - c).abs() / half_width;
                    if t <= 0.0 {
                        continue;
                    }
                    let open = smoothstep(s0, s0 + ease, s)
                        * smoothstep(s0 + length + 2.0 * ease, s0 + length + ease, s);
                    height * t * t * open
                }
                Feature::Lip {
                    s: s0,
                    offset: c,
                    half_width,
                    height,
                    ramp,
                    fall,
                    kind,
                } => {
                    let u = s - s0;
                    if u <= 0.0 || u >= ramp + fall {
                        continue;
                    }
                    let side = smoothstep(half_width + 2.0, half_width, (offset - c).abs());
                    let profile = if u < ramp {
                        match kind {
                            LipKind::Log => height * smoothstep(0.0, ramp, u),
                            LipKind::Wind | LipKind::Rock => {
                                let t = u / ramp;
                                height * t * t
                            }
                        }
                    } else {
                        height * (1.0 - smoothstep(0.0, fall, u - ramp))
                    };
                    profile * side
                }
            };
        }
        h
    }

    /// Height of the snow at `(x, z)`.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let m = self.mountain(x, z);
        let (s, offset) = self.project(x, z);
        let w = self.width_at(s);
        let edge = w.half + w.wall;
        let a = offset.abs();
        if a >= edge + BERM_FADE {
            return m;
        }
        let c = self.centerline(s);
        let bench = self.mountain(c.x, c.z);
        let side = clamp(offset, -w.half, w.half);
        let lip = bench + self.bank(s) * side + self.features_at(s, side);
        let wall_top = m.max(lip + BERM);
        if a >= edge {
            return m + (wall_top - m) * smoothstep(edge + BERM_FADE, edge, a);
        }
        let run = bench + self.bank(s) * side + self.features_at(s, offset);
        run + (wall_top - run) * smoothstep(w.half, edge, a)
    }

    /// Height and unit normal of the snow at `(x, z)`.
    pub fn sample(&self, x: f32, z: f32) -> (f32, Vec3) {
        let h = self.height(x, z);
        let hx = self.height(x + SLOPE_STEP, z);
        let hz = self.height(x, z + SLOPE_STEP);
        let n = Vec3::new(-(hx - h) / SLOPE_STEP, 1.0, -(hz - h) / SLOPE_STEP);
        (h, n.normalize_or(Vec3::UP))
    }

    /// The obstacles, placed on the snow.
    pub fn obstacles(&self) -> &[Obstacle] {
        self.placed.get_or_init(|| {
            self.obstacles
                .iter()
                .map(|o| {
                    let (x, z) = self.centerline(o.s).at_offset(o.offset);
                    Obstacle {
                        x,
                        y: self.height(x, z),
                        z,
                        radius: o.radius,
                        height: o.height,
                        kind: o.kind,
                    }
                })
                .collect()
        })
    }
}

impl Geometry {
    fn seg(&self, s: f32) -> &Seg {
        let i = self.segs.partition_point(|g| g.s0 <= s);
        &self.segs[i.max(1) - 1]
    }

    fn at(&self, s: f32) -> (f32, f32, f32) {
        let seg = self.seg(s);
        seg.at(s - seg.s0)
    }

    fn x_at(&self, z: f32) -> f32 {
        self.by_z(&self.x_at_z, z)
    }

    fn s_at(&self, z: f32) -> f32 {
        self.by_z(&self.s_at_z, z)
    }

    /// A table on the grid in z, at `z` (clamped at both ends).
    fn by_z(&self, table: &[f32], z: f32) -> f32 {
        let f = (z - self.z_first) / X_AT_Z_STEP;
        let n = table.len();
        if f <= 0.0 {
            return table[0];
        }
        let i = f as usize;
        if i + 1 >= n {
            return table[n - 1];
        }
        let t = f - i as f32;
        table[i] + (table[i + 1] - table[i]) * t
    }

    /// How far the mountain has fallen from the top at `z` (the slope bands
    /// integrated, with the slope linear in between).
    fn fall(&self, z: f32) -> f32 {
        let b = &self.bands;
        let i = b.partition_point(|band| band.0 <= z);
        if i == 0 {
            let (z0, slope0, fall0) = b[0];
            return fall0 + slope0 * (z - z0);
        }
        let (za, sa, fa) = b[i - 1];
        if i == b.len() {
            return fa + sa * (z - za);
        }
        let (zb, sb, _) = b[i];
        let dz = z - za;
        let k = if zb > za { (sb - sa) / (zb - za) } else { 0.0 };
        fa + sa * dz + 0.5 * k * dz * dz
    }
}

/// Linear interpolation in a table keyed by `key`, clamped at both ends.
fn piecewise<T: Copy, R>(
    table: &[T],
    s: f32,
    key: impl Fn(&T) -> f32,
    lerp: impl Fn(T, T, f32) -> R,
) -> R {
    let i = table.partition_point(|e| key(e) <= s);
    if i == 0 {
        return lerp(table[0], table[0], 0.0);
    }
    if i == table.len() {
        let last = table[table.len() - 1];
        return lerp(last, last, 0.0);
    }
    let (a, b) = (table[i - 1], table[i]);
    let span = key(&b) - key(&a);
    let t = if span > 0.0 {
        (s - key(&a)) / span
    } else {
        0.0
    };
    lerp(a, b, t)
}

const fn w(s: f32, half: f32, wall: f32) -> Width {
    Width { s, half, wall }
}

const fn slope(s: f32, slope: f32) -> Slope {
    Slope { s, slope }
}

const fn valley(s: f32, flat: f32, rise: f32, soft: f32) -> Valley {
    Valley {
        s,
        flat,
        rise,
        soft,
    }
}

const fn pine(s: f32, offset: f32) -> ObstacleDef {
    ObstacleDef {
        s,
        offset,
        radius: 0.7,
        height: 12.0,
        kind: ObstacleKind::Pine,
    }
}

const fn tower(s: f32, offset: f32) -> ObstacleDef {
    ObstacleDef {
        s,
        offset,
        radius: 0.6,
        height: 14.0,
        kind: ObstacleKind::Tower,
    }
}

const fn rock(s: f32, offset: f32, radius: f32) -> ObstacleDef {
    ObstacleDef {
        s,
        offset,
        radius,
        height: radius * 1.2,
        kind: ObstacleKind::Rock,
    }
}

const fn turn(radius: f32, degrees: f32) -> Piece {
    Piece::Turn { radius, degrees }
}

/// The mountain run: ~2 km from the summit lift station down to the village.
/// A flat start, a steep start ramp onto a wide open slope (sweeping turns,
/// rollers, a big table), tree-lined S-turns past the chairlift, a bench
/// that ends in a cliff drop, a winding gully, more open slope with side
/// kickers and a second table, and a final pitch to the finish.
pub static RUN: Run = Run::new(
    (0.0, 0.0, 0.0),
    &[
        Piece::Straight(70.0),
        turn(140.0, 20.0),
        Piece::Straight(60.0),
        turn(120.0, -45.0),
        Piece::Straight(50.0),
        turn(110.0, 45.0),
        Piece::Straight(70.0),
        turn(150.0, 30.0),
        Piece::Straight(90.0),
        turn(150.0, -30.0),
        turn(80.0, -55.0),
        turn(80.0, 60.0),
        turn(80.0, -25.0),
        Piece::Straight(115.0),
        Piece::Straight(70.0),
        turn(70.0, 35.0),
        turn(60.0, -60.0),
        turn(60.0, 55.0),
        turn(60.0, -40.0),
        Piece::Straight(60.0),
        turn(130.0, 25.0),
        Piece::Straight(110.0),
        turn(120.0, -40.0),
        Piece::Straight(60.0),
        turn(110.0, 40.0),
        Piece::Straight(120.0),
        turn(150.0, -15.0),
        Piece::Straight(260.0),
    ],
    &[
        w(0.0, 11.0, 6.0),
        w(60.0, 16.0, 8.0),
        w(120.0, 20.0, 10.0),
        w(700.0, 20.0, 10.0),
        w(730.0, 13.0, 8.0),
        w(960.0, 13.0, 8.0),
        w(990.0, 15.0, 8.0),
        w(1100.0, 15.0, 8.0),
        w(1120.0, 8.0, 9.0),
        w(1350.0, 8.0, 9.0),
        w(1380.0, 18.0, 10.0),
        w(1750.0, 20.0, 10.0),
        w(2150.0, 25.0, 10.0),
    ],
    420.0,
    &[
        slope(0.0, 0.04),
        slope(40.0, 0.04),
        slope(48.0, 0.55),
        slope(85.0, 0.55),
        slope(100.0, 0.32),
        slope(1000.0, 0.30),
        slope(1030.0, 0.10),
        slope(1060.0, 0.10),
        slope(1062.0, 1.10),
        slope(1068.0, 1.10),
        slope(1070.0, 0.45),
        slope(1100.0, 0.45),
        slope(1120.0, 0.26),
        slope(1700.0, 0.30),
        slope(1720.0, 0.36),
        slope(1950.0, 0.36),
        slope(2000.0, 0.15),
        slope(2050.0, 0.04),
        slope(2150.0, -0.15),
    ],
    &[valley(0.0, VALLEY_FLAT, VALLEY_RISE, VALLEY_SOFT)],
    &[
        Feature::Table {
            s: 262.0,
            offset: 0.0,
            half_width: f32::INFINITY,
            height: 1.4,
            ramp: 8.0,
            table: 4.0,
            landing: 40.0,
            dig: 3.5,
            recover: 16.0,
        },
        Feature::Rollers {
            s: 412.0,
            count: 4,
            length: 18.0,
            height: 0.8,
        },
        Feature::Gully {
            s: 1135.0,
            length: 210.0,
            depth: 5.0,
            ease: 50.0,
        },
        Feature::Rollers {
            s: 1440.0,
            count: 4,
            length: 18.0,
            height: 0.8,
        },
        Feature::Table {
            s: 1520.0,
            offset: -9.0,
            half_width: 4.0,
            height: 1.2,
            ramp: 6.0,
            table: 2.0,
            landing: 14.0,
            dig: 1.0,
            recover: 8.0,
        },
        Feature::Table {
            s: 1620.0,
            offset: 0.0,
            half_width: f32::INFINITY,
            height: 1.8,
            ramp: 9.0,
            table: 5.0,
            landing: 42.0,
            dig: 4.0,
            recover: 18.0,
        },
        Feature::Table {
            s: 1800.0,
            offset: 8.0,
            half_width: 4.0,
            height: 1.2,
            ramp: 6.0,
            table: 2.0,
            landing: 14.0,
            dig: 1.0,
            recover: 8.0,
        },
        Feature::Table {
            s: 1870.0,
            offset: -8.0,
            half_width: 4.0,
            height: 1.2,
            ramp: 6.0,
            table: 2.0,
            landing: 14.0,
            dig: 1.0,
            recover: 8.0,
        },
    ],
    &[250.0, 520.0, 800.0, 1050.0, 1290.0, 1560.0, 1850.0],
    2050.0,
    &[
        // Chairlift towers up the open slope.
        tower(380.0, 15.0),
        tower(480.0, 14.0),
        tower(580.0, 15.0),
        tower(680.0, 14.0),
        // Lone pines in the tree section.
        pine(760.0, 9.5),
        pine(812.0, -10.0),
        pine(866.0, 8.0),
        pine(915.0, -9.0),
        pine(940.0, 10.5),
        // Rocks along the open slopes.
        rock(1400.0, 14.0, 1.5),
        rock(1700.0, -15.0, 1.8),
        rock(1760.0, 16.0, 1.2),
    ],
    0x5_EA50,
);

/// The mountain run, raced once from the top.
pub static MOUNTAIN: Course = Course {
    sport: Sport::Snowboard,
    line: Line::Run(&RUN),
    lane_half: 8.0,
    laps: 1,
    start_s: 40.0,
    buoys: &[],
    ramps: &[],
    land: &[],
    sea: SeaState::OPEN_SEA,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::angle_diff;

    const RUNS: [&Run; 2] = [&RUN, &GLADES_RUN];

    #[test]
    fn centre_line_and_projection_agree() {
        for run in RUNS {
            centre_line_and_projection_agree_on(run);
        }
    }

    fn centre_line_and_projection_agree_on(run: &Run) {
        let mut s = 0.5;
        while s < run.length() {
            let f = run.centerline(s);
            for off in [-18.0, -5.0, 0.0, 7.0, 20.0] {
                let (x, z) = f.at_offset(off);
                let (ps, po) = run.project(x, z);
                assert!((ps - s).abs() < 0.02, "s {s} off {off} -> {ps}");
                assert!((po - off).abs() < 0.02, "s {s} off {off} -> {po}");
            }
            let g = run.centerline(s + 0.05);
            let heading = atan2(g.x - f.x, g.z - f.z);
            assert!(angle_diff(f.yaw, heading).abs() < 0.01, "s {s}");
            s += 3.7;
        }
    }

    #[test]
    fn the_run_always_goes_downhill_and_crosses_each_z_once() {
        for run in RUNS {
            goes_downhill(run);
        }
    }

    fn goes_downhill(run: &Run) {
        let mut last_z = f32::MIN;
        let mut s = 0.0;
        while s < run.length() {
            let f = run.centerline(s);
            assert!(f.z > last_z, "s {s}");
            last_z = f.z;
            s += 1.0;
        }
        assert!(matches!(run.pieces[0], Piece::Straight(_)));
        assert!(matches!(
            run.pieces[run.pieces.len() - 1],
            Piece::Straight(_)
        ));
    }

    #[test]
    fn the_snow_is_continuous() {
        for run in RUNS {
            continuous(run);
        }
    }

    /// Walk across and along the run in small steps: no steps in the snow.
    /// Where riders go, nothing steeper than a gully wall; beyond, walls may
    /// be steeper.
    fn continuous(run: &Run) {
        let mut s = 0.0;
        while s < run.length() {
            let f = run.centerline(s);
            let (rx, rz) = f.right();
            let ride = run.limit(s);
            let mut prev: Option<f32> = None;
            let mut off = -45.0;
            while off <= 45.0 {
                let (x, z) = (f.x + rx * off, f.z + rz * off);
                let h = run.height(x, z);
                let steepest = if off.abs() <= ride { 1.6 } else { 3.0 };
                if let Some(p) = prev {
                    assert!(
                        (h - p).abs() < 0.25 * steepest,
                        "s {s} off {off}: {p} -> {h}"
                    );
                }
                prev = Some(h);
                off += 0.25;
            }
            s += 9.0;
        }
        let mut prev = run.height(0.0, -10.0);
        let mut s = -10.0;
        while s < run.length() + 20.0 {
            let f = run.centerline(s);
            let h = run.height(f.x, f.z);
            assert!((h - prev).abs() < 0.1 * 1.5, "s {s}: {prev} -> {h}");
            prev = h;
            s += 0.1;
        }
    }

    #[test]
    fn turns_are_banked_toward_the_inside() {
        let run = &RUN;
        // The second piece turns left: the right side (outside) is higher.
        let s = 95.0;
        assert!(run.bank(s) > 0.05, "{}", run.bank(s));
        let f = run.centerline(s);
        let (lx, lz) = f.at_offset(-8.0);
        let (rx, rz) = f.at_offset(8.0);
        assert!(run.height(rx, rz) > run.height(lx, lz));
    }

    /// Every height, bank and limit of a run on a dense sample (along it,
    /// across it and far around it), and its obstacles, hashed bit for bit.
    fn fingerprint(run: &Run) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: f32| {
            h ^= u64::from(v.to_bits());
            h = h.wrapping_mul(0x0100_0000_01b3);
        };
        let mut s = -20.0;
        while s < run.length() + 40.0 {
            let f = run.centerline(s);
            let mut off = -70.0;
            while off <= 70.0 {
                let (x, z) = f.at_offset(off);
                mix(run.height(x, z));
                off += 1.7;
            }
            mix(run.bank(s));
            mix(run.limit(s));
            s += 2.3;
        }
        for i in 0..60 {
            for j in 0..60 {
                mix(run.height(-600.0 + i as f32 * 20.0, -300.0 + j as f32 * 45.0));
            }
        }
        for o in run.obstacles() {
            for v in [o.x, o.y, o.z, o.radius, o.height] {
                mix(v);
            }
        }
        h
    }

    #[test]
    fn the_first_run_never_changes() {
        assert_eq!(fingerprint(&RUN), 0xaedb_f188_b704_ade5);
    }

    #[test]
    fn obstacles_stand_inside_the_run() {
        for run in RUNS {
            for o in run.obstacles() {
                let (s, off) = run.project(o.x, o.z);
                assert!(off.abs() < run.limit(s), "{o:?}");
            }
            assert_eq!(run.obstacles().len(), run.obstacles.len());
        }
    }

    #[test]
    fn checkpoints_are_in_order_on_the_run() {
        for run in RUNS {
            let mut last = 0.0;
            for &c in run.checkpoints {
                assert!(c > last, "{c}");
                last = c;
            }
            assert!(run.finish_s > last && run.finish_s + 80.0 < run.length());
        }
    }

    #[test]
    fn the_glades_have_their_sections() {
        let run = &GLADES_RUN;
        // A steep couloir, narrow between rock walls.
        let pitch = |s: f32| {
            let a = run.centerline(s - 3.0);
            let b = run.centerline(s + 3.0);
            (run.height(a.x, a.z) - run.height(b.x, b.z)) / 6.0
        };
        assert!(pitch(100.0) > 0.6, "{}", pitch(100.0));
        assert!(run.width_at(100.0).half < 8.0);
        let f = run.centerline(100.0);
        let (wx, wz) = f.at_offset(run.width_at(100.0).half + 5.0);
        assert!(run.height(wx, wz) > run.height(f.x, f.z) + 4.0);
        // A wide bowl whose sides rise.
        assert!(run.width_at(400.0).half > 20.0);
        let f = run.centerline(300.0);
        let (sx, sz) = f.at_offset(-20.0);
        assert!(run.height(sx, sz) > run.height(f.x, f.z) + 1.5);
        // Pines in the glades.
        let pines = run
            .obstacles
            .iter()
            .filter(|o| o.kind == ObstacleKind::Pine && (640.0..1200.0).contains(&o.s))
            .count();
        assert!(pines > 12, "{pines}");
        // The spine stands proud of the bowl.
        let f = run.centerline(420.0);
        let (sx, sz) = f.at_offset(-2.0);
        let (ox, oz) = f.at_offset(-12.0);
        assert!(run.height(sx, sz) > run.height(ox, oz) + 1.0);
    }
}
