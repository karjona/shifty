//! Pure game logic: physics, rules, scoring. No I/O, no clocks, no threads.
//!
//! Compiled natively for the race server and to WASM for client-side
//! prediction. Every float operation must give bit-identical results on both,
//! so: no SIMD math crates, no platform libm (use `math::*`), no `mul_add`,
//! no iteration over hash maps.

pub mod bot;
pub mod input;
pub mod jetski;
pub mod math;
pub mod quant;
pub mod surface;
pub mod world;

pub use input::{Input, buttons};
pub use math::Vec3;
pub use surface::{Surface, SurfaceKind};
pub use world::{Inputs, Rider, World};

/// Hash of the sim's source code (see `build.rs`). Client and server must
/// agree on it, or prediction would silently drift.
pub const SIM_VERSION: u32 = parse_u32(env!("SIM_SOURCE_HASH"));

const fn parse_u32(s: &str) -> u32 {
    let b = s.as_bytes();
    let mut i = 0;
    let mut v: u32 = 0;
    while i < b.len() {
        v = v * 10 + (b[i] - b'0') as u32;
        i += 1;
    }
    v
}

/// Simulation rate. Inputs and snapshots are numbered in these ticks.
pub const TICK_HZ: u32 = 60;
pub const DT: f32 = 1.0 / TICK_HZ as f32;

/// Rider slots per room (humans + bots). Snapshots are budgeted for this.
pub const MAX_RIDERS: usize = 8;
/// Humans per room. The rest of the slots can be filled with bots.
pub const MAX_HUMANS: usize = 4;

/// A fixed scenario used to compare native and WASM builds bit for bit:
/// a full room of riders on swells, driven by seeded pseudo-random inputs.
pub fn determinism_scenario(ticks: u32) -> u64 {
    let mut world = World::new(Surface::new(SurfaceKind::Swells, 0xC0FFEE));
    for slot in 0..MAX_RIDERS {
        world.spawn(slot);
    }
    let mut rng = math::Pcg32::new(42);
    let mut inputs: Inputs = [None; MAX_RIDERS];
    for _ in 0..ticks {
        for (slot, input) in inputs.iter_mut().enumerate() {
            *input = Some(if slot >= 6 {
                bot::bot_input(&world, slot)
            } else {
                Input::from_analog(
                    rng.range(-1.0, 1.0),
                    rng.range(-0.3, 1.0),
                    rng.range(-1.0, 1.0),
                    (rng.next_u32() & 0xFF) as u8,
                )
            });
        }
        world.step(&inputs);
    }
    world.state_hash()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jetski::tuning as jet;
    use crate::math::{angle_diff, clamp};

    fn run(world: &mut World, input: Input, ticks: u32) {
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for _ in 0..ticks {
            for (slot, i) in inputs.iter_mut().enumerate() {
                if world.riders[slot].is_some() {
                    *i = Some(input);
                }
            }
            world.step(&inputs);
        }
    }

    /// Full throttle on a fixed heading for `ticks`, optionally pulling back
    /// whenever the hull rises. Returns the longest airtime in ticks and the
    /// highest point above the water.
    fn ride_heading(world: &mut World, heading: f32, pop: bool, ticks: u32) -> (u32, f32) {
        let mut r = world.riders[0].unwrap();
        r.yaw = heading;
        world.riders[0] = Some(r);
        let mut inputs: Inputs = [None; MAX_RIDERS];
        let (mut air, mut max_air, mut max_h) = (0u32, 0u32, 0.0f32);
        for _ in 0..ticks {
            let r = world.riders[0].unwrap();
            let steer = clamp(-2.0 * angle_diff(r.yaw, heading), -1.0, 1.0);
            let lean = if pop && r.grounded && r.vel.y > 1.0 {
                -1.0
            } else {
                0.0
            };
            inputs[0] = Some(Input::from_analog(steer, 1.0, lean, 0));
            world.step(&inputs);
            let r = world.riders[0].unwrap();
            assert!(r.pos.y.is_finite() && r.vel.y.is_finite());
            let h = world.surface.height(r.pos.x, r.pos.z, world.tick);
            max_h = max_h.max(r.pos.y - h);
            air = if r.grounded { 0 } else { air + 1 };
            max_air = max_air.max(air);
        }
        (max_air, max_h)
    }

    /// A world on big swells with one rider placed where it has room to
    /// ride straight into the swell for a while.
    fn swell_world(seed: u32) -> (World, f32) {
        let mut w = World::new(Surface::new(SurfaceKind::Swells, seed));
        w.spawn(0);
        let wave = w.surface.waves()[0];
        let into = math::atan2(-wave.dir_x, -wave.dir_z);
        let mut r = w.riders[0].unwrap();
        // Start upwind so the run stays inside the arena.
        r.pos.x = wave.dir_x * 100.0;
        r.pos.z = wave.dir_z * 100.0;
        r.pos.y = w.surface.height(r.pos.x, r.pos.z, 0) - jet::DRAFT;
        r.quantize();
        w.riders[0] = Some(r);
        (w, into)
    }

    #[test]
    fn floats_level_on_calm_water() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::default(), 120);
        let r = w.riders[0].unwrap();
        assert!(r.grounded);
        assert!((r.pos.y + jet::DRAFT).abs() < 0.02, "y = {}", r.pos.y);
        assert!(r.pitch.abs() < 0.01 && r.roll.abs() < 0.01, "{r:?}");
    }

    #[test]
    fn throttle_moves_forward_and_tops_out() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60 * 5);
        let r = w.riders[0].unwrap();
        assert!(r.pos.z > 60.0, "should have moved forward, z = {}", r.pos.z);
        assert!(
            r.speed() > 18.0 && r.speed() <= jet::MAX_SPEED,
            "speed {}",
            r.speed()
        );
        assert!(r.grounded);
    }

    #[test]
    fn a_coasting_jetski_comes_to_rest() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60 * 2);
        run(&mut w, Input::default(), 60 * 40);
        let r = w.riders[0].unwrap();
        assert_eq!(r.speed(), 0.0, "{r:?}");
    }

    #[test]
    fn steering_right_turns_right_and_banks_into_the_turn() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60);
        run(&mut w, Input::from_analog(1.0, 1.0, 0.0, 0), 20);
        let r = w.riders[0].unwrap();
        // Facing +Z, right is -X.
        assert!(r.pos.x < -0.1, "x = {}", r.pos.x);
        assert!(r.roll > 0.05, "should bank right, roll = {}", r.roll);
    }

    #[test]
    fn leaning_back_lifts_the_nose() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 1.0, -1.0, 0), 60);
        let back = w.riders[0].unwrap().pitch;
        run(&mut w, Input::from_analog(0.0, 1.0, 1.0, 0), 60);
        let forward = w.riders[0].unwrap().pitch;
        assert!(back > 0.02 && forward < -0.02, "{back} {forward}");
    }

    #[test]
    fn riders_bump_instead_of_overlapping() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        w.spawn(1);
        let mut a = w.riders[0].unwrap();
        let mut b = w.riders[1].unwrap();
        a.pos = Vec3::new(-3.0, a.pos.y, 0.0);
        a.vel = Vec3::new(8.0, 0.0, 0.0);
        a.yaw = core::f32::consts::FRAC_PI_2;
        b.pos = Vec3::new(3.0, b.pos.y, 0.0);
        b.vel = Vec3::new(-8.0, 0.0, 0.0);
        b.yaw = 3.0 * core::f32::consts::FRAC_PI_2;
        w.riders[0] = Some(a);
        w.riders[1] = Some(b);
        let mut min_dist = f32::MAX;
        let mut inputs: Inputs = [None; MAX_RIDERS];
        inputs[0] = Some(Input::default());
        inputs[1] = Some(Input::default());
        for _ in 0..60 {
            w.step(&inputs);
            let d = (w.riders[1].unwrap().pos - w.riders[0].unwrap().pos).length();
            min_dist = min_dist.min(d);
        }
        assert!(
            min_dist > world::tuning::RIDER_RADIUS * 2.0 - 0.3,
            "overlapped: {min_dist}"
        );
        assert!(w.riders[0].unwrap().vel.x <= 0.0, "a should bounce back");
    }

    #[test]
    fn state_stays_on_network_grid() {
        let mut w = World::new(Surface::new(SurfaceKind::Swells, 7));
        w.spawn(0);
        run(&mut w, Input::from_analog(0.3, 1.0, -0.5, 0), 300);
        let r = w.riders[0].unwrap();
        let mut q = r;
        q.quantize();
        assert_eq!(r, q);
    }

    #[test]
    fn swells_are_big_and_sampled_consistently() {
        let s = Surface::new(SurfaceKind::Swells, 1);
        let main = s.waves()[0];
        assert!(2.0 * main.amplitude > 0.9, "main swell {main:?}");
        assert!(main.sharpness > 1);
        let (x, z, tick) = (10.0, 5.0, 30);
        let a = s.sample(x, z, tick);
        assert_eq!(a.height, s.height(x, z, tick));
        // Analytic slope and rise rate match finite differences.
        let e = 0.01;
        let dx = (s.height(x + e, z, tick) - s.height(x - e, z, tick)) / (2.0 * e);
        let dt = (s.height(x, z, tick + 1) - s.height(x, z, tick - 1)) / (2.0 * DT);
        assert!((a.dhdx - dx).abs() < 0.02, "{} vs {dx}", a.dhdx);
        assert!((a.dhdt - dt).abs() < 0.1, "{} vs {dt}", a.dhdt);
    }

    #[test]
    fn crests_launch_you_and_pulling_back_pops_you_higher() {
        let (mut longest, mut longest_pop, mut highest) = (0u32, 0u32, 0.0f32);
        for seed in 0..6 {
            let (mut w, into) = swell_world(seed);
            let (air, h) = ride_heading(&mut w, into, false, 60 * 10);
            longest = longest.max(air);
            highest = highest.max(h);
            let (mut w, into) = swell_world(seed);
            let (air, h) = ride_heading(&mut w, into, true, 60 * 10);
            longest_pop = longest_pop.max(air);
            highest = highest.max(h);
        }
        // Meeting crests at speed gives real air, enough for a trick...
        assert!(longest >= 45, "longest airtime {longest} ticks");
        // ...pulling back makes it bigger...
        assert!(longest_pop > longest + 10, "{longest_pop} vs {longest}");
        // ...but nothing launches like a rocket.
        assert!(longest_pop < 60 * 3, "{longest_pop} ticks in the air");
        assert!(highest < 10.0, "{highest} m above the water");
    }

    #[test]
    fn bots_lap_without_leaving_the_arena() {
        let mut w = World::new(Surface::new(SurfaceKind::Swells, 3));
        for slot in 0..MAX_RIDERS {
            w.spawn(slot);
        }
        let mut inputs: Inputs = [None; MAX_RIDERS];
        for _ in 0..60 * 30 {
            for (slot, i) in inputs.iter_mut().enumerate() {
                *i = Some(bot::bot_input(&w, slot));
            }
            w.step(&inputs);
        }
        for r in w.riders.iter().flatten() {
            assert!(r.speed() > 5.0, "bot stalled: {:?}", r);
            assert!(
                r.pos.x.abs() < world::tuning::ARENA_HALF
                    && r.pos.z.abs() < world::tuning::ARENA_HALF
            );
        }
    }

    #[test]
    fn random_riding_stays_stable() {
        for seed in 0..10 {
            let mut w = World::new(Surface::new(SurfaceKind::Swells, seed));
            w.tick = seed * 997; // spawn at arbitrary times, on crests and troughs
            for slot in 0..MAX_RIDERS {
                w.spawn(slot);
            }
            let mut rng = math::Pcg32::new(u64::from(seed));
            let mut inputs: Inputs = [None; MAX_RIDERS];
            for _ in 0..60 * 20 {
                for i in inputs.iter_mut() {
                    *i = Some(Input::from_analog(
                        rng.range(-1.0, 1.0),
                        rng.range(-0.2, 1.0),
                        rng.range(-1.0, 1.0),
                        0,
                    ));
                }
                w.step(&inputs);
                for r in w.riders.iter().flatten() {
                    let h = w.surface.height(r.pos.x, r.pos.z, w.tick);
                    assert!(r.pos.y.is_finite() && r.vel.length().is_finite());
                    assert!(r.pos.y - h < 10.0 && r.pos.y - h > -2.0, "{r:?}");
                }
            }
        }
    }

    #[test]
    fn determinism_scenario_is_repeatable() {
        assert_eq!(determinism_scenario(600), determinism_scenario(600));
    }
}
