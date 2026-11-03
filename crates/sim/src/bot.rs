//! Server-side bots. A bot is just a rider whose inputs come from this code
//! instead of the network; its inputs go through the same sim path as a
//! human's. The function is deterministic, so clients can predict bots
//! exactly by running it too.

use crate::DT;
use crate::course::{Keep, Line};
use crate::input::{Input, buttons};
use crate::jetski::tuning as jet;
use crate::math::{TAU, angle_diff, atan2, clamp, sqrt};
use crate::mountain::{Feature, Run};
use crate::snowboard::tuning as snow;
use crate::world::World;

/// What a bot does this tick, for whatever sport the course is.
pub fn bot_input(world: &World, slot: usize) -> Input {
    match world.course().line {
        Line::Stadium(_) => jetski_input(world, slot),
        Line::Run(run) => snowboard_input(world, run, slot),
    }
}

/// Jetski bots follow the course, swing out to pass each buoy on its
/// correct side, pull back on some crests to pop, and some take the ramps
/// and throw a 360 on big launches.
fn jetski_input(world: &World, slot: usize) -> Input {
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

/// Snowboard bots ride their own line down the run, scrub speed before turns
/// too tight to carve at full speed and tuck where it is open. Tricksters
/// line up with every table they meet, load a pop and let go at the lip; in
/// the air they spin a 360 when there is time for it, and grab otherwise.
fn snowboard_input(world: &World, run: &Run, slot: usize) -> Input {
    let Some(r) = world.riders[slot] else {
        return Input::default();
    };
    let (s, _) = run.project(r.pos.x, r.pos.z);
    let speed = r.speed();
    let half = run.width_at(s).half;
    let pace = 0.86 + (slot % 3) as f32 * 0.05;
    let trickster = slot % 3 != 1;
    let mut lane = clamp(
        ((slot % 4) as f32 - 1.5) * 0.3 * half,
        -half + 2.0,
        half - 2.0,
    );

    // The next table: line up with it, load a pop, let go at the lip.
    let mut jump = false;
    for f in run.features {
        if let Feature::Table {
            s: s0,
            offset,
            half_width,
            ramp,
            ..
        } = *f
        {
            let to_lip = s0 + ramp - s;
            if !(0.0..60.0).contains(&to_lip) {
                continue;
            }
            if !trickster {
                continue;
            }
            if half_width.is_finite() {
                lane = offset;
            }
            jump = to_lip > speed * DT * 1.5 && to_lip < speed * 0.6 + 1.0;
            break;
        }
    }

    // Steer round whatever stands in the line ahead (to the side nearer
    // the middle of the run).
    for o in run.obstacles {
        let ahead = o.s - s;
        let clear = o.radius + 2.5;
        if (0.0..50.0).contains(&ahead) && (o.offset - lane).abs() < clear {
            lane = if o.offset > 0.0 {
                o.offset - clear
            } else {
                o.offset + clear
            };
        }
    }

    let look = 8.0 + speed * 0.5;
    let (tx, tz) = run.centerline(s + look).at_offset(lane);
    let desired = atan2(tx - r.pos.x, tz - r.pos.z);
    let heading = if speed > 3.0 {
        atan2(r.vel.x, r.vel.z)
    } else {
        r.yaw
    };
    let steer = clamp(-angle_diff(heading, desired) * 2.0, -1.0, 1.0);

    // Speed: the tightest bend in the next stretch sets how fast to go.
    let ahead = 20.0 + speed * 1.5;
    let mut bend: f32 = 0.0;
    let mut d = 10.0;
    while d <= ahead {
        let a = run.centerline(s + d - 10.0).yaw;
        let b = run.centerline(s + d + 10.0).yaw;
        bend = bend.max(angle_diff(a, b).abs() / 20.0);
        d += 10.0;
    }
    let safe = if bend > 1e-3 {
        sqrt(snow::CARVE_GRIP * 0.85 / bend) * pace
    } else {
        f32::MAX
    };
    let lean = if speed > safe + 1.5 {
        -clamp((speed - safe) / 4.0, 0.3, 1.0)
    } else if speed < safe - 2.0 && bend < 1.0 / 250.0 {
        // Tuck only where it is open: tucked, you carve wider.
        pace
    } else {
        0.0
    };

    if r.grounded {
        let buttons = if jump { buttons::JUMP } else { 0 };
        return Input::from_analog(steer, 0.0, lean, buttons);
    }
    // In the air: how long until the snow comes back up?
    let g = snow::GRAVITY;
    let above = (r.pos.y - run.height(r.pos.x, r.pos.z)).max(0.0);
    let air_left = (r.vel.y + sqrt(r.vel.y * r.vel.y + 2.0 * g * above)) / g;
    if trickster {
        let to_go = 0.8 * TAU - r.air_spin.abs();
        let spinning = r.yaw_rate.abs() > 0.4 * snow::SPIN_RATE;
        if to_go > 0.0 && (spinning || air_left > to_go / snow::SPIN_RATE + 0.35) {
            let dir = if slot.is_multiple_of(2) { 1.0 } else { -1.0 };
            return Input::from_analog(dir, 0.0, 0.0, buttons::TRICK);
        }
    }
    if r.air_spin.abs() < 0.5 && air_left > 0.35 {
        return Input::from_analog(0.0, 0.0, 0.0, buttons::GRAB);
    }
    Input::from_analog(0.0, 0.0, 0.0, 0)
}
