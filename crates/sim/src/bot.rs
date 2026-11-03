//! Server-side bots. A bot is just a rider whose inputs come from this code
//! instead of the network; its inputs go through the same sim path as a
//! human's. The function is deterministic, so clients can predict bots
//! exactly by running it too.

use crate::course::Keep;
use crate::input::{Input, buttons};
use crate::jetski::tuning as jet;
use crate::math::{TAU, angle_diff, atan2, clamp, sqrt};
use crate::world::World;

/// Bots follow the course, swing out to pass each buoy on its correct side,
/// pull back on some crests to pop, and some take the ramps and throw a 360
/// on big launches.
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

    let trickster = slot % 3 != 1;
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
    // Tricksters line up with a ramp coming up and pull back all the way up it.
    let ramp_ahead = course
        .ramps
        .iter()
        .find(|rd| (0.0..45.0).contains(&course.delta_s(s, rd.s)));
    if let Some(rd) = ramp_ahead
        && trickster
    {
        target_offset = rd.offset;
    }
    let on_ramp = course
        .ramp_under(r.pos.x, r.pos.z, &world.surface, world.tick)
        .is_some();
    let look = 12.0 + r.speed() * 0.6;
    let (tx, tz) = course.centerline(s + look).at_offset(target_offset);
    let desired = atan2(tx - r.pos.x, tz - r.pos.z);
    // Positive steer turns right, which lowers yaw.
    let steer = clamp(-angle_diff(r.yaw, desired) * 2.5, -1.0, 1.0);

    let pops = world.tick.wrapping_add(slot as u32 * 131) % 400 < 200;
    if r.grounded {
        let lean = if (pops || on_ramp) && r.vel.y > 1.5 {
            -1.0
        } else {
            0.0
        };
        return Input::from_analog(steer, pace, lean, 0);
    }
    // In the air: spin while there is time left to get most of the way
    // round (ramps, big pops), then let go and let it finish itself.
    let g = jet::GRAVITY;
    let above = (r.pos.y - world.surface.height(r.pos.x, r.pos.z, world.tick)).max(0.0);
    let air_left = (r.vel.y + sqrt(r.vel.y * r.vel.y + 2.0 * g * above)) / g;
    let to_go = 0.78 * TAU - r.air_spin.abs();
    let spin_up = (1.0 - r.yaw_rate.abs() / jet::SPIN_RATE).max(0.0) / jet::TRICK_RESPONSE;
    let spinning = r.yaw_rate.abs() > 0.4 * jet::SPIN_RATE;
    if trickster && to_go > 0.0 && (spinning || air_left > to_go / jet::SPIN_RATE + spin_up) {
        let dir = if slot.is_multiple_of(2) { 1.0 } else { -1.0 };
        return Input::from_analog(dir, pace, 0.0, buttons::TRICK);
    }
    Input::from_analog(0.0, pace, 0.0, 0)
}
