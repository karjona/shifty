//! A looped course of any shape on the water: a polygon of corners, each
//! rounded off by an arc of its own radius, so the centre line is straights
//! and arcs that meet without a kink. Raced for laps, like the oval.
//!
//! The centre line starts at the end of the arc round the first corner and
//! runs on toward the second one. Arc length `s` and `offset` follow the
//! same conventions as every course (offset positive to the right of the
//! direction of travel).

use std::sync::OnceLock;

use crate::course::Frame;
use crate::math::{atan2, clamp, cos, sin, sqrt, wrap_angle, wrap_pi};

/// A corner of the polygon and the radius it is rounded off with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Corner {
    pub x: f32,
    pub z: f32,
    pub radius: f32,
}

#[derive(Debug)]
pub struct Circuit {
    pub corners: &'static [Corner],
    /// How far from the centre line riders can go, either side.
    pub limit: f32,
    geometry: OnceLock<Geometry>,
}

#[derive(Debug)]
enum Kind {
    Straight,
    /// Turning right (`sign = -1`, yaw falls) or left (`sign = 1`) round `(cx, cz)`.
    Arc {
        radius: f32,
        sign: f32,
        cx: f32,
        cz: f32,
    },
}

/// One piece of the centre line, placed.
#[derive(Debug)]
struct Seg {
    s0: f32,
    len: f32,
    x0: f32,
    z0: f32,
    yaw0: f32,
    kind: Kind,
    min: (f32, f32),
    max: (f32, f32),
}

#[derive(Debug)]
struct Geometry {
    segs: Vec<Seg>,
    length: f32,
}

/// Points farther than this from a piece's bounds never project onto it.
const REACH: f32 = 80.0;

impl Seg {
    /// Position and heading at `u` metres into the piece.
    fn at(&self, u: f32) -> (f32, f32, f32) {
        match self.kind {
            Kind::Straight => (
                self.x0 + sin(self.yaw0) * u,
                self.z0 + cos(self.yaw0) * u,
                self.yaw0,
            ),
            Kind::Arc {
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

    /// `(u, offset, distance)` of the closest point of this piece to `(x, z)`.
    fn closest(&self, x: f32, z: f32) -> (f32, f32, f32) {
        match self.kind {
            Kind::Straight => {
                let (fx, fz) = (sin(self.yaw0), cos(self.yaw0));
                let dx = x - self.x0;
                let dz = z - self.z0;
                let u = clamp(dx * fx + dz * fz, 0.0, self.len);
                let ex = dx - fx * u;
                let ez = dz - fz * u;
                // Right of the direction of travel: (-fz, fx).
                let offset = -ex * fz + ez * fx;
                (u, offset, sqrt(ex * ex + ez * ez))
            }
            Kind::Arc {
                radius,
                sign,
                cx,
                cz,
            } => {
                let dx = x - cx;
                let dz = z - cz;
                let dist = sqrt(dx * dx + dz * dz);
                // The heading whose right-hand side points from the centre here.
                let yaw = atan2(sign * dz, -sign * dx);
                let along = sign * wrap_pi(yaw - self.yaw0) * radius;
                let u = clamp(along, 0.0, self.len);
                if u == along {
                    let d = dist - radius;
                    (u, sign * d, d.abs())
                } else {
                    let (px, pz, pyaw) = self.at(u);
                    let ex = x - px;
                    let ez = z - pz;
                    let offset = -ex * cos(pyaw) + ez * sin(pyaw);
                    (u, offset, sqrt(ex * ex + ez * ez))
                }
            }
        }
    }
}

impl Circuit {
    pub const fn new(corners: &'static [Corner], limit: f32) -> Self {
        Self {
            corners,
            limit,
            geometry: OnceLock::new(),
        }
    }

    fn geo(&self) -> &Geometry {
        self.geometry.get_or_init(|| self.build())
    }

    fn build(&self) -> Geometry {
        let n = self.corners.len();
        let heading = |a: &Corner, b: &Corner| atan2(b.x - a.x, b.z - a.z);
        // Each corner's arc: where it starts, its heading in and its turn.
        let arcs: Vec<(f32, f32, f32, f32, f32)> = (0..n)
            .map(|i| {
                let c = &self.corners[i];
                let prev = &self.corners[(i + n - 1) % n];
                let next = &self.corners[(i + 1) % n];
                let yaw_in = heading(prev, c);
                let turn = wrap_pi(heading(c, next) - yaw_in);
                let half = turn.abs() * 0.5;
                let t = c.radius * sin(half) / cos(half);
                (
                    c.x - sin(yaw_in) * t,
                    c.z - cos(yaw_in) * t,
                    yaw_in,
                    turn,
                    t,
                )
            })
            .collect();
        let mut segs = Vec::with_capacity(n * 2);
        let mut s = 0.0;
        let mut push = |mut seg: Seg, s: &mut f32| {
            seg.s0 = *s;
            let steps = (seg.len / 4.0) as u32 + 1;
            seg.min = (seg.x0, seg.z0);
            seg.max = (seg.x0, seg.z0);
            for i in 0..=steps {
                let (px, pz, _) = seg.at(seg.len * i as f32 / steps as f32);
                seg.min = (seg.min.0.min(px), seg.min.1.min(pz));
                seg.max = (seg.max.0.max(px), seg.max.1.max(pz));
            }
            *s += seg.len;
            segs.push(seg);
        };
        for i in 0..n {
            let (x0, z0, yaw_in, turn, t) = arcs[i];
            let c = &self.corners[i];
            let sign = if turn >= 0.0 { 1.0 } else { -1.0 };
            let arc = Seg {
                s0: 0.0,
                len: c.radius * turn.abs(),
                x0,
                z0,
                yaw0: yaw_in,
                kind: Kind::Arc {
                    radius: c.radius,
                    sign,
                    cx: x0 + sign * c.radius * cos(yaw_in),
                    cz: z0 - sign * c.radius * sin(yaw_in),
                },
                min: (0.0, 0.0),
                max: (0.0, 0.0),
            };
            let yaw_out = yaw_in + turn;
            let (ex, ez) = (c.x + sin(yaw_out) * t, c.z + cos(yaw_out) * t);
            push(arc, &mut s);
            let (nx, nz, _, _, _) = arcs[(i + 1) % n];
            let len = sqrt((nx - ex) * (nx - ex) + (nz - ez) * (nz - ez));
            let straight = Seg {
                s0: 0.0,
                len,
                x0: ex,
                z0: ez,
                yaw0: yaw_out,
                kind: Kind::Straight,
                min: (0.0, 0.0),
                max: (0.0, 0.0),
            };
            push(straight, &mut s);
        }
        Geometry { segs, length: s }
    }

    pub fn length(&self) -> f32 {
        self.geo().length
    }

    /// The centre line at `s`, already wrapped into one lap.
    pub fn centerline(&self, s: f32) -> Frame {
        let geo = self.geo();
        let i = geo
            .segs
            .partition_point(|seg| seg.s0 <= s)
            .saturating_sub(1);
        let seg = &geo.segs[i];
        let (x, z, yaw) = seg.at(clamp(s - seg.s0, 0.0, seg.len));
        Frame {
            x,
            z,
            yaw: wrap_angle(yaw),
        }
    }

    /// Arc length and offset of the closest point on the centre line.
    pub fn project(&self, x: f32, z: f32) -> (f32, f32) {
        let geo = self.geo();
        let mut best = (0.0, 0.0, f32::MAX);
        for seg in &geo.segs {
            if x < seg.min.0 - REACH
                || x > seg.max.0 + REACH
                || z < seg.min.1 - REACH
                || z > seg.max.1 + REACH
            {
                continue;
            }
            let (u, offset, dist) = seg.closest(x, z);
            if dist < best.2 {
                best = (seg.s0 + u, offset, dist);
            }
        }
        if best.2 == f32::MAX {
            // Far off the course: the nearest piece by its start.
            for seg in &geo.segs {
                let (u, offset, dist) = seg.closest(x, z);
                if dist < best.2 {
                    best = (seg.s0 + u, offset, dist);
                }
            }
        }
        let s = if best.0 >= geo.length { 0.0 } else { best.0 };
        (s, best.1)
    }

    /// How sharply the centre line turns at `s` (1 / radius, positive to the
    /// right; 0 on a straight).
    pub fn curvature(&self, s: f32) -> f32 {
        let geo = self.geo();
        let i = geo
            .segs
            .partition_point(|seg| seg.s0 <= s)
            .saturating_sub(1);
        match geo.segs[i].kind {
            Kind::Straight => 0.0,
            Kind::Arc { radius, sign, .. } => -sign / radius,
        }
    }
}
