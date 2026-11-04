//! Races bots with each setup on both courses and compares them with the
//! balanced one: mean finish time, the gap to balanced, trick points, bails.
//! A fair setup trades time for style, never wins on both.
//!
//! `cargo run -p sim --example setup_lab --release [races]`

use sim::race::EventKind;
use sim::{CourseId, Inputs, MAX_RIDERS, Phase, Setup, SurfaceKind, World};

const SETUPS: [(&str, [u8; 4]); 9] = [
    ("balanced", [3, 3, 3, 3]),
    ("speed", [6, 2, 2, 2]),
    ("handling", [2, 6, 2, 2]),
    ("stability", [2, 2, 6, 2]),
    ("tricks", [2, 2, 2, 6]),
    ("speed+handling", [6, 6, 0, 0]),
    ("speed+stability", [6, 0, 6, 0]),
    ("racer", [5, 4, 3, 0]),
    ("showboat", [1, 2, 3, 6]),
];

struct Tally {
    time: f64,
    finished: u32,
    points: u64,
    bails: u32,
}

fn race(course: CourseId, seed: u32, setup: Setup) -> Tally {
    let mut w = World::on_course(course, SurfaceKind::Swells, seed);
    for slot in 0..MAX_RIDERS {
        w.spawn(slot);
        w.setups[slot] = setup;
    }
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut t = Tally {
        time: 0.0,
        finished: 0,
        points: 0,
        bails: 0,
    };
    let mut started = false;
    loop {
        for (slot, i) in inputs.iter_mut().enumerate() {
            *i = Some(sim::bot::bot_input(&w, slot));
        }
        for e in w.step(&inputs) {
            if e.kind == EventKind::Bail && w.race.phase == Phase::Racing {
                t.bails += 1;
            }
        }
        if w.race.phase == Phase::Racing {
            started = true;
        }
        if started && w.race.phase == Phase::Results {
            break;
        }
    }
    for st in w.standings() {
        let p = st.progress;
        if p.finished() {
            t.time += f64::from(p.finish_ticks) / 60.0;
            t.finished += 1;
        }
        t.points += u64::from(p.points);
    }
    t
}

fn main() {
    let races: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(4);
    for course in [CourseId::Oval, CourseId::Mountain] {
        println!("{course:?}: {races} races of 8 bots per setup");
        let mut base = 0.0;
        for (name, bytes) in SETUPS {
            let setup = Setup::from_bytes(bytes);
            let mut sum = Tally {
                time: 0.0,
                finished: 0,
                points: 0,
                bails: 0,
            };
            for seed in 1..=races {
                let t = race(course, seed, setup);
                sum.time += t.time;
                sum.finished += t.finished;
                sum.points += t.points;
                sum.bails += t.bails;
            }
            let mean = sum.time / f64::from(sum.finished.max(1));
            if name == "balanced" {
                base = mean;
            }
            let riders = f64::from(races * MAX_RIDERS as u32);
            println!(
                "  {name:<16} {mean:>7.2}s  {:>+6.2}%  finished {:>3}  points/rider {:>6.0}  bails/rider {:>4.2}",
                (mean / base - 1.0) * 100.0,
                sum.finished,
                sum.points as f64 / riders,
                f64::from(sum.bails) / riders,
            );
        }
    }
}
