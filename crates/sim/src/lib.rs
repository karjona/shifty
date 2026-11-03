//! Pure game logic: physics, rules, scoring. No I/O, no clocks, no threads.
//!
//! Compiled natively for the race server and to WASM for client-side
//! prediction. Every float operation must give bit-identical results on both,
//! so: no SIMD math crates, no platform libm (use `math::*`), no `mul_add`,
//! no iteration over hash maps.

pub mod bot;
pub mod course;
pub mod input;
pub mod jetski;
pub mod math;
pub mod quant;
pub mod race;
pub mod surface;
pub mod world;

pub use course::{Course, CourseId};
pub use input::{Input, buttons};
pub use math::Vec3;
pub use race::{Phase, SimEvent};
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
    let mut world = World::on_course(CourseId::Oval, SurfaceKind::Swells, 0xC0FFEE);
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
    use crate::course::OVAL;
    use crate::jetski::tuning as jet;
    use crate::math::{angle_diff, clamp};
    use crate::race::{EventKind, Phase};

    fn run(world: &mut World, input: Input, ticks: u32) -> Vec<SimEvent> {
        let mut inputs: Inputs = [None; MAX_RIDERS];
        let mut events = Vec::new();
        for _ in 0..ticks {
            for (slot, i) in inputs.iter_mut().enumerate() {
                if world.riders[slot].is_some() {
                    *i = Some(input);
                }
            }
            events.extend(world.step(&inputs));
        }
        events
    }

    /// One rider at the start of the first straight (which heads into the
    /// swell), on the centre line, at rest.
    fn straight_world(kind: SurfaceKind, seed: u32) -> World {
        let mut w = World::on_course(CourseId::Oval, kind, seed);
        w.spawn(0);
        place(&mut w, 0, 2.0, 0.0, 0.0);
        w
    }

    /// Puts a rider on the course at `(s, offset)` heading along it at `speed`.
    fn place(w: &mut World, slot: usize, s: f32, offset: f32, speed: f32) {
        let f = OVAL.centerline(s);
        let (x, z) = f.at_offset(offset);
        let mut r = w.riders[slot].unwrap();
        r.pos = Vec3::new(x, w.surface.height(x, z, w.tick) - jet::DRAFT, z);
        r.yaw = f.yaw;
        r.vel = r.forward() * speed;
        r.quantize();
        w.riders[slot] = Some(r);
    }

    /// Full throttle on a fixed heading for `ticks`, optionally pulling back
    /// whenever the hull rises. Returns the longest airtime in ticks and the
    /// highest point above the water.
    fn ride_heading(world: &mut World, heading: f32, pop: bool, ticks: u32) -> (u32, f32) {
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

    #[test]
    fn floats_level_on_calm_water() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        run(&mut w, Input::default(), 120);
        let r = w.riders[0].unwrap();
        assert!(r.grounded);
        assert!((r.pos.y + jet::DRAFT).abs() < 0.02, "y = {}", r.pos.y);
        assert!(r.pitch.abs() < 0.01 && r.roll.abs() < 0.01, "{r:?}");
    }

    #[test]
    fn throttle_moves_forward_and_tops_out() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        let x0 = w.riders[0].unwrap().pos.x;
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60 * 5);
        let r = w.riders[0].unwrap();
        assert!(r.pos.x - x0 > 60.0, "should have moved forward: {r:?}");
        assert!(
            r.speed() > 18.0 && r.speed() <= jet::MAX_SPEED,
            "speed {}",
            r.speed()
        );
        assert!(r.grounded);
    }

    #[test]
    fn a_coasting_jetski_comes_to_rest() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60 * 2);
        run(&mut w, Input::default(), 60 * 40);
        let r = w.riders[0].unwrap();
        assert_eq!(r.speed(), 0.0, "{r:?}");
    }

    #[test]
    fn steering_right_turns_right_and_banks_into_the_turn() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60);
        let before = w.riders[0].unwrap();
        run(&mut w, Input::from_analog(1.0, 1.0, 0.0, 0), 20);
        let r = w.riders[0].unwrap();
        let moved = r.pos - before.pos;
        assert!(moved.dot(before.right()) > 0.1, "{moved:?}");
        assert!(r.roll > 0.05, "should bank right, roll = {}", r.roll);
    }

    #[test]
    fn leaning_back_lifts_the_nose() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        run(&mut w, Input::from_analog(0.0, 1.0, -1.0, 0), 60);
        let back = w.riders[0].unwrap().pitch;
        run(&mut w, Input::from_analog(0.0, 1.0, 1.0, 0), 60);
        let forward = w.riders[0].unwrap().pitch;
        assert!(back > 0.02 && forward < -0.02, "{back} {forward}");
    }

    #[test]
    fn riders_bump_instead_of_overlapping() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        w.spawn(1);
        place(&mut w, 0, 20.0, -6.0, 0.0);
        place(&mut w, 1, 20.0, 6.0, 0.0);
        let mut a = w.riders[0].unwrap();
        let mut b = w.riders[1].unwrap();
        let n = (b.pos - a.pos).horizontal().normalize_or(Vec3::UP);
        a.vel = n * 8.0;
        b.vel = n * -8.0;
        a.yaw = math::wrap_angle(math::atan2(n.x, n.z));
        b.yaw = math::wrap_angle(a.yaw + math::PI);
        w.riders[0] = Some(a);
        w.riders[1] = Some(b);
        let mut min_dist = f32::MAX;
        let mut inputs: Inputs = [None; MAX_RIDERS];
        inputs[0] = Some(Input::default());
        inputs[1] = Some(Input::default());
        for _ in 0..90 {
            w.step(&inputs);
            let d = (w.riders[1].unwrap().pos - w.riders[0].unwrap().pos).length();
            min_dist = min_dist.min(d);
        }
        assert!(
            min_dist > world::tuning::RIDER_RADIUS * 2.0 - 0.3,
            "overlapped: {min_dist}"
        );
        assert!(
            w.riders[0].unwrap().vel.dot(n) <= 0.0,
            "a should bounce back"
        );
    }

    #[test]
    fn state_stays_on_network_grid() {
        let mut w = straight_world(SurfaceKind::Swells, 7);
        run(&mut w, Input::from_analog(0.3, 1.0, -0.5, 0), 300);
        let r = w.riders[0].unwrap();
        let mut q = r;
        q.quantize();
        assert_eq!(r, q);
    }

    #[test]
    fn swells_are_big_and_sampled_consistently() {
        let s = OVAL.surface(SurfaceKind::Swells, 1);
        let main = s.waves()[0];
        assert!(2.0 * main.amplitude > 0.9, "main swell {main:?}");
        assert!(main.sharpness > 1);
        // The swell rolls against the first straight.
        assert!(main.dir_x < -0.9, "{main:?}");
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
        let heading = OVAL.centerline(0.0).yaw;
        for seed in 0..6 {
            let mut w = straight_world(SurfaceKind::Swells, seed);
            let (air, h) = ride_heading(&mut w, heading, false, 60 * 10);
            longest = longest.max(air);
            highest = highest.max(h);
            let mut w = straight_world(SurfaceKind::Swells, seed);
            let (air, h) = ride_heading(&mut w, heading, true, 60 * 10);
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
    fn ramps_throw_you_in_the_air() {
        let ramp = OVAL.ramps[0];
        let mut w = straight_world(SurfaceKind::Flat, 0);
        place(&mut w, 0, ramp.s - 30.0, ramp.offset, 20.0);
        let mut air = 0;
        let mut longest = 0;
        for _ in 0..240 {
            run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 1);
            let r = w.riders[0].unwrap();
            air = if r.grounded { 0 } else { air + 1 };
            longest = longest.max(air);
        }
        assert!(longest > 50, "airtime off the ramp: {longest} ticks");
        assert!(w.riders[0].unwrap().speed() > 12.0);
    }

    #[test]
    fn a_slow_rider_slides_back_off_a_ramp() {
        let ramp = OVAL.ramps[0];
        for input in [
            Input::default(),
            Input::from_analog(0.0, -1.0, 0.0, 0), // back away
        ] {
            let mut w = straight_world(SurfaceKind::Flat, 0);
            place(&mut w, 0, ramp.s + 4.0, ramp.offset, 1.0);
            let mut r = w.riders[0].unwrap();
            r.pos.y = OVAL
                .ramp_under(r.pos.x, r.pos.z, &w.surface, w.tick)
                .unwrap()
                .top;
            r.quantize();
            w.riders[0] = Some(r);
            run(&mut w, input, 60 * 4);
            let r = w.riders[0].unwrap();
            let on_deck = OVAL
                .ramp_under(r.pos.x, r.pos.z, &w.surface, w.tick)
                .is_some();
            assert!(!on_deck, "stuck on the ramp with {input:?}: {r:?}");
        }
    }

    #[test]
    fn buoys_fill_the_meter_and_misses_empty_it() {
        let mut w = straight_world(SurfaceKind::Flat, 0);
        let b0 = OVAL.buoys[0]; // keep on your right: pass on its left
        let mut r = w.riders[0].unwrap();
        r.race.next_gate = 1;
        r.race.meter = 2;
        w.riders[0] = Some(r);
        place(&mut w, 0, b0.s - 15.0, b0.offset - 4.0, 18.0);
        let ev = run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60);
        assert!(
            ev.contains(&SimEvent {
                slot: 0,
                kind: EventKind::Buoy {
                    buoy: 0,
                    ok: true,
                    meter: 3
                }
            }),
            "{ev:?}"
        );
        let r = w.riders[0].unwrap();
        assert_eq!((r.race.meter, r.race.next_gate), (3, 2));

        // Next buoy (keep on your left) passed on the wrong side.
        let b1 = OVAL.buoys[1];
        place(&mut w, 0, b1.s - 15.0, b1.offset - 4.0, 18.0);
        let ev = run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60);
        assert!(
            ev.iter()
                .any(|e| matches!(e.kind, EventKind::Buoy { ok: false, .. })),
            "{ev:?}"
        );
        assert_eq!(w.riders[0].unwrap().race.meter, 0);
    }

    #[test]
    fn the_meter_raises_top_speed() {
        let mut slow = straight_world(SurfaceKind::Flat, 0);
        let mut fast = straight_world(SurfaceKind::Flat, 0);
        for (w, meter) in [(&mut slow, 0), (&mut fast, race::tuning::METER_MAX)] {
            let mut r = w.riders[0].unwrap();
            r.race.meter = meter;
            // Aim for a buoy on the far side, so none is passed on the way.
            r.race.next_gate = 7;
            w.riders[0] = Some(r);
        }
        run(&mut slow, Input::from_analog(0.0, 1.0, 0.0, 0), 60 * 8);
        run(&mut fast, Input::from_analog(0.0, 1.0, 0.0, 0), 60 * 8);
        let (a, b) = (slow.riders[0].unwrap(), fast.riders[0].unwrap());
        assert!(
            b.speed() > a.speed() * 1.08,
            "{} vs {}",
            b.speed(),
            a.speed()
        );
    }

    #[test]
    fn countdown_holds_everyone_on_the_grid() {
        let mut w = World::on_course(CourseId::Oval, SurfaceKind::Swells, 5);
        w.spawn(0);
        w.spawn(3);
        // Ride off during the warm-up...
        run(
            &mut w,
            Input::from_analog(0.2, 1.0, 0.0, 0),
            race::tuning::WARMUP_TICKS,
        );
        assert_eq!(w.race.phase, Phase::Countdown);
        // ...and get put back and held at full throttle.
        run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 60);
        for slot in [0, 3] {
            let r = w.riders[slot].unwrap();
            let spot = OVAL.grid_spot(slot);
            assert!((r.pos.x - spot.x).abs() < 0.01 && (r.pos.z - spot.z).abs() < 0.01);
            assert!(r.race.racing && r.race.lap == 0);
        }
        run(
            &mut w,
            Input::from_analog(0.0, 1.0, 0.0, 0),
            race::tuning::COUNTDOWN_TICKS,
        );
        assert_eq!(w.race.phase, Phase::Racing);
        let ev = run(&mut w, Input::from_analog(0.0, 1.0, 0.0, 0), 120);
        assert!(ev.contains(&SimEvent {
            slot: 0,
            kind: EventKind::Lap { lap: 1 }
        }));
    }

    #[test]
    fn bots_race_three_laps_and_the_room_starts_over() {
        for seed in [3, 11] {
            let mut w = World::on_course(CourseId::Oval, SurfaceKind::Swells, seed);
            for slot in 0..MAX_RIDERS {
                w.spawn(slot);
            }
            let mut inputs: Inputs = [None; MAX_RIDERS];
            let mut finished_in = Vec::new();
            for _ in 0..60 * 60 * 5 {
                for (slot, i) in inputs.iter_mut().enumerate() {
                    *i = Some(bot::bot_input(&w, slot));
                }
                for e in w.step(&inputs) {
                    if let EventKind::Finish { ticks } = e.kind {
                        finished_in.push(ticks);
                    }
                }
                if w.race.phase == Phase::Results {
                    break;
                }
            }
            assert_eq!(
                w.race.phase,
                Phase::Results,
                "seed {seed}: race never ended"
            );
            let standings = w.standings();
            assert_eq!(standings.len(), MAX_RIDERS);
            for st in &standings {
                let p = st.progress;
                assert!(p.finished(), "seed {seed}: {st:?}");
                assert!(p.misses <= 3, "seed {seed}: bot missed {} buoys", p.misses);
            }
            // Three laps of ~860 m at jetski speeds: about two and a half minutes.
            let best = *finished_in.iter().min().unwrap();
            assert!(
                (60 * 100..60 * 200).contains(&best),
                "seed {seed}: {best} ticks"
            );
            for pair in standings.windows(2) {
                assert!(pair[0].progress.finish_ticks <= pair[1].progress.finish_ticks);
            }
            // The results don't change while everyone keeps riding.
            for _ in 0..60 * 5 {
                for (slot, i) in inputs.iter_mut().enumerate() {
                    *i = Some(bot::bot_input(&w, slot));
                }
                w.step(&inputs);
            }
            assert_eq!(w.standings(), standings);
            // Results, then a new warm-up.
            run(&mut w, Input::default(), race::tuning::RESULTS_TICKS);
            assert_eq!(w.race.phase, Phase::Warmup);
        }
    }

    #[test]
    fn random_riding_stays_stable() {
        for seed in 0..10 {
            let mut w = World::on_course(CourseId::Oval, SurfaceKind::Swells, seed);
            w.tick = seed * 997; // spawn at arbitrary times, on crests and troughs
            w.restart_warmup();
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
                    let (_, offset) = OVAL.project(r.pos.x, r.pos.z);
                    assert!(offset.abs() < OVAL.outer_limit, "left the course: {r:?}");
                }
            }
        }
    }

    #[test]
    fn determinism_scenario_is_repeatable() {
        assert_eq!(determinism_scenario(600), determinism_scenario(600));
    }
}
