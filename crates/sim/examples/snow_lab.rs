//! Prints how the snowboard and the mountain run behave: the run's profile
//! (pitch, banks, widths), how fast a rider goes standing tall and tucked,
//! how much air the tables and the drop give with and without a pop, and a
//! bots-only race down the whole run (times, falls, tricks, cost per tick),
//! and the snow in every season and a spread of weathers: what lies at the
//! top, the middle and the bottom, how fast a tuck goes on it, and the
//! bots' times against the home conditions'. For tuning.
//!
//! `cargo run -p sim --example snow_lab --release [seed] [course]`
//! (`course`: a run's id or name, `mountain` by default)

use std::time::Instant;

use sim::bot::bot_input;
use sim::conditions::{Conditions, Event, Season, TimeOfDay, Weather};
use sim::course::Line;
use sim::input::buttons;
use sim::math::{angle_diff, atan2, clamp};
use sim::mountain::{Feature, Run};
use sim::race::{EventKind, Phase};
use sim::{CourseId, Input, Inputs, MAX_RIDERS, Sport, SurfaceKind, World};

fn main() {
    let seed: u32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1);
    let course = std::env::args()
        .nth(2)
        .and_then(|a| {
            CourseId::ALL
                .iter()
                .copied()
                .find(|c| a == (*c as u8).to_string() || a.eq_ignore_ascii_case(&format!("{c:?}")))
        })
        .filter(|c| c.sport() == Sport::Snowboard)
        .or_else(|| {
            CourseId::ALL
                .iter()
                .copied()
                .find(|c| c.sport() == Sport::Snowboard)
        })
        .expect("a run to ride");
    let run = course.course().run().expect("a run");
    println!("== {course:?}");
    profile(run);
    speeds(course);
    jumps(course);
    let home = race(Event::home(course), seed, true);
    conditions(course, seed, home);
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

fn speeds(course: CourseId) {
    println!("\n== speed down the open slope (s = 100), km/h each second");
    for (name, lean) in [("tall ", 0.0), ("tuck ", 1.0), ("brake", -0.5)] {
        let (v, falls) = ride(Event::home(course), 100.0, lean, 12);
        let line: Vec<String> = v.iter().map(|s| format!("{:3.0}", s * 3.6)).collect();
        println!("{name} {}  falls {falls}", line.join(" "));
    }
}

/// Approaches a table (or the drop) along the centre line at the speed the
/// slope gives, popping at the lip or not. Prints airtime, distance, and how
/// it landed.
fn jumps(course: CourseId) {
    println!("\n== air: tables and the drop (approach from 120 m up, tucked)");
    let run = course.course().run().expect("a run");
    let mut spots: Vec<(String, f32, f32)> = Vec::new();
    for f in run.features {
        if let Feature::Table {
            s, ramp, offset, ..
        } = *f
        {
            spots.push((format!("table s={s:.0}"), s + ramp, offset));
        }
    }
    spots.push(("drop".into(), 1061.0, 0.0));
    spots.push(("rollers".into(), 1440.0, 0.0));
    for (name, lip, offset) in spots {
        for pop in [false, true] {
            let mut w = World::on_course(course, SurfaceKind::Flat, 0);
            w.spawn(0);
            w.ride_free();
            let mut r = w.riders[0].unwrap();
            let f = run.centerline(lip - 120.0);
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
            println!(
                "{name:14} pop {:5}: {:4.2} s in the air, {:4.0} m, off at {:3.0} km/h ({outcome})",
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
            if e.kind == EventKind::Bail && w.race.phase == Phase::Racing {
                falls[e.slot as usize] += 1;
            }
        }
        ticks += 1;
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
    if !print {
        let falls: u32 = falls.iter().sum();
        println!(
            "   bots: winner {:6.2} s, median {median:6.2} s, {} DNF, {falls} falls",
            times.first().copied().unwrap_or(f32::NAN),
            MAX_RIDERS - times.len()
        );
        return median;
    }
    for st in w.standings() {
        let p = st.progress;
        let slot = st.slot as usize;
        println!(
            "{}. bot {}: {}  falls {}  tricks {} ({} pts)  top {:.0} km/h  longest air {:.2} s",
            st.place,
            slot + 1,
            if p.finished() {
                format!("{:6.2} s", p.finish_ticks as f32 / 60.0)
            } else {
                "   DNF  ".into()
            },
            falls[slot],
            p.tricks,
            p.points,
            max_speed[slot] * 3.6,
            longest[slot] as f32 / 60.0
        );
    }
    println!("whole sim: {per_tick:.1} µs/tick with 8 riders");
    median
}

/// The snow in every season the run is ridden, in a spread of weathers:
/// what lies at the top, the middle and the bottom (depth in m, and the
/// share of powder, slush and hard snow), a tuck's speed after 10 s from
/// the top, and the bots against the home conditions' median time.
fn conditions(course: CourseId, seed: u32, home: f32) {
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
            let (v, _) = ride(event, 100.0, 1.0, 10);
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
