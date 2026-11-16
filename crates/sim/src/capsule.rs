//! Capsules in the horizontal plane: a segment (x, z) and a radius. A
//! rider's body (the hull or the board, along its heading), land and moored
//! boats are capsules; two of them touch when the closest points of their
//! segments are nearer than their two radii.

use crate::math::{clamp, sqrt};

/// A segment from `a` to `b` (world x, z). `a == b` is a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    pub a: (f32, f32),
    pub b: (f32, f32),
}

/// Below this squared length a segment counts as a point.
const POINT: f32 = 1e-8;

impl Segment {
    pub const fn new(a: (f32, f32), b: (f32, f32)) -> Self {
        Self { a, b }
    }

    /// A segment `half` metres either side of `(x, z)` along the heading
    /// `yaw` (as `sin`, `cos`), its middle `ahead` metres forward of `(x, z)`.
    pub fn along(x: f32, z: f32, (fx, fz): (f32, f32), ahead: f32, half: f32) -> Self {
        let (cx, cz) = (x + fx * ahead, z + fz * ahead);
        Self {
            a: (cx - fx * half, cz - fz * half),
            b: (cx + fx * half, cz + fz * half),
        }
    }

    /// The point `t` of the way from `a` to `b`.
    pub fn at(&self, t: f32) -> (f32, f32) {
        (
            self.a.0 + (self.b.0 - self.a.0) * t,
            self.a.1 + (self.b.1 - self.a.1) * t,
        )
    }

    /// The closest point of this segment to `(x, z)`.
    pub fn closest_to(&self, x: f32, z: f32) -> (f32, f32) {
        let (dx, dz) = (self.b.0 - self.a.0, self.b.1 - self.a.1);
        let len2 = dx * dx + dz * dz;
        if len2 <= POINT {
            return self.a;
        }
        self.at(clamp(
            ((x - self.a.0) * dx + (z - self.a.1) * dz) / len2,
            0.0,
            1.0,
        ))
    }

    /// The closest points of two segments: on this one, and on `other`.
    pub fn closest(&self, other: &Segment) -> ((f32, f32), (f32, f32)) {
        let d1 = (self.b.0 - self.a.0, self.b.1 - self.a.1);
        let d2 = (other.b.0 - other.a.0, other.b.1 - other.a.1);
        let r = (self.a.0 - other.a.0, self.a.1 - other.a.1);
        let a = d1.0 * d1.0 + d1.1 * d1.1;
        let e = d2.0 * d2.0 + d2.1 * d2.1;
        let f = d2.0 * r.0 + d2.1 * r.1;
        let (s, t) = if a <= POINT && e <= POINT {
            (0.0, 0.0)
        } else if a <= POINT {
            (0.0, clamp(f / e, 0.0, 1.0))
        } else {
            let c = d1.0 * r.0 + d1.1 * r.1;
            if e <= POINT {
                (clamp(-c / a, 0.0, 1.0), 0.0)
            } else {
                let b = d1.0 * d2.0 + d1.1 * d2.1;
                let denom = a * e - b * b;
                // Parallel segments: start from this one's first end.
                let s = if denom > POINT * a * e {
                    clamp((b * f - c * e) / denom, 0.0, 1.0)
                } else {
                    0.0
                };
                let t = (b * s + f) / e;
                if t < 0.0 {
                    (clamp(-c / a, 0.0, 1.0), 0.0)
                } else if t > 1.0 {
                    (clamp((b - c) / a, 0.0, 1.0), 1.0)
                } else {
                    (s, t)
                }
            }
        };
        (self.at(s), other.at(t))
    }
}

/// Which way, and how far, to move `q` out of `p` so the two segments are
/// `min` apart: a unit direction and a distance, or `None` when they
/// already are. Segments that (nearly) touch or cross, where the closest
/// points say little about the way out, come apart along `across` (a unit
/// direction), far enough to clear each other's ends.
pub fn separate(p: &Segment, q: &Segment, min: f32, across: (f32, f32)) -> Option<(f32, f32, f32)> {
    let (cp, cq) = p.closest(q);
    let (dx, dz) = (cq.0 - cp.0, cq.1 - cp.1);
    let dd = dx * dx + dz * dz;
    if dd >= min * min {
        return None;
    }
    let d = sqrt(dd);
    if d > min * 0.25 {
        return Some((dx / d, dz / d, min - d));
    }
    let (nx, nz) = across;
    let along = |(x, z): (f32, f32)| x * nx + z * nz;
    let far = along(p.a).max(along(p.b));
    let near = along(q.a).min(along(q.b));
    Some((nx, nz, far - near + min))
}

/// How far apart two points are, and the unit direction from `from` to
/// `to` (`fallback` when they are on top of each other).
pub fn apart(from: (f32, f32), to: (f32, f32), fallback: (f32, f32)) -> (f32, f32, f32) {
    let (dx, dz) = (to.0 - from.0, to.1 - from.1);
    let d = sqrt(dx * dx + dz * dz);
    if d > 1e-4 {
        (d, dx / d, dz / d)
    } else {
        (0.0, fallback.0, fallback.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gap(p: Segment, q: Segment) -> f32 {
        let (a, b) = p.closest(&q);
        apart(a, b, (1.0, 0.0)).0
    }

    #[test]
    fn closest_points_of_two_segments() {
        let a = Segment::new((0.0, -1.0), (0.0, 1.0));
        // Nose to tail, in line: the gap between the ends.
        assert!((gap(a, Segment::new((0.0, 3.0), (0.0, 5.0))) - 2.0).abs() < 1e-5);
        assert!((gap(Segment::new((0.0, 3.0), (0.0, 5.0)), a) - 2.0).abs() < 1e-5);
        // Side by side: the gap across.
        assert!((gap(a, Segment::new((1.5, -0.5), (1.5, 1.5))) - 1.5).abs() < 1e-5);
        // Crossing: they touch.
        assert!(gap(a, Segment::new((-1.0, 0.2), (1.0, 0.2))) < 1e-5);
        // A T: the end of one against the middle of the other.
        assert!((gap(a, Segment::new((0.7, 0.0), (3.0, 0.0))) - 0.7).abs() < 1e-5);
        // Points.
        let p = Segment::new((2.0, 0.5), (2.0, 0.5));
        assert!((gap(a, p) - 2.0).abs() < 1e-5);
        assert!((gap(p, a) - 2.0).abs() < 1e-5);
        assert!((gap(p, Segment::new((2.0, 2.5), (2.0, 2.5))) - 2.0).abs() < 1e-5);
        let (x, z) = a.closest_to(5.0, 0.3);
        assert!(x.abs() < 1e-6 && (z - 0.3).abs() < 1e-6);
        assert_eq!(a.closest_to(0.0, 9.0), (0.0, 1.0));
    }
}
