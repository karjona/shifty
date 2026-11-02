//! Prints how the jetski behaves on flat water and on swells: draft, top
//! speed, and how often and how high crests launch you. For tuning.
//!
//! `cargo run -p sim --example jetski_lab --release [seed]`

use sim::math::{angle_diff, clamp};
use sim::{Input, Inputs, MAX_RIDERS, Surface, SurfaceKind, World};

struct Run {
    air_frac: f32,
    launches: [u32; 4],
    max_air_s: f32,
    max_height: f32,
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
    let mut w = World::new(surface);
    w.spawn(0);
    let mut r = w.riders[0].unwrap();
    r.yaw = heading;
    w.riders[0] = Some(r);
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let (mut air, mut total) = (0u32, 0u32);
    let mut launches = [0u32; 4];
    let mut cur_air = 0u32;
    let (mut max_air, mut max_h, mut speed_sum) = (0u32, 0.0f32, 0.0f32);
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
        // Stay clear of the arena walls: jump back (the sea is endless anyway).
        if r.pos.x.abs() > 90.0 {
            r.pos.x -= 160.0 * r.pos.x.signum();
        }
        if r.pos.z.abs() > 90.0 {
            r.pos.z -= 160.0 * r.pos.z.signum();
        }
        if r.grounded {
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
    let mut w = World::new(Surface::flat());
    w.spawn(0);
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

    let s = Surface::new(SurfaceKind::Swells, seed);
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
        "{:>14} {:>5} {:>6} {:>18} {:>6} {:>6} {:>6} {:>6}",
        "heading", "pop", "air%", "hops<.3/.7/1.2/+", "maxair", "maxh", "pitch", "roll"
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
                "{:>14} {:>5} {:>5.1}% {:>18} {:>5.2}s {:>5.2}m {:>5.0}° {:>5.0}°  v {:.1}",
                name,
                pop,
                r.air_frac * 100.0,
                format!(
                    "{}/{}/{}/{}",
                    r.launches[0], r.launches[1], r.launches[2], r.launches[3]
                ),
                r.max_air_s,
                r.max_height,
                r.max_pitch,
                r.max_roll,
                r.mean_speed
            );
        }
    }
}
