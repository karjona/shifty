//! Pure game logic: physics, rules, scoring. No I/O, no clocks, no threads.
//!
//! Compiled natively for the race server and to WASM for client-side
//! prediction. Every float operation must give bit-identical results on both,
//! so: no SIMD math crates, no platform libm (use `math::*`), no `mul_add`,
//! no iteration over hash maps.

pub mod bot;
pub mod input;
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
                    if rng.next_u32().is_multiple_of(50) {
                        buttons::JUMP
                    } else {
                        0
                    },
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

    #[test]
    fn throttle_moves_forward_and_tops_out() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0), 60 * 5);
        let r = w.riders[0].unwrap();
        assert!(r.pos.z > 50.0, "should have moved forward, z = {}", r.pos.z);
        assert!(
            r.speed() > 15.0 && r.speed() <= world::tuning::MAX_SPEED + 0.5,
            "speed {}",
            r.speed()
        );
        assert!(r.grounded);
    }

    #[test]
    fn steering_right_turns_right() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0), 60);
        run(&mut w, Input::from_analog(1.0, 1.0, 0), 20);
        let r = w.riders[0].unwrap();
        // Facing +Z, right is -X.
        assert!(r.pos.x < -0.1, "x = {}", r.pos.x);
    }

    #[test]
    fn jump_leaves_ground_and_lands() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        run(&mut w, Input::from_analog(0.0, 0.5, buttons::JUMP), 1);
        assert!(!w.riders[0].unwrap().grounded);
        // Holding jump does not re-trigger; we land within a second.
        run(&mut w, Input::from_analog(0.0, 0.5, buttons::JUMP), 60);
        let r = w.riders[0].unwrap();
        assert!(r.grounded);
        assert_eq!(r.pos.y, 0.0);
    }

    #[test]
    fn riders_bump_instead_of_overlapping() {
        let mut w = World::new(Surface::flat());
        w.spawn(0);
        w.spawn(1);
        let mut a = w.riders[0].unwrap();
        let mut b = w.riders[1].unwrap();
        a.pos = Vec3::new(-3.0, 0.0, 0.0);
        a.vel = Vec3::new(8.0, 0.0, 0.0);
        a.yaw = core::f32::consts::FRAC_PI_2;
        b.pos = Vec3::new(3.0, 0.0, 0.0);
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
        run(&mut w, Input::from_analog(0.3, 1.0, 0), 300);
        let r = w.riders[0].unwrap();
        let mut q = r;
        q.quantize();
        assert_eq!(r, q);
    }

    #[test]
    fn swells_move_the_surface() {
        let s = Surface::new(SurfaceKind::Swells, 1);
        let h0 = s.height(10.0, 5.0, 0);
        let h1 = s.height(10.0, 5.0, 30);
        assert!((h0 - h1).abs() > 1e-3);
        assert!(
            s.waves().iter().all(|w| w.amplitude * w.k < 0.2),
            "swells should be gentle"
        );
        let n = s.normal(10.0, 5.0, 0);
        assert!((n.length() - 1.0).abs() < 1e-4 && n.y > 0.8);
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
    fn riding_swells_stays_near_the_water() {
        for seed in 0..20 {
            let mut w = World::new(Surface::new(SurfaceKind::Swells, seed));
            w.tick = seed * 997; // spawn at arbitrary times, on crests and troughs
            for slot in 0..MAX_RIDERS {
                w.spawn(slot);
            }
            let mut max_air = 0.0f32;
            let mut inputs: Inputs = [None; MAX_RIDERS];
            for t in 0..60 * 20 {
                for (slot, i) in inputs.iter_mut().enumerate() {
                    let steer = if (t / 90 + slot as u32).is_multiple_of(2) {
                        0.4
                    } else {
                        -0.4
                    };
                    *i = Some(Input::from_analog(steer, 1.0, 0));
                }
                w.step(&inputs);
                for r in w.riders.iter().flatten() {
                    let h = w.surface.height(r.pos.x, r.pos.z, w.tick);
                    max_air = max_air.max(r.pos.y - h);
                }
            }
            // Swell launches are small hops, never rockets.
            assert!(
                max_air < 1.5,
                "seed {seed}: rider got {max_air} m above the water"
            );
        }
    }

    #[test]
    fn determinism_scenario_is_repeatable() {
        assert_eq!(determinism_scenario(600), determinism_scenario(600));
    }
}
