//! Jetski bots race the water circuits clean: they finish, keep clear of
//! the moored boats and the jetty, and rarely miss a buoy or fall.

use sim::capsule::Segment;
use sim::course::{BoatDef, LandKind};
use sim::race::EventKind;
use sim::{CourseId, Inputs, MAX_RIDERS, Phase, SurfaceKind, World};

fn race_clean(course: CourseId, seed: u32) {
    let c = course.course();
    let moored: Vec<(Segment, f32)> = c
        .boats
        .iter()
        .map(BoatDef::hull)
        .chain(
            c.land
                .iter()
                .filter(|l| l.kind == LandKind::Jetty)
                .map(|l| (Segment::new(l.a, l.b), l.radius)),
        )
        .collect();
    let body = c.sport.body();
    let mut w = World::on_course(course, SurfaceKind::Swells, seed);
    for slot in 0..MAX_RIDERS {
        w.spawn(slot);
    }
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut nearest = f32::MAX;
    let mut falls = 0;
    while w.race.phase != Phase::Results {
        for (slot, i) in inputs.iter_mut().enumerate() {
            *i = Some(sim::bot::bot_input(&w, slot));
        }
        let racing = w.race.phase == Phase::Racing;
        falls += w
            .step(&inputs)
            .iter()
            .filter(|e| racing && e.kind == EventKind::Bail)
            .count();
        if w.race.phase != Phase::Racing {
            continue;
        }
        for r in w.riders.iter().flatten().filter(|r| !r.race.done()) {
            let hull = body.segment(r.pos.x, r.pos.z, r.yaw);
            for &(spine, radius) in &moored {
                let (p, q) = hull.closest(&spine);
                let gap = (p.0 - q.0).hypot(p.1 - q.1) - radius - body.radius;
                nearest = nearest.min(gap);
            }
        }
    }
    assert!(falls <= 2, "{course:?} seed {seed}: {falls} falls");
    assert!(
        nearest > 3.0,
        "{course:?} seed {seed}: a bot came {nearest} m from a boat"
    );
    for r in w.riders.iter().flatten() {
        assert!(
            r.race.finished(),
            "{course:?} seed {seed}: everyone finishes"
        );
        assert!(
            r.race.misses <= 2,
            "{course:?} seed {seed}: {} misses",
            r.race.misses
        );
    }
}

#[test]
fn bots_race_the_bay_clean() {
    race_clean(CourseId::Oval, 1);
}

#[test]
fn bots_race_the_cape_clean() {
    race_clean(CourseId::Cape, 2);
}
