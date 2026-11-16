//! Runs a full bots-only race and prints what happened: finish times,
//! missed buoys or gates and disqualifications, tricks, points and bails,
//! and which tricks were landed.
//! For tuning bots, tricks and the courses, in any conditions.
//!
//! `cargo run -p sim --example bot_race --release [seed] [course] [season weather [turns] [time]]`
//!
//! `course` is a circuit's id or name (`oval`, `mountain`, ...); the
//! conditions are names (`winter storm clear 60`), the course's home
//! conditions if left out. `bot_race table [seed]` races every circuit in
//! every season its sport rides, in a spread of weathers, and prints a
//! table: the times against the home conditions', misses (all of them,
//! the most by one bot) and disqualifications, falls and tricks.
//! `bot_race kinds [seeds] [course...]` races seeds 1 to `seeds` on each
//! circuit (all of them if none is named) in its home conditions and
//! prints, by bot kind (each seat's pace, and whether it tricks), the wins,
//! the average place and time, missed buoys and falls.
//! `bot_race best [course...]` races one jetski bot alone on each water
//! circuit (the bay and the cape if none is named): flat out with the meter
//! full from the start and no tricks or pops (the best a bot does), then
//! each seat's bot alone, from an empty meter; it prints race and lap times.
//! `BOT_TRACE=<slot>` prints where that bot is every second
//! (`BOT_TRACE_EVERY=<ticks>` for another interval).

use std::collections::BTreeMap;

use sim::bot::{JetskiBot, Tier};
use sim::conditions::{Conditions, Event, NOON, Season, Weather};
use sim::race::tuning::METER_MAX;
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
    let every: u32 = std::env::var("BOT_TRACE_EVERY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
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
            && w.tick.is_multiple_of(every)
            && w.race.phase == Phase::Racing
            && let Some(r) = w.riders[slot]
        {
            let (s, offset) = w.course().project(r.pos.x, r.pos.z);
            println!(
                "  t {:>6.2}  s {s:>7.1}  offset {offset:>6.1}  speed {:>5.1}  bail {}  yaw {:>5.2}  input {:?}",
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

/// Misses in all, the most by one rider, and how many were disqualified.
fn misses(o: &Outcome) -> (u32, u8, usize) {
    let st = o.world.standings();
    let all = st.iter().map(|s| u32::from(s.progress.misses)).sum();
    let most = st.iter().map(|s| s.progress.misses).max().unwrap_or(0);
    let out = st.iter().filter(|s| s.progress.disqualified()).count();
    (all, most, out)
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
    if args.first().is_some_and(|a| a == "best") {
        let courses: Vec<CourseId> = args.iter().skip(1).filter_map(|a| course(a)).collect();
        best(if courses.is_empty() {
            &[CourseId::Oval, CourseId::Cape]
        } else {
            &courses
        });
        return;
    }
    if args.first().is_some_and(|a| a == "kinds") {
        let seeds = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(10);
        let courses: Vec<CourseId> = args.iter().skip(2).filter_map(|a| course(a)).collect();
        kinds(
            seeds,
            if courses.is_empty() {
                CourseId::ALL
            } else {
                &courses
            },
        );
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
        let time = if p.disqualified() {
            format!("DQ {:>5.1}s", p.disqualified_ticks as f32 / 60.0)
        } else {
            format!("{:>6.2}s", p.finish_ticks as f32 / 60.0)
        };
        println!(
            "{}. bot {} {time:>9}  missed {}  tricks {:>2} ({:>5} pts)  bails {}  air {:.1}s",
            st.place,
            slot + 1,
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
        "{:<10} {:<7} {:<16} {:>8} {:>8} {:>7} {:>4} {:>6} {:>4} {:>3} {:>6} {:>7}",
        "circuit",
        "season",
        "weather",
        "winner",
        "median",
        "vs home",
        "dnf",
        "missed",
        "most",
        "dq",
        "bails",
        "tricks"
    );
    let mut worst = (0u8, String::new());
    let mut out_all = 0;
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
                let (missed, most, out) = misses(&o);
                out_all += out;
                if most > worst.0 {
                    worst = (most, format!("{course:?} {season:?} {label}"));
                }
                println!(
                    "{:<10} {:<7} {:<16} {:>7.2}s {:>7.2}s {:>+6.1}% {:>4} {:>6} {:>4} {:>3} {:>6} {:>7}",
                    format!("{course:?}"),
                    format!("{season:?}"),
                    label,
                    winner,
                    median,
                    (median / home_median - 1.0) * 100.0,
                    dnf,
                    missed,
                    most,
                    out,
                    o.bails.iter().sum::<u32>(),
                    tricks
                );
            }
        }
    }
    println!(
        "disqualified in all: {out_all}; most misses by one bot: {} ({})",
        worst.0, worst.1
    );
}

/// A seat's kind of bot: its pace class (0 slowest to 2 fastest) and
/// whether it tricks.
fn kind_of(course: CourseId, slot: usize) -> (usize, bool) {
    if course.sport() == sim::Sport::Jetski {
        let (tier, trickster) = sim::bot::JETSKI_SEATS[slot];
        let class = match tier {
            Tier::Slow => 0,
            Tier::Middling => 1,
            Tier::Fast => 2,
        };
        return (class, trickster);
    }
    (slot % 3, slot % 3 != 1)
}

/// What one kind of bot did over many races.
#[derive(Default)]
struct Tally {
    races: u32,
    wins: u32,
    places: u32,
    finished: u32,
    time: f32,
    misses: u32,
    most_misses: u8,
    out: u32,
    bails: u32,
    air: u32,
    points: u32,
}

impl Tally {
    fn row(&self, label: &str) {
        let n = self.races.max(1) as f32;
        println!(
            "  {label:<22} {:>5} {:>6.2} {:>8.2}s {:>7.2} {:>5} {:>3} {:>6.2} {:>6.1}s {:>7.0}",
            self.wins,
            self.places as f32 / n,
            self.time / self.finished.max(1) as f32,
            self.misses as f32 / n,
            self.most_misses,
            self.out,
            self.bails as f32 / n,
            self.air as f32 / 60.0 / n,
            self.points as f32 / n,
        );
    }
}

/// Wins and places by bot kind, over many races on each circuit.
fn kinds(seeds: u32, courses: &[CourseId]) {
    for &course in courses {
        let mut by_class: [Tally; 3] = Default::default();
        let mut by_tricks: [Tally; 2] = Default::default();
        let mut by_seat: [Tally; MAX_RIDERS] = Default::default();
        for seed in 1..=seeds {
            let o = race(Event::home(course), seed);
            for st in o.world.standings() {
                let slot = usize::from(st.slot);
                let (class, trickster) = kind_of(course, slot);
                let p = st.progress;
                for t in [
                    &mut by_class[class],
                    &mut by_tricks[usize::from(trickster)],
                    &mut by_seat[slot],
                ] {
                    t.races += 1;
                    t.wins += u32::from(st.place == 1);
                    t.places += u32::from(st.place);
                    if p.finished() {
                        t.finished += 1;
                        t.time += p.finish_ticks as f32 / 60.0;
                    }
                    t.misses += u32::from(p.misses);
                    t.most_misses = t.most_misses.max(p.misses);
                    t.out += u32::from(p.disqualified());
                    t.bails += o.bails[slot];
                    t.air += o.airtime[slot];
                    t.points += u32::from(p.points);
                }
            }
        }
        println!("{course:?}, {seeds} races in its home conditions");
        println!(
            "  {:<22} {:>5} {:>6} {:>9} {:>7} {:>5} {:>3} {:>6} {:>7} {:>7}",
            "kind", "wins", "place", "time", "misses", "most", "dq", "bails", "air", "points"
        );
        for (class, t) in by_class.iter().enumerate() {
            t.row(&format!("pace class {class}"));
        }
        by_tricks[1].row("all tricksters");
        by_tricks[0].row("all plain");
        if std::env::var("KINDS_SEATS").is_ok() {
            for (slot, t) in by_seat.iter().enumerate() {
                let (class, trickster) = kind_of(course, slot);
                let tricks = if trickster { ", tricks" } else { "" };
                t.row(&format!("seat {slot}: class {class}{tricks}"));
            }
        }
    }
}

/// One jetski bot alone on a course in its home conditions: its race time,
/// its lap times, the buoys it missed and how long it flew (s).
fn solo(
    course: CourseId,
    seed: u32,
    slot: usize,
    bot: JetskiBot,
    full: bool,
) -> (f32, Vec<f32>, u8, f32) {
    let mut w = World::for_event(Event::home(course), SurfaceKind::Swells, seed);
    w.spawn(slot);
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut laps = Vec::new();
    let mut lap_start = 0;
    let mut air = 0;
    while w.race.phase != Phase::Results {
        inputs[slot] = Some(sim::bot::jetski_input_as(&w, slot, bot));
        if full
            && w.race.phase == Phase::Racing
            && let Some(r) = w.riders[slot].as_mut()
        {
            r.race.meter = METER_MAX;
        }
        for e in w.step(&inputs) {
            match e.kind {
                EventKind::Lap { lap } if lap > 1 => {
                    let now = w.race.elapsed(w.tick);
                    laps.push((now - lap_start) as f32 / 60.0);
                    lap_start = now;
                }
                EventKind::Lap { .. } => lap_start = w.race.elapsed(w.tick),
                EventKind::Finish { ticks } => laps.push((ticks - lap_start) as f32 / 60.0),
                EventKind::Buoy {
                    buoy, ok: false, ..
                } if std::env::var("BEST_MISSES").is_ok() => {
                    println!("    missed buoy {buoy} (seed {seed}, seat {slot})");
                }
                _ => {}
            }
        }
        if w.race.phase == Phase::Racing && w.riders[slot].is_some_and(|r| !r.grounded) {
            air += 1;
        }
        if let Ok(range) = std::env::var("BEST_TRACE")
            && let Some((a, b)) = range.split_once('-')
            && let (Ok(a), Ok(b)) = (a.parse::<f32>(), b.parse::<f32>())
            && w.tick.is_multiple_of(3)
            && let Some(r) = w.riders[slot]
        {
            let (s, offset) = w.course().project(r.pos.x, r.pos.z);
            if (a..b).contains(&s) {
                println!(
                    "    seed {seed} s {s:>6.1} offset {offset:>5.1} speed {:>4.1} air {} gate {} steer {} y {:.2}",
                    r.speed(),
                    !r.grounded,
                    r.race.next_gate,
                    r.last_input.steer,
                    r.pos.y
                );
            }
        }
    }
    let r = w.riders[slot].unwrap();
    (
        r.race.finish_ticks as f32 / 60.0,
        laps,
        r.race.misses,
        air as f32 / 60.0,
    )
}

/// The best a jetski bot does alone, and each seat's bot alone.
fn best(courses: &[CourseId]) {
    for &course in courses {
        println!("{course:?}, alone, home conditions, seeds 1-3");
        let flat_out = JetskiBot {
            pace: 1.0,
            lane: 0,
            margin: 2.5,
            trickster: false,
            ramp_laps: 0,
            ramp_reach: 0.0,
            pops: false,
        };
        let mut rows: Vec<(String, usize, JetskiBot, bool)> =
            vec![("flat out, full meter".to_owned(), 0, flat_out, true)];
        rows.push(("flat out".to_owned(), 0, flat_out, false));
        for slot in [6, 7, 2, 3, 4, 5] {
            let bot = JetskiBot::of(slot);
            let (tier, _) = sim::bot::JETSKI_SEATS[slot];
            let label = format!(
                "seat {slot}: {tier:?} {:.2}{}",
                bot.pace,
                if bot.trickster { ", tricks" } else { "" }
            );
            rows.push((label, slot, bot, false));
        }
        if std::env::var("BEST_MORE").is_ok() {
            for slot in [7, 5] {
                let bot = JetskiBot::of(slot);
                for (label, laps, reach) in [
                    ("no ramps", 0, 0.0),
                    ("ramps on its line", 7, 4.5),
                    ("every ramp", 7, 45.0),
                ] {
                    for trickster in [false, true] {
                        let b = JetskiBot {
                            ramp_laps: laps,
                            ramp_reach: reach,
                            trickster,
                            ..bot
                        };
                        let tricks = if trickster { ", tricks" } else { "" };
                        rows.push((format!("seat {slot}, {label}{tricks}"), slot, b, false));
                    }
                }
            }
        }
        for (label, slot, bot, full) in rows {
            let mut total = 0.0;
            let mut best_lap = f32::MAX;
            let mut misses = 0;
            let mut air = 0.0;
            for seed in 1..=3 {
                let (t, laps, m, a) = solo(course, seed, slot, bot, full);
                total += t;
                best_lap = laps.iter().copied().fold(best_lap, f32::min);
                misses += u32::from(m);
                air += a;
            }
            println!(
                "  {label:<28} race {:>7.2}s  best lap {best_lap:>6.2}s  missed {misses}  air {:>5.1}s",
                total / 3.0,
                air / 3.0
            );
        }
    }
}
