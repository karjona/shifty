//! Five missed buoys or gates take a rider out of the race.

use sim::course::{Keep, OVAL};
use sim::jetski::tuning::DRAFT;
use sim::race::tuning::{COUNTDOWN_TICKS, FINISH_GRACE_TICKS, INTRO_TICKS, MAX_MISSES};
use sim::race::{EventKind, Progress};
use sim::{CourseId, Input, Inputs, MAX_RIDERS, Phase, SimEvent, SurfaceKind, Vec3, World};

fn run(w: &mut World, input: Input, ticks: u32) -> Vec<SimEvent> {
    let mut events = Vec::new();
    for _ in 0..ticks {
        let inputs: Inputs = core::array::from_fn(|slot| w.riders[slot].is_some().then_some(input));
        events.extend(w.step(&inputs));
    }
    events
}

/// An oval with riders in `slots`, through the intro and the countdown.
fn racing_world(slots: &[usize]) -> World {
    let mut w = World::on_course(CourseId::Oval, SurfaceKind::Flat, 9);
    for &slot in slots {
        w.spawn(slot);
    }
    w.start_intro();
    run(&mut w, Input::default(), INTRO_TICKS + COUNTDOWN_TICKS);
    assert_eq!(w.race.phase, Phase::Racing);
    w
}

/// Puts a racing rider at `(s, offset)` heading along the course at
/// `speed`, with `progress`.
fn place(w: &mut World, slot: usize, s: f32, offset: f32, speed: f32, progress: Progress) {
    let f = OVAL.centerline(s);
    let (x, z) = f.at_offset(offset);
    let mut r = w.riders[slot].unwrap();
    r.pos = Vec3::new(x, w.surface.height(x, z, w.tick) - DRAFT, z);
    r.yaw = f.yaw;
    r.vel = r.forward() * speed;
    r.race = progress;
    r.quantize();
    w.riders[slot] = Some(r);
}

/// Rides rider `slot` past buoy `index` on its wrong side, with `misses`
/// already counted. Returns the events of the way.
fn miss_buoy(w: &mut World, slot: usize, index: usize, misses: u8) -> Vec<SimEvent> {
    let b = OVAL.buoys[index];
    let wrong = match b.keep {
        Keep::Right => b.offset + 4.0,
        Keep::Left => b.offset - 4.0,
    };
    let progress = Progress {
        next_gate: index as u8 + 1,
        lap: 1,
        misses,
        ..Progress::lined_up()
    };
    place(w, slot, b.s - 15.0, wrong, 18.0, progress);
    let mut events = Vec::new();
    for _ in 0..60 {
        let mut inputs: Inputs = [None; MAX_RIDERS];
        inputs[slot] = Some(Input::from_analog(0.0, 1.0, 0.0, 0));
        events.extend(w.step(&inputs));
        if w.riders[slot].unwrap().race.next_gate != index as u8 + 1 {
            break;
        }
    }
    events
}

fn disqualified_events(events: &[SimEvent]) -> Vec<(u8, u32)> {
    events
        .iter()
        .filter_map(|e| match e.kind {
            EventKind::Disqualified { ticks } => Some((e.slot, ticks)),
            _ => None,
        })
        .collect()
}

#[test]
fn the_fifth_miss_disqualifies() {
    let mut w = racing_world(&[0, 1]);
    place(&mut w, 1, 600.0, 0.0, 0.0, Progress::lined_up());
    let ev = miss_buoy(&mut w, 0, 1, MAX_MISSES - 2);
    assert!(disqualified_events(&ev).is_empty(), "{ev:?}");
    let r = w.riders[0].unwrap();
    assert_eq!(r.race.misses, MAX_MISSES - 1);
    assert!(!r.race.disqualified() && !w.on_autopilot(0));

    let ev = miss_buoy(&mut w, 0, 1, MAX_MISSES - 1);
    let out = disqualified_events(&ev);
    let r = w.riders[0].unwrap();
    assert_eq!(out, [(0, r.race.disqualified_ticks)], "{ev:?}");
    assert_eq!(r.race.disqualified_ticks, w.race.elapsed(w.tick));
    assert_eq!(r.race.misses, MAX_MISSES);
    assert!(r.race.done() && !r.race.finished());
    assert!(w.on_autopilot(0), "out of the race, on autopilot");
    assert!(!w.on_autopilot(1));

    // Nothing more counts: no more misses, no second verdict.
    let ticks = r.race.disqualified_ticks;
    let mut r = w.riders[0].unwrap();
    r.race.next_gate = 2;
    w.riders[0] = Some(r);
    let ev = run(&mut w, Input::default(), 60 * 20);
    assert!(disqualified_events(&ev).is_empty(), "{ev:?}");
    let p = w.riders[0].unwrap().race;
    assert_eq!(
        (p.misses, p.disqualified_ticks, p.finish_ticks),
        (MAX_MISSES, ticks, 0)
    );
}

#[test]
fn disqualified_riders_ride_the_bots_line_whatever_their_players_do() {
    let mut a = racing_world(&[0, 1]);
    place(&mut a, 1, 600.0, 0.0, 0.0, Progress::lined_up());
    miss_buoy(&mut a, 0, 1, MAX_MISSES - 1);
    assert!(a.riders[0].unwrap().race.disqualified());
    let mut b = a.clone();
    for i in 0..60 * 10 {
        let mut noise: Inputs = [None; MAX_RIDERS];
        noise[0] = Some(Input::from_analog(
            if i % 40 < 20 { 1.0 } else { -1.0 },
            -1.0,
            1.0,
            0xFF,
        ));
        a.step(&noise);
        b.step(&[None; MAX_RIDERS]);
    }
    assert_eq!(a, b);
    assert!(a.riders[0].unwrap().speed() > 10.0);
}

#[test]
fn the_disqualified_are_placed_last_the_later_out_first() {
    let mut w = racing_world(&[0, 1, 2, 3]);
    // 0: finished. 1: racing, behind everyone. 2 and 3: out, 3 later.
    place(
        &mut w,
        0,
        100.0,
        0.0,
        0.0,
        Progress {
            lap: 3,
            finish_ticks: 5000,
            ..Progress::lined_up()
        },
    );
    place(&mut w, 1, 20.0, 0.0, 0.0, Progress::lined_up());
    for (slot, out) in [(2, 900), (3, 1200)] {
        place(
            &mut w,
            slot,
            700.0,
            0.0,
            0.0,
            Progress {
                lap: 3,
                misses: MAX_MISSES,
                disqualified_ticks: out,
                ..Progress::lined_up()
            },
        );
    }
    let order: Vec<u8> = w.standings().iter().map(|st| st.slot).collect();
    assert_eq!(order, [0, 1, 3, 2]);
}

#[test]
fn the_race_ends_once_everyone_left_is_through_or_out() {
    let mut w = racing_world(&[0, 1]);
    place(
        &mut w,
        1,
        600.0,
        0.0,
        0.0,
        Progress {
            misses: MAX_MISSES,
            disqualified_ticks: 300,
            ..Progress::lined_up()
        },
    );
    miss_buoy(&mut w, 0, 1, MAX_MISSES - 1);
    run(&mut w, Input::default(), 1);
    assert_eq!(w.race.phase, Phase::Results, "nobody left racing");

    // A finisher's grace still runs for those still racing; the
    // disqualified don't hold it open.
    let mut w = racing_world(&[0, 1, 2]);
    let now = w.race.elapsed(w.tick);
    place(
        &mut w,
        0,
        100.0,
        0.0,
        0.0,
        Progress {
            lap: 3,
            finish_ticks: now.max(1),
            ..Progress::lined_up()
        },
    );
    place(
        &mut w,
        1,
        600.0,
        0.0,
        0.0,
        Progress {
            misses: MAX_MISSES,
            disqualified_ticks: 300,
            ..Progress::lined_up()
        },
    );
    place(&mut w, 2, 300.0, 0.0, 0.0, Progress::lined_up());
    run(&mut w, Input::default(), 60);
    assert_eq!(w.race.phase, Phase::Racing, "rider 2 still racing");
    run(&mut w, Input::default(), FINISH_GRACE_TICKS);
    assert_eq!(w.race.phase, Phase::Results);
}

#[test]
fn a_world_that_does_not_disqualify_counts_misses_only() {
    let mut w = racing_world(&[0, 1]);
    w.disqualify = false;
    place(&mut w, 1, 600.0, 0.0, 0.0, Progress::lined_up());
    let ev = miss_buoy(&mut w, 0, 1, MAX_MISSES - 1);
    assert!(disqualified_events(&ev).is_empty(), "{ev:?}");
    let ev = miss_buoy(&mut w, 0, 3, MAX_MISSES);
    assert!(disqualified_events(&ev).is_empty(), "{ev:?}");
    let r = w.riders[0].unwrap();
    assert_eq!(r.race.misses, MAX_MISSES + 1);
    assert!(!r.race.disqualified() && !w.on_autopilot(0));
}

#[test]
fn being_out_is_in_the_state_hash() {
    let mut w = racing_world(&[0]);
    let before = w.state_hash();
    let mut r = w.riders[0].unwrap();
    r.race.disqualified_ticks = 77;
    w.riders[0] = Some(r);
    assert_ne!(w.state_hash(), before);
}

#[test]
fn the_next_race_starts_everyone_back_in() {
    let mut w = racing_world(&[0]);
    miss_buoy(&mut w, 0, 1, MAX_MISSES - 1);
    assert!(w.riders[0].unwrap().race.disqualified());
    run(&mut w, Input::default(), 1);
    assert_eq!(w.race.phase, Phase::Results);
    w.restart();
    let p = w.riders[0].unwrap().race;
    assert!(p.racing && !p.done() && p.misses == 0);
}
