//! Runs a full bots-only race and prints what happened: finish times,
//! missed buoys, tricks, points and bails, and which tricks were landed.
//! For tuning bots, tricks and the course.
//!
//! `cargo run -p sim --example bot_race --release [course] [seed]`
//! (course: `bay`, the default, or `cape`)

use std::collections::BTreeMap;

use sim::race::{EventKind, Trick};
use sim::{CourseId, Inputs, MAX_RIDERS, Phase, SurfaceKind, World};

const STUNTS: [&str; 6] = [
    "",
    "no hander",
    "handstand",
    "superman",
    "nac-nac",
    "can-can",
];

fn name(t: &Trick) -> String {
    let mut parts = Vec::new();
    if t.flip != 0 {
        parts.push(if t.flip > 0 { "backflip" } else { "frontflip" }.to_owned());
    }
    if t.roll != 0 {
        parts.push("barrel roll".to_owned());
    }
    if t.spin != 0 {
        parts.push(format!("{}", u32::from(t.spin.unsigned_abs()) * 180));
    }
    if t.stunt != 0 {
        parts.push(STUNTS[usize::from(t.stunt)].to_owned());
    }
    parts.join(" + ")
}

fn main() {
    let mut seed: u32 = 1;
    let mut course = CourseId::Oval;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "bay" | "oval" => course = CourseId::Oval,
            "cape" => course = CourseId::Cape,
            other => seed = other.parse().expect("a course (bay, cape) or a seed"),
        }
    }
    let mut w = World::on_course(course, SurfaceKind::Swells, seed);
    println!(
        "{course:?}: {:.0} m a lap, {} laps, seed {seed}",
        w.course().length(),
        w.course().laps
    );
    for slot in 0..MAX_RIDERS {
        w.spawn(slot);
    }
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut bails = [0u32; MAX_RIDERS];
    let mut airtime = [0u32; MAX_RIDERS];
    let mut crawling = [0u32; MAX_RIDERS];
    let mut missed: BTreeMap<u8, u32> = BTreeMap::new();
    let mut landed: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    while w.race.phase != Phase::Results {
        for (slot, i) in inputs.iter_mut().enumerate() {
            *i = Some(sim::bot::bot_input(&w, slot));
        }
        for e in w.step(&inputs) {
            match e.kind {
                EventKind::Bail => bails[usize::from(e.slot)] += 1,
                EventKind::Buoy {
                    buoy, ok: false, ..
                } if w.race.phase == Phase::Racing => {
                    *missed.entry(buoy).or_default() += 1;
                }
                EventKind::Trick { trick, .. } if w.race.phase == Phase::Racing => {
                    let n = landed.entry(name(&trick)).or_default();
                    n.0 += 1;
                    n.1 = n.1.max(u32::from(trick.points));
                }
                _ => {}
            }
        }
        if w.race.phase == Phase::Racing {
            for (slot, r) in w.riders.iter().enumerate() {
                let Some(r) = r else { continue };
                if !r.grounded {
                    airtime[slot] += 1;
                }
                // Stuck on land or crawling (after the start, until the finish).
                if !r.race.finished()
                    && w.race.elapsed(w.tick) > 180
                    && r.speed() < 4.0
                    && !r.bailing()
                {
                    crawling[slot] += 1;
                }
            }
        }
    }
    for st in w.standings() {
        let p = st.progress;
        let slot = usize::from(st.slot);
        println!(
            "{}. bot {} {:>6.2}s  missed {}  tricks {:>2} ({:>5} pts)  bails {}  air {:.1}s  crawling {:.1}s",
            st.place,
            slot + 1,
            p.finish_ticks as f32 / 60.0,
            p.misses,
            p.tricks,
            p.points,
            bails[slot],
            airtime[slot] as f32 / 60.0,
            crawling[slot] as f32 / 60.0
        );
    }
    if !missed.is_empty() {
        let list: Vec<String> = missed.iter().map(|(b, n)| format!("{b}: {n}")).collect();
        println!("missed by buoy: {}", list.join(", "));
    }
    println!("tricks landed (times, best points):");
    for (trick, (n, best)) in &landed {
        println!("  {trick:<28} {n:>3}  {best:>5}");
    }
}
