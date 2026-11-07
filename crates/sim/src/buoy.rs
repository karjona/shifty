//! Buoys: tall inflatable marks, anchored to the seabed.
//!
//! A buoy gives way: ride into one and it is shoved aside or under the hull.
//! It never stops you dead or throws you off; it squeezes you out to the
//! side you hit it on and drags at the hull while you plough through it, so
//! a hit costs some speed and a deflection. The hull turns with its new
//! path, so a hit in the air still lands straight.
//!
//! In the sim a buoy stays on its anchor; how it swings and bobs is drawn
//! by the client from where the riders are.

use crate::DT;
use crate::course::Course;
use crate::math::{angle_diff, atan2, sqrt, wrap_angle};
use crate::surface::Surface;
use crate::world::Rider;

pub mod tuning {
    /// Radius of a buoy at the water line.
    pub const RADIUS: f32 = 0.85;
    /// Height of a buoy's top above the water: riders higher than that clear it.
    pub const HEIGHT: f32 = 2.6;
    /// Sideways push at full overlap (m/s²), out to the side the rider is on.
    pub const SIDE_PUSH: f32 = 60.0;
    /// Speed lost per metre ploughed through a buoy at full overlap (a
    /// fraction), so a hit costs the same share of speed at any speed.
    pub const DRAG: f32 = 0.14;
    /// How much of the turn the buoy gives the rider's path the hull follows.
    pub const YAW_FOLLOW: f32 = 0.8;
    /// Below this speed (m/s) the hull's heading stands for its direction.
    pub const SLOW: f32 = 2.0;
}

use tuning::*;

/// Pushes a rider out of any buoy they ride into.
pub fn bump(r: &mut Rider, course: &Course, surface: &Surface, tick: u32) {
    let reach = RADIUS + course.sport.rider_radius();
    for i in 0..course.buoys.len() {
        let (bx, bz) = course.buoy_pos(i);
        let dx = r.pos.x - bx;
        let dz = r.pos.z - bz;
        let dd = dx * dx + dz * dz;
        if dd >= reach * reach || r.pos.y >= surface.height(bx, bz, tick) + HEIGHT {
            continue;
        }
        let dist = sqrt(dd);
        let overlap = (reach - dist) / reach;
        let speed = r.speed();
        let (mx, mz) = if speed > SLOW {
            (r.vel.x / speed, r.vel.z / speed)
        } else {
            let f = r.forward();
            (f.x, f.z)
        };
        // Out across the direction of travel, to the side of the buoy the
        // rider is on (to the right when dead centre).
        let (rx, rz) = (-mz, mx);
        let side = if dx * rx + dz * rz < 0.0 { -1.0 } else { 1.0 };
        let push = SIDE_PUSH * overlap * DT * side;
        let keep = 1.0 - DRAG * overlap * speed * DT;
        let before = atan2(r.vel.x, r.vel.z);
        r.vel.x = r.vel.x * keep + rx * push;
        r.vel.z = r.vel.z * keep + rz * push;
        if speed > SLOW {
            let turned = angle_diff(before, atan2(r.vel.x, r.vel.z));
            r.yaw = wrap_angle(r.yaw + turned * YAW_FOLLOW);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::MAX_RIDERS;
    use crate::course::{CourseId, OVAL};
    use crate::input::Input;
    use crate::jetski::tuning::{DRAFT, MAX_SPEED};
    use crate::math::{Vec3, atan2, cos, sin};
    use crate::race::EventKind;
    use crate::surface::SurfaceKind;
    use crate::world::{Inputs, World};

    /// Rides at buoy `b` from 12 m out at `speed`, `aside` metres off its
    /// centre (to the right of the line in). Returns whether the rider
    /// bailed, the share of speed kept through the buoy, and how far to the
    /// side the rider ended up 8 m past it.
    fn ride_into(kind: SurfaceKind, b: usize, aside: f32, speed: f32) -> (bool, f32, f32) {
        let mut w = World::on_course(CourseId::Oval, kind, 4);
        w.spawn(0);
        w.ride_free();
        let (bx, bz) = OVAL.buoy_pos(b);
        let from = OVAL.centerline(OVAL.buoys[b].s - 12.0);
        let yaw = atan2(bx - from.x, bz - from.z);
        let (fx, fz, rx, rz) = (sin(yaw), cos(yaw), -cos(yaw), sin(yaw));
        let (x, z) = (from.x + rx * aside, from.z + rz * aside);
        let mut r = w.riders[0].unwrap();
        r.pos = Vec3::new(x, w.surface.height(x, z, 0) - DRAFT, z);
        r.yaw = yaw;
        r.vel = r.forward() * speed;
        r.race.next_gate = b as u8 + 1;
        w.riders[0] = Some(r);
        let mut inputs: Inputs = [None; MAX_RIDERS];
        inputs[0] = Some(Input::from_analog(0.0, 1.0, 0.0, 0));
        let (mut bailed, mut before, mut after, mut side) = (false, None, None, None);
        for _ in 0..180 {
            bailed |= w.step(&inputs).iter().any(|e| e.kind == EventKind::Bail);
            let r = w.riders[0].unwrap();
            let along = (r.pos.x - bx) * fx + (r.pos.z - bz) * fz;
            if along > -3.0 {
                before.get_or_insert(r.speed());
            }
            if along > 2.0 {
                after.get_or_insert(r.speed());
            }
            if along > 8.0 {
                side.get_or_insert((r.pos.x - bx) * rx + (r.pos.z - bz) * rz);
            }
        }
        let kept = after.unwrap() / before.unwrap();
        (bailed, kept, side.unwrap())
    }

    #[test]
    fn riding_into_a_buoy_shoves_it_aside() {
        for kind in [SurfaceKind::Flat, SurfaceKind::Swells, SurfaceKind::Rough] {
            for b in [0, 3, 5] {
                for speed in [MAX_SPEED, 12.0] {
                    let (_, clear, _) = ride_into(kind, b, 3.0, speed);
                    for aside in [-0.9, -0.5, 0.5, 0.9] {
                        let (bailed, kept, side) = ride_into(kind, b, aside, speed);
                        let case = format!("{kind:?} buoy {b} aside {aside} at {speed}");
                        assert!(!bailed, "{case}: bailed");
                        // It costs some speed, never most of it.
                        assert!(
                            kept < clear - 0.02 && kept > clear * 0.75,
                            "{case}: kept {kept} of {clear}"
                        );
                        // Pushed further out to the side it was hit on.
                        assert!(
                            side * aside > 0.0 && side.abs() > aside.abs() + 0.3,
                            "{case}: {side}"
                        );
                    }
                }
            }
        }
    }
}
