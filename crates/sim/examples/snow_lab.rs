//! Prints how the snowboard and the mountain's runs behave: each run's
//! profile (pitch, banks, widths), how fast a rider goes standing tall and
//! tucked, how much air its tables, lips and drops give with and without a
//! pop, a bots-only race down the whole run (times, falls and where, missed
//! gates, tricks, cost per tick), and the snow in every season and a spread of weathers:
//! what lies at the top, the middle and the bottom, how fast a tuck goes on
//! it, and the bots' times against the home conditions'. For tuning.
//!
//! `cargo run -p sim --example snow_lab --release [mountain|glades] [seed]`
//! (every run by default; the arguments in any order).
//!
//! `snow_lab kinds [mountain|glades]` races the bots on each run in every
//! season and a spread of weathers, and prints who wins by kind of bot
//! (tricksters or not, and by pace), their times against the best a bot
//! does alone flat out in the same conditions, their falls and missed gates.
//! `SEATS_FROM=n` leaves the first n seats empty (where players sit).
//! `snow_lab gates [mountain|glades]` sends a lone bot at the fast bots' pace
//! down each run from every seat's line, tricking and not, in a spread of
//! conditions, and prints every gate it misses.

use std::time::Instant;

use sim::bot::{SNOW_SEATS, SnowBot, Tier, bot_input, snowboard_input};
use sim::conditions::{Conditions, Event, Season, TimeOfDay, Weather};
use sim::course::Line;
use sim::input::buttons;
use sim::math::{angle_diff, atan2, clamp};
use sim::mountain::{Feature, LipKind, Run};
use sim::race::{EventKind, Phase};
use sim::{CourseId, Input, Inputs, MAX_RIDERS, Sport, SurfaceKind, World};

/// A run to try: its course, where its open slope is, and its jumps that
/// are not built features (drops, rollers): name and lip.
struct Lab {
    course: CourseId,
    open_s: f32,
    extra: &'static [(&'static str, f32)],
}

const LABS: [Lab; 2] = [
    Lab {
        course: CourseId::Mountain,
        open_s: 100.0,
        extra: &[("cliff", 1058.6), ("rollers", 1440.0)],
    },
    Lab {
        course: CourseId::Glades,
        open_s: 200.0,
        extra: &[
            ("step-down", 1537.5),
            ("glade rollers", 900.0),
            ("rollers", 1700.0),
        ],
    },
];

fn main() {
    let mut seed = 1;
    let mut only = None;
    let mut by_kind = false;
    let mut trick_only = false;
    let mut gates_only = false;
    for a in std::env::args().skip(1) {
        if let Ok(n) = a.parse() {
            seed = n;
        } else if a == "kinds" {
            by_kind = true;
        } else if a == "tricks" {
            trick_only = true;
        } else if a == "gates" {
            gates_only = true;
        } else {
            only = CourseId::ALL.iter().copied().find(|c| {
                a.eq_ignore_ascii_case(&format!("{c:?}")) && c.sport() == Sport::Snowboard
            });
        }
    }
    if by_kind {
        kinds(only);
        return;
    }
    if trick_only {
        tricks(only);
        return;
    }
    if gates_only {
        lone_gates(only);
        return;
    }
    for lab in LABS.iter().filter(|l| only.is_none_or(|c| c == l.course)) {
        let course = lab.course;
        let run = course.course().run().expect("a run");
        println!("== {course:?}");
        profile(run);
        speeds(lab);
        jumps(lab);
        let home = race(Event::home(course), seed, true);
        conditions(lab, seed, home);
        println!();
    }
}

fn profile(run: &Run) {
    println!(
        "== run: {:.0} m, finish at {:.0} m",
        run.length(),
        run.finish_s
    );
    println!("     s      z   head    elev  pitch   bank  half");
    let mut s = 0.0;
    while s < run.length() {
        let f = run.centerline(s);
        let a = run.centerline(s - 3.0);
        let b = run.centerline(s + 3.0);
        let pitch = (run.height(b.x, b.z) - run.height(a.x, a.z)) / 6.0;
        println!(
            "{s:6.0} {:6.0} {:5.0}° {:7.1} {:6.2} {:6.2} {:5.1}",
            f.z,
            f.yaw
                .to_degrees()
                .rem_euclid(360.0)
                .min(360.0 - f.yaw.to_degrees().rem_euclid(360.0))
                * if angle_diff(0.0, f.yaw) < 0.0 {
                    -1.0
                } else {
                    1.0
                },
            run.height(f.x, f.z),
            pitch,
            run.bank(s),
            run.width_at(s).half
        );
        s += 50.0;
    }
}

/// One rider from `s0` down the centre line, holding `lean`, for `secs`.
/// Returns (speed every second, falls).
fn ride(event: Event, s0: f32, lean: f32, secs: u32) -> (Vec<f32>, u32) {
    let mut w = World::for_event(event, SurfaceKind::Flat, 0);
    let run = w.course().run().expect("a run");
    w.spawn(0);
    w.ride_free();
    let mut r = w.riders[0].unwrap();
    let f = run.centerline(s0);
    r.pos.x = f.x;
    r.pos.z = f.z;
    r.pos.y = run.height(f.x, f.z);
    r.yaw = f.yaw;
    r.quantize();
    w.riders[0] = Some(r);
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut out = Vec::new();
    let mut falls = 0;
    for t in 0..secs * 60 {
        let r = w.riders[0].unwrap();
        let (s, _) = run.project(r.pos.x, r.pos.z);
        let (tx, tz) = run.centerline(s + 10.0 + r.speed() * 0.5).at_offset(0.0);
        let heading = if r.speed() > 3.0 {
            atan2(r.vel.x, r.vel.z)
        } else {
            r.yaw
        };
        let steer = clamp(
            -angle_diff(heading, atan2(tx - r.pos.x, tz - r.pos.z)) * 2.0,
            -1.0,
            1.0,
        );
        inputs[0] = Some(Input::from_analog(steer, 0.0, lean, 0));
        for e in w.step(&inputs) {
            if e.kind == EventKind::Bail {
                falls += 1;
            }
        }
        if t % 60 == 59 {
            out.push(w.riders[0].unwrap().speed());
        }
    }
    (out, falls)
}

fn speeds(lab: &Lab) {
    println!(
        "\n== speed down the open slope (s = {}), km/h each second",
        lab.open_s
    );
    for (name, lean) in [("tall ", 0.0), ("tuck ", 1.0), ("brake", -0.5)] {
        let (v, falls) = ride(Event::home(lab.course), lab.open_s, lean, 12);
        let line: Vec<String> = v.iter().map(|s| format!("{:3.0}", s * 3.6)).collect();
        println!("{name} {}  falls {falls}", line.join(" "));
    }
}

/// Approaches a table, a lip or a drop along the centre line at the speed
/// the slope gives, popping at the lip or not. Prints airtime, distance, and
/// how it landed.
fn jumps(lab: &Lab) {
    println!("\n== air: tables, lips and drops (approach from 120 m up, tucked)");
    let course = lab.course;
    let run = course.course().run().expect("a run");
    let mut spots: Vec<(String, f32, f32)> = Vec::new();
    for f in run.features {
        match *f {
            Feature::Table {
                s, ramp, offset, ..
            } => spots.push((format!("table s={s:.0}"), s + ramp, offset)),
            Feature::Lip {
                s,
                ramp,
                offset,
                kind,
                ..
            } => {
                let kind = match kind {
                    LipKind::Wind => "wind lip",
                    LipKind::Log => "log",
                    LipKind::Rock => "rock lip",
                };
                spots.push((format!("{kind} s={s:.0}"), s + ramp, offset));
            }
            _ => {}
        }
    }
    for &(name, lip) in lab.extra {
        spots.push((name.into(), lip, 0.0));
    }
    for (name, lip, offset) in spots {
        for pop in [false, true] {
            let mut w = World::on_course(course, SurfaceKind::Flat, 0);
            w.spawn(0);
            w.ride_free();
            let mut r = w.riders[0].unwrap();
            // From 120 m up, or from past the last trunk in the way.
            let from = run
                .obstacles
                .iter()
                .filter(|o| o.s < lip && (o.offset - offset).abs() < o.radius + 1.5)
                .map(|o| o.s + 4.0)
                .fold(lip - 120.0, f32::max);
            let f = run.centerline(from);
            let (x, z) = f.at_offset(offset);
            r.pos.x = x;
            r.pos.z = z;
            r.pos.y = run.height(x, z);
            r.yaw = f.yaw;
            r.quantize();
            w.riders[0] = Some(r);
            let mut inputs: Inputs = [None; MAX_RIDERS];
            let (mut air, mut longest, mut takeoff_speed, mut flew_at) =
                (0u32, 0u32, 0.0f32, 0.0f32);
            let mut landed_at;
            let mut distance = 0.0;
            let mut outcome = String::from("-");
            for _ in 0..60 * 12 {
                let r = w.riders[0].unwrap();
                let (s, _) = run.project(r.pos.x, r.pos.z);
                let (tx, tz) = run.centerline(s + 10.0 + r.speed() * 0.5).at_offset(offset);
                let heading = if r.speed() > 3.0 {
                    atan2(r.vel.x, r.vel.z)
                } else {
                    r.yaw
                };
                let steer = clamp(
                    -angle_diff(heading, atan2(tx - r.pos.x, tz - r.pos.z)) * 2.0,
                    -1.0,
                    1.0,
                );
                let to_lip = lip - s;
                let jump = pop
                    && r.grounded
                    && to_lip > r.speed() / 60.0 * 1.5
                    && to_lip < r.speed() * 0.6 + 1.0;
                inputs[0] = Some(Input::from_analog(
                    if r.grounded { steer } else { 0.0 },
                    0.0,
                    if r.grounded { 1.0 } else { 0.0 },
                    if jump { buttons::JUMP } else { 0 },
                ));
                for e in w.step(&inputs) {
                    if e.kind == EventKind::Bail {
                        outcome = "FELL".into();
                    } else if e.kind == EventKind::Sketchy && outcome == "-" {
                        outcome = "sketchy".into();
                    }
                }
                let r2 = w.riders[0].unwrap();
                if !r2.grounded {
                    if air == 0 {
                        takeoff_speed = r.speed();
                        flew_at = s;
                    }
                    air += 1;
                } else {
                    if air > longest && flew_at > lip - 30.0 {
                        longest = air;
                        landed_at = run.project(r2.pos.x, r2.pos.z).0;
                        distance = landed_at - flew_at;
                        if outcome == "-" {
                            outcome = "ok".into();
                        }
                    }
                    air = 0;
                }
                if s > lip + 120.0 {
                    break;
                }
            }
            let short = if from > lip - 120.0 {
                format!(", from {:.0} m up", lip - from)
            } else {
                String::new()
            };
            println!(
                "{name:14} pop {:5}: {:4.2} s in the air, {:4.0} m, off at {:3.0} km/h ({outcome}{short})",
                pop,
                longest as f32 / 60.0,
                distance,
                takeoff_speed * 3.6
            );
        }
    }
}

/// A bots-only race down the run in some conditions: prints every rider
/// (with `print`), and returns the median finish time (s).
fn race(event: Event, seed: u32, print: bool) -> f32 {
    if print {
        println!("\n== bots race the run (seed {seed})");
    }
    let mut w = World::for_event(event, SurfaceKind::Flat, seed);
    assert!(matches!(w.course().line, Line::Run(_)));
    for slot in 0..MAX_RIDERS {
        w.spawn(slot);
    }
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut falls = [0u32; MAX_RIDERS];
    let mut fell_at: Vec<String> = Vec::new();
    let mut missed = std::collections::BTreeMap::new();
    let mut max_speed = [0.0f32; MAX_RIDERS];
    let mut air = [0u32; MAX_RIDERS];
    let mut longest = [0u32; MAX_RIDERS];
    let mut ticks = 0u32;
    let start = Instant::now();
    loop {
        for (slot, i) in inputs.iter_mut().enumerate() {
            *i = Some(bot_input(&w, slot));
        }
        for e in w.step(&inputs) {
            if let EventKind::Buoy {
                buoy, ok: false, ..
            } = e.kind
                && w.race.phase == Phase::Racing
            {
                *missed.entry(buoy).or_insert(0u32) += 1;
                if std::env::var_os("MISSES").is_some()
                    && let (Some(r), Some(run)) = (w.riders[e.slot as usize], w.course().run())
                {
                    let (s, off) = run.project(r.pos.x, r.pos.z);
                    let g = run.gates[usize::from(buoy)];
                    println!(
                        "   bot {} missed gate {} (s={:.0} {:+.1}±{:.1}) at s={s:.0} off={off:+.1} {:.0} km/h{}",
                        e.slot + 1,
                        buoy + 1,
                        g.s,
                        g.offset,
                        g.span * 0.5,
                        r.speed() * 3.6,
                        if r.grounded { "" } else { " in the air" }
                    );
                }
            }
            if e.kind == EventKind::Bail && w.race.phase == Phase::Racing {
                falls[e.slot as usize] += 1;
                if let (Some(r), Some(run)) = (w.riders[e.slot as usize], w.course().run()) {
                    let (s, off) = run.project(r.pos.x, r.pos.z);
                    fell_at.push(format!("bot {} s={s:.0} off={off:.1}", e.slot + 1));
                }
            }
        }
        ticks += 1;
        // `TRACE=slot,from,to` prints that bot every tenth of a second between those arc lengths.
        if let Some((slot, from, to)) = std::env::var("TRACE").ok().and_then(|t| {
            let v: Vec<f32> = t.split(',').filter_map(|x| x.parse().ok()).collect();
            (v.len() == 3).then(|| (v[0] as usize, v[1], v[2]))
        }) && print
            && ticks.is_multiple_of(6)
            && let (Some(r), Some(run)) = (w.riders[slot], w.course().run())
        {
            let (s, off) = run.project(r.pos.x, r.pos.z);
            if (from..to).contains(&s) {
                println!(
                    "   s {s:6.1} off {off:+5.1} line {:+5.1} {:3.0} km/h {} steer {:+.2} lean {:+.2}",
                    sim::bot::snow_line(run, w.cover_rocks(), slot, s),
                    r.speed() * 3.6,
                    if r.grounded { "snow" } else { "air " },
                    r.last_input.steer_f(),
                    r.last_input.lean_f()
                );
            }
        }
        for (slot, r) in w.riders.iter().enumerate() {
            let Some(r) = r else { continue };
            if w.race.phase == Phase::Racing && !r.race.finished() {
                max_speed[slot] = max_speed[slot].max(r.speed());
                air[slot] = if r.grounded { 0 } else { air[slot] + 1 };
                longest[slot] = longest[slot].max(air[slot]);
            }
        }
        if w.race.phase == Phase::Results || ticks > 60 * 60 * 8 {
            break;
        }
    }
    let per_tick = start.elapsed().as_secs_f64() * 1e6 / f64::from(ticks);
    let mut times: Vec<f32> = w
        .standings()
        .iter()
        .filter(|st| st.progress.finished())
        .map(|st| st.progress.finish_ticks as f32 / 60.0)
        .collect();
    times.sort_by(f32::total_cmp);
    let median = times.get(times.len() / 2).copied().unwrap_or(f32::NAN);
    let gates_missed: Vec<String> = missed
        .iter()
        .map(|(g, n)| {
            let gate = w.course().run().map_or(0.0, |r| r.gates[usize::from(*g)].s);
            format!("gate {} (s={gate:.0}) x{n}", g + 1)
        })
        .collect();
    if !print {
        let falls: u32 = falls.iter().sum();
        if !gates_missed.is_empty() {
            println!("   missed: {}", gates_missed.join(", "));
        }
        println!(
            "   bots: winner {:6.2} s, median {median:6.2} s, {} DNF, {falls} falls",
            times.first().copied().unwrap_or(f32::NAN),
            MAX_RIDERS - times.len()
        );
        if !fell_at.is_empty() {
            println!("   falls at: {}", fell_at.join(", "));
        }
        return median;
    }
    for st in w.standings() {
        let p = st.progress;
        let slot = st.slot as usize;
        println!(
            "{}. bot {}: {}  falls {}  missed gates {}  tricks {} ({} pts)  top {:.0} km/h  longest air {:.2} s",
            st.place,
            slot + 1,
            if p.finished() {
                format!("{:6.2} s", p.finish_ticks as f32 / 60.0)
            } else {
                "   DNF  ".into()
            },
            falls[slot],
            p.misses,
            p.tricks,
            p.points,
            max_speed[slot] * 3.6,
            longest[slot] as f32 / 60.0
        );
    }
    if !fell_at.is_empty() {
        println!("falls at: {}", fell_at.join(", "));
    }
    if !gates_missed.is_empty() {
        println!("missed: {}", gates_missed.join(", "));
    }
    println!("whole sim: {per_tick:.1} µs/tick with 8 riders");
    median
}

/// The snow in every season the run is ridden, in a spread of weathers:
/// what lies at the top, the middle and the bottom (depth in m, and the
/// share of powder, slush and hard snow), a tuck's speed after 10 s from
/// the top, and the bots against the home conditions' median time.
fn conditions(lab: &Lab, seed: u32, home: f32) {
    let course = lab.course;
    println!("\n== the snow by conditions (bots' median vs home {home:.2} s)");
    let cover = |c: Conditions, p: f32| {
        let s = c.snow(p, sim::conditions::turn_blend(p, false, 1));
        let g = s.grip();
        format!(
            "{:.2}m p{:.1} s{:.1} h{:.1} f{:.2} e{:.2}",
            s.depth, s.powder, s.slush, s.hard, g.friction, g.edge
        )
    };
    for &season in Sport::Snowboard.seasons() {
        for (weather, turns, time) in [
            (Weather::Clear, Weather::Clear, TimeOfDay::Morning),
            (Weather::Clear, Weather::Clear, TimeOfDay::Afternoon),
            (Weather::Snow, Weather::Snow, TimeOfDay::Noon),
            (Weather::Windy, Weather::Clear, TimeOfDay::Noon),
            (Weather::Storm, Weather::Cloudy, TimeOfDay::Noon),
            (Weather::Rain, Weather::Rain, TimeOfDay::Noon),
        ] {
            if !season.has(weather) || !season.has(turns) {
                continue;
            }
            let c = Conditions {
                season,
                weather,
                turns,
                time: season.time_of(time),
            };
            let event = Event {
                course,
                conditions: c,
            };
            let (v, _) = ride(event, lab.open_s, 1.0, 10);
            println!(
                "{season:?} {weather:?}>{turns:?} {time:?}: top {}  mid {}  bottom {}  tuck {:.0} km/h",
                cover(c, 0.0),
                cover(c, 0.5),
                cover(c, 1.0),
                v.last().copied().unwrap_or(0.0) * 3.6
            );
            let median = race(event, seed, false);
            println!("   {:+.1}% vs home", (median / home - 1.0) * 100.0);
        }
    }
    let world = World::for_event(
        Event {
            course,
            conditions: Conditions::clear(Season::Fall),
        },
        SurfaceKind::Flat,
        seed,
    );
    let rocks: Vec<String> = world
        .cover_rocks()
        .iter()
        .map(|k| format!("{:.0}/{:+.1}", k.s, k.offset))
        .collect();
    println!(
        "fall rocks ({}), s/offset: {}",
        rocks.len(),
        rocks.join(" ")
    );
}

/// A seat's bot's tier: 0 fast, 1 middling, 2 slow.
fn kind(slot: usize) -> usize {
    match SNOW_SEATS[slot].0 {
        Tier::Fast => 0,
        Tier::Middling => 1,
        Tier::Slow => 2,
    }
}

/// A seat with a fast bot in it.
fn fast_seat() -> usize {
    (0..SNOW_SEATS.len()).find(|&s| kind(s) == 0).unwrap_or(0)
}

/// A spread of conditions for every season a run is ridden in.
fn spread(course: CourseId) -> Vec<Event> {
    let mut out = Vec::new();
    for &season in Sport::Snowboard.seasons() {
        for (weather, turns, time) in [
            (Weather::Clear, Weather::Clear, TimeOfDay::Morning),
            (Weather::Clear, Weather::Clear, TimeOfDay::Dusk),
            (Weather::Cloudy, Weather::Cloudy, TimeOfDay::Noon),
            (Weather::Snow, Weather::Snow, TimeOfDay::Noon),
            (Weather::Windy, Weather::Clear, TimeOfDay::Noon),
            (Weather::Storm, Weather::Cloudy, TimeOfDay::Noon),
            (Weather::Rain, Weather::Rain, TimeOfDay::Afternoon),
            (Weather::Cloudy, Weather::Storm, TimeOfDay::Dawn),
        ] {
            if !season.has(weather) || !season.has(turns) {
                continue;
            }
            out.push(Event {
                course,
                conditions: Conditions {
                    season,
                    weather,
                    turns,
                    time: season.time_of(time),
                },
            });
        }
    }
    out
}

/// One bot alone down the run riding as `bot`: its time (s) and falls.
fn solo(event: Event, bot: SnowBot) -> (f32, u32) {
    let (t, falls, _) = solo_landings(event, bot);
    (t, falls)
}

/// [`solo`], and how many of its landings were sketchy.
fn solo_landings(event: Event, bot: SnowBot) -> (f32, u32, u32) {
    let mut w = World::for_event(event, SurfaceKind::Flat, 1);
    let run = w.course().run().expect("a run");
    w.spawn(0);
    w.start_intro();
    let mut inputs: Inputs = [None; MAX_RIDERS];
    let mut falls = 0;
    let mut sketchy = 0;
    for _ in 0..60 * 60 * 6 {
        inputs[0] = Some(snowboard_input(&w, run, 0, bot));
        // `SOLO_TRACE=1` prints the lone bot every second.
        if std::env::var_os("SOLO_TRACE").is_some() && w.tick.is_multiple_of(60) {
            let r = w.riders[0].unwrap();
            let (s, off) = run.project(r.pos.x, r.pos.z);
            println!(
                "   solo s {s:6.1} off {off:+5.1} {:3.0} km/h bail {} yaw {:+.2} input {:?}",
                r.speed() * 3.6,
                r.bail_ticks,
                r.yaw,
                r.last_input
            );
        }
        for e in w.step(&inputs) {
            if e.kind == EventKind::Bail && w.race.phase == Phase::Racing {
                falls += 1;
            }
            if matches!(
                e.kind,
                EventKind::Sketchy | EventKind::Trick { sketchy: true, .. }
            ) {
                sketchy += 1;
            }
            if let EventKind::Buoy {
                buoy, ok: false, ..
            } = e.kind
                && std::env::var_os("MISSES").is_some()
            {
                let r = w.riders[0].unwrap();
                let (s, off) = run.project(r.pos.x, r.pos.z);
                let g = run.gates[usize::from(buoy)];
                println!(
                    "   alone ({:.2}) missed gate {} (s={:.0} {:+.1}±{:.1}) at off={off:+.1} s={s:.0} {:.0} km/h{}",
                    bot.pace,
                    buoy + 1,
                    g.s,
                    g.offset,
                    g.span * 0.5,
                    r.speed() * 3.6,
                    if r.grounded { "" } else { " in the air" }
                );
            }
        }
        if w.riders[0].unwrap().race.finished() {
            break;
        }
    }
    let p = w.riders[0].unwrap().race;
    let t = if p.finished() {
        p.finish_ticks as f32 / 60.0
    } else {
        f32::NAN
    };
    (t, falls, sketchy)
}

/// What tricks cost a bot alone at the fastest bots' pace, in every
/// condition of the spread.
fn tricks(only: Option<CourseId>) {
    // `SEAT=n` rides as that seat's bot's pace.
    let seat = std::env::var("SEAT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(fast_seat);
    let fast = SnowBot::of(seat).pace;
    let mut cost = Vec::new();
    for lab in LABS.iter().filter(|l| only.is_none_or(|c| c == l.course)) {
        for event in spread(lab.course) {
            let (clean, f0, k0) = solo_landings(
                event,
                SnowBot {
                    pace: fast,
                    trickster: false,
                },
            );
            let (tricking, f1, k1) = solo_landings(
                event,
                SnowBot {
                    pace: fast,
                    trickster: true,
                },
            );
            let c = event.conditions;
            println!(
                "{:?} {:?} {:?}>{:?}: clean {clean:.2} s ({f0} falls, {k0} sketchy), tricking {tricking:.2} s ({f1} falls, {k1} sketchy): {:+.2} s",
                lab.course,
                c.season,
                c.weather,
                c.turns,
                tricking - clean
            );
            cost.push(tricking - clean);
        }
    }
    cost.sort_by(f32::total_cmp);
    println!("median {:+.2} s", cost[cost.len() / 2]);
}

/// A lone bot at the fast bots' pace down each run, from every seat's line
/// and tricking or not, in a spread of conditions: the gates it misses.
fn lone_gates(only: Option<CourseId>) {
    let pace = SnowBot::of(fast_seat()).pace;
    for lab in LABS.iter().filter(|l| only.is_none_or(|c| c == l.course)) {
        let mut runs = 0;
        let mut missed = std::collections::BTreeMap::<usize, u32>::new();
        for event in spread(lab.course) {
            for slot in 0..4 {
                for trickster in [false, true] {
                    let mut w = World::for_event(event, SurfaceKind::Flat, 1);
                    let run = w.course().run().expect("a run");
                    w.spawn(slot);
                    w.start_intro();
                    let mut inputs: Inputs = [None; MAX_RIDERS];
                    for _ in 0..60 * 60 * 6 {
                        inputs[slot] =
                            Some(snowboard_input(&w, run, slot, SnowBot { pace, trickster }));
                        // `GATES_TRACE=<seat>` prints that seat's clean run twice a second.
                        if std::env::var("GATES_TRACE").is_ok_and(|v| v == (slot + 1).to_string())
                            && !trickster
                            && w.tick.is_multiple_of(30)
                        {
                            let r = w.riders[slot].unwrap();
                            let (s, off) = run.project(r.pos.x, r.pos.z);
                            let c = event.conditions;
                            println!(
                                "   trace {:?}/{:?} s {s:6.1} off {off:+5.1} line {:+5.1} {:3.0} km/h air {} input {:?}",
                                c.season,
                                c.weather,
                                sim::bot::snow_line(run, &[], slot, s),
                                r.speed() * 3.6,
                                !r.grounded,
                                r.last_input
                            );
                        }
                        for e in w.step(&inputs) {
                            if let EventKind::Buoy {
                                buoy, ok: false, ..
                            } = e.kind
                            {
                                *missed.entry(usize::from(buoy)).or_insert(0) += 1;
                                let r = w.riders[slot].unwrap();
                                let (s, off) = run.project(r.pos.x, r.pos.z);
                                let g = run.gates[usize::from(buoy)];
                                let c = event.conditions;
                                println!(
                                    "   {:?} {:?}/{:?} seat {} {}: missed gate {} (s={:.0} {:+.1}±{:.1}) at off={off:+.1} s={s:.0} {:.0} km/h",
                                    lab.course,
                                    c.season,
                                    c.weather,
                                    slot + 1,
                                    if trickster { "tricks" } else { "clean" },
                                    buoy + 1,
                                    g.s,
                                    g.offset,
                                    g.span * 0.5,
                                    r.speed() * 3.6,
                                );
                            }
                        }
                        if w.riders[slot].unwrap().race.finished() {
                            break;
                        }
                    }
                    runs += 1;
                }
            }
        }
        let total: u32 = missed.values().sum();
        println!(
            "== {:?}: {runs} lone runs at pace {pace}, {total} gates missed",
            lab.course
        );
    }
}

/// Who wins, by kind of bot, across a spread of conditions on each run.
fn kinds(only: Option<CourseId>) {
    const KINDS: [&str; 3] = ["fast", "middling", "slow"];
    let mut wins = [0u32; 3];
    let mut trick_wins = [0u32; 2];
    let mut races = 0u32;
    let mut gap = [Vec::<f32>::new(), Vec::new(), Vec::new()];
    let mut best_gap = Vec::<f32>::new();
    let mut falls = [0u32; 3];
    let mut misses = [0u32; 3];
    let mut most_misses = 0u8;
    let mut points = [0u32; 3];
    let mut by_gate = std::collections::BTreeMap::new();
    let mut fell = std::collections::BTreeMap::new();
    let mut trick_cost = Vec::<f32>::new();
    // `SEATS_FROM=n` leaves the first n seats empty, as players' seats are in a race.
    let first: usize = std::env::var("SEATS_FROM")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut seat_wins = [0u32; MAX_RIDERS];
    let mut seat_falls = [0u32; MAX_RIDERS];
    for lab in LABS.iter().filter(|l| only.is_none_or(|c| c == l.course)) {
        println!("== {:?}", lab.course);
        for event in spread(lab.course) {
            // The best a bot does alone, flat out and clean.
            let mut best = f32::MAX;
            let mut best_falls = 0;
            for pace in [0.95, 1.0, 1.05, 1.1, 1.15, 1.2] {
                let (t, f) = solo(
                    event,
                    SnowBot {
                        pace,
                        trickster: false,
                    },
                );
                if std::env::var_os("SOLO").is_some() {
                    println!("   alone at pace {pace}: {t:.2} s, {f} falls");
                }
                if t < best {
                    best = t;
                    best_falls = f;
                }
            }
            // What tricks cost a bot riding at the fastest bots' pace.
            let fast = SnowBot::of(fast_seat()).pace;
            let (clean, _) = solo(
                event,
                SnowBot {
                    pace: fast,
                    trickster: false,
                },
            );
            let (tricking, _) = solo(
                event,
                SnowBot {
                    pace: fast,
                    trickster: true,
                },
            );
            trick_cost.push(tricking - clean);
            let mut w = World::for_event(event, SurfaceKind::Flat, 1);
            for slot in first..MAX_RIDERS {
                w.spawn(slot);
            }
            w.start_intro();
            let mut inputs: Inputs = [None; MAX_RIDERS];
            for _ in 0..60 * 60 * 8 {
                for (slot, i) in inputs.iter_mut().enumerate().skip(first) {
                    *i = Some(bot_input(&w, slot));
                }
                let before = w.riders;
                // `KINDS_TRACE=<seat>,<from s>,<to s>` follows one bot down part of the run.
                if let Some((seat, from, to)) = std::env::var("KINDS_TRACE").ok().and_then(|v| {
                    let p: Vec<f32> = v.split(',').filter_map(|x| x.parse().ok()).collect();
                    (p.len() == 3).then(|| (p[0] as usize - 1, p[1], p[2]))
                }) && let (Some(r), Some(run)) = (w.riders[seat], w.course().run())
                {
                    let (s, off) = run.project(r.pos.x, r.pos.z);
                    if (from..to).contains(&s) && w.tick.is_multiple_of(10) {
                        let c = event.conditions;
                        println!(
                            "   trace {:?} {:?}/{:?} s {s:6.1} off {off:+5.1} line {:+5.1} {:3.0} km/h air {} steer {} lean {}",
                            lab.course,
                            c.season,
                            c.weather,
                            sim::bot::snow_line(run, w.cover_rocks(), seat, s),
                            r.speed() * 3.6,
                            !r.grounded,
                            inputs[seat].unwrap().steer,
                            inputs[seat].unwrap().lean,
                        );
                    }
                }
                for e in w.step(&inputs) {
                    if e.kind == EventKind::Bail && w.race.phase == Phase::Racing {
                        falls[kind(usize::from(e.slot))] += 1;
                        seat_falls[usize::from(e.slot)] += 1;
                        // `FALLS=1` prints each fall: where, how fast, from the air or not.
                        if let (Some(r), Some(run), true) = (
                            before[usize::from(e.slot)],
                            w.course().run(),
                            std::env::var_os("FALLS").is_some(),
                        ) {
                            let (s, off) = run.project(r.pos.x, r.pos.z);
                            let c = event.conditions;
                            println!(
                                "   fall {:?} {:?}/{:?} seat {} s {s:.0} off {off:+.1} {:.0} km/h {} spin {:+.2} pitch {:+.2} roll {:+.2} grab {}",
                                lab.course,
                                c.season,
                                c.weather,
                                e.slot + 1,
                                r.speed() * 3.6,
                                if r.grounded { "on the snow" } else { "landing" },
                                r.air_spin,
                                r.pitch,
                                r.roll,
                                r.grab
                            );
                        }
                        if let (Some(r), Some(run)) =
                            (w.riders[usize::from(e.slot)], w.course().run())
                        {
                            let (s, off) = run.project(r.pos.x, r.pos.z);
                            let at = format!(
                                "{:?} s~{:.0} {}",
                                lab.course,
                                (s / 10.0).round() * 10.0,
                                if off < 0.0 { "left" } else { "right" }
                            );
                            *fell.entry(at).or_insert(0u32) += 1;
                        }
                    }
                    if let EventKind::Buoy {
                        buoy, ok: false, ..
                    } = e.kind
                        && w.race.phase == Phase::Racing
                    {
                        let c = event.conditions;
                        let at = format!("{:?} gate {}", lab.course, buoy + 1);
                        let n = by_gate
                            .entry(at)
                            .or_insert((0u32, std::collections::BTreeSet::new()));
                        n.0 += 1;
                        n.1.insert(format!("{:?}/{:?}", c.season, c.weather));
                    }
                }
                if w.race.phase == Phase::Results {
                    break;
                }
            }
            races += 1;
            let standings = w.standings();
            let winner = usize::from(standings[0].slot);
            wins[kind(winner)] += 1;
            seat_wins[winner] += 1;
            trick_wins[usize::from(SNOW_SEATS[winner].1)] += 1;
            let mut line = Vec::new();
            for st in &standings {
                let k = kind(usize::from(st.slot));
                let p = st.progress;
                misses[k] += u32::from(p.misses);
                most_misses = most_misses.max(p.misses);
                points[k] += u32::from(p.points);
                if p.finished() {
                    let t = p.finish_ticks as f32 / 60.0;
                    gap[k].push(t / best - 1.0);
                    line.push(format!("{}:{t:.1}", st.slot + 1));
                } else {
                    line.push(format!("{}:DNF", st.slot + 1));
                }
            }
            let first = standings[0].progress.finish_ticks as f32 / 60.0;
            best_gap.push(first / best - 1.0);
            let c = event.conditions;
            println!(
                "{:?} {:?}>{:?} {:5.1}: alone flat out {best:.2} s ({best_falls} falls) | {}",
                c.season,
                c.weather,
                c.turns,
                f32::from(c.time) / 6.0,
                line.join(" ")
            );
        }
    }
    let median = |v: &mut Vec<f32>| {
        v.sort_by(f32::total_cmp);
        v.get(v.len() / 2).copied().unwrap_or(f32::NAN) * 100.0
    };
    println!("\n== {races} races");
    for k in 0..3 {
        println!(
            "{:28} wins {:3}  median {:+5.1}% vs alone flat out  falls {:3}  missed gates {:3}  points {}",
            KINDS[k],
            wins[k],
            median(&mut gap[k]),
            falls[k],
            misses[k],
            points[k]
        );
    }
    println!(
        "wins: tricksters {}, bots that never trick {}",
        trick_wins[1], trick_wins[0]
    );
    for (seat, (tier, trickster)) in SNOW_SEATS.iter().enumerate().skip(first) {
        println!(
            "   seat {}: {tier:?}{} wins {:2} falls {:2}",
            seat + 1,
            if *trickster { ", tricks" } else { "" },
            seat_wins[seat],
            seat_falls[seat]
        );
    }
    println!(
        "winner median {:+.1}% vs alone flat out; most gates one bot missed in a race: {most_misses}",
        median(&mut best_gap)
    );
    trick_cost.sort_by(f32::total_cmp);
    println!(
        "tricks cost a fast bot alone: median {:+.2} s (from {:+.2} to {:+.2} s)",
        trick_cost[trick_cost.len() / 2],
        trick_cost[0],
        trick_cost[trick_cost.len() - 1]
    );
    let mut fell: Vec<(String, u32)> = fell.into_iter().collect();
    fell.sort_by_key(|f| std::cmp::Reverse(f.1));
    let fell: Vec<String> = fell
        .iter()
        .take(12)
        .map(|(at, n)| format!("{at} x{n}"))
        .collect();
    println!("falls most at: {}", fell.join(", "));
    for (gate, (n, when)) in by_gate {
        let when: Vec<String> = when.into_iter().collect();
        println!("   {gate}: missed {n} times ({})", when.join(" "));
    }
}
