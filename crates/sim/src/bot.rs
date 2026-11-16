//! Server-side bots. A bot is just a rider whose inputs come from this code
//! instead of the network; its inputs go through the same sim path as a
//! human's. The function is deterministic, so clients can predict bots
//! exactly by running it too.

use crate::DT;
use crate::conditions::Rock;
use crate::course::{Course, Keep, Line};
use crate::input::{Input, buttons};
use crate::jetski as jet;
use crate::math::{TAU, angle_diff, atan2, clamp, smoothstep, sqrt};
use crate::mountain::{Feature, Run};
use crate::snowboard::tuning as snow;
use crate::world::{Rider, World};

/// What a bot does this tick, for whatever sport the course is.
pub fn bot_input(world: &World, slot: usize) -> Input {
    match world.course().line {
        Line::Stadium(_) | Line::Loop(_) => jetski_input(world, slot),
        Line::Run(run) => snowboard_input(world, run, slot, SnowBot::of(slot)),
    }
}

/// How a jetski bot rides.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JetskiBot {
    /// Throttle (1 = flat out).
    pub pace: f32,
    /// Its lane on the first leg (0-3, left to right): away from the buoys
    /// it rides that far to the side of the line through them, and it
    /// moves a lane over at every buoy.
    pub lane: u8,
    /// How wide of a buoy's middle it passes (m).
    pub margin: f32,
    /// Whether it tricks whenever it flies.
    pub trickster: bool,
    /// The laps on which it takes the ramps on its line: bit `k` for lap
    /// `k + 1`.
    pub ramp_laps: u8,
    /// How far off its line (m) a ramp still counts as on it.
    pub ramp_reach: f32,
    /// Whether it pulls back on some crests to pop.
    pub pops: bool,
}

/// How fast a seat's bot rides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Fast,
    Middling,
    Slow,
}

/// Each seat's bot: its tier and whether it tricks. Bots fill the seats
/// from the last one down, so a field of any size has fast, middling and
/// slow bots in it, tricksters and not.
pub const JETSKI_SEATS: [(Tier, bool); crate::MAX_RIDERS] = [
    (Tier::Middling, true),
    (Tier::Slow, false),
    (Tier::Middling, false),
    (Tier::Middling, true),
    (Tier::Slow, false),
    (Tier::Slow, true),
    (Tier::Fast, false),
    (Tier::Fast, true),
];

impl JetskiBot {
    /// The bot in a seat: its tier's pace (a trickster's a little higher:
    /// what its tricks cost it, it makes up between the ramps), its own
    /// lane and room round the buoys, and one lap on which it takes the
    /// ramps on its line.
    pub fn of(slot: usize) -> Self {
        let (tier, trickster) = JETSKI_SEATS[slot % crate::MAX_RIDERS];
        let (pace, margin) = match tier {
            Tier::Fast => (FAST_PACE, 2.5),
            Tier::Middling => (MIDDLING_PACE, 3.0),
            Tier::Slow => (SLOW_PACE, 3.5),
        };
        Self {
            pace: if trickster { pace } else { pace - TRICKS_PACE },
            lane: (slot % 4) as u8,
            margin: margin + (slot % 2) as f32 * 0.5,
            trickster,
            ramp_laps: if trickster { 1 << (slot % 3) } else { 0 },
            ramp_reach: RAMP_REACH,
            pops: false,
        }
    }
}

/// Each tier's throttle, and how much less of it a bot that never tricks
/// gives.
const FAST_PACE: f32 = 1.0;
const MIDDLING_PACE: f32 = 0.92;
const SLOW_PACE: f32 = 0.84;
const TRICKS_PACE: f32 = 0.015;
/// How far off its line (m) a ramp's middle can be for a trickster to
/// take it.
const RAMP_REACH: f32 = 4.5;

/// How far ahead (m, and s per m/s) a jetski bot aims, and how hard it
/// steers per radian off that aim.
const LOOK: f32 = 10.0;
const LOOK_PER_SPEED: f32 = 0.5;
const STEER_GAIN: f32 = 3.0;
/// How wide of a ramp's side (m) a bot not taking it keeps.
const RAMP_CLEAR: f32 = 1.5;
/// A bot this close to a buoy's middle (m) on its wrong side is about to miss it.
const BUOY_CLEAR: f32 = 1.0;
/// Over this far (m) from a buoy a bot moves from its lane onto the line
/// through the buoys; and how far apart lanes are (m).
const LANE_BLEND: f32 = 30.0;
const LANE_WIDTH: f32 = 2.5;

/// A jetski bot's line: straight (along the course) from where it passed
/// the last buoy to where it passes the next one, `lane` to the side
/// away from them.
struct RacingLine {
    /// Arc length and offset where it passes the last buoy and the next.
    prev: (f32, f32),
    next: (f32, f32),
    /// And the one after.
    after: (f32, f32),
    /// Its lane before the next buoy and after it (m to the right).
    lanes: (f32, f32),
    /// The next buoy: its offset and the side it is kept on.
    buoy: f32,
    keep: Keep,
}

impl RacingLine {
    fn of(world: &World, r: &Rider, bot: JetskiBot) -> Self {
        let course = world.course();
        let n = course.buoys.len();
        let gate = usize::from(r.race.next_gate) % course.gate_count();
        let next = gate.saturating_sub(1);
        let passing = |i: usize| {
            let b = &course.buoys[i % n];
            let side = match b.keep {
                Keep::Right => -bot.margin,
                Keep::Left => bot.margin,
            };
            (b.s, b.offset + side)
        };
        let b = &course.buoys[next];
        // A lane over at every buoy, round all four in turn (counting laps
        // from the last buoy, so the lane holds over the start line).
        let lap = usize::from(r.race.lap) + usize::from(gate == 0);
        let leg = usize::from(bot.lane) + next + n * lap;
        let lane = |k: usize| ((k % 4) as f32 - 1.5) * LANE_WIDTH;
        Self {
            prev: passing(next + n - 1),
            next: passing(next),
            after: passing(next + 1),
            lanes: (lane(leg), lane(leg + 1)),
            buoy: b.offset,
            keep: b.keep,
        }
    }

    /// The line's offset at arc length `at`, ahead of the last buoy.
    fn at(&self, course: &Course, at: f32) -> f32 {
        let span = |a: (f32, f32), b: (f32, f32)| course.wrap_s(b.0 - a.0).max(1.0);
        let into = course.wrap_s(at - self.prev.0);
        let first = span(self.prev, self.next);
        let (from, to, k, len, lane) = if into <= first {
            (self.prev, self.next, into / first, first, self.lanes.0)
        } else {
            let second = span(self.next, self.after);
            let k = (into - first) / second;
            (self.next, self.after, k.min(1.0), second, self.lanes.1)
        };
        let base = from.1 + (to.1 - from.1) * k;
        // Away from the buoys, its own lane.
        let near = (k * len).min((1.0 - k) * len);
        base + lane * clamp(near / LANE_BLEND, 0.0, 1.0)
    }
}

/// Jetski bots follow the course, swing out to pass each buoy on its
/// correct side, pull back on some crests to pop, and some take the ramps.
/// In the air tricksters pick a trick for each jump (a rotation, a stunt,
/// or both) and do the parts that fit the air left.
fn jetski_input(world: &World, slot: usize) -> Input {
    jetski_input_as(world, slot, JetskiBot::of(slot))
}

/// What the jetski bot `bot` does this tick, riding seat `slot`.
pub fn jetski_input_as(world: &World, slot: usize, bot: JetskiBot) -> Input {
    let Some(r) = world.riders[slot] else {
        return Input::default();
    };
    let course = world.course();
    let (s, _) = course.project(r.pos.x, r.pos.z);

    let pace = bot.pace;
    let trickster = bot.trickster;
    let speed = r.speed();
    let look = LOOK + speed * LOOK_PER_SPEED;
    let line = RacingLine::of(world, &r, bot);
    let mut target_offset = line.at(course, s + look);
    let to_buoy = course.delta_s(s, line.next.0);

    // The ramps: on its ramp lap a bot takes those on its line (lined up
    // with one and pulling back all the way up it); otherwise it keeps
    // clear of them.
    for rd in course.ramps {
        let ahead = course.delta_s(s, rd.s);
        if !(0.0..45.0).contains(&ahead) {
            continue;
        }
        let mid = line.at(course, rd.s + rd.length * 0.5);
        if r.race.lap >= 1
            && bot.ramp_laps & (1 << (r.race.lap - 1).min(7)) != 0
            && (rd.offset - mid).abs() <= bot.ramp_reach
        {
            target_offset = rd.offset;
            break;
        }
        let clear = rd.width * 0.5 + RAMP_CLEAR;
        if (target_offset - rd.offset).abs() < clear {
            target_offset = if mid >= rd.offset {
                rd.offset + clear
            } else {
                rd.offset - clear
            };
        }
    }
    let on_ramp = course
        .ramp_under(r.pos.x, r.pos.z, &world.surface, world.tick)
        .is_some();
    let (tx, tz) = course.centerline(s + look).at_offset(target_offset);
    let desired = atan2(tx - r.pos.x, tz - r.pos.z);
    // Positive steer turns right, which lowers yaw.
    let steer = clamp(-angle_diff(r.yaw, desired) * STEER_GAIN, -1.0, 1.0);
    // Coming up on the wrong side of the next buoy: ease off to turn tighter.
    let (_, offset) = course.project(r.pos.x, r.pos.z);
    let wrong = match line.keep {
        Keep::Right => offset - (line.buoy - BUOY_CLEAR),
        Keep::Left => (line.buoy + BUOY_CLEAR) - offset,
    };
    let pace = if wrong > 0.0 && to_buoy > 0.0 && to_buoy < speed * 1.2 + 6.0 {
        pace * clamp(1.0 - wrong * 0.25, 0.25, 1.0)
    } else {
        pace
    };

    let pops = bot.pops && world.tick.wrapping_add(slot as u32 * 131) % 400 < 200;
    if r.grounded {
        let lean = if (pops || on_ramp) && r.vel.y > 1.5 {
            -1.0
        } else {
            0.0
        };
        return Input::from_analog(steer, pace, lean, 0);
    }
    if !trickster {
        return Input::from_analog(0.0, pace, 0.0, 0);
    }
    let g = jet::tuning::GRAVITY;
    let above = (r.pos.y - world.surface.height(r.pos.x, r.pos.z, world.tick)).max(0.0);
    let air_left = (r.vel.y + sqrt(r.vel.y * r.vel.y + 2.0 * g * above)) / g;
    // The takeoff tick: the same all through a jump.
    let jump = world.tick.wrapping_sub(u32::from(r.state_ticks));
    let plan = JetskiPlan::pick(slot, jump);
    let rate = world.setups[slot].sanitized().tricks();

    let mut buttons = 0;
    let (mut steer, mut lean) = (0.0, 0.0);
    if let Some(id) = plan.stunt {
        let stunt = jet::Stunt::of(id);
        let ticks = |reach: u8| f32::from(jet::tuning::STUNT_FULL) / f32::from(reach) * DT;
        let back = ticks(stunt.reach_out) + 0.15;
        let whole =
            ticks(stunt.reach_in) + f32::from(jet::tuning::MIN_STUNT_TICKS) * DT + 0.1 + back;
        let started = r.grab != 0;
        if (started && air_left > back && r.last_input.pressed(buttons::GRAB))
            || (!started && air_left > whole)
        {
            buttons |= buttons::GRAB;
            if !started {
                // The stick picks the stunt as the button goes down.
                let (s, l) = stunt_stick(id);
                return Input::from_analog(s, pace, l, buttons);
            }
        }
    }
    if let Some(rot) = plan.rotation {
        let (button, stick_steer, stick_lean, done, max_rate) = match rot {
            Rotation::Spin(dir) => (
                buttons::TRICK,
                dir,
                0.0,
                r.air_spin.abs(),
                jet::tuning::SPIN_RATE,
            ),
            Rotation::Backflip => (
                buttons::TRICK,
                0.0,
                -1.0,
                r.pitch.max(0.0),
                jet::tuning::FLIP_RATE,
            ),
            Rotation::Roll(dir) => (
                buttons::ROLL,
                dir,
                0.0,
                r.roll.abs(),
                jet::tuning::ROLL_RATE,
            ),
        };
        let speed = max_rate * rate;
        let current = match rot {
            Rotation::Spin(_) => r.yaw_rate.abs(),
            Rotation::Backflip => r.pitch_rate.max(0.0),
            Rotation::Roll(_) => r.roll_rate.abs(),
        };
        let to_go = 0.78 * TAU - done;
        let spin_up = (1.0 - current / speed).max(0.0) / jet::tuning::TRICK_RESPONSE;
        let turning = current > 0.4 * speed;
        if to_go > 0.0 && (turning || air_left > to_go / speed + spin_up + 0.3) {
            buttons |= button;
            steer = stick_steer;
            lean = stick_lean;
        }
    }
    Input::from_analog(steer, pace, lean, buttons)
}

#[derive(Clone, Copy, Debug)]
enum Rotation {
    /// Flat spin, to the right (+1) or the left (-1).
    Spin(f32),
    Backflip,
    /// Barrel roll, to the right (+1) or the left (-1).
    Roll(f32),
}

/// What a jetski bot tries on one jump.
#[derive(Clone, Copy, Debug)]
struct JetskiPlan {
    rotation: Option<Rotation>,
    stunt: Option<u8>,
}

impl JetskiPlan {
    /// A trick for this bot's jump that took off at tick `jump`.
    fn pick(slot: usize, jump: u32) -> Self {
        let h = jump
            .wrapping_add(slot as u32 * 0x9E37)
            .wrapping_mul(0x9E37_79B9)
            >> 16;
        let dir = if (h >> 8) & 1 == 0 { 1.0 } else { -1.0 };
        let stunt = 1 + (h >> 4) as u8 % 5;
        let (rotation, stunt) = match h % 8 {
            0 => (Some(Rotation::Spin(dir)), None),
            1 => (Some(Rotation::Backflip), None),
            2 => (Some(Rotation::Roll(dir)), None),
            3 => (Some(Rotation::Spin(dir)), Some(stunt)),
            4 => (Some(Rotation::Backflip), Some(stunt)),
            _ => (None, Some(stunt)),
        };
        Self { rotation, stunt }
    }
}

/// The stick that picks a stunt (steer, lean).
fn stunt_stick(id: u8) -> (f32, f32) {
    match id {
        jet::stunts::HANDSTAND => (0.0, 1.0),
        jet::stunts::SUPERMAN => (0.0, -1.0),
        jet::stunts::NAC_NAC => (-1.0, 0.0),
        jet::stunts::CAN_CAN => (1.0, 0.0),
        _ => (0.0, 0.0),
    }
}

/// How a snowboard bot rides: how hard it pushes (`pace`, 1 = flat out)
/// and whether it goes for tricks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnowBot {
    pub pace: f32,
    pub trickster: bool,
}

/// Each seat's snowboard bot: its tier and whether it tricks. On a narrow
/// run the grid counts: the two fast bots start side by side in the front
/// row, one that tricks and one that doesn't, so either can win. Bots fill
/// the seats from the last one down, so a small field has middling and
/// slow bots, tricksters and not.
pub const SNOW_SEATS: [(Tier, bool); crate::MAX_RIDERS] = [
    (Tier::Middling, true),
    (Tier::Fast, true),
    (Tier::Fast, false),
    (Tier::Middling, false),
    (Tier::Slow, true),
    (Tier::Slow, false),
    (Tier::Slow, true),
    (Tier::Middling, false),
];

impl SnowBot {
    /// The bot in a seat: its tier's pace, and whether it tricks.
    pub fn of(slot: usize) -> Self {
        let (tier, trickster) = SNOW_SEATS[slot % crate::MAX_RIDERS];
        let pace = match tier {
            Tier::Fast => SNOW_FAST,
            Tier::Middling => SNOW_MIDDLING,
            Tier::Slow => SNOW_SLOW,
        };
        Self { pace, trickster }
    }
}

/// Each tier's pace on the snow (how fast it takes the bends, how much it tucks).
const SNOW_FAST: f32 = 0.97;
const SNOW_MIDDLING: f32 = 0.92;
const SNOW_SLOW: f32 = 0.84;

/// Slower than this (m/s) on the snow, a bot skates whatever the bend.
const STUCK_SPEED: f32 = 3.0;

/// Snowboard bots ride their own line down the run, round spines and trees,
/// scrub speed before turns too tight to carve at full speed and tuck where
/// it is open. Tricksters line up with every table and lip they meet, load a
/// pop and let go at the lip; in the air they spin a 360 when there is time
/// for it, and grab otherwise. Past the finish they pull up in the finish
/// area (see `finish_area_input`).
pub fn snowboard_input(world: &World, run: &Run, slot: usize, bot: SnowBot) -> Input {
    let Some(r) = world.riders[slot] else {
        return Input::default();
    };
    let (s, off) = run.project(r.pos.x, r.pos.z);
    if s > run.finish_s {
        return finish_area_input(world, run, slot, &r, s);
    }
    let speed = r.speed();
    let half = run.width_at(s).half;
    let SnowBot { pace, trickster } = bot;
    // Nearly stopped, aim close by: a short way round whatever is in front.
    let look = if speed < STUCK_SPEED {
        3.0
    } else {
        6.0 + speed * 0.4
    };
    let rocks = world.cover_rocks();
    let mut lane = snow_line(run, rocks, slot, s + look);

    // The next table or lip on its line: a trickster loads a pop and lets
    // go at the lip.
    let mut jump = false;
    for f in run.features {
        // Only where the landing is long enough for a popped jump.
        let (s0, offset, half_width, ramp) = match *f {
            Feature::Table {
                s,
                offset,
                half_width,
                ramp,
                landing,
                ..
            } if landing >= POP_LANDING => (s, offset, half_width, ramp),
            Feature::Lip {
                s,
                offset,
                half_width,
                ramp,
                ..
            } => (s, offset, half_width, ramp),
            _ => continue,
        };
        let to_lip = s0 + ramp - s;
        if !trickster || !(0.0..60.0).contains(&to_lip) {
            continue;
        }
        let on_line = (snow_line(run, rocks, slot, s0 + ramp) - offset).abs() < half_width - 1.0;
        // Not with a rock poking through where it would come down.
        let lip = s0 + ramp;
        let rock_below = rocks.iter().any(|k| {
            (lip..lip + POP_ROCK_CLEAR).contains(&k.s)
                && (k.offset - snow_line(run, rocks, slot, k.s)).abs()
                    < k.obstacle.radius + DODGE_CLEAR + 2.0
        });
        if on_line && !rock_below {
            jump = to_lip > speed * DT * 1.5 && to_lip < speed * POP_LOAD;
            break;
        }
    }

    // Round a spine, on the side the lane is on.
    for f in run.features {
        if let Feature::Spine {
            s: s0,
            length,
            ease,
            offset,
            half_width,
            ..
        } = *f
        {
            let clear = half_width + 1.5;
            if s > s0 - 40.0 && s < s0 + length + 2.0 * ease && (lane - offset).abs() < clear {
                lane = if lane >= offset {
                    offset + clear
                } else {
                    offset - clear
                };
            }
        }
    }

    let near = look + DODGE_AHEAD;
    // Among trees, dodging one can lead into the next: then the nearest
    // lane clear of every trunk (and rock) close ahead.
    let blocked = |l: f32| {
        let near = |os: f32, offset: f32, radius: f32| {
            (0.0..near.min(TREE_LOOK)).contains(&(os - s))
                && (offset - l).abs() < radius + TREE_CLEAR
        };
        run.obstacles.iter().any(|o| near(o.s, o.offset, o.radius))
            || world
                .cover_rocks()
                .iter()
                .any(|k| near(k.s, k.offset, k.obstacle.radius))
    };
    if blocked(lane) {
        let room = half - 1.5;
        let mut k = 1.0;
        while k * LANE_STEP <= 2.0 * room {
            let found = [lane + k * LANE_STEP, lane - k * LANE_STEP]
                .into_iter()
                .find(|&l| l.abs() <= room && !blocked(l));
            if let Some(l) = found {
                lane = l;
                break;
            }
            k += 1.0;
        }
    }

    // Aim past the line by some of how far off it the bot is, to catch up.
    let behind = snow_line(run, rocks, slot, s) - off;
    let room = half - 1.0;
    let mut aim = clamp(lane + CATCH_UP * behind, -room, room);
    let mut look = look;
    // Held up against something: round it, on the side the bot is on.
    if speed < STUCK_SPEED {
        let against = run
            .obstacles
            .iter()
            .map(|o| (o.s, o.offset, o.radius))
            .chain(rocks.iter().map(|k| (k.s, k.offset, k.obstacle.radius)))
            .find(|&(os, offset, radius)| {
                (-1.0..4.0).contains(&(os - s)) && (offset - off).abs() < radius + 1.2
            });
        if let Some((os, offset, radius)) = against {
            let side = if off >= offset { 1.0 } else { -1.0 };
            aim = clamp(offset + side * (radius + 1.8), -room, room);
            look = (os - s).max(0.0) + 3.0;
        }
    }
    let (tx, tz) = run.centerline(s + look).at_offset(aim);
    let desired = atan2(tx - r.pos.x, tz - r.pos.z);
    let heading = if speed > 3.0 {
        atan2(r.vel.x, r.vel.z)
    } else {
        r.yaw
    };
    let steer = clamp(-angle_diff(heading, desired) * 3.0, -1.0, 1.0);

    // Speed: the tightest bend of the line in the next stretch (the run's
    // and its own weave through the gates) sets how fast to go.
    let ahead = 20.0 + speed * 1.5;
    let mut bend: f32 = 0.0;
    let mut d = 10.0;
    while d <= ahead {
        let a = run.centerline(s + d - 10.0).yaw;
        let b = run.centerline(s + d + 10.0).yaw;
        let line = |t: f32| snow_line(run, rocks, slot, t);
        let weave = line(s + d - 10.0) - 2.0 * line(s + d) + line(s + d + 10.0);
        bend = bend.max(angle_diff(a, b).abs() / 20.0 + weave.abs() / 100.0);
        d += 10.0;
    }
    // The fastest a carve makes that bend, standing tall and tucked.
    let carve = |grip: f32| {
        if bend > 1e-3 {
            sqrt(grip * 0.85 / bend) * pace
        } else {
            f32::MAX
        }
    };
    let safe = carve(snow::CARVE_GRIP);
    let tucked = carve(snow::CARVE_GRIP * (1.0 - snow::TUCK_TURN_LOSS));
    let lean = if speed > safe + 1.5 {
        -clamp((speed - safe) / 4.0, 0.3, 1.0)
    } else if speed < STUCK_SPEED {
        // Nearly stopped (back up after a fall, held up by a rock): skate on.
        1.0
    } else if speed < tucked - 2.0 && steer.abs() < TUCK_STEER {
        // Tuck wherever a tucked carve still makes the bends ahead, and
        // stand up to turn hard (a tuck turns less).
        pace.min(1.0)
    } else {
        0.0
    };

    if r.grounded {
        let buttons = if jump { buttons::JUMP } else { 0 };
        return Input::from_analog(steer, 0.0, lean, buttons);
    }
    // In the air: how long until the snow comes back up?
    let g = snow::GRAVITY;
    let above = (r.pos.y - run.height(r.pos.x, r.pos.z)).max(0.0);
    let air_left = (r.vel.y + sqrt(r.vel.y * r.vel.y + 2.0 * g * above)) / g;
    if trickster {
        let to_go = 0.8 * TAU - r.air_spin.abs();
        let spinning = r.yaw_rate.abs() > 0.4 * snow::SPIN_RATE;
        if to_go > 0.0 && (spinning || air_left > to_go / snow::SPIN_RATE + 0.35) {
            let dir = if slot.is_multiple_of(2) { 1.0 } else { -1.0 };
            return Input::from_analog(dir, 0.0, 0.0, buttons::TRICK);
        }
    }
    if r.air_spin.abs() < 0.5 && air_left > 0.35 {
        return Input::from_analog(0.0, 0.0, 0.0, buttons::GRAB);
    }
    Input::from_analog(0.0, 0.0, 0.0, 0)
}

/// The offset a bot rides at arc length `t`: its line through the gates
/// (see [`gate_line`]), swinging round whatever stands on it (on the side
/// the line is on, or toward the middle of the run), easing out after the
/// gate before it if there is one, and kept inside the run.
pub fn snow_line(run: &Run, rocks: &[Rock], slot: usize, t: f32) -> f32 {
    let base = gate_line(run, slot, t);
    let mut swing: f32 = 0.0;
    let obstacles = run
        .obstacles
        .iter()
        .map(|o| (o.s, o.offset, o.radius))
        .chain(rocks.iter().map(|k| (k.s, k.offset, k.obstacle.radius)));
    for (os, offset, radius) in obstacles {
        if !(os - DODGE_BEFORE..os + DODGE_AFTER).contains(&t) {
            continue;
        }
        let there = gate_line(run, slot, os);
        let clear = radius + DODGE_CLEAR;
        if (offset - there).abs() >= clear {
            continue;
        }
        let right = if (there - offset).abs() > 0.3 {
            there > offset
        } else {
            offset < 0.0
        };
        let by = if right {
            offset + clear
        } else {
            offset - clear
        } - there;
        // Not before passing a gate in the way.
        let from = run
            .gates
            .iter()
            .filter(|g| (os - DODGE_BEFORE..os).contains(&g.s))
            .map(|g| g.s + 2.0)
            .fold(os - DODGE_BEFORE, f32::max);
        let k = if t < os {
            smoothstep(from, os - 3.0, t)
        } else {
            smoothstep(os + DODGE_AFTER, os + 2.0, t)
        };
        if (by * k).abs() > swing.abs() {
            swing = by * k;
        }
    }
    let room = run.width_at(t).half - 1.2;
    clamp(base + swing, -room, room)
}

/// A bot swings round an obstacle on its line from this far before it (m),
/// back over `DODGE_AFTER` m past it, this far clear of it (beyond its
/// radius).
const DODGE_BEFORE: f32 = 50.0;
const DODGE_AFTER: f32 = 12.0;
const DODGE_CLEAR: f32 = 2.2;

/// The offset a bot's line through the gates passes at arc length `t`:
/// through each gate on its own way through it (off the gate's centre by
/// its seat, inside the poles), easing from one gate to the next, and on its
/// own lane before the first gate and after the last.
fn gate_line(run: &Run, slot: usize, t: f32) -> f32 {
    let seat = (slot % 4) as f32 - 1.5;
    let half = run.width_at(t).half;
    let own = clamp(seat * 0.3 * half, -half + 2.0, half - 2.0);
    let aim = |g: &crate::mountain::GateDef| {
        let room = (g.span * 0.5 - GATE_MARGIN).max(0.0);
        g.offset + clamp(seat * 0.5, -room, room)
    };
    let i = run.gates.partition_point(|g| g.s <= t);
    let before = i.checked_sub(1).map(|j| &run.gates[j]);
    match (before, run.gates.get(i)) {
        (Some(a), Some(b)) if b.s - a.s <= GATE_LINK => {
            aim(a) + (aim(b) - aim(a)) * smoothstep(a.s, b.s, t)
        }
        (a, b) => {
            let from = a.map_or(own, |a| {
                own + (aim(a) - own) * smoothstep(a.s + GATE_EASE, a.s, t)
            });
            b.map_or(from, |b| {
                from + (aim(b) - from) * smoothstep(b.s - GATE_EASE, b.s, t)
            })
        }
    }
}

/// Bots pass a gate at least this far inside its poles (m); gates closer
/// than `GATE_LINK` m are ridden as one line, and the line eases onto (and
/// off) a gate over `GATE_EASE` m.
const GATE_MARGIN: f32 = 1.6;
const GATE_LINK: f32 = 130.0;
const GATE_EASE: f32 = 60.0;

/// Among trees: how far ahead (m) bots look for trunks in their lane, how
/// far from a trunk (beyond its radius) a lane is clear, and the step
/// between lanes tried.
const TREE_LOOK: f32 = 40.0;
/// Bots steer round an obstacle once it is this far past where they aim (m).
const DODGE_AHEAD: f32 = 12.0;
/// Tricksters load a pop for this long before a lip (s): a short pop, for
/// air enough to trick without flying far past the landing.
const POP_LOAD: f32 = 0.2;
/// Tricksters don't pop with a rock this far past the lip (m) near their line.
const POP_ROCK_CLEAR: f32 = 90.0;
/// Tricksters pop off tables whose landing is at least this long (m).
const POP_LANDING: f32 = 30.0;
/// A bot steering harder than this stands up out of its tuck.
const TUCK_STEER: f32 = 0.5;
/// How much of its distance off its line a bot aims past it.
const CATCH_UP: f32 = 0.3;
const TREE_CLEAR: f32 = 1.6;
const LANE_STEP: f32 = 0.5;

/// Where riders pull up past the finish: each seat its own spot, in two
/// rows of four across the run (metres past the line, and apart).
const STOP_PAST_FINISH: f32 = 28.0;
const STOP_ROW: f32 = 9.0;
const STOP_LANE: f32 = 6.0;
/// Within this of its spot (m) a rider pulls up; twice as far short, it skates on.
const STOP_NEAR: f32 = 4.0;
/// Braking is planned at this deceleration (m/s²); a skid does better.
const STOP_DECEL: f32 = 7.0;
/// Standing still after the finish, a rider hops now and then: the time is
/// cut into spells this long (ticks), and from `HOP_FROM` on it hops in the
/// first spell and in some of the later ones.
const HOP_SPELL: u32 = crate::TICK_HZ * 5 / 2;
const HOP_FROM: u32 = 2;

/// Past the finish: on to this seat's spot in the finish area, a skid to a
/// stop there (the board swung across, sitting back), then standing still.
/// A rider who stopped short skates on. Finishers standing still hop now
/// and then (loading a pop, grabbing in the air) while the race goes on.
fn finish_area_input(world: &World, run: &Run, slot: usize, r: &Rider, s: f32) -> Input {
    let speed = r.speed();
    let spot = run.finish_s + STOP_PAST_FINISH + (slot / 4) as f32 * STOP_ROW;
    let lane = ((slot % 4) as f32 - 1.5) * STOP_LANE;
    let to_go = spot - s;
    if !r.grounded {
        let g = snow::GRAVITY;
        let above = (r.pos.y - run.height(r.pos.x, r.pos.z)).max(0.0);
        let air_left = (r.vel.y + sqrt(r.vel.y * r.vel.y + 2.0 * g * above)) / g;
        let grab = if air_left > 0.25 { buttons::GRAB } else { 0 };
        return Input::from_analog(0.0, 0.0, 0.0, grab);
    }
    let short = to_go > 2.0 * STOP_NEAR;
    if speed > 0.4 && !short && to_go < speed * speed / (2.0 * STOP_DECEL) + STOP_NEAR {
        // A hockey stop, swinging toward this seat's side of the run
        // (gently once nearly still, or it would spin on the spot).
        let away = if lane < 0.0 { -1.0 } else { 1.0 };
        return Input::from_analog(away * (speed / 4.0).min(1.0), 0.0, -1.0, 0);
    }
    if speed <= 0.4 && !short {
        let jump = if hops(world, slot, r) {
            buttons::JUMP
        } else {
            0
        };
        return Input::from_analog(0.0, 0.0, 0.0, jump);
    }
    let look = 6.0 + speed * 0.5;
    let (tx, tz) = run.centerline(s + look).at_offset(lane);
    let desired = atan2(tx - r.pos.x, tz - r.pos.z);
    let heading = if speed > 3.0 {
        atan2(r.vel.x, r.vel.z)
    } else {
        r.yaw
    };
    let steer = clamp(-angle_diff(heading, desired) * 2.0, -1.0, 1.0);
    // Stopped short: skate on.
    let skate = if short && speed < 3.0 { 1.0 } else { 0.0 };
    Input::from_analog(steer, 0.0, skate, 0)
}

/// Whether a finisher standing still loads a hop now: through the start
/// of its first spell from `HOP_FROM` on, and of a third of the later ones.
fn hops(world: &World, slot: usize, r: &Rider) -> bool {
    let race = &world.race;
    if race.phase != crate::race::Phase::Racing || !r.race.finished() {
        return false;
    }
    let since = race.elapsed(world.tick).wrapping_sub(r.race.finish_ticks);
    let spell = since / HOP_SPELL;
    let roll = spell
        .wrapping_add(slot as u32 * 7)
        .wrapping_mul(0x9E37_79B9)
        >> 16;
    let lucky = spell == HOP_FROM || (spell > HOP_FROM && roll.is_multiple_of(3));
    lucky && since % HOP_SPELL < u32::from(snow::CHARGE_TICKS)
}
