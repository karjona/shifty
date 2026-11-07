//! Prints how the jetski behaves on flat water and on swells: draft, top
//! speed, how turns build up, how long tricks take off a ramp, how often and
//! how high crests launch you, and how deep the hull dives. For tuning.
//!
//! `cargo run -p sim --example jetski_lab --release [seed] [surface]`
//! (surface: 1 = the course's sea, 2 = calm, 3 = rough)

use sim::course::OVAL;
use sim::math::{angle_diff, clamp};
use sim::{CourseId, Input, Inputs, MAX_RIDERS, Surface, SurfaceKind, World};

struct Run {
    air_frac: f32,
    launches: [u32; 4],
    max_air_s: f32,
    max_height: f32,
    max_depth: f32,
    mean_speed: f32,
    max_pitch: f32,
    max_roll: f32,
}

fn run(
    surface: Surface,
    heading: f32,
    lean_back_on_rise: bool,
    secs: u32,
    steer_wiggle: bool,
) -> Run {
    let mut w = World::new(CourseId::Oval, surface);
    w.spawn(0);
    w.ride_free();
    let mut r = w.riders[0].unwrap();
    r.yaw = heading;
    let start = OVAL.centerline(150.0).at_offset(-20.0);
    r.pos.x = start.0;
    r.pos.z = start.1;
    w.riders[0] = Some(r);
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let (mut air, mut total) = (0u32, 0u32);
    let mut launches = [0u32; 4];
    let mut cur_air = 0u32;
    let (mut max_air, mut max_h, mut speed_sum) = (0u32, 0.0f32, 0.0f32);
    let mut max_depth = 0.0f32;
    // Ticks since the last jump back (the water under the hull changes).
    let mut since_jump = 0u32;
    let (mut max_pitch, mut max_roll) = (0.0f32, 0.0f32);
    for t in 0..secs * 60 {
        let r = w.riders[0].unwrap();
        let target = if steer_wiggle {
            heading + 0.5 * libm::sinf(t as f32 / 90.0)
        } else {
            heading
        };
        let steer = clamp(angle_diff(r.yaw, target) * -2.0, -1.0, 1.0);
        let lean = if lean_back_on_rise && r.grounded && r.vel.y > 1.0 {
            -1.0
        } else {
            0.0
        };
        inputs[0] = Some(Input::from_analog(steer, 1.0, lean, 0));
        w.step(&inputs);
        let mut r = w.riders[0].unwrap();
        // Stay in the open water of the first straight, clear of the walls:
        // jump back (the sea is endless anyway).
        let before = (r.pos.x, r.pos.z);
        if r.pos.x.abs() > 130.0 {
            r.pos.x -= 260.0 * r.pos.x.signum();
        }
        if r.pos.z > -18.0 {
            r.pos.z -= 58.0;
        } else if r.pos.z < -80.0 {
            r.pos.z += 58.0;
        }
        since_jump += 1;
        if before != (r.pos.x, r.pos.z) {
            since_jump = 0;
        }
        if r.grounded && since_jump == 0 {
            r.pos.y = r
                .pos
                .y
                .max(w.surface.height(r.pos.x, r.pos.z, w.tick) - 0.6);
        }
        w.riders[0] = Some(r);
        assert!(r.pos.y.is_finite() && r.vel.y.is_finite(), "NaN");
        if t > 180 {
            total += 1;
            speed_sum += r.speed();
            max_pitch = max_pitch.max(r.pitch.abs());
            max_roll = max_roll.max(r.roll.abs());
            let h = w.surface.height(r.pos.x, r.pos.z, w.tick);
            max_h = max_h.max(r.pos.y - h);
            if since_jump > 60 {
                max_depth = max_depth.max(h - r.pos.y);
            }
            if !r.grounded {
                air += 1;
                cur_air += 1;
            } else if cur_air > 0 {
                let s = cur_air as f32 / 60.0;
                let b = if s >= 1.2 {
                    3
                } else if s >= 0.7 {
                    2
                } else if s >= 0.3 {
                    1
                } else {
                    0
                };
                launches[b] += 1;
                max_air = max_air.max(cur_air);
                cur_air = 0;
            }
        }
    }
    Run {
        air_frac: air as f32 / total as f32,
        launches,
        max_air_s: max_air as f32 / 60.0,
        max_height: max_h,
        max_depth,
        mean_speed: speed_sum / total as f32,
        max_pitch: max_pitch.to_degrees(),
        max_roll: max_roll.to_degrees(),
    }
}

fn main() {
    let seed: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    // Flat water: draft and settling.
    let mut w = World::new(CourseId::Oval, Surface::flat());
    w.spawn(0);
    w.ride_free();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    inputs[0] = Some(Input::default());
    for _ in 0..120 {
        w.step(&inputs);
    }
    let r = w.riders[0].unwrap();
    println!(
        "flat rest: y {:.3} pitch {:.2}° roll {:.2}° vy {:.3}",
        r.pos.y,
        r.pitch.to_degrees(),
        r.roll.to_degrees(),
        r.vel.y
    );
    let f = run(Surface::flat(), 0.0, false, 20, false);
    println!(
        "flat full throttle: speed {:.1} air {:.1}% max pitch {:.1}° roll {:.1}°",
        f.mean_speed,
        f.air_frac * 100.0,
        f.max_pitch,
        f.max_roll
    );
    let f = run(Surface::flat(), 0.0, false, 20, true);
    println!(
        "flat carving: speed {:.1} air {:.1}% max pitch {:.1}° roll {:.1}°",
        f.mean_speed,
        f.air_frac * 100.0,
        f.max_pitch,
        f.max_roll
    );

    turning();
    tricks();

    let kind = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .and_then(SurfaceKind::from_u8)
        .unwrap_or(SurfaceKind::Swells);
    let s = OVAL.surface(kind, seed);
    let main_dir = libm::atan2f(s.waves()[0].dir_x, s.waves()[0].dir_z);
    for w in s.waves() {
        println!(
            "wave: λ {:.1} m, height {:.2} m, steep {:.3}, sharp {}, speed {:.1} m/s",
            std::f32::consts::TAU / w.k,
            2.0 * w.amplitude,
            w.amplitude * w.k,
            w.sharpness,
            w.omega / w.k
        );
    }
    println!(
        "{:>14} {:>5} {:>6} {:>18} {:>6} {:>6} {:>6} {:>6} {:>6}",
        "heading", "pop", "air%", "hops<.3/.7/1.2/+", "maxair", "maxh", "dive", "pitch", "roll"
    );
    for (name, off) in [
        ("into swell", std::f32::consts::PI),
        ("with swell", 0.0),
        ("across", std::f32::consts::FRAC_PI_2),
        ("diagonal in", 2.3),
    ] {
        for pop in [false, true] {
            let r = run(s.clone(), main_dir + off, pop, 60, false);
            println!(
                "{:>14} {:>5} {:>5.1}% {:>18} {:>5.2}s {:>5.2}m {:>5.2}m {:>5.0}° {:>5.0}°  v {:.1}",
                name,
                pop,
                r.air_frac * 100.0,
                format!(
                    "{}/{}/{}/{}",
                    r.launches[0], r.launches[1], r.launches[2], r.launches[3]
                ),
                r.max_air_s,
                r.max_height,
                r.max_depth,
                r.max_pitch,
                r.max_roll,
                r.mean_speed
            );
        }
    }
}

/// Full lock at top speed on flat water: how fast the turn builds, how
/// tight it gets, what it costs, and how long it carries on after letting go.
fn turning() {
    let mut w = World::new(CourseId::Oval, Surface::flat());
    w.spawn(0);
    w.ride_free();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    inputs[0] = Some(Input::from_analog(0.0, 1.0, 0.0, 0));
    for _ in 0..60 * 8 {
        w.step(&inputs);
    }
    let v0 = w.riders[0].unwrap().speed();
    inputs[0] = Some(Input::from_analog(1.0, 1.0, 0.0, 0));
    let mut rates = Vec::new();
    for _ in 0..60 * 3 {
        w.step(&inputs);
        rates.push(w.riders[0].unwrap().yaw_rate.abs());
    }
    let r = w.riders[0].unwrap();
    let steady = r.yaw_rate.abs();
    let build = rates.iter().position(|&y| y >= 0.9 * steady).unwrap_or(0);
    inputs[0] = Some(Input::from_analog(0.0, 1.0, 0.0, 0));
    let mut carry = 0;
    while w.riders[0].unwrap().yaw_rate.abs() > 0.1 * steady && carry < 600 {
        w.step(&inputs);
        carry += 1;
    }
    println!(
        "full lock at {:.1} m/s: {:.0}°/s after {:.2}s, radius {:.1} m, speed {:.1}, keeps turning {:.2}s after release",
        v0,
        steady.to_degrees(),
        build as f32 / 60.0,
        r.speed() / steady,
        r.speed(),
        carry as f32 / 60.0
    );
}

/// Off the first ramp at near top speed (pulling back up it): airtime, and
/// for each trick (held to three quarters of a turn, then released) how long
/// a full turn takes and how it lands.
fn tricks() {
    use sim::math::{TAU, Vec3};
    use sim::race::EventKind;
    use sim::{Rider, buttons};
    let jump = |in_air: &dyn Fn(&Rider) -> Input| {
        let ramp = OVAL.ramps[0];
        let mut w = World::new(CourseId::Oval, Surface::flat());
        w.spawn(0);
        w.ride_free();
        let f = OVAL.centerline(ramp.s - 40.0);
        let (x, z) = f.at_offset(ramp.offset);
        let mut r = w.riders[0].unwrap();
        r.pos = Vec3::new(x, -sim::jetski::tuning::DRAFT, z);
        r.yaw = f.yaw;
        r.vel = r.forward() * sim::jetski::tuning::MAX_SPEED * 0.9;
        r.race.next_gate = 9;
        r.quantize();
        w.riders[0] = Some(r);
        let mut inputs: Inputs = [None; MAX_RIDERS];
        let (mut air, mut turned, mut result) = (0u32, None, "no trick");
        for t in 0..60 * 5 {
            let r = w.riders[0].unwrap();
            inputs[0] = Some(if r.grounded {
                Input::from_analog(0.0, 1.0, -1.0, 0)
            } else {
                air += 1;
                in_air(&r)
            });
            let spun = r.air_spin.abs().max(r.pitch.abs()).max(r.roll.abs());
            if turned.is_none() && !r.grounded && spun >= TAU {
                turned = Some(air);
            }
            for e in w.step(&inputs) {
                match e.kind {
                    EventKind::Trick { .. } => result = "clean",
                    EventKind::Bail => result = "bail",
                    _ => {}
                }
            }
            if air > 0 && w.riders[0].unwrap().grounded && t > 60 {
                break;
            }
        }
        (air, turned, result)
    };
    let (air, _, _) = jump(&|_| Input::from_analog(0.0, 1.0, 0.0, 0));
    println!("ramp jump: {:.2}s in the air", air as f32 / 60.0);
    let held = |b: u8, steer: f32, lean: f32, angle: fn(&Rider) -> f32| {
        move |r: &Rider| {
            if angle(r).abs() < 0.75 * TAU {
                Input::from_analog(steer, 1.0, lean, b)
            } else {
                Input::from_analog(0.0, 1.0, 0.0, 0)
            }
        }
    };
    for (name, b, steer, lean, angle) in [
        (
            "spin",
            buttons::TRICK,
            1.0,
            0.0,
            (|r: &Rider| r.air_spin) as fn(&Rider) -> f32,
        ),
        ("backflip", buttons::TRICK, 0.0, -1.0, |r: &Rider| r.pitch),
        ("barrel roll", buttons::ROLL, -1.0, 0.0, |r: &Rider| r.roll),
    ] {
        let (_, turned, result) = jump(&held(b, steer, lean, angle));
        match turned {
            Some(t) => println!(
                "  {name}: full turn after {:.2}s, {result}",
                t as f32 / 60.0
            ),
            None => println!("  {name}: never made a full turn, {result}"),
        }
    }
}
