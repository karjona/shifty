//! Server-side bots. A bot is just a rider whose inputs come from this code
//! instead of the network; its inputs go through the same sim path as a
//! human's. The function is deterministic, so clients can predict bots
//! exactly by running it too.

use crate::input::Input;
use crate::math::{angle_diff, atan2, clamp, cos, sin};
use crate::world::World;

/// Bots lap a circle around the arena centre, each on its own radius.
pub fn bot_input(world: &World, slot: usize) -> Input {
    let Some(r) = world.riders[slot] else {
        return Input::default();
    };
    let radius = 40.0 + (slot % 4) as f32 * 7.0;
    // Angle around the centre, then aim a bit further along the circle.
    let around = atan2(r.pos.x, r.pos.z);
    let target_angle = around + 0.45;
    let tx = sin(target_angle) * radius;
    let tz = cos(target_angle) * radius;
    let desired_yaw = atan2(tx - r.pos.x, tz - r.pos.z);
    let diff = angle_diff(r.yaw, desired_yaw);
    // Positive steer turns right, which lowers yaw.
    let steer = clamp(-diff * 2.0, -1.0, 1.0);
    let throttle = 0.7 + (slot % 3) as f32 * 0.1;
    Input::from_analog(if r.grounded { steer } else { 0.0 }, throttle, 0.0, 0)
}
