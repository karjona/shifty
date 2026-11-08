//! Runs a full bots-only race and prints what happened: finish times,
//! missed buoys, tricks, points and bails, and which tricks were landed.
//! For tuning bots, tricks and the courses, in any conditions.
//!
//! `cargo run -p sim --example bot_race --release [seed] [course] [season weather [turns] [time]]`
//!
//! `course` is a circuit's id or name (`oval`, `mountain`, ...); the
//! conditions are names (`winter storm clear 60`), the course's home
//! conditions if left out. `bot_race table [seed]` races every circuit in
//! every season its sport rides, in a spread of weathers, and prints a
//! table: the times against the home conditions', falls and tricks.
//! `BOT_TRACE=<slot>` prints where that bot is every second.

use std::collections::BTreeMap;

use sim::conditions::{Conditions, Event, NOON, Season, Weather};
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
const GRABS: [&str; 6] = ["", "indy", "nose", "tail", "melon", "method"];

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
    if t.grab != 0 {
        parts.push(GRABS[usize::from(t.grab).min(5)].to_owned());
    }
    parts.join(" + ")
}

/// A circuit by id or name.
fn course(arg: &str) -> Option<CourseId> {
    CourseId::ALL
        .iter()
        .copied()
        .find(|c| arg == (*c as u8).to_string() || arg.eq_ignore_ascii_case(&format!("{c:?}")))
}

fn season(arg: &str) -> Option<Season> {
    Season::ALL
        .into_iter()
        .find(|s| arg.eq_ignore_ascii_case(&format!("{s:?}")))
}

fn weather(arg: &str) -> Option<Weather> {
    Weather::ALL
        .into_iter()
        .find(|w| arg.eq_ignore_ascii_case(&format!("{w:?}")))
}

/// How a race went.
struct Outcome {
    world: World,
    bails: [u32; MAX_RIDERS],
    airtime: [u32; MAX_RIDERS],
    landed: BTreeMap<String, (u32, u32)>,
}

fn race(event: Event, seed: u32) -> Outcome {
    // `BOT_TRACE=<slot>` prints where that rider is every second.
    let trace: Option<usize> = std::env::var("BOT_TRACE").ok().and_then(|s| s.parse().ok());
    let mut w = World::for_event(event, SurfaceKind::Swells, seed);
    for slot in 0..MAX_RIDERS {
        w.spawn(slot);
    }
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut bails = [0u32; MAX_RIDERS];
    let mut airtime = [0u32; MAX_RIDERS];
    let mut landed: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    while w.race.phase != Phase::Results {
        for (slot, i) in inputs.iter_mut().enumerate() {
            *i = Some(sim::bot::bot_input(&w, slot));
        }
        for e in w.step(&inputs) {
            match e.kind {
                EventKind::Bail if w.race.phase == Phase::Racing => {
                    bails[usize::from(e.slot)] += 1;
                }
                EventKind::Trick { trick, .. } if w.race.phase == Phase::Racing => {
                    let n = landed.entry(name(&trick)).or_default();
                    n.0 += 1;
                    n.1 = n.1.max(u32::from(trick.points));
                }
                _ => {}
            }
        }
        if let Some(slot) = trace
            && w.tick.is_multiple_of(60)
            && w.race.phase == Phase::Racing
            && let Some(r) = w.riders[slot]
        {
            let (s, offset) = w.course().project(r.pos.x, r.pos.z);
            println!(
                "  t {:>5.1}  s {s:>7.1}  offset {offset:>6.1}  speed {:>5.1}  bail {}  yaw {:>5.2}  input {:?}",
                w.race.elapsed(w.tick) as f32 / 60.0,
                r.speed(),
                r.bail_ticks,
                r.yaw,
                r.last_input
            );
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
    Outcome {
        world: w,
        bails,
        airtime,
        landed,
    }
}

/// Finish times (s) of those who finished, fastest first, and how many didn't.
fn times(o: &Outcome) -> (Vec<f32>, usize) {
    let mut t: Vec<f32> = o
        .world
        .standings()
        .iter()
        .filter(|st| st.progress.finished())
        .map(|st| st.progress.finish_ticks as f32 / 60.0)
        .collect();
    t.sort_by(f32::total_cmp);
    let dnf = MAX_RIDERS - t.len();
    (t, dnf)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "table") {
        let seed = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
        table(seed);
        return;
    }
    let seed: u32 = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
    let course = args
        .get(1)
        .and_then(|a| course(a))
        .unwrap_or(CourseId::Oval);
    let mut event = Event::home(course);
    if let (Some(s), Some(w)) = (
        args.get(2).and_then(|a| season(a)),
        args.get(3).and_then(|a| weather(a)),
    ) {
        event.conditions = Conditions {
            season: s,
            weather: w,
            turns: args.get(4).and_then(|a| weather(a)).unwrap_or(w),
            time: args
                .get(5)
                .and_then(|a| a.parse().ok())
                .map_or(NOON, |t| s.clamp_time(t)),
        };
    }
    println!("{course:?} in {:?}", event.conditions);
    let o = race(event, seed);
    for st in o.world.standings() {
        let p = st.progress;
        let slot = usize::from(st.slot);
        println!(
            "{}. bot {} {:>6.2}s  missed {}  tricks {:>2} ({:>5} pts)  bails {}  air {:.1}s",
            st.place,
            slot + 1,
            p.finish_ticks as f32 / 60.0,
            p.misses,
            p.tricks,
            p.points,
            o.bails[slot],
            o.airtime[slot] as f32 / 60.0
        );
    }
    println!("tricks landed (times, best points):");
    for (trick, (n, best)) in &o.landed {
        println!("  {trick:<28} {n:>3}  {best:>5}");
    }
}

/// Every circuit in every season its sport rides, in a spread of weathers
/// the season brings (steady, and one that turns), against its home
/// conditions.
fn table(seed: u32) {
    println!(
        "{:<10} {:<7} {:<16} {:>8} {:>8} {:>7} {:>4} {:>6} {:>7}",
        "circuit", "season", "weather", "winner", "median", "vs home", "dnf", "bails", "tricks"
    );
    for &course in CourseId::ALL {
        let home = race(Event::home(course), seed);
        let (home_times, _) = times(&home);
        let home_median = home_times[home_times.len() / 2];
        for &season in course.sport().seasons() {
            let mut rows: Vec<(Weather, Weather)> = [
                Weather::Clear,
                Weather::Fog,
                Weather::Windy,
                Weather::Rain,
                Weather::Storm,
                Weather::Snow,
            ]
            .into_iter()
            .filter(|&w| season.has(w))
            .map(|w| (w, w))
            .collect();
            if season.has(Weather::Storm) {
                rows.push((Weather::Cloudy, Weather::Storm));
                rows.push((Weather::Storm, Weather::Clear));
            }
            for (from, to) in rows {
                let conditions = Conditions {
                    season,
                    weather: from,
                    turns: to,
                    time: season.time_of(sim::conditions::TimeOfDay::Afternoon),
                };
                let o = race(Event { course, conditions }, seed);
                let (t, dnf) = times(&o);
                let label = if from == to {
                    format!("{from:?}")
                } else {
                    format!("{from:?} > {to:?}")
                };
                let (winner, median) = match (t.first(), t.get(t.len() / 2)) {
                    (Some(&a), Some(&b)) => (a, b),
                    _ => (f32::NAN, f32::NAN),
                };
                let tricks: u32 = o.landed.values().map(|v| v.0).sum();
                println!(
                    "{:<10} {:<7} {:<16} {:>7.2}s {:>7.2}s {:>+6.1}% {:>4} {:>6} {:>7}",
                    format!("{course:?}"),
                    format!("{season:?}"),
                    label,
                    winner,
                    median,
                    (median / home_median - 1.0) * 100.0,
                    dnf,
                    o.bails.iter().sum::<u32>(),
                    tricks
                );
            }
        }
    }
}
