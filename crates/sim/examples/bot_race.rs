//! Runs a full bots-only race and prints what happened: finish times,
//! missed buoys, tricks and bails. For tuning bots and the course.
//!
//! `cargo run -p sim --example bot_race --release [seed]`

use sim::race::EventKind;
use sim::{CourseId, Inputs, MAX_RIDERS, Phase, SurfaceKind, World};

fn main() {
    let seed: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let mut w = World::on_course(CourseId::Oval, SurfaceKind::Swells, seed);
    for slot in 0..MAX_RIDERS {
        w.spawn(slot);
    }
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut bails = [0u32; MAX_RIDERS];
    let mut airtime = [0u32; MAX_RIDERS];
    while w.race.phase != Phase::Results {
        for (slot, i) in inputs.iter_mut().enumerate() {
            *i = Some(sim::bot::bot_input(&w, slot));
        }
        for e in w.step(&inputs) {
            if e.kind == EventKind::Bail {
                bails[usize::from(e.slot)] += 1;
            }
        }
        if w.race.phase == Phase::Racing {
            for (slot, r) in w.riders.iter().enumerate() {
                if let Some(r) = r
                    && !r.grounded
                {
                    airtime[slot] += 1;
                }
            }
        }
    }
    for st in w.standings() {
        let p = st.progress;
        let slot = usize::from(st.slot);
        println!(
            "{}. bot {} {:>6.2}s  missed {}  tricks {}  bails {}  air {:.1}s",
            st.place,
            slot + 1,
            p.finish_ticks as f32 / 60.0,
            p.misses,
            p.tricks,
            bails[slot],
            airtime[slot] as f32 / 60.0
        );
    }
}
