//! Jetski physics: a hull floating on four buoyancy points.
//!
//! Each point (bow, stern, left, right) is pushed up by the water in
//! proportion to how deep it sits, along the water's normal, damped against
//! the water's own vertical motion. Water can push but never pull, so when a
//! crest falls away faster than gravity can follow, the hull flies. The same
//! forces tip the nose and the sides, so the ski pitches over swells and
//! rolls in carves without any scripted animation.
//!
//! Units are per unit of mass: forces are accelerations, torques are angular
//! accelerations times the inertia constants below.

use crate::DT;
use crate::course::{self, Course, RampSurface};
use crate::input::Input;
use crate::math::{Vec3, angle_diff, atan2, clamp, cos, sin, wrap_angle, wrap_pi};
use crate::surface::Surface;
use crate::world::Rider;

pub mod tuning {
    pub const GRAVITY: f32 = 13.0;
    pub const MAX_SPEED: f32 = 23.0;
    pub const MAX_REVERSE: f32 = 5.0;
    pub const ACCEL: f32 = 16.0;
    pub const BRAKE: f32 = 16.0;
    pub const REVERSE_ACCEL: f32 = 5.0;
    /// Water drag on horizontal speed, per second.
    pub const DRAG: f32 = 0.1;
    /// Constant water drag (m/s²), so a coasting hull comes to rest.
    pub const STOP_DECEL: f32 = 0.6;
    pub const AIR_DRAG: f32 = 0.02;
    /// Sideways velocity bleed per second (the keel biting).
    pub const GRIP: f32 = 5.5;
    pub const TURN_RATE: f32 = 2.1;
    pub const TURN_RESPONSE: f32 = 8.0;

    /// Hull sample points in body space (x = left, y = up, z = forward),
    /// relative to the rider position (the bottom of the hull).
    pub const HULL_POINTS: [(f32, f32, f32); 4] = [
        (0.0, 0.0, 1.35),   // bow
        (0.0, 0.0, -1.25),  // stern (the jet)
        (0.55, 0.0, -0.1),  // left
        (-0.55, 0.0, -0.1), // right
    ];
    pub const STERN: usize = 1;
    /// How deep the hull sits at rest.
    pub const DRAFT: f32 = 0.14;
    /// Upward push per point per metre of depth.
    pub const BUOYANCY: f32 = GRAVITY / (4.0 * DRAFT);
    /// Depth beyond which a point pushes no harder.
    pub const MAX_DEPTH: f32 = 0.7;
    /// Damping of each point's vertical speed relative to the water.
    pub const BUOY_DAMP: f32 = 3.6;
    pub const PITCH_INERTIA: f32 = 1.1;
    pub const ROLL_INERTIA: f32 = 0.3;
    /// Extra angular damping while wet, per second.
    pub const WET_ANGULAR_DAMP: f32 = 2.5;
    /// The jet still pushes when the stern is just above the water.
    pub const STERN_WET_DEPTH: f32 = -0.12;

    /// Rider weight shift front/back (angular acceleration at full lean).
    pub const LEAN_ACCEL: f32 = 10.0;
    /// How far the rider banks into a full-speed, full-lock turn.
    pub const MAX_BANK: f32 = 0.5;
    pub const BANK_STIFFNESS: f32 = 26.0;
    /// Hydrodynamic lift at top speed, as a fraction of gravity: the hull
    /// rises and skims.
    pub const PLANING_LIFT: f32 = 0.3;
    /// Extra drag per metre a point sits deeper than twice the draft (nose
    /// dives, belly flops).
    pub const DIG_DRAG: f32 = 1.4;

    /// Pulling back as the hull leaves the water adds this much upward speed
    /// (at full lean).
    pub const POP_SPEED: f32 = 3.0;
    /// Only a real launch (rising this fast) can be popped.
    pub const POP_MIN_RISE: f32 = 1.0;
    /// Ticks on the water before another pop is possible.
    pub const POP_MIN_WET_TICKS: u16 = 8;

    /// A hull this close above a ramp deck lands on it.
    pub const RAMP_CATCH: f32 = 0.05;
    pub const RAMP_DRAG: f32 = 0.3;

    pub const AIR_STEER_RATE: f32 = 0.8;
    pub const AIR_TURN_RESPONSE: f32 = 4.0;
    /// In the air the nose eases toward the flight path (plus lean).
    pub const AIR_PITCH_STIFFNESS: f32 = 14.0;
    pub const AIR_PITCH_DAMP: f32 = 6.0;
    pub const AIR_LEAN_PITCH: f32 = 0.45;
    pub const AIR_ROLL_STIFFNESS: f32 = 12.0;
    pub const AIR_ROLL_DAMP: f32 = 6.0;
}

use tuning::*;

/// A hull point in world space, plus how its height changes with pitch and
/// roll (the levers buoyancy acts through).
struct HullPoint {
    pos: Vec3,
    lever_pitch: f32,
    lever_roll: f32,
}

/// Rotation used everywhere for riders: yaw about world Y, then pitch about
/// the rider's left axis (nose up positive), then roll about the forward
/// axis (positive = left side up, banked right). Three.js order "YXZ" with
/// rotation `(-pitch, yaw, roll)`.
fn hull_point(r: &Rider, o: (f32, f32, f32)) -> HullPoint {
    let (sp, cp) = (sin(r.pitch), cos(r.pitch));
    let (sr, cr) = (sin(r.roll), cos(r.roll));
    let (sy, cy) = (sin(r.yaw), cos(r.yaw));
    let (ox, oy, oz) = o;
    let ax = ox * cr - oy * sr;
    let ay = ox * sr + oy * cr;
    let by = ay * cp + oz * sp;
    let bz = oz * cp - ay * sp;
    HullPoint {
        pos: Vec3::new(
            r.pos.x + ax * cy + bz * sy,
            r.pos.y + by,
            r.pos.z + bz * cy - ax * sy,
        ),
        lever_pitch: oz * cp - ay * sp,
        lever_roll: ax * cp,
    }
}

/// Water forces on the hull this tick.
#[derive(Default)]
struct Wet {
    /// Acceleration from buoyancy.
    force: Vec3,
    pitch: f32,
    roll: f32,
    points: u32,
    stern_wet: bool,
    excess_depth: f32,
}

fn water_forces(r: &Rider, surface: &Surface, tick: u32) -> Wet {
    let mut wet = Wet::default();
    for (i, o) in HULL_POINTS.iter().enumerate() {
        let p = hull_point(r, *o);
        let w = surface.sample(p.pos.x, p.pos.z, tick);
        let depth = w.height - p.pos.y;
        if i == STERN && depth > STERN_WET_DEPTH {
            wet.stern_wet = true;
        }
        if depth <= 0.0 {
            continue;
        }
        wet.points += 1;
        let point_vy = r.vel.y + r.pitch_rate * p.lever_pitch + r.roll_rate * p.lever_roll;
        let water_vy = w.dhdt + w.dhdx * r.vel.x + w.dhdz * r.vel.z;
        let f = (BUOYANCY * depth.min(MAX_DEPTH) - BUOY_DAMP * (point_vy - water_vy)).max(0.0);
        wet.force += Vec3::new(-f * w.dhdx, f, -f * w.dhdz);
        wet.pitch += f * p.lever_pitch;
        wet.roll += f * p.lever_roll;
        wet.excess_depth += (depth - 2.0 * DRAFT).max(0.0);
    }
    wet
}

/// Advance one rider one tick on the water (or above it).
pub fn integrate(r: &mut Rider, input: Input, surface: &Surface, course: &Course, tick: u32) {
    let steer = input.steer_f();
    let throttle = input.throttle_f();
    let lean = input.lean_f();
    let was_grounded = r.grounded;
    let top_speed = MAX_SPEED * r.race.speed_bonus();

    if let Some(deck) = course.ramp_under(r.pos.x, r.pos.z, surface, tick)
        && r.pos.y <= deck.top + RAMP_CATCH
        && r.pos.y >= deck.top - course::tuning::RAMP_STEP
    {
        ride_ramp(r, input, &deck);
        return;
    }

    let wet = water_forces(r, surface, tick);
    let grounded = wet.points > 0;
    // Two or more points in the water = full control.
    let bite = clamp(wet.points as f32 * 0.5, 0.0, 1.0);
    let forward = r.forward();
    let right = r.right();
    let speed_fwd = r.vel.horizontal().dot(forward);

    let mut accel = wet.force - Vec3::new(0.0, GRAVITY, 0.0);
    let mut pitch_acc = wet.pitch / PITCH_INERTIA;
    let mut roll_acc = wet.roll / ROLL_INERTIA;

    if grounded {
        // Steering: stronger with speed, reversed when going backwards.
        let speed_factor = clamp(speed_fwd.abs() / 6.0, 0.2, 1.0);
        let dir = if speed_fwd < -0.5 { -1.0 } else { 1.0 };
        let target_rate = -steer * TURN_RATE * speed_factor * dir;
        r.yaw_rate += (target_rate - r.yaw_rate) * clamp(TURN_RESPONSE * bite * DT, 0.0, 1.0);

        if wet.stern_wet {
            let thrust = if throttle >= 0.0 {
                let v = clamp(speed_fwd / top_speed, 0.0, 1.0);
                throttle * ACCEL * (1.0 - v * v)
            } else if speed_fwd > 0.5 {
                throttle * BRAKE
            } else {
                throttle * REVERSE_ACCEL * (1.0 - clamp(-speed_fwd / MAX_REVERSE, 0.0, 1.0))
            };
            accel += forward * thrust;
        }

        // Grip: bleed sideways velocity so the hull carves instead of sliding.
        let lateral = r.vel.dot(right);
        r.vel -= right * (lateral * clamp(GRIP * bite * DT, 0.0, 1.0));

        let drag = DRAG * bite + DIG_DRAG * wet.excess_depth;
        accel.x -= r.vel.x * drag;
        accel.z -= r.vel.z * drag;
        // Proportional drag alone fades below one velocity grid step per
        // tick at low speed; a small constant part brings the hull to rest.
        let speed = r.speed();
        if speed > 1e-4 {
            let stop = (STOP_DECEL * bite).min(speed / DT);
            accel.x -= r.vel.x / speed * stop;
            accel.z -= r.vel.z / speed * stop;
        }

        let planing = clamp(speed_fwd / top_speed, 0.0, 1.0);
        accel.y += PLANING_LIFT * GRAVITY * planing * planing * bite;

        // The rider banks into turns and shifts weight front to back.
        let bank_target = steer * MAX_BANK * speed_factor;
        roll_acc += BANK_STIFFNESS * (bank_target - r.roll) * bite;
        pitch_acc -= LEAN_ACCEL * lean * bite;

        let damp = 1.0 - clamp(WET_ANGULAR_DAMP * bite * DT, 0.0, 1.0);
        r.pitch_rate *= damp;
        r.roll_rate *= damp;
    } else {
        // In the air: a little steering, and the nose follows the flight path.
        let target_rate = -steer * AIR_STEER_RATE;
        r.yaw_rate += (target_rate - r.yaw_rate) * clamp(AIR_TURN_RESPONSE * DT, 0.0, 1.0);
        let speed_h = r.speed().max(0.1);
        let flight = clamp(atan2(r.vel.y, speed_h) * 0.5, -0.5, 0.5);
        let pitch_target = clamp(flight - lean * AIR_LEAN_PITCH, -0.8, 0.8);
        pitch_acc = AIR_PITCH_STIFFNESS * (pitch_target - r.pitch) - AIR_PITCH_DAMP * r.pitch_rate;
        roll_acc = -AIR_ROLL_STIFFNESS * r.roll - AIR_ROLL_DAMP * r.roll_rate;
        accel.x -= r.vel.x * AIR_DRAG;
        accel.z -= r.vel.z * AIR_DRAG;

        // Leaving the water while pulling back: pop off the crest.
        if was_grounded
            && r.state_ticks >= POP_MIN_WET_TICKS
            && lean < -0.3
            && r.vel.y > POP_MIN_RISE
        {
            r.vel.y += POP_SPEED * -lean;
        }
    }

    r.vel += accel * DT;
    r.pitch_rate += pitch_acc * DT;
    r.roll_rate += roll_acc * DT;

    r.yaw = wrap_angle(r.yaw + r.yaw_rate * DT);
    r.pitch = wrap_pi(r.pitch + r.pitch_rate * DT);
    r.roll = wrap_pi(r.roll + r.roll_rate * DT);
    r.pos += r.vel * DT;

    finish_tick(r, grounded, input);
}

fn finish_tick(r: &mut Rider, grounded: bool, input: Input) {
    r.state_ticks = if grounded == r.grounded {
        r.state_ticks.saturating_add(1)
    } else {
        0
    };
    r.grounded = grounded;
    r.last_input = input;
}

/// On a ramp the deck holds the hull: it slides up at the deck's slope and
/// leaves the lip with that rise as upward speed. The jet is out of the
/// water, so there is no thrust and no steering, only momentum.
fn ride_ramp(r: &mut Rider, input: Input, deck: &RampSurface) {
    let (fx, fz) = (sin(deck.yaw), cos(deck.yaw));
    let along = r.vel.x * fx + r.vel.z * fz;
    r.pos.y = deck.top;
    r.vel.y = along.max(0.0) * deck.slope;
    r.vel.x -= r.vel.x * RAMP_DRAG * DT;
    r.vel.z -= r.vel.z * RAMP_DRAG * DT;
    let deck_pitch = atan2(deck.slope, 1.0) * cos(angle_diff(r.yaw, deck.yaw));
    r.pitch += (deck_pitch - r.pitch) * 0.5;
    r.pitch_rate = 0.0;
    r.roll *= 0.8;
    r.roll_rate = 0.0;
    r.yaw_rate *= 0.8;
    r.yaw = wrap_angle(r.yaw + r.yaw_rate * DT);
    r.pos.x += r.vel.x * DT;
    r.pos.z += r.vel.z * DT;
    finish_tick(r, true, input);
}

/// Height a resting hull sits at, on a surface of height `h`.
pub fn rest_height(h: f32) -> f32 {
    h - DRAFT
}
