//! Server-side bots. A bot is just a rider whose inputs come from this code
//! instead of the network; its inputs go through the same sim path as a
//! human's. The function is deterministic, so clients can predict bots
//! exactly by running it too.

use crate::course::Keep;
use crate::input::Input;
use crate::math::{angle_diff, atan2, clamp};
use crate::world::World;

/// Bots follow the course, swing out to pass each buoy on its correct side,
/// and pull back on some crests to pop.
pub fn bot_input(world: &World, slot: usize) -> Input {
    let Some(r) = world.riders[slot] else {
        return Input::default();
    };
    let course = world.course();
    let (s, _) = course.project(r.pos.x, r.pos.z);

    // Each bot has its own lane, pace and appetite for air.
    let lane = ((slot % 4) as f32 - 1.5) * 2.5;
    let pace = 0.9 + (slot % 3) as f32 * 0.05;
    let margin = 2.5 + (slot % 3) as f32;

    let mut target_offset = lane;
    let gate = usize::from(r.race.next_gate) % course.gate_count();
    if gate >= 1 {
        let b = &course.buoys[gate - 1];
        if course.delta_s(s, b.s) < 70.0 {
            target_offset = match b.keep {
                Keep::Right => b.offset - margin,
                Keep::Left => b.offset + margin,
            };
        }
    }
    let look = 12.0 + r.speed() * 0.6;
    let (tx, tz) = course.centerline(s + look).at_offset(target_offset);
    let desired = atan2(tx - r.pos.x, tz - r.pos.z);
    // Positive steer turns right, which lowers yaw.
    let steer = clamp(-angle_diff(r.yaw, desired) * 2.5, -1.0, 1.0);

    let pops = world.tick.wrapping_add(slot as u32 * 131) % 400 < 200;
    let lean = if pops && r.grounded && r.vel.y > 1.5 {
        -1.0
    } else {
        0.0
    };
    Input::from_analog(if r.grounded { steer } else { 0.0 }, pace, lean, 0)
}
