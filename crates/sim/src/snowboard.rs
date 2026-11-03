//! Snowboard physics: a board on the snow, carving, sliding and flying off
//! whatever the mountain throws at it.
//!
//! On the snow the board follows the surface. Gravity along the slope is
//! the engine; snow friction and air drag hold it back (tucking cuts the
//! drag, sitting back on the tail brakes, and when slow, pushing the stick
//! forward skates you along). The edge grips: sideways speed is
//! turned into speed along the board, so steering carves without scrubbing
//! speed, and how tight you can carve falls with speed. Wherever the snow
//! falls away faster than gravity can pull the rider after it (a lip, a
//! knuckle, a cliff), the board flies.
//!
//! Jumping is a crouch and a pop: hold the button to load, let go to spring
//! off the snow, harder the longer you loaded. Letting go right at a lip
//! adds the pop to the lip's own launch (and a pop just after the lip still
//! counts).
//!
//! In the air the stick spins and flips while the trick button is held, and
//! the grab button grabs the board (the stick picks the grab). Let go and the
//! rider finishes the rotation toward the nearest way to land. A landing is
//! judged against the snow: the board along the direction of travel
//! (forward or switch), flat on the slope, and not still grabbing, or the
//! rider falls.
//!
//! Units are per unit of mass: forces are accelerations.

use crate::DT;
use crate::course::Frame;
use crate::input::{Input, buttons};
use crate::math::{
    PI, TAU, Vec3, angle_diff, atan, atan2, clamp, round, sqrt, wrap_angle, wrap_pi,
};
use crate::mountain::Run;
use crate::race::{Landing, Trick};
use crate::world::Rider;

pub mod tuning {
    pub const GRAVITY: f32 = 18.0;
    /// Snow friction (fraction of the normal force).
    pub const SNOW_FRICTION: f32 = 0.035;
    /// Air drag: deceleration per (m/s)², standing tall and tucked.
    pub const DRAG: f32 = 0.0067;
    pub const TUCK_DRAG: f32 = 0.005;
    pub const AIR_DRAG: f32 = 0.0058;
    /// Sitting back on the tail, at full stick (m/s²).
    pub const BRAKE: f32 = 10.0;
    /// Pushing with the back foot (stick forward) when slow, up to `SKATE_TOP` m/s.
    pub const SKATE: f32 = 3.0;
    pub const SKATE_TOP: f32 = 5.0;
    /// The most sideways acceleration a carve holds (m/s²): fast turns are wide.
    pub const CARVE_GRIP: f32 = 15.0;
    pub const MAX_TURN_RATE: f32 = 2.4;
    /// Tucked, you turn this much less.
    pub const TUCK_TURN_LOSS: f32 = 0.35;
    /// Braking while steering swings the tail round: this much tighter.
    pub const SKID_TURN: f32 = 0.7;
    pub const TURN_RESPONSE: f32 = 6.0;
    /// How fast the edge turns sideways speed into speed along the board, per second.
    pub const GRIP: f32 = 10.0;
    /// Speed lost to carving: per m/s of speed per rad/s of turn.
    pub const CARVE_DRAG: f32 = 0.06;
    /// Most the rider leans into a turn (rad).
    pub const MAX_LEAN: f32 = 0.8;
    /// The most rotation the snow hands the board as it leaves it (rad/s):
    /// a lip tips the nose over, it doesn't flip you.
    pub const TAKEOFF_ROTATION: f32 = 2.5;
    /// Gaps between the board and the snow smaller than this are not air (m).
    pub const MIN_GAP: f32 = 0.004;

    /// Ticks of crouch for a full pop, and the pop's upward speed (m/s).
    pub const CHARGE_TICKS: u8 = 36;
    pub const POP_MIN: f32 = 3.5;
    pub const POP_MAX: f32 = 6.5;
    /// A loaded pop let go this many ticks after leaving a lip still pops.
    pub const LATE_POP_TICKS: u16 = 6;

    /// Trick rotation speeds at full stick, rad/s.
    pub const SPIN_RATE: f32 = 7.0;
    pub const FLIP_RATE: f32 = 6.0;
    pub const TRICK_RESPONSE: f32 = 8.0;
    /// Without the trick button the board springs toward the nearest way to
    /// land (forward or switch), critically damped; the stick steers a little.
    pub const AIR_ALIGN: f32 = 40.0;
    pub const AIR_ALIGN_DAMP: f32 = 12.6;
    pub const AIR_STEER_RATE: f32 = 0.5;
    /// The rider levels the board with the snow below.
    pub const AIR_PITCH_STIFFNESS: f32 = 10.0;
    pub const AIR_PITCH_DAMP: f32 = 5.0;
    pub const AIR_ROLL_STIFFNESS: f32 = 10.0;
    pub const AIR_ROLL_DAMP: f32 = 5.0;
    /// A rotation still turning faster than this (rad/s) when let go is
    /// finished forward, not undone (unless it is already this close to a
    /// way to land, rad).
    pub const FINISH_RATE: f32 = 1.5;
    pub const FINISH_NEAR: f32 = 0.6;

    /// Landing more crooked than this is a fall.
    pub const LAND_HEADING: f32 = 0.6;
    pub const LAND_PITCH: f32 = 0.7;
    /// Roll is judged loosely: a board still on edge from a carve lands fine.
    pub const LAND_ROLL: f32 = 1.2;
    /// Hitting the snow faster than this (into it, m/s) is a fall. Below
    /// it, a flat landing only costs the speed that went into the snow.
    pub const HARD_LANDING: f32 = 28.0;
    /// Hops shorter than this are never judged.
    pub const MIN_JUDGED_AIR_TICKS: u16 = 10;
    /// A grab held this long counts as a trick.
    pub const MIN_GRAB_TICKS: u8 = 8;

    /// Hitting something this hard (m/s into it) knocks you down.
    pub const CRASH_SPEED: f32 = 8.0;
    pub const BAIL_TICKS: u8 = 80;
    /// Speed kept when falling.
    pub const BAIL_IMPACT: f32 = 0.6;
    /// Sliding on your back (m/s²).
    pub const BAIL_DECEL: f32 = 8.0;
}

/// Grabs, picked by the stick when the grab starts.
pub mod grabs {
    pub const INDY: u8 = 1;
    pub const NOSE: u8 = 2;
    pub const TAIL: u8 = 3;
    pub const MELON: u8 = 4;
    pub const METHOD: u8 = 5;
}

use tuning::*;

/// The board's direction along the snow and its right-hand side, for a
/// heading on a surface with normal `n`.
fn board_axes(yaw: f32, n: Vec3) -> (Vec3, Vec3) {
    let flat = Vec3::new(crate::math::sin(yaw), 0.0, crate::math::cos(yaw));
    let f = (flat - n * flat.dot(n)).normalize_or(flat);
    (f, f.cross(n))
}

/// Pitch and roll of a board lying flat on snow with normal `n`.
fn snow_attitude(yaw: f32, n: Vec3) -> (f32, f32) {
    let (f, right) = board_axes(yaw, n);
    let pitch = atan2(f.y, f.horizontal().length());
    // Positive roll = left side up = right side down.
    let roll = atan2(-right.y, right.horizontal().length());
    (pitch, roll)
}

/// Points for a trick: spins grow faster than linearly, flips are worth a
/// lot, grabs pay by how long they are held.
pub fn points(spin: i8, flip: i8, grab_ticks: u8) -> u16 {
    let h = u32::from(spin.unsigned_abs());
    let spins = 100 * h + 50 * h * h.saturating_sub(1);
    let flips = 600 * u32::from(flip.unsigned_abs());
    let grab = 8 * u32::from(grab_ticks.min(120));
    (spins + flips + grab).min(u32::from(u16::MAX)) as u16
}

fn grab_from_stick(steer: f32, lean: f32) -> u8 {
    if steer.abs() > 0.5 && steer.abs() >= lean.abs() {
        if steer > 0.0 {
            grabs::MELON
        } else {
            grabs::METHOD
        }
    } else if lean > 0.5 {
        grabs::NOSE
    } else if lean < -0.5 {
        grabs::TAIL
    } else {
        grabs::INDY
    }
}

/// Knocked down: the rider falls and slides.
pub fn fall(r: &mut Rider) {
    r.bail_ticks = BAIL_TICKS;
    r.vel = r.vel * BAIL_IMPACT;
    r.yaw_rate = 0.0;
    r.pitch_rate = 0.0;
    r.roll_rate = 0.0;
    r.charge = 0;
    r.grab = 0;
    r.grab_ticks = 0;
}

/// On the start grid: standing still on the snow at `spot`.
pub fn hold(r: &mut Rider, spot: Frame, run: &Run) {
    let (h, n) = run.sample(spot.x, spot.z);
    r.pos = Vec3::new(spot.x, h, spot.z);
    r.vel = Vec3::ZERO;
    r.yaw = spot.yaw;
    r.yaw_rate = 0.0;
    (r.pitch, r.roll) = snow_attitude(spot.yaw, n);
    r.pitch_rate = 0.0;
    r.roll_rate = 0.0;
    r.grounded = true;
}

/// Advance one rider one tick on the snow (or above it). Returns how a jump
/// ended, on the tick it touches down.
pub fn integrate(r: &mut Rider, input: Input, run: &Run) -> Option<Landing> {
    let was_bailing = r.bailing();
    r.bail_ticks = r.bail_ticks.saturating_sub(1);
    if was_bailing && !r.bailing() {
        // Back on your feet, facing down the run.
        let (s, _) = run.project(r.pos.x, r.pos.z);
        r.yaw = run.centerline(s).yaw;
        r.yaw_rate = 0.0;
    }
    let landing = if r.grounded {
        ride(r, input, run);
        None
    } else {
        fly(r, input, run)
    };
    r.last_input = input;
    landing
}

/// One tick on the snow.
fn ride(r: &mut Rider, input: Input, run: &Run) {
    let steer = input.steer_f();
    let lean = input.lean_f();
    let bailing = r.bailing();
    let (h, n) = run.sample(r.pos.x, r.pos.z);
    r.pos.y = h;
    let mut v = r.vel - n * r.vel.dot(n);
    let speed = v.length();
    let (tuck, brake) = if bailing {
        (0.0, 0.0)
    } else {
        (lean.max(0.0), (-lean).max(0.0))
    };

    // Steering: the edge holds at most CARVE_GRIP sideways, plus whatever
    // the slope pulls toward the inside of the turn (banks), so fast turns
    // are wide; braking swings the tail round tighter.
    let gravity = Vec3::new(0.0, -GRAVITY, 0.0);
    let downhill = gravity - n * gravity.dot(n);
    let (f, right) = board_axes(r.yaw, n);
    let inward = if steer >= 0.0 {
        downhill.dot(right)
    } else {
        -downhill.dot(right)
    };
    let grip = CARVE_GRIP * (1.0 - TUCK_TURN_LOSS * tuck) + inward.max(0.0);
    let cap = (grip / speed.max(1.0)).min(MAX_TURN_RATE) * (1.0 + SKID_TURN * brake);
    let target = if bailing { 0.0 } else { -steer * cap };
    r.yaw_rate += (target - r.yaw_rate) * clamp(TURN_RESPONSE * DT, 0.0, 1.0);

    // Gravity along the slope; friction, drag, braking and carving against
    // the motion (never reversing it).
    v += downhill * DT;
    let drag = DRAG + (TUCK_DRAG - DRAG) * tuck;
    let decel = if bailing {
        BAIL_DECEL + SNOW_FRICTION * GRAVITY * n.y
    } else {
        SNOW_FRICTION * GRAVITY * n.y
            + drag * speed * speed
            + BRAKE * brake
            + CARVE_DRAG * r.yaw_rate.abs() * speed
    };
    let sp = v.length();
    if sp > 1e-4 {
        v = v * (1.0 - (decel * DT).min(sp) / sp);
    }
    // Slow on the flat: push along with the back foot.
    if !bailing && tuck > 0.0 && speed < SKATE_TOP {
        let ahead = if v.dot(f) < -0.5 { -1.0 } else { 1.0 };
        v += f * (ahead * SKATE * tuck * DT);
    }

    // The edge: sideways speed turns into speed along the board while the
    // board points close to where it is going (a carve), and is scrubbed
    // off when it is sideways (a skid).
    if !bailing {
        let along = v.dot(f);
        let lat = v.dot(right);
        let sp = v.length();
        let grip = clamp(GRIP * (1.0 - 0.6 * brake) * DT, 0.0, 1.0);
        let lat_after = lat * (1.0 - grip);
        let carving = if sp > 1e-3 {
            crate::math::smoothstep(0.5, 0.2, lat.abs() / sp)
        } else {
            0.0
        };
        let gained = (lat * lat - lat_after * lat_after) * carving;
        let along_after = if along >= 0.0 {
            sqrt(along * along + gained)
        } else {
            -sqrt(along * along + gained)
        };
        v = f * along_after + right * lat_after + n * v.dot(n);
    }

    // The jump: hold to crouch, let go to pop.
    let mut pop = 0.0;
    if !bailing {
        if input.pressed(buttons::JUMP) {
            r.charge = (r.charge + 1).min(CHARGE_TICKS);
        } else if r.charge > 0 {
            pop = POP_MIN + (POP_MAX - POP_MIN) * f32::from(r.charge) / f32::from(CHARGE_TICKS);
            r.charge = 0;
        }
    } else {
        r.charge = 0;
    }
    r.grab = 0;
    r.grab_ticks = 0;

    r.yaw = wrap_angle(r.yaw + r.yaw_rate * DT);
    r.pos += v * DT;
    r.vel = v;
    let (pitch0, roll0) = (r.pitch, r.roll);

    if pop > 0.0 {
        r.vel += n * pop;
        take_off(r, input);
        return;
    }
    let (h1, n1) = run.sample(r.pos.x, r.pos.z);
    let gap = r.pos.y - h1;
    // Leave the snow where it falls away faster than gravity can follow.
    if gap > MIN_GAP && 2.0 * gap / (DT * DT) > GRAVITY * n.y {
        take_off(r, input);
        return;
    }
    r.pos.y = h1;
    let speed = r.vel.length();
    let along = r.vel - n1 * r.vel.dot(n1);
    r.vel = along.normalize_or(Vec3::ZERO) * speed;

    let (pitch, roll) = snow_attitude(r.yaw, n1);
    let lean = if bailing {
        0.0
    } else {
        clamp(atan(speed * -r.yaw_rate / GRAVITY), -MAX_LEAN, MAX_LEAN)
    };
    r.pitch = pitch;
    r.roll = roll + lean;
    r.pitch_rate = clamp(
        wrap_pi(r.pitch - pitch0) / DT,
        -TAKEOFF_ROTATION,
        TAKEOFF_ROTATION,
    );
    r.roll_rate = clamp(
        wrap_pi(r.roll - roll0) / DT,
        -TAKEOFF_ROTATION,
        TAKEOFF_ROTATION,
    );
    r.air_spin = 0.0;
    settle(r, true);
}

fn take_off(r: &mut Rider, input: Input) {
    r.air_spin = 0.0;
    if input.pressed(buttons::GRAB) {
        r.grab = grab_from_stick(input.steer_f(), input.lean_f());
    }
    settle(r, false);
}

/// One tick in the air.
fn fly(r: &mut Rider, input: Input, run: &Run) -> Option<Landing> {
    let steer = input.steer_f();
    let lean = input.lean_f();
    let bailing = r.bailing();
    let speed_h = r.speed();
    let travel = if speed_h > 3.0 {
        atan2(r.vel.x, r.vel.z)
    } else {
        r.yaw
    };

    // A loaded pop let go just after leaving the snow still pops.
    if r.charge > 0 && !input.pressed(buttons::JUMP) {
        if r.state_ticks < LATE_POP_TICKS {
            let pop = POP_MIN + (POP_MAX - POP_MIN) * f32::from(r.charge) / f32::from(CHARGE_TICKS);
            r.vel.y += pop;
        }
        r.charge = 0;
    } else if r.state_ticks >= LATE_POP_TICKS {
        r.charge = 0;
    }

    // Grabs: the stick picks one as the button goes down.
    if input.pressed(buttons::GRAB) && !bailing {
        if r.grab == 0 || !r.last_input.pressed(buttons::GRAB) {
            r.grab = grab_from_stick(steer, lean);
        }
        r.grab_ticks = r.grab_ticks.saturating_add(1);
    }

    // The snow below, to level the board with.
    let (_, below) = run.sample(r.pos.x, r.pos.z);
    let (snow_pitch, _) = snow_attitude(r.yaw, below);

    let mut pitch_acc;
    let roll_acc;
    if input.pressed(buttons::TRICK) && !bailing {
        let spin = -steer * SPIN_RATE;
        let flip = -lean * FLIP_RATE;
        r.yaw_rate += (spin - r.yaw_rate) * clamp(TRICK_RESPONSE * DT, 0.0, 1.0);
        pitch_acc = (flip - r.pitch_rate) * TRICK_RESPONSE;
        roll_acc = -AIR_ROLL_STIFFNESS * (r.roll - TAU * round(r.roll / TAU))
            - AIR_ROLL_DAMP * r.roll_rate;
    } else {
        // Let go: finish toward the nearest way to land, forward or switch,
        // carrying on the way it was turning.
        let rel = angle_diff(travel, r.yaw);
        let nearest = if rel.abs() < PI * 0.5 {
            0.0
        } else if rel > 0.0 {
            PI
        } else {
            -PI
        };
        let to = if (rel - nearest).abs() < FINISH_NEAR {
            nearest
        } else if r.yaw_rate > FINISH_RATE {
            if rel <= 0.0 { 0.0 } else { PI }
        } else if r.yaw_rate < -FINISH_RATE {
            if rel >= 0.0 { 0.0 } else { -PI }
        } else {
            nearest
        };
        let yaw_acc =
            AIR_ALIGN * (to - rel) - AIR_ALIGN_DAMP * (r.yaw_rate + steer * AIR_STEER_RATE);
        r.yaw_rate += yaw_acc * DT;
        let q = (r.pitch - snow_pitch) / TAU;
        let whole = if r.pitch_rate > FINISH_RATE {
            libm::ceilf(q)
        } else if r.pitch_rate < -FINISH_RATE {
            libm::floorf(q)
        } else {
            round(q)
        };
        let pitch_target = snow_pitch + TAU * whole;
        pitch_acc = AIR_PITCH_STIFFNESS * (pitch_target - r.pitch) - AIR_PITCH_DAMP * r.pitch_rate;
        roll_acc = -AIR_ROLL_STIFFNESS * (r.roll - TAU * round(r.roll / TAU))
            - AIR_ROLL_DAMP * r.roll_rate;
    }
    if bailing {
        pitch_acc = -AIR_PITCH_DAMP * r.pitch_rate;
    }

    let sp = r.vel.length();
    r.vel.y -= GRAVITY * DT;
    if sp > 1e-4 {
        r.vel = r.vel * (1.0 - (AIR_DRAG * sp * DT).min(1.0));
    }
    r.pitch_rate += pitch_acc * DT;
    r.roll_rate += roll_acc * DT;
    r.yaw = wrap_angle(r.yaw + r.yaw_rate * DT);
    r.pitch += r.pitch_rate * DT;
    r.roll += r.roll_rate * DT;
    r.air_spin += r.yaw_rate * DT;
    r.pos += r.vel * DT;

    let (h, n) = run.sample(r.pos.x, r.pos.z);
    if r.pos.y > h {
        settle(r, false);
        return None;
    }
    r.pos.y = h;
    let into = r.vel.dot(n);
    if into < 0.0 {
        r.vel -= n * into;
    }
    let landing = judge(r, input, n, -into);
    settle(r, true);
    landing
}

/// Judges a touchdown, scores it, and puts the board flat on the snow.
fn judge(r: &mut Rider, input: Input, n: Vec3, impact: f32) -> Option<Landing> {
    let spin = -(clamp(round(r.air_spin / PI), -18.0, 18.0) as i8);
    let (snow_pitch, snow_roll) = snow_attitude(r.yaw, n);
    let flip = clamp(round((r.pitch - snow_pitch) / TAU), -9.0, 9.0) as i8;
    let pitch_err = wrap_pi(r.pitch - snow_pitch);
    let roll_err = wrap_pi(r.roll - snow_roll);
    let travel = atan2(r.vel.x, r.vel.z);
    let rel = angle_diff(travel, r.yaw).abs();
    let heading_err = if r.speed() > 3.0 {
        rel.min(PI - rel)
    } else {
        0.0
    };
    let grab = r.grab;
    let grab_ticks = r.grab_ticks;
    let air_ticks = r.state_ticks;
    let grabbing = input.pressed(buttons::GRAB) && grab != 0;

    r.pitch = snow_pitch;
    r.roll = snow_roll;
    r.pitch_rate = 0.0;
    r.roll_rate = 0.0;
    r.air_spin = 0.0;
    r.grab = 0;
    r.grab_ticks = 0;
    r.charge = 0;

    if r.bailing() || air_ticks < MIN_JUDGED_AIR_TICKS {
        return None;
    }
    if grabbing
        || heading_err > LAND_HEADING
        || pitch_err.abs() > LAND_PITCH
        || roll_err.abs() > LAND_ROLL
        || impact > HARD_LANDING
    {
        fall(r);
        return Some(Landing::Bail);
    }
    let grab_ticks = if grab_ticks >= MIN_GRAB_TICKS {
        grab_ticks
    } else {
        0
    };
    if spin == 0 && flip == 0 && grab_ticks == 0 {
        return None;
    }
    Some(Landing::Clean(Trick {
        spin,
        flip,
        roll: 0,
        grab: if grab_ticks > 0 { grab } else { 0 },
        grab_ticks,
        points: points(spin, flip, grab_ticks),
    }))
}

fn settle(r: &mut Rider, grounded: bool) {
    r.state_ticks = if grounded == r.grounded {
        r.state_ticks.saturating_add(1)
    } else {
        0
    };
    r.grounded = grounded;
}

/// Height a rider stands at on the snow.
pub fn rest_height(run: &Run, x: f32, z: f32) -> f32 {
    run.height(x, z)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot::bot_input;
    use crate::mountain::{Feature, RUN};
    use crate::race::{self, EventKind, Phase, SimEvent};
    use crate::{CourseId, Inputs, MAX_RIDERS, SurfaceKind, World};

    /// A mountain world with one rider free riding (the room never moves on
    /// to a race unless the test lets it).
    fn world() -> World {
        let mut w = World::on_course(CourseId::Mountain, SurfaceKind::Flat, 0);
        w.spawn(0);
        w
    }

    /// Puts rider `slot` on the run at `(s, offset)`, heading down it at `speed`.
    fn place(w: &mut World, slot: usize, s: f32, offset: f32, speed: f32) {
        let f = RUN.centerline(s);
        let (x, z) = f.at_offset(offset);
        let mut r = w.riders[slot].unwrap();
        r.pos = Vec3::new(x, RUN.height(x, z), z);
        r.yaw = f.yaw;
        r.vel = r.forward() * speed;
        r.grounded = true;
        r.quantize();
        w.riders[slot] = Some(r);
    }

    /// Steers rider 0 down the run's centre line (offset `lane`), adding `lean`
    /// and `buttons`.
    fn follow(w: &World, lane: f32, lean: f32, buttons: u8) -> Input {
        let r = w.riders[0].unwrap();
        let (s, _) = RUN.project(r.pos.x, r.pos.z);
        let (tx, tz) = RUN.centerline(s + 10.0 + r.speed() * 0.5).at_offset(lane);
        let heading = if r.speed() > 3.0 {
            atan2(r.vel.x, r.vel.z)
        } else {
            r.yaw
        };
        let steer = clamp(
            -angle_diff(heading, atan2(tx - r.pos.x, tz - r.pos.z)) * 2.0,
            -1.0,
            1.0,
        );
        Input::from_analog(steer, 0.0, lean, buttons)
    }

    /// Steps the world with `drive` choosing rider 0's input, holding the
    /// room in free ride. Returns the events.
    fn run(w: &mut World, ticks: u32, mut drive: impl FnMut(&World) -> Input) -> Vec<SimEvent> {
        let mut inputs: Inputs = [None; MAX_RIDERS];
        let mut events = Vec::new();
        for _ in 0..ticks {
            w.race.phase_tick = w.tick;
            inputs[0] = Some(drive(w));
            events.extend(w.step(&inputs));
        }
        events
    }

    fn tricks(events: &[SimEvent]) -> Vec<EventKind> {
        events
            .iter()
            .map(|e| e.kind)
            .filter(|k| matches!(k, EventKind::Trick { .. } | EventKind::Bail))
            .collect()
    }

    #[test]
    fn gravity_takes_you_down_and_tucking_is_faster() {
        let mut top = Vec::new();
        for lean in [0.0, 1.0] {
            let mut w = world();
            place(&mut w, 0, 100.0, 0.0, 5.0);
            run(&mut w, 60 * 9, |w| follow(w, 0.0, lean, 0));
            let r = w.riders[0].unwrap();
            assert!(r.grounded && !r.bailing());
            top.push(r.speed());
        }
        assert!(
            top[0] > 18.0 && top[0] < 30.0,
            "standing tall: {} m/s",
            top[0]
        );
        assert!(
            top[1] > top[0] + 1.0,
            "tucked {} vs tall {}",
            top[1],
            top[0]
        );
    }

    #[test]
    fn sitting_back_brakes() {
        let mut w = world();
        place(&mut w, 0, 120.0, 0.0, 25.0);
        run(&mut w, 60 * 2, |w| follow(w, 0.0, -1.0, 0));
        assert!(w.riders[0].unwrap().speed() < 12.0, "{:?}", w.riders[0]);
    }

    #[test]
    fn a_stopped_rider_skates_off_the_flat() {
        let mut w = world();
        place(&mut w, 0, 10.0, 0.0, 0.0);
        run(&mut w, 60 * 3, |w| follow(w, 0.0, 1.0, 0));
        let r = w.riders[0].unwrap();
        assert!(RUN.project(r.pos.x, r.pos.z).0 > 18.0, "{r:?}");
    }

    #[test]
    fn carving_turns_without_scrubbing_speed() {
        let mut straight = world();
        let mut carved = world();
        place(&mut straight, 0, 140.0, 0.0, 20.0);
        place(&mut carved, 0, 140.0, 0.0, 20.0);
        let yaw0 = carved.riders[0].unwrap().yaw;
        run(&mut straight, 45, |_| Input::default());
        run(&mut carved, 45, |_| Input::from_analog(1.0, 0.0, 0.0, 0));
        let (a, b) = (straight.riders[0].unwrap(), carved.riders[0].unwrap());
        // Turned right (yaw down), and the velocity followed the board.
        assert!(
            angle_diff(yaw0, b.yaw) < -0.3,
            "{}",
            angle_diff(yaw0, b.yaw)
        );
        let slip = angle_diff(b.yaw, atan2(b.vel.x, b.vel.z));
        assert!(slip.abs() < 0.15, "slipping {slip}");
        assert!(
            b.speed() > a.speed() * 0.85,
            "{} vs {}",
            b.speed(),
            a.speed()
        );
        assert!(b.roll > 0.1, "leans into the turn: {}", b.roll);
    }

    #[test]
    fn holding_the_jump_loads_a_bigger_pop() {
        let mut airtimes = Vec::new();
        for load in [4u32, u32::from(CHARGE_TICKS)] {
            let mut w = world();
            place(&mut w, 0, 12.0, 0.0, 2.0);
            let mut t = 0;
            let mut air = 0;
            run(&mut w, 120, |w| {
                t += 1;
                if !w.riders[0].unwrap().grounded {
                    air += 1;
                }
                Input::from_analog(0.0, 0.0, 0.0, if t <= load { buttons::JUMP } else { 0 })
            });
            airtimes.push(air);
        }
        assert!(airtimes[0] >= 15, "a quick pop still hops: {airtimes:?}");
        assert!(airtimes[1] > airtimes[0] + 10, "{airtimes:?}");
        // A full pop on the flat is about 2 * POP_MAX / g.
        let full = 2.0 * POP_MAX / GRAVITY * 60.0;
        assert!(
            (airtimes[1] as f32 - full).abs() < 8.0,
            "{airtimes:?} vs {full}"
        );
    }

    /// The first table: (s of the lip).
    fn table_lip() -> f32 {
        RUN.features
            .iter()
            .find_map(|f| match *f {
                Feature::Table { s, ramp, .. } => Some(s + ramp),
                _ => None,
            })
            .unwrap()
    }

    /// Rides at the first table, pops at the lip, and lets `air` drive in
    /// the air. Returns the events and the rider once it is down.
    fn table_jump(mut air: impl FnMut(&Rider) -> Input) -> (Vec<SimEvent>, Rider) {
        let lip = table_lip();
        let mut w = world();
        place(&mut w, 0, lip - 40.0, 0.0, 24.0);
        let (mut flew, mut landed) = (false, false);
        let events = run(&mut w, 60 * 5, |w| {
            let r = w.riders[0].unwrap();
            if r.grounded {
                landed |= flew;
                let (s, _) = RUN.project(r.pos.x, r.pos.z);
                let load = !flew && lip - s < 14.0 && lip - s > r.speed() * DT * 1.5;
                follow(w, 0.0, 0.0, if load { buttons::JUMP } else { 0 })
            } else if landed {
                Input::default()
            } else {
                flew = true;
                air(&r)
            }
        });
        assert!(flew);
        (events, w.riders[0].unwrap())
    }

    #[test]
    fn tables_and_pops_give_real_air() {
        let lip = table_lip();
        let mut w = world();
        place(&mut w, 0, lip - 40.0, 0.0, 24.0);
        let (mut air, mut longest) = (0, 0);
        run(&mut w, 60 * 4, |w| {
            let r = w.riders[0].unwrap();
            air = if r.grounded { 0 } else { air + 1 };
            longest = longest.max(air);
            follow(w, 0.0, 0.0, 0)
        });
        assert!(longest > 50, "off the table without a pop: {longest} ticks");
        let mut popped = 0;
        let (ev, r) = table_jump(|_| {
            popped += 1;
            Input::default()
        });
        assert!(
            popped > longest + 15,
            "a pop at the lip: {popped} vs {longest}"
        );
        assert!(tricks(&ev).is_empty(), "a plain jump is no trick: {ev:?}");
        assert!(!r.bailing() && r.speed() > 15.0, "{r:?}");
    }

    #[test]
    fn a_360_lands_clean_and_scores_points() {
        let (ev, r) = table_jump(|r| {
            if r.air_spin.abs() < 0.8 * TAU {
                Input::from_analog(1.0, 0.0, 0.0, buttons::TRICK)
            } else {
                Input::default()
            }
        });
        let t = tricks(&ev);
        let [EventKind::Trick { trick, meter: 0 }] = t[..] else {
            panic!("{t:?}");
        };
        assert_eq!((trick.spin.abs(), trick.flip), (2, 0));
        assert_eq!(trick.points, points(2, 0, 0));
        assert!(!r.bailing());
        // Riding on forward: board along the direction of travel.
        let rel = angle_diff(atan2(r.vel.x, r.vel.z), r.yaw).abs();
        assert!(rel < 0.5, "{rel}");
    }

    #[test]
    fn a_180_lands_switch() {
        let (ev, r) = table_jump(|r| {
            if r.air_spin.abs() < 0.35 * TAU {
                Input::from_analog(-1.0, 0.0, 0.0, buttons::TRICK)
            } else {
                Input::default()
            }
        });
        let t = tricks(&ev);
        let [EventKind::Trick { trick, .. }] = t[..] else {
            panic!("{t:?}");
        };
        assert_eq!(trick.spin.abs(), 1);
        // Riding on backwards (fakie).
        let rel = angle_diff(atan2(r.vel.x, r.vel.z), r.yaw).abs();
        assert!(rel > PI - 0.5, "{rel}");
    }

    #[test]
    fn landing_sideways_is_a_fall() {
        // Spin a quarter turn and hold it there.
        let (ev, r) = table_jump(|r| {
            let steer = if r.air_spin.abs() < 0.25 * TAU {
                1.0
            } else {
                0.0
            };
            Input::from_analog(steer, 0.0, 0.0, buttons::TRICK)
        });
        assert_eq!(tricks(&ev), [EventKind::Bail]);
        assert!(r.bailing() || r.speed() < 15.0);
    }

    #[test]
    fn grabs_score_if_let_go_before_landing() {
        // Grab for most of the jump and let go: a clean grab.
        let mut t = 0;
        let (ev, _) = table_jump(|_| {
            t += 1;
            let grab = if t < 40 { buttons::GRAB } else { 0 };
            Input::from_analog(0.0, 0.0, 1.0, grab)
        });
        let k = tricks(&ev);
        let [EventKind::Trick { trick, .. }] = k[..] else {
            panic!("{k:?}");
        };
        assert_eq!(trick.grab, grabs::NOSE);
        assert!(trick.grab_ticks >= 30 && trick.points > 0, "{trick:?}");
        // Still grabbing when the snow comes back: a fall.
        let (ev, _) = table_jump(|_| Input::from_analog(0.0, 0.0, 0.0, buttons::GRAB));
        assert_eq!(tricks(&ev), [EventKind::Bail]);
    }

    #[test]
    fn hitting_a_tower_knocks_you_down() {
        let tower = RUN.obstacles()[0];
        assert_eq!(tower.kind, crate::mountain::ObstacleKind::Tower);
        let mut w = world();
        let s = RUN.project(tower.x, tower.z).0;
        place(&mut w, 0, s - 15.0, 0.0, 20.0);
        let mut r = w.riders[0].unwrap();
        r.yaw = wrap_angle(atan2(tower.x - r.pos.x, tower.z - r.pos.z));
        r.vel = r.forward() * 20.0;
        w.riders[0] = Some(r);
        let ev = run(&mut w, 120, |_| Input::default());
        assert!(ev.iter().any(|e| e.kind == EventKind::Bail), "{ev:?}");
    }

    #[test]
    fn the_run_holds_riders_in() {
        let mut w = world();
        for slot in 1..MAX_RIDERS {
            w.spawn(slot);
        }
        let mut rng = crate::math::Pcg32::new(7);
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for _ in 0..60 * 40 {
            w.race.phase_tick = w.tick;
            for i in inputs.iter_mut() {
                *i = Some(Input::from_analog(
                    rng.range(-1.0, 1.0),
                    0.0,
                    rng.range(-0.3, 1.0),
                    (rng.next_u32() & 0x0F) as u8,
                ));
            }
            w.step(&inputs);
            for r in w.riders.iter().flatten() {
                assert!(r.pos.y.is_finite() && r.vel.length().is_finite(), "{r:?}");
                let (s, off) = RUN.project(r.pos.x, r.pos.z);
                assert!(off.abs() < RUN.limit(s) + 0.5, "left the run: {r:?}");
                let h = RUN.height(r.pos.x, r.pos.z);
                assert!(r.pos.y > h - 0.05 && r.pos.y < h + 15.0, "{r:?} over {h}");
            }
        }
        let mut q = w.riders[0].unwrap();
        q.quantize();
        assert_eq!(Some(q), w.riders[0]);
    }

    #[test]
    fn bots_race_down_the_run_and_the_room_starts_over() {
        let mut w = World::on_course(CourseId::Mountain, SurfaceKind::Flat, 0);
        for slot in 0..MAX_RIDERS {
            w.spawn(slot);
        }
        let mut inputs: Inputs = [None; MAX_RIDERS];
        let mut checkpoints = 0;
        let mut finishes = Vec::new();
        for _ in 0..60 * 60 * 4 {
            for (slot, i) in inputs.iter_mut().enumerate() {
                *i = Some(bot_input(&w, slot));
            }
            for e in w.step(&inputs) {
                match e.kind {
                    EventKind::Checkpoint { .. } if w.race.phase == Phase::Racing => {
                        checkpoints += 1
                    }
                    EventKind::Finish { ticks } => finishes.push(ticks),
                    _ => {}
                }
            }
            if w.race.phase == Phase::Results {
                break;
            }
        }
        assert_eq!(w.race.phase, Phase::Results, "the race never ended");
        assert_eq!(finishes.len(), MAX_RIDERS, "everyone finishes");
        assert_eq!(checkpoints, MAX_RIDERS * RUN.checkpoints.len());
        let best = *finishes.iter().min().unwrap();
        assert!((60 * 70..60 * 120).contains(&best), "{best} ticks");
        let standings = w.standings();
        for pair in standings.windows(2) {
            assert!(pair[0].progress.finish_ticks <= pair[1].progress.finish_ticks);
        }
        assert!(
            standings.iter().any(|s| s.progress.points > 0),
            "bots score tricks"
        );
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for _ in 0..race::tuning::RESULTS_TICKS {
            for (slot, i) in inputs.iter_mut().enumerate() {
                *i = Some(bot_input(&w, slot));
            }
            w.step(&inputs);
        }
        assert_eq!(w.race.phase, Phase::Warmup);
    }

    #[test]
    fn the_countdown_holds_riders_at_the_top() {
        let mut w = World::on_course(CourseId::Mountain, SurfaceKind::Flat, 0);
        w.spawn(0);
        w.spawn(5);
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for _ in 0..race::tuning::WARMUP_TICKS + 30 {
            inputs[0] = Some(Input::from_analog(0.3, 0.0, 1.0, 0));
            inputs[5] = Some(Input::from_analog(-0.3, 0.0, 1.0, 0));
            w.step(&inputs);
        }
        assert_eq!(w.race.phase, Phase::Countdown);
        for slot in [0, 5] {
            let r = w.riders[slot].unwrap();
            let spot = w.course().grid_spot(slot);
            assert!((r.pos.x - spot.x).abs() < 0.01 && (r.pos.z - spot.z).abs() < 0.01);
            assert!((r.pos.y - RUN.height(spot.x, spot.z)).abs() < 0.01);
            assert!(r.race.racing && r.speed() == 0.0);
        }
    }
}
