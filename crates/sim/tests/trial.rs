//! A time trial session: laps without end, each timed on its own, a lap
//! with a miss void, a run back to the top after each lap, and a retry.

use sim::course::{Keep, OVAL};
use sim::jetski::tuning::DRAFT;
use sim::race::tuning::{COUNTDOWN_TICKS, INTRO_TICKS, MAX_RACE_TICKS, RUN_OUT_TICKS};
use sim::race::{EventKind, Laps};
use sim::{CourseId, Inputs, MAX_RIDERS, Phase, SimEvent, SurfaceKind, TICK_HZ, Vec3, World};

/// A trial world on `course` with one rider, through the intro and the countdown.
fn trial(course: CourseId) -> World {
    let mut w = World::on_course(course, SurfaceKind::Swells, 4);
    w.trial = true;
    w.disqualify = false;
    w.hold_results = true;
    w.spawn(0);
    w.start_intro();
    for _ in 0..INTRO_TICKS + COUNTDOWN_TICKS {
        w.step(&[None; MAX_RIDERS]);
    }
    assert_eq!(w.race.phase, Phase::Racing);
    w
}

/// One tick, the rider riding like a bot.
fn ride(w: &mut World) -> Vec<SimEvent> {
    let mut inputs: Inputs = [None; MAX_RIDERS];
    inputs[0] = Some(sim::bot::bot_input(w, 0));
    w.step(&inputs)
}

/// A lap's end: its session lap number, time, and whether it was clean and the best.
fn lap_times(events: &[SimEvent]) -> Vec<(u8, u32, bool, bool)> {
    events
        .iter()
        .filter_map(|e| match e.kind {
            EventKind::LapTime {
                lap,
                ticks,
                clean,
                best,
            } => Some((lap, ticks, clean, best)),
            _ => None,
        })
        .collect()
}

/// Rides until `n` laps have ended (at most `limit` ticks). Returns the events.
fn ride_laps(w: &mut World, n: usize, limit: u32) -> Vec<SimEvent> {
    let mut events = Vec::new();
    for _ in 0..limit {
        events.extend(ride(w));
        if lap_times(&events).len() >= n {
            return events;
        }
    }
    panic!(
        "{n} laps not ridden in {limit} ticks: {:?}",
        lap_times(&events)
    );
}

#[test]
fn a_loop_is_lapped_without_end_each_lap_timed_from_line_to_line() {
    let mut w = trial(CourseId::Oval);
    assert_eq!(w.riders[0].unwrap().race.laps, Laps::default());
    // The first crossing of the line starts lap 1 and ends nothing.
    let mut crossings = Vec::new();
    let mut events = Vec::new();
    for _ in 0..TICK_HZ * 10 {
        let ev = ride(&mut w);
        for e in &ev {
            if let EventKind::Lap { lap } = e.kind {
                crossings.push((lap, w.tick));
            }
        }
        events.extend(ev);
        if !crossings.is_empty() {
            break;
        }
    }
    assert_eq!(crossings, [(1, w.tick)]);
    assert!(lap_times(&events).is_empty());
    assert_eq!(w.riders[0].unwrap().race.laps.start, w.tick);

    // Four laps, well past the race's time cap: the session goes on.
    let started = w.race.phase_tick;
    for _ in 0..4 {
        let ev = ride_laps(&mut w, 1, TICK_HZ * 120);
        for e in &ev {
            if let EventKind::Lap { lap } = e.kind {
                crossings.push((lap, w.tick));
            }
        }
        events.extend(ev);
    }
    let laps = lap_times(&events);
    assert_eq!(laps.len(), 4, "{laps:?}");
    for (i, &(lap, ticks, clean, _)) in laps.iter().enumerate() {
        assert_eq!(usize::from(lap), i + 1);
        assert_eq!(ticks, crossings[i + 1].1 - crossings[i].1, "line to line");
        assert!(clean, "the bot's line passes every buoy: {laps:?}");
    }
    let p = w.riders[0].unwrap().race;
    let best = laps.iter().map(|l| l.1).min().unwrap();
    assert_eq!(p.laps.done, 4);
    assert_eq!(p.laps.best, best);
    assert_eq!(p.laps.last, laps[3].1);
    assert!(!p.laps.last_void);
    assert_eq!(p.laps.start, w.tick, "the next lap is under way");
    assert_eq!(p.lap, 5);
    assert!(laps.iter().filter(|l| l.3).all(|l| l.1 >= best));
    // Racing on, past the race's own time cap, never on autopilot.
    for _ in 0..MAX_RACE_TICKS + 60 - w.race.elapsed(w.tick).min(MAX_RACE_TICKS) {
        ride(&mut w);
    }
    assert_eq!((w.race.phase, w.race.phase_tick), (Phase::Racing, started));
    assert!(!w.on_autopilot(0));
    assert!(w.riders[0].unwrap().race.laps.done > 4);
}

#[test]
fn a_lap_with_a_miss_is_void_and_the_next_one_counts_again() {
    let mut w = trial(CourseId::Oval);
    ride_laps(&mut w, 1, TICK_HZ * 120);
    let best = w.riders[0].unwrap().race.laps.best;
    assert!(best > 0);
    // Ride the next lap past buoy 1 on its wrong side.
    let b = OVAL.buoys[1];
    let wrong = match b.keep {
        Keep::Right => b.offset + 4.0,
        Keep::Left => b.offset - 4.0,
    };
    let f = OVAL.centerline(b.s - 15.0);
    let (x, z) = f.at_offset(wrong);
    let mut r = w.riders[0].unwrap();
    assert_eq!(r.race.next_gate, 1);
    r.race.next_gate = 2;
    r.pos = Vec3::new(x, w.surface.height(x, z, w.tick) - DRAFT, z);
    r.yaw = f.yaw;
    r.vel = r.forward() * 18.0;
    r.quantize();
    w.riders[0] = Some(r);
    let mut events = Vec::new();
    for _ in 0..60 {
        let mut inputs: Inputs = [None; MAX_RIDERS];
        inputs[0] = Some(sim::Input::from_analog(0.0, 1.0, 0.0, 0));
        events.extend(w.step(&inputs));
    }
    assert!(
        events
            .iter()
            .any(|e| matches!(e.kind, EventKind::Buoy { ok: false, .. })),
        "{events:?}"
    );
    assert_eq!(w.riders[0].unwrap().race.misses, 1);
    assert!(!w.on_autopilot(0), "never disqualified in a time trial");

    let void = lap_times(&ride_laps(&mut w, 1, TICK_HZ * 120));
    let [(2, _, false, false)] = void[..] else {
        panic!("lap 2 void: {void:?}")
    };
    let p = w.riders[0].unwrap().race;
    assert!(p.laps.last_void && p.laps.best == best && p.laps.done == 2);
    assert_eq!(p.misses, 0, "a new lap starts clean");

    let next = lap_times(&ride_laps(&mut w, 1, TICK_HZ * 120));
    let [(3, ticks, true, is_best)] = next[..] else {
        panic!("lap 3 clean: {next:?}")
    };
    assert_eq!(is_best, ticks < best);
    assert!(!w.riders[0].unwrap().race.laps.last_void);
}

#[test]
fn a_run_is_a_lap_and_the_rider_goes_back_to_the_top_for_the_next() {
    let mut w = trial(CourseId::Mountain);
    let start = w.race.phase_tick;
    assert_eq!(w.riders[0].unwrap().race.laps.start, start);
    let events = ride_laps(&mut w, 1, TICK_HZ * 240);
    let finish = events
        .iter()
        .find_map(|e| match e.kind {
            EventKind::Finish { ticks } => Some(ticks),
            _ => None,
        })
        .expect("through the finish");
    let [(1, ticks, true, true)] = lap_times(&events)[..] else {
        panic!("{events:?}")
    };
    assert_eq!(ticks, finish, "start signal to finish");
    assert!(w.on_autopilot(0), "riding out");
    // Rides out a beat, then the sim takes it back to the top.
    for _ in 0..RUN_OUT_TICKS - 1 {
        ride(&mut w);
    }
    assert_eq!(w.race.phase, Phase::Racing);
    ride(&mut w);
    assert_eq!(w.race.phase, Phase::Countdown);
    let r = w.riders[0].unwrap();
    let spot = w.course().grid_spot(0);
    assert!((r.pos.x - spot.x).abs() < 0.01 && (r.pos.z - spot.z).abs() < 0.01);
    assert_eq!(
        (r.race.finish_ticks, r.race.lap, r.race.laps.start),
        (0, 0, 0)
    );
    assert_eq!((r.race.laps.done, r.race.laps.best), (1, ticks));
    for _ in 0..COUNTDOWN_TICKS {
        ride(&mut w);
    }
    assert_eq!(w.race.phase, Phase::Racing);
    assert_eq!(w.riders[0].unwrap().race.laps.start, w.race.phase_tick);
    let second = lap_times(&ride_laps(&mut w, 1, TICK_HZ * 240));
    assert_eq!(second[0].0, 2);
    assert!(second[0].2);
}

#[test]
fn a_retry_drops_the_lap_under_way_and_keeps_the_session() {
    for course in [CourseId::Oval, CourseId::Mountain] {
        let mut w = trial(course);
        ride_laps(&mut w, 1, TICK_HZ * 240);
        if !w.course().looped() {
            while w.race.phase != Phase::Racing || w.riders[0].unwrap().race.finished() {
                ride(&mut w);
            }
        }
        for _ in 0..TICK_HZ * 5 {
            ride(&mut w);
        }
        let before = w.riders[0].unwrap().race.laps;
        assert_ne!(before.start, 0, "{course:?}: a lap under way");
        w.retry();
        assert_eq!(w.race.phase, Phase::Countdown);
        let r = w.riders[0].unwrap();
        assert_eq!(r.race.laps, before.kept(), "{course:?}");
        let spot = w.course().grid_spot(0);
        assert!(
            (r.pos.x - spot.x).abs() < 0.01,
            "{course:?}: back on the grid"
        );
        for _ in 0..COUNTDOWN_TICKS + TICK_HZ * 5 {
            ride(&mut w);
        }
        assert!(lap_times(&ride_laps(&mut w, 1, TICK_HZ * 240))[0].0 == before.done + 1);
    }
}

#[test]
fn a_session_ends_on_its_results_and_stays_there() {
    let mut w = trial(CourseId::Oval);
    ride_laps(&mut w, 1, TICK_HZ * 120);
    let laps = w.riders[0].unwrap().race.laps;
    w.end_session();
    assert_eq!(w.race.phase, Phase::Results);
    assert_eq!(w.riders[0].unwrap().race.laps, laps.kept());
    for _ in 0..TICK_HZ * 60 {
        ride(&mut w);
    }
    assert_eq!(w.race.phase, Phase::Results);
    assert!(w.on_autopilot(0));
}

#[test]
fn a_session_resimulates_exactly_from_any_tick() {
    for course in [CourseId::Oval, CourseId::Mountain] {
        let mut a = trial(course);
        let mut copies = Vec::new();
        for i in 0..TICK_HZ * 300 {
            if i == TICK_HZ * 50 {
                a.retry();
            }
            if i > TICK_HZ * 50 && i % (TICK_HZ * 17) == 0 {
                copies.push(a.clone());
            }
            ride(&mut a);
        }
        assert!(a.riders[0].unwrap().race.laps.done >= 2, "{course:?}");
        for mut b in copies {
            let from = b.tick;
            while b.tick < a.tick {
                ride(&mut b);
            }
            assert_eq!(b.state_hash(), a.state_hash(), "{course:?} from {from}");
        }
    }
}
