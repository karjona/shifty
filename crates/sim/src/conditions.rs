//! Conditions: the season, the weather and the time of day a race is run
//! in. A race is a circuit plus its conditions (an [`Event`]); a room's plan
//! is a list of them, drawn from a [`PlanSpec`] with a seed so the server
//! resolves it once and everyone agrees.
//!
//! - **Season:** each sport rides its own (the jetski all four, the
//!   snowboard fall, winter and spring).
//! - **Weather:** each season draws from its own climate. A race's weather
//!   can change along it: on a loop it goes from `weather` on the first lap
//!   to `turns` on the last; on a run from `weather` at the top to `turns`
//!   at the bottom. The same value both ways is steady weather.
//! - **Time of day:** local solar time in 10-minute steps from midnight
//!   (72 = noon), within the season's daylight: Costa Nevada sits at 37°N,
//!   so the noon sun stands about 76° high in summer, 53° at the equinoxes
//!   and 30° in winter, and the days are longer in summer.
//!
//! The Tilt is a year: one race per season, summer → fall → winter →
//! spring, each on a circuit its season suits, both sports in every Tilt,
//! and no circuit twice.
//!
//! What the conditions do to the riding, all of it deterministic sim:
//! - **The sea** runs with the weather and the season (calm on a fair
//!   summer day, bigger and steeper with wind, big in a storm), and turns
//!   along the race from `weather` to `turns` (see `surface::SeaClock`).
//! - **The wind** pushes every rider a little the same way: some drift
//!   crosswind, slower into it, faster with it. It blows hardest high on a
//!   run.
//! - **The snow** ([`SnowCover`]) follows the season, the weather and the
//!   place: a thin early cover in fall, with rocks poking through
//!   ([`cover_rocks`]); powder in winter; hard snow up top and slush below
//!   in spring, the slush climbing as the day warms.

use std::sync::OnceLock;

use crate::course::{CourseId, Sport};
use crate::math::{PI, Pcg32, TAU, clamp, cos, sin, smoothstep};
use crate::mountain::{Obstacle, ObstacleKind, Run};
use crate::surface::SeaTurn;

/// The seasons, in the Tilt's order. The numbers are wire values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Season {
    Summer = 0,
    Fall = 1,
    Winter = 2,
    Spring = 3,
}

impl Season {
    /// Every season, in the Tilt's order.
    pub const ALL: [Season; 4] = [Self::Summer, Self::Fall, Self::Winter, Self::Spring];

    pub fn from_u8(v: u8) -> Option<Self> {
        Self::ALL.get(usize::from(v)).copied()
    }

    /// The sun's declination (degrees north of the equator): the 23.4° tilt.
    pub fn declination(self) -> f32 {
        match self {
            Self::Summer => AXIAL_TILT,
            Self::Fall | Self::Spring => 0.0,
            Self::Winter => -AXIAL_TILT,
        }
    }

    /// The weathers this season draws, with their weights (see [`Weather`]
    /// for the order). A zero never comes up.
    pub fn climate(self) -> [u8; WEATHERS] {
        //       Clear Cloudy Windy Fog Rain Storm Snow
        match self {
            Self::Summer => [7, 2, 2, 1, 0, 1, 0],
            Self::Fall => [3, 3, 2, 2, 3, 3, 1],
            Self::Winter => [4, 3, 2, 1, 1, 1, 4],
            Self::Spring => [5, 3, 2, 1, 2, 1, 1],
        }
    }

    /// Whether this season's climate ever brings `weather`.
    pub fn has(self, weather: Weather) -> bool {
        self.climate()[weather as usize] > 0
    }

    /// The first and the last start time of a race (10-minute steps from
    /// midnight, solar time): the sun a little up at the start, and still up
    /// when a race of a few minutes ends.
    pub fn daylight(self) -> (u8, u8) {
        let mut first = NOON;
        while first > 0 && sun_up(self, first - 1) {
            first -= 1;
        }
        let mut last = NOON;
        while last < STEPS_PER_DAY - 1 - RACE_STEPS && sun_up(self, last + 1 + RACE_STEPS) {
            last += 1;
        }
        (first, last)
    }

    /// A start time within this season's daylight (clamped into it).
    pub fn clamp_time(self, time: u8) -> u8 {
        let (first, last) = self.daylight();
        time.clamp(first, last)
    }

    /// How much bigger the sea runs this season (height multiplier).
    pub fn sea_height(self) -> f32 {
        match self {
            Self::Summer | Self::Spring => 1.0,
            Self::Fall => 1.03,
            Self::Winter => 1.06,
        }
    }

    /// How far through its daylight a start time is (0 at dawn, 1 at dusk).
    pub fn day_fraction(self, time: u8) -> f32 {
        let (first, last) = self.daylight();
        clamp(
            (f32::from(time) - f32::from(first)) / f32::from(last - first).max(1.0),
            0.0,
            1.0,
        )
    }

    /// The start time of a named time of day in this season.
    pub fn time_of(self, named: TimeOfDay) -> u8 {
        let (first, last) = self.daylight();
        match named {
            TimeOfDay::Dawn => first,
            TimeOfDay::Morning => (first + NOON) / 2,
            TimeOfDay::Noon => NOON,
            TimeOfDay::Afternoon => (NOON + last) / 2,
            TimeOfDay::Dusk => last,
        }
    }
}

/// The weathers. The numbers are wire values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Weather {
    Clear = 0,
    Cloudy = 1,
    Windy = 2,
    Fog = 3,
    Rain = 4,
    Storm = 5,
    Snow = 6,
}

/// How many weathers there are.
pub const WEATHERS: usize = 7;

impl Weather {
    pub const ALL: [Weather; WEATHERS] = [
        Self::Clear,
        Self::Cloudy,
        Self::Windy,
        Self::Fog,
        Self::Rain,
        Self::Storm,
        Self::Snow,
    ];

    pub fn from_u8(v: u8) -> Option<Self> {
        Self::ALL.get(usize::from(v)).copied()
    }

    /// How big the sea runs in this weather against a course's sea as
    /// designed (a fair summer day): a multiplier on the waves' heights,
    /// and so on their steepness (their lengths stay).
    pub fn sea(self) -> f32 {
        match self {
            Self::Fog => 0.85,
            Self::Clear => 1.0,
            Self::Cloudy => 1.03,
            Self::Snow => 1.04,
            Self::Rain => 1.06,
            Self::Windy => 1.14,
            Self::Storm => 1.25,
        }
    }

    /// Wind speed in this weather (m/s).
    pub fn wind(self) -> f32 {
        match self {
            Self::Clear | Self::Fog => 0.0,
            Self::Cloudy => 3.0,
            Self::Snow => 4.0,
            Self::Rain => 5.0,
            Self::Windy => 10.0,
            Self::Storm => 14.0,
        }
    }

    /// What this weather can build up to.
    fn builds_to(self) -> &'static [Weather] {
        match self {
            Self::Clear => &[Self::Cloudy, Self::Windy],
            Self::Cloudy => &[Self::Rain, Self::Storm, Self::Snow],
            Self::Windy => &[Self::Storm],
            Self::Fog => &[Self::Cloudy, Self::Rain],
            Self::Rain => &[Self::Storm],
            Self::Storm => &[],
            Self::Snow => &[Self::Storm],
        }
    }

    /// What this weather can clear up to.
    fn clears_to(self) -> &'static [Weather] {
        match self {
            Self::Clear => &[],
            Self::Cloudy => &[Self::Clear],
            Self::Windy => &[Self::Clear, Self::Cloudy],
            Self::Fog => &[Self::Clear, Self::Cloudy],
            Self::Rain => &[Self::Cloudy],
            Self::Storm => &[Self::Rain, Self::Cloudy, Self::Windy],
            Self::Snow => &[Self::Cloudy, Self::Clear],
        }
    }
}

/// The named times of day the menus offer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TimeOfDay {
    Dawn = 0,
    Morning = 1,
    Noon = 2,
    Afternoon = 3,
    Dusk = 4,
}

impl TimeOfDay {
    pub const ALL: [TimeOfDay; 5] = [
        Self::Dawn,
        Self::Morning,
        Self::Noon,
        Self::Afternoon,
        Self::Dusk,
    ];
}

/// The Earth's axial tilt, degrees.
pub const AXIAL_TILT: f32 = 23.4;
/// Costa Nevada's latitude, degrees north.
pub const LATITUDE: f32 = 37.0;
/// Ten-minute steps in a day, and noon.
pub const STEPS_PER_DAY: u8 = 144;
pub const NOON: u8 = 72;
/// The sun stands at least this high (degrees) at a race's start and end.
pub const MIN_SUN: f32 = 5.0;
/// A race is over within this many steps of its start.
const RACE_STEPS: u8 = 1;
/// The pace (m/s) a loop's weather turns at: about a good rider's.
pub const LOOP_PAR_SPEED: f32 = 22.0;

/// Sine of the sun's elevation at solar time `time` (10-minute steps).
pub fn sun_sine(season: Season, time: u8) -> f32 {
    let rad = PI / 180.0;
    let lat = LATITUDE * rad;
    let dec = season.declination() * rad;
    let hour_angle = (f32::from(time) - f32::from(NOON)) * (PI / f32::from(NOON));
    sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(hour_angle)
}

fn sun_up(season: Season, time: u8) -> bool {
    sun_sine(season, time) >= sin(MIN_SUN * (PI / 180.0))
}

/// The conditions a race is run in: 4 bytes on the wire, in field order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Conditions {
    pub season: Season,
    /// The weather at the start (a loop's first lap, the top of a run).
    pub weather: Weather,
    /// The weather it turns to (a loop's last lap, the bottom of a run).
    pub turns: Weather,
    /// Local solar time at the start, in 10-minute steps from midnight.
    pub time: u8,
}

impl Conditions {
    /// A clear noon in the season.
    pub const fn clear(season: Season) -> Self {
        Self {
            season,
            weather: Weather::Clear,
            turns: Weather::Clear,
            time: NOON,
        }
    }

    /// A sport's conditions when nothing says otherwise: a clear summer noon
    /// on the water, a clear winter noon on the snow.
    pub fn home(sport: Sport) -> Self {
        Self::clear(match sport {
            Sport::Jetski => Season::Summer,
            Sport::Snowboard => Season::Winter,
        })
    }

    pub fn to_bytes(self) -> [u8; 4] {
        [
            self.season as u8,
            self.weather as u8,
            self.turns as u8,
            self.time,
        ]
    }

    /// Reads the wire bytes; None if any is out of range.
    pub fn from_bytes(b: [u8; 4]) -> Option<Self> {
        Some(Self {
            season: Season::from_u8(b[0])?,
            weather: Weather::from_u8(b[1])?,
            turns: Weather::from_u8(b[2])?,
            time: (b[3] < STEPS_PER_DAY).then_some(b[3])?,
        })
    }

    /// Whether the weather changes along the race.
    pub fn changes(self) -> bool {
        self.weather != self.turns
    }

    /// How the sea runs through the race (see `surface::Surface::turning`):
    /// the weather's sea at the start and at the end, bigger in the cold
    /// seasons, and veering (up to about 0.3 rad, as `veer` in -1..1 says)
    /// the windier it is.
    pub fn sea(self, veer: f32) -> SeaTurn {
        let season = self.season.sea_height();
        let windy = clamp(self.weather.wind().max(self.turns.wind()) / 14.0, 0.0, 1.0);
        SeaTurn {
            from: self.weather.sea() * season,
            to: self.turns.sea() * season,
            veer: clamp(veer, -1.0, 1.0) * 0.3 * windy,
        }
    }

    /// Wind speed (m/s) `turn` of the way from `weather` to `turns`.
    pub fn wind(self, turn: f32) -> f32 {
        self.weather.wind() + (self.turns.wind() - self.weather.wind()) * clamp(turn, 0.0, 1.0)
    }

    /// How much of the weather `turn` of the way along is `kind`.
    fn share(self, turn: f32, kind: impl Fn(Weather) -> bool) -> f32 {
        let t = clamp(turn, 0.0, 1.0);
        let a = if kind(self.weather) { 1.0 - t } else { 0.0 };
        let b = if kind(self.turns) { t } else { 0.0 };
        a + b
    }

    /// Snow falling (0-1) `turn` of the way along: snowfall, or a winter storm.
    pub fn snowing(self, turn: f32) -> f32 {
        let winter = self.season == Season::Winter;
        self.share(turn, |w| {
            w == Weather::Snow || (winter && w == Weather::Storm)
        })
    }

    /// Rain falling (0-1) `turn` of the way along: rain, or a storm out of winter.
    pub fn raining(self, turn: f32) -> f32 {
        let winter = self.season == Season::Winter;
        self.share(turn, |w| {
            w == Weather::Rain || (!winter && w == Weather::Storm)
        })
    }

    /// The snow on a run at `progress` down it (0 at the top), with the
    /// weather `turn` of the way along (see [`SnowCover`]).
    pub fn snow(self, progress: f32, turn: f32) -> SnowCover {
        let p = clamp(progress, 0.0, 1.0);
        let snowing = self.snowing(turn);
        let raining = self.raining(turn);
        let mut cover = match self.season {
            Season::Summer => SnowCover::NONE,
            Season::Fall => SnowCover {
                depth: 0.35 - 0.15 * p,
                ..SnowCover::PACKED
            },
            Season::Winter => SnowCover {
                depth: 1.5 - 0.6 * p,
                powder: 0.75,
                ..SnowCover::PACKED
            },
            Season::Spring => {
                // The slush line climbs as the day warms.
                let line = 0.7 - 0.35 * self.season.day_fraction(self.time);
                let slush = smoothstep(line - 0.12, line + 0.12, p);
                SnowCover {
                    depth: 1.0 - 0.5 * p,
                    slush,
                    hard: 1.0 - slush,
                    ..SnowCover::PACKED
                }
            }
        };
        if cover.depth > 0.0 {
            // Fresh snow softens anything and covers the slush; rain wets it.
            cover.powder = clamp(cover.powder + 0.7 * snowing, 0.0, 1.0);
            cover.hard *= 1.0 - snowing;
            cover.slush *= 1.0 - 0.5 * snowing;
            cover.slush = clamp(cover.slush + 0.4 * raining * (1.0 - cover.powder), 0.0, 1.0);
            cover.hard *= 1.0 - raining;
        }
        cover
    }
}

/// The snow at a point of a run: how deep it lies (m), and how much of it
/// (0-1 each) is powder, slush and hard snow; the rest is packed, groomed
/// snow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnowCover {
    pub depth: f32,
    pub powder: f32,
    pub slush: f32,
    pub hard: f32,
}

/// How the snow holds a board: snow friction and the edge's grip, as
/// multipliers on the snowboard's own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnowGrip {
    pub friction: f32,
    pub edge: f32,
}

impl SnowGrip {
    /// Packed, groomed snow: the board as tuned.
    pub const PACKED: Self = Self {
        friction: 1.0,
        edge: 1.0,
    };
}

/// A thin cover is scratchy below this depth (m).
const THIN_COVER: f32 = 0.4;

impl SnowCover {
    pub const PACKED: Self = Self {
        depth: 1.0,
        powder: 0.0,
        slush: 0.0,
        hard: 0.0,
    };
    pub const NONE: Self = Self {
        depth: 0.0,
        powder: 0.0,
        slush: 0.0,
        hard: 0.0,
    };

    /// How it rides: powder is soft and a little slower, slush slow and
    /// grippy, hard snow quick and slippery, a thin cover a little scratchy.
    pub fn grip(&self) -> SnowGrip {
        let thin = clamp((THIN_COVER - self.depth) / THIN_COVER, 0.0, 1.0);
        SnowGrip {
            friction: 1.0 + 0.8 * self.powder + 2.0 * self.slush - 0.25 * self.hard + 0.2 * thin,
            edge: 1.0 - 0.08 * self.powder + 0.15 * self.slush - 0.2 * self.hard,
        }
    }
}

/// Wind pushes riders this hard per m/s of wind (m/s²).
pub const WIND_PUSH: f32 = 0.02;
/// High on a run the wind blows this much harder than at the bottom.
const WIND_TOP: f32 = 1.5;

/// Wind speed (m/s) at `progress` down a run (0 at the top) or round a
/// loop, `turn` of the way from `weather` to `turns`.
pub fn wind_speed(c: Conditions, looped: bool, progress: f32, turn: f32) -> f32 {
    let speed = c.wind(turn);
    if looped {
        return speed;
    }
    // Stronger up high, sheltered below.
    speed * (WIND_TOP - (WIND_TOP - 0.5) * clamp(progress, 0.0, 1.0))
}

/// Where the wind blows toward on a race (yaw convention): close to the
/// way the swell runs on the water (`swell`), from anywhere on a run.
pub fn wind_heading(swell: Option<f32>, seed: u32) -> f32 {
    let mut rng = Pcg32::new(u64::from(seed) ^ 0x0057_1ED5);
    match swell {
        Some(h) => h + rng.range(-0.5, 0.5),
        None => rng.range(0.0, TAU),
    }
}

/// A rock poking through the snow on a run, where it stands along the run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rock {
    pub s: f32,
    pub offset: f32,
    pub obstacle: Obstacle,
}

/// Rocks on a run this far apart along it (m), about.
const ROCK_GAP: (f32, f32) = (55.0, 105.0);
/// No rocks this close to the start, the finish, a checkpoint (m), or
/// another obstacle (m, beyond both radii).
const ROCK_CLEAR_GATE: f32 = 25.0;
const ROCK_CLEAR_OBSTACLE: f32 = 6.0;
/// Rocks stand inside this fraction of the run's half width, and leave at
/// least this much room (m) to the run's edge.
const ROCK_SPREAD: f32 = 0.65;
const ROCK_ROOM: f32 = 5.0;

/// The rocks a thin cover leaves poking through on a course's run, placed
/// once per run (none on the water). Fall only: see `World::cover_rocks`.
pub fn cover_rocks(course: CourseId) -> &'static [Rock] {
    static PLACED: [OnceLock<Vec<Rock>>; 16] = [const { OnceLock::new() }; 16];
    let Some(cell) = PLACED.get(course as usize) else {
        return &[];
    };
    cell.get_or_init(|| {
        let c = course.course();
        c.run()
            .map_or_else(Vec::new, |run| place_rocks(run, c.start_s))
    })
}

fn place_rocks(run: &Run, start_s: f32) -> Vec<Rock> {
    let mut rng = Pcg32::new(u64::from(run.seed) ^ 0x0F41_1500);
    let mut rocks: Vec<Rock> = Vec::new();
    let gates: Vec<f32> = [start_s, run.finish_s]
        .into_iter()
        .chain(run.checkpoints.iter().copied())
        .collect();
    let mut s = start_s + 80.0;
    while s < run.finish_s - 50.0 {
        let half = run.width_at(s).half.min(run.limit(s) - ROCK_ROOM).max(0.0);
        let offset = rng.range(-ROCK_SPREAD, ROCK_SPREAD) * half;
        let radius = rng.range(0.5, 0.85);
        let height = rng.range(0.35, 0.6);
        let (x, z) = run.centerline(s).at_offset(offset);
        let near_gate = gates.iter().any(|&g| (g - s).abs() < ROCK_CLEAR_GATE);
        // Off the built features (tables, rollers, kickers): flat snow only.
        let on_feature = (-3..=3).any(|i| run.features_at(s + i as f32 * 5.0, offset).abs() > 0.05);
        let crowded = run.obstacles().iter().any(|o| {
            let (dx, dz) = (o.x - x, o.z - z);
            let clear = o.radius + radius + ROCK_CLEAR_OBSTACLE;
            dx * dx + dz * dz < clear * clear
        });
        if near_gate || on_feature || crowded {
            s += 10.0;
            continue;
        }
        rocks.push(Rock {
            s,
            offset,
            obstacle: Obstacle {
                x,
                y: run.height(x, z),
                z,
                radius,
                height,
                kind: ObstacleKind::Rock,
            },
        });
        s += rng.range(ROCK_GAP.0, ROCK_GAP.1);
    }
    rocks
}

impl Sport {
    /// The seasons this sport rides, in the Tilt's order.
    pub fn seasons(self) -> &'static [Season] {
        match self {
            Self::Jetski => &Season::ALL,
            Self::Snowboard => &[Season::Fall, Season::Winter, Season::Spring],
        }
    }

    pub fn rides(self, season: Season) -> bool {
        self.seasons().contains(&season)
    }
}

/// One race of a room's plan: a circuit and its conditions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event {
    pub course: CourseId,
    pub conditions: Conditions,
}

impl Event {
    /// A course in its sport's home conditions.
    pub fn home(course: CourseId) -> Self {
        Self {
            course,
            conditions: Conditions::home(course.sport()),
        }
    }
}

/// One race as asked for: each field picked, or left to the draw (None).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EventSpec {
    pub course: Option<CourseId>,
    pub season: Option<Season>,
    pub weather: Option<Weather>,
    pub turns: Option<Weather>,
    pub time: Option<u8>,
}

/// A room's plan as asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanSpec {
    /// The Tilt: a year, everything drawn.
    Tilt,
    /// These races, in order.
    Races(Vec<EventSpec>),
}

/// Odds (out of 100) a weather turns along a loop: builds up, clears, or
/// (the rest) stays.
const LOOP_BUILDS: u32 = 25;
const LOOP_CLEARS: u32 = 15;
/// On a run the bottom is more often clearer than the top: cloud and wind
/// up high, sun below.
const RUN_BUILDS: u32 = 10;
const RUN_CLEARS: u32 = 40;

/// Draws one of `options` by `weights` (all of them if every weight is 0).
fn pick_weighted<T: Copy>(rng: &mut Pcg32, options: &[(T, u32)]) -> Option<T> {
    let total: u32 = options.iter().map(|o| o.1).sum();
    if total == 0 {
        let n = options.len() as u32;
        return (n > 0).then(|| options[(rng.next_u32() % n) as usize].0);
    }
    let mut r = rng.next_u32() % total;
    for &(v, w) in options {
        if r < w {
            return Some(v);
        }
        r -= w;
    }
    None
}

fn pick<T: Copy>(rng: &mut Pcg32, options: &[T]) -> Option<T> {
    let n = options.len() as u32;
    (n > 0).then(|| options[(rng.next_u32() % n) as usize])
}

/// A weather from the season's climate.
pub fn draw_weather(rng: &mut Pcg32, season: Season) -> Weather {
    let climate = season.climate();
    let options: Vec<(Weather, u32)> = Weather::ALL
        .iter()
        .map(|&w| (w, u32::from(climate[w as usize])))
        .collect();
    pick_weighted(rng, &options).unwrap_or(Weather::Clear)
}

/// What the weather turns to along a race: mostly steady, sometimes a
/// build-up or a clearing, always within the season's climate. `looped`:
/// on a loop (else a run, where the bottom tends to be clearer).
pub fn draw_turns(rng: &mut Pcg32, season: Season, weather: Weather, looped: bool) -> Weather {
    let (builds, clears) = if looped {
        (LOOP_BUILDS, LOOP_CLEARS)
    } else {
        (RUN_BUILDS, RUN_CLEARS)
    };
    let roll = rng.next_u32() % 100;
    let toward = if roll < builds {
        weather.builds_to()
    } else if roll < builds + clears {
        weather.clears_to()
    } else {
        return weather;
    };
    let climate = season.climate();
    let options: Vec<(Weather, u32)> = toward
        .iter()
        .filter(|&&w| season.has(w))
        .map(|&w| (w, u32::from(climate[w as usize])))
        .collect();
    pick_weighted(rng, &options).unwrap_or(weather)
}

/// A start time within the season's daylight.
pub fn draw_time(rng: &mut Pcg32, season: Season) -> u8 {
    let (first, last) = season.daylight();
    first + (rng.next_u32() % u32::from(last - first + 1)) as u8
}

/// The circuits that suit a season: their sport rides it.
fn circuits_for(season: Season) -> Vec<CourseId> {
    CourseId::ALL
        .iter()
        .copied()
        .filter(|c| c.sport().rides(season))
        .collect()
}

/// One race from its spec. Picks that don't fit (a season the circuit's
/// sport doesn't ride, a weather its season never brings) go to the draw;
/// a time outside the season's daylight is moved into it.
pub fn resolve_event(spec: &EventSpec, rng: &mut Pcg32) -> Event {
    let (course, season) = match (spec.course, spec.season) {
        (Some(c), Some(s)) if c.sport().rides(s) => (c, s),
        (Some(c), _) => (c, pick(rng, c.sport().seasons()).unwrap_or(Season::Summer)),
        (None, Some(s)) => match pick(rng, &circuits_for(s)) {
            Some(c) => (c, s),
            None => {
                let c = pick(rng, CourseId::ALL).unwrap_or(CourseId::Oval);
                (c, pick(rng, c.sport().seasons()).unwrap_or(Season::Summer))
            }
        },
        (None, None) => {
            let c = pick(rng, CourseId::ALL).unwrap_or(CourseId::Oval);
            (c, pick(rng, c.sport().seasons()).unwrap_or(Season::Summer))
        }
    };
    conditions_for(course, season, spec, rng)
}

/// The weather and time of a race on `course` in `season`, from the spec's
/// picks where they fit.
fn conditions_for(course: CourseId, season: Season, spec: &EventSpec, rng: &mut Pcg32) -> Event {
    let weather = match spec.weather {
        Some(w) if season.has(w) => w,
        _ => draw_weather(rng, season),
    };
    let turns = match spec.turns {
        Some(w) if season.has(w) => w,
        _ => draw_turns(rng, season, weather, course.course().looped()),
    };
    let time = match spec.time {
        Some(t) => season.clamp_time(t),
        None => draw_time(rng, season),
    };
    Event {
        course,
        conditions: Conditions {
            season,
            weather,
            turns,
            time,
        },
    }
}

/// The races of a plan, drawn with `seed`. The same plan and seed always
/// give the same races.
pub fn resolve_plan(plan: &PlanSpec, seed: u32) -> Vec<Event> {
    let mut rng = Pcg32::new(u64::from(seed) ^ 0x7417_5EA5_0000_0000);
    match plan {
        PlanSpec::Tilt => tilt(&mut rng),
        PlanSpec::Races(specs) if specs.is_empty() => {
            vec![resolve_event(&EventSpec::default(), &mut rng)]
        }
        PlanSpec::Races(specs) => specs.iter().map(|s| resolve_event(s, &mut rng)).collect(),
    }
}

/// The Tilt: one race per season in order, each on a circuit its season
/// suits, both sports, no circuit twice. Without circuits enough for that,
/// it is summer on the water, then winter on the mountain.
fn tilt(rng: &mut Pcg32) -> Vec<Event> {
    let mut courses = Vec::with_capacity(Season::ALL.len());
    let year = if assign_year(rng, &mut courses) {
        courses
            .iter()
            .zip(Season::ALL)
            .map(|(&c, s)| (c, s))
            .collect::<Vec<_>>()
    } else {
        let mut short = Vec::new();
        for (sport, season) in [
            (Sport::Jetski, Season::Summer),
            (Sport::Snowboard, Season::Winter),
        ] {
            let options: Vec<CourseId> = CourseId::ALL
                .iter()
                .copied()
                .filter(|c| c.sport() == sport)
                .collect();
            if let Some(c) = pick(rng, &options) {
                short.push((c, season));
            }
        }
        short
    };
    year.into_iter()
        .map(|(course, season)| conditions_for(course, season, &EventSpec::default(), rng))
        .collect()
}

/// Fills `courses` with one circuit per season (in the Tilt's order), each
/// suiting its season, none twice, both sports among them. Candidates are
/// tried in a drawn order, so every valid year can come up. False if there
/// is no such year.
fn assign_year(rng: &mut Pcg32, courses: &mut Vec<CourseId>) -> bool {
    let depth = courses.len();
    if depth == Season::ALL.len() {
        let water = courses.iter().any(|c| c.sport() == Sport::Jetski);
        let snow = courses.iter().any(|c| c.sport() == Sport::Snowboard);
        return water && snow;
    }
    let season = Season::ALL[depth];
    let mut options: Vec<CourseId> = circuits_for(season)
        .into_iter()
        .filter(|c| !courses.contains(c))
        .collect();
    // Fisher-Yates with the plan's generator.
    for i in (1..options.len()).rev() {
        let j = (rng.next_u32() % (i as u32 + 1)) as usize;
        options.swap(i, j);
    }
    for c in options {
        courses.push(c);
        if assign_year(rng, courses) {
            return true;
        }
        courses.pop();
    }
    false
}

/// How far along a race its weather has turned (0 = `weather`, 1 = `turns`),
/// from its progress (0 at the start, 1 at the finish): steady through the
/// first part, turning in the middle, settled at the end. On a loop with
/// `laps`, the first lap is all `weather` and the last all `turns`.
pub fn turn_blend(progress: f32, looped: bool, laps: u8) -> f32 {
    let (from, to) = if looped && laps >= 3 {
        let l = f32::from(laps);
        (1.0 / l, (l - 1.0) / l)
    } else {
        (0.2, 0.8)
    };
    crate::math::smoothstep(from, to, progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_round_trip_and_bad_ones_are_refused() {
        let c = Conditions {
            season: Season::Spring,
            weather: Weather::Storm,
            turns: Weather::Snow,
            time: 101,
        };
        assert_eq!(c.to_bytes(), [3, 5, 6, 101]);
        assert_eq!(Conditions::from_bytes(c.to_bytes()), Some(c));
        assert_eq!(Conditions::from_bytes([4, 0, 0, 72]), None);
        assert_eq!(Conditions::from_bytes([0, 7, 0, 72]), None);
        assert_eq!(Conditions::from_bytes([0, 0, 7, 72]), None);
        assert_eq!(Conditions::from_bytes([0, 0, 0, 144]), None);
    }

    #[test]
    fn the_noon_sun_follows_the_tilt() {
        let noon = |s: Season| {
            let x = sun_sine(s, NOON);
            // asin through atan: x / sqrt(1 - x²).
            crate::math::atan(x / crate::math::sqrt(1.0 - x * x)) * 180.0 / PI
        };
        assert!((noon(Season::Summer) - 76.4).abs() < 0.2);
        assert!((noon(Season::Fall) - 53.0).abs() < 0.2);
        assert!((noon(Season::Spring) - 53.0).abs() < 0.2);
        assert!((noon(Season::Winter) - 29.6).abs() < 0.2);
    }

    #[test]
    fn races_run_dawn_to_dusk_and_summer_days_are_longest() {
        // 05:20-18:30 in summer, 06:30-17:20 at the equinoxes, 07:50-16:00
        // in winter.
        assert_eq!(Season::Summer.daylight(), (32, 111));
        assert_eq!(Season::Fall.daylight(), (39, 104));
        assert_eq!(Season::Spring.daylight(), Season::Fall.daylight());
        assert_eq!(Season::Winter.daylight(), (47, 96));
        for s in Season::ALL {
            let (first, last) = s.daylight();
            assert!(sun_sine(s, first) > 0.0 && sun_sine(s, last + 1) > 0.0);
            assert!(sun_sine(s, first - 1) < sin(MIN_SUN * PI / 180.0));
            let named: Vec<u8> = TimeOfDay::ALL.iter().map(|&n| s.time_of(n)).collect();
            assert!(named.windows(2).all(|w| w[0] < w[1]), "{s:?}: {named:?}");
            assert_eq!(s.clamp_time(0), first);
            assert_eq!(s.clamp_time(143), last);
        }
    }

    #[test]
    fn climates_keep_snow_out_of_summer_and_storms_mostly_in_fall() {
        assert!(!Season::Summer.has(Weather::Snow));
        let storms = |s: Season| {
            let c = s.climate();
            f32::from(c[Weather::Storm as usize]) / c.iter().map(|&w| f32::from(w)).sum::<f32>()
        };
        for s in [Season::Summer, Season::Winter, Season::Spring] {
            assert!(storms(Season::Fall) > storms(s));
        }
        let snow = |s: Season| s.climate()[Weather::Snow as usize];
        assert!(snow(Season::Winter) > snow(Season::Fall));
        assert!(snow(Season::Winter) > snow(Season::Spring));
    }

    #[test]
    fn turns_stay_in_the_climate_and_are_mostly_steady() {
        for season in Season::ALL {
            for looped in [true, false] {
                let mut rng = Pcg32::new(u64::from(season as u8) * 31 + u64::from(looped));
                let mut steady = 0;
                let mut cleared = 0;
                for _ in 0..2000 {
                    let w = draw_weather(&mut rng, season);
                    assert!(season.has(w));
                    let t = draw_turns(&mut rng, season, w, looped);
                    assert!(season.has(t), "{season:?}: {w:?} -> {t:?}");
                    steady += u32::from(w == t);
                    cleared += u32::from(w.clears_to().contains(&t));
                }
                assert!(steady > 900, "{season:?} looped {looped}: {steady}");
                if !looped {
                    assert!(cleared > 300, "{season:?}: runs clear below ({cleared})");
                }
            }
        }
    }

    #[test]
    fn picks_are_kept_and_the_rest_is_drawn() {
        let spec = EventSpec {
            course: Some(CourseId::Mountain),
            season: Some(Season::Spring),
            weather: Some(Weather::Fog),
            turns: Some(Weather::Clear),
            time: Some(80),
        };
        for seed in 0..20 {
            let [e] = resolve_plan(&PlanSpec::Races(vec![spec]), seed)[..] else {
                panic!("one race");
            };
            assert_eq!(e.course, CourseId::Mountain);
            assert_eq!(
                e.conditions,
                Conditions {
                    season: Season::Spring,
                    weather: Weather::Fog,
                    turns: Weather::Clear,
                    time: 80,
                }
            );
        }
        // No snow in summer, no summer on the snow, no racing at night.
        let bad = EventSpec {
            course: Some(CourseId::Mountain),
            season: Some(Season::Summer),
            weather: Some(Weather::Snow),
            turns: None,
            time: Some(0),
        };
        for seed in 0..50 {
            let e = resolve_plan(&PlanSpec::Races(vec![bad]), seed)[0];
            assert_eq!(e.course, CourseId::Mountain);
            assert_ne!(e.conditions.season, Season::Summer);
            assert_eq!(e.conditions.time, e.conditions.season.daylight().0);
            let summer = EventSpec {
                season: Some(Season::Summer),
                weather: Some(Weather::Snow),
                ..EventSpec::default()
            };
            let e = resolve_plan(&PlanSpec::Races(vec![summer]), seed)[0];
            assert_eq!(e.course.sport(), Sport::Jetski);
            assert_eq!(e.conditions.season, Season::Summer);
            assert_ne!(e.conditions.weather, Weather::Snow);
        }
    }

    #[test]
    fn the_draw_is_seeded_and_covers_everything() {
        let plan = PlanSpec::Races(vec![EventSpec::default()]);
        assert_eq!(resolve_plan(&plan, 7), resolve_plan(&plan, 7));
        let mut courses = [false; 16];
        let mut seasons = [false; 4];
        let mut weathers = [false; WEATHERS];
        for seed in 0..500 {
            let e = resolve_plan(&plan, seed)[0];
            let c = e.conditions;
            assert!(e.course.sport().rides(c.season));
            assert!(c.season.has(c.weather) && c.season.has(c.turns));
            let (first, last) = c.season.daylight();
            assert!((first..=last).contains(&c.time));
            courses[e.course as usize] = true;
            seasons[c.season as usize] = true;
            weathers[c.weather as usize] = true;
        }
        assert!(CourseId::ALL.iter().all(|&c| courses[c as usize]));
        assert!(seasons.iter().all(|&s| s));
        assert!(weathers.iter().all(|&w| w));
        assert_eq!(resolve_plan(&PlanSpec::Races(Vec::new()), 3).len(), 1);
    }

    #[test]
    fn every_tilt_is_a_year_with_both_sports_and_no_repeats() {
        let enough = CourseId::ALL.len() >= Season::ALL.len();
        for seed in 0..300 {
            let plan = resolve_plan(&PlanSpec::Tilt, seed);
            assert_eq!(plan, resolve_plan(&PlanSpec::Tilt, seed));
            let seasons: Vec<Season> = plan.iter().map(|e| e.conditions.season).collect();
            if enough {
                assert_eq!(seasons, Season::ALL);
            } else {
                assert_eq!(seasons, [Season::Summer, Season::Winter]);
            }
            assert_eq!(plan[0].course.sport(), Sport::Jetski);
            for e in &plan {
                assert!(e.course.sport().rides(e.conditions.season));
                assert!(e.conditions.season.has(e.conditions.weather));
            }
            for (i, a) in plan.iter().enumerate() {
                assert!(plan[i + 1..].iter().all(|b| b.course != a.course));
            }
            assert!(plan.iter().any(|e| e.course.sport() == Sport::Snowboard));
        }
    }

    /// The tables the menus and the lobby mirror (`packages/rider/src/
    /// conditions.ts` renders the same lines).
    fn fixture() -> String {
        let sport = |s: Sport| match s {
            Sport::Jetski => "jetski",
            Sport::Snowboard => "snow",
        };
        let join = |v: &[u8]| v.iter().map(u8::to_string).collect::<Vec<_>>().join(" ");
        let mut lines = Vec::new();
        for &c in CourseId::ALL {
            lines.push(format!("circuit {} {}", c as u8, sport(c.sport())));
        }
        for s in [Sport::Jetski, Sport::Snowboard] {
            let seasons: Vec<u8> = s.seasons().iter().map(|&x| x as u8).collect();
            lines.push(format!("sport {} {}", sport(s), join(&seasons)));
        }
        for s in Season::ALL {
            let (first, last) = s.daylight();
            let times: Vec<u8> = TimeOfDay::ALL.iter().map(|&n| s.time_of(n)).collect();
            lines.push(format!(
                "season {} climate {} daylight {first} {last} times {}",
                s as u8,
                join(&s.climate()),
                join(&times)
            ));
        }
        lines.join("\n") + "\n"
    }

    /// Run with `UPDATE_FIXTURES=1` to write the fixture after changing the
    /// tables (and change `conditions.ts` to match).
    #[test]
    fn the_menus_tables_match_the_sims() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/rider/test/conditions.txt"
        );
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(path, fixture()).expect("write the fixture");
        }
        let on_disk = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            on_disk,
            fixture(),
            "packages/rider/test/conditions.txt is out of date: run with UPDATE_FIXTURES=1 and update packages/rider/src/conditions.ts"
        );
    }

    #[test]
    fn the_weather_moves_with_the_clock_on_a_loop_and_down_a_run() {
        use crate::race::{Phase, Race};
        use crate::{SurfaceKind, World};
        let mut bay = World::on_course(CourseId::Oval, SurfaceKind::Flat, 1);
        assert_eq!(bay.weather_progress(0.0, 0.0), 0.0);
        bay.race = Race {
            phase: Phase::Racing,
            phase_tick: 0,
        };
        bay.sync_weather();
        let course = CourseId::Oval.course();
        let par = f32::from(course.laps) * course.length() / LOOP_PAR_SPEED;
        bay.tick = (par * 0.5 * crate::TICK_HZ as f32) as u32;
        assert!((bay.weather_progress(0.0, 0.0) - 0.5).abs() < 0.01);
        bay.tick = u32::MAX / 2;
        assert_eq!(bay.weather_progress(0.0, 0.0), 1.0);
        assert_eq!(bay.weather_turn(0.0, 0.0), 1.0);

        let snow = World::on_course(CourseId::Mountain, SurfaceKind::Flat, 1);
        let c = CourseId::Mountain.course();
        let run = c.run().unwrap();
        let at = |s: f32| {
            let f = c.centerline(s);
            snow.weather_progress(f.x, f.z)
        };
        assert!(at(c.start_s) < 0.01);
        assert!((at((c.start_s + run.finish_s) / 2.0) - 0.5).abs() < 0.02);
        assert!(at(run.finish_s) > 0.99);
    }

    #[test]
    fn a_storm_builds_lap_by_lap_and_the_wind_with_it() {
        use crate::race::{Phase, Race};
        use crate::{SurfaceKind, World};
        let event = Event {
            course: CourseId::Oval,
            conditions: Conditions {
                season: Season::Fall,
                weather: Weather::Cloudy,
                turns: Weather::Storm,
                time: NOON,
            },
        };
        let mut w = World::for_event(event, SurfaceKind::Swells, 3);
        let main = w.surface.waves()[0];
        assert!(main.amplitude_to > main.amplitude * 1.15);
        let calm = World::on_course(CourseId::Oval, SurfaceKind::Swells, 3);
        assert!(main.amplitude > calm.surface.waves()[0].amplitude);
        // Dev seas stay as they are.
        let flat = World::for_event(event, SurfaceKind::Flat, 3);
        assert!(flat.surface.waves().is_empty());
        let wind = |w: &World| {
            let (x, z) = w.wind_at(0.0, 0.0);
            (x * x + z * z).sqrt()
        };
        assert_eq!(w.surface.turn(w.tick), 0.0);
        assert!((wind(&w) - 3.0).abs() < 1e-3);
        w.race = Race {
            phase: Phase::Racing,
            phase_tick: 0,
        };
        w.sync_weather();
        let h0 = w.surface.height(10.0, 10.0, 0);
        w.tick = 60 * 60 * 3;
        assert_eq!(w.surface.turn(w.tick), 1.0);
        assert!((wind(&w) - 14.0).abs() < 1e-3);
        // The sea changes smoothly: a tick apart it hardly moves.
        w.tick = 60 * 60;
        let a = w.surface.height(10.0, 10.0, w.tick);
        let b = w.surface.height(10.0, 10.0, w.tick + 1);
        assert!((a - b).abs() < 0.1, "{a} {b}");
        assert!(h0.is_finite());
    }

    #[test]
    fn the_snow_follows_the_season_and_the_wind_blows_hardest_up_high() {
        let c = |season, weather| Conditions {
            season,
            weather,
            turns: weather,
            time: NOON,
        };
        let spring = c(Season::Spring, Weather::Clear);
        assert!(spring.snow(0.0, 0.0).hard > 0.9 && spring.snow(1.0, 0.0).slush > 0.9);
        assert!(spring.snow(1.0, 0.0).grip().friction > 2.0);
        assert!(spring.snow(0.0, 0.0).grip().friction < 1.0);
        // The slush climbs as the day warms.
        let morning = Conditions {
            time: Season::Spring.time_of(TimeOfDay::Morning),
            ..spring
        };
        let dusk = Conditions {
            time: Season::Spring.time_of(TimeOfDay::Dusk),
            ..spring
        };
        assert!(dusk.snow(0.45, 0.0).slush > morning.snow(0.45, 0.0).slush);
        let winter = c(Season::Winter, Weather::Clear);
        assert!(winter.snow(0.5, 0.0).powder > 0.5);
        assert!(
            winter.snow(0.0, 0.0).depth
                > c(Season::Fall, Weather::Clear).snow(0.0, 0.0).depth * 3.0
        );
        assert!(c(Season::Fall, Weather::Snow).snow(0.5, 0.0).powder > 0.5);
        assert_eq!(c(Season::Summer, Weather::Clear).snow(0.5, 0.0).depth, 0.0);
        let storm = c(Season::Winter, Weather::Storm);
        assert!(wind_speed(storm, false, 0.0, 0.0) > wind_speed(storm, false, 1.0, 0.0) * 2.0);
        assert_eq!(wind_speed(storm, true, 0.0, 0.0), 14.0);
    }

    #[test]
    fn fall_rocks_stand_on_the_run_clear_of_gates_and_features() {
        use crate::{SurfaceKind, World};
        for &course in CourseId::ALL {
            let c = course.course();
            let rocks = cover_rocks(course);
            let Some(run) = c.run() else {
                assert!(rocks.is_empty());
                continue;
            };
            assert!(rocks.len() >= 8, "{course:?}: {} rocks", rocks.len());
            assert_eq!(rocks, cover_rocks(course));
            for k in rocks {
                assert!(k.offset.abs() + k.obstacle.radius < run.limit(k.s) - 3.0);
                assert!((k.s - c.start_s).abs() > ROCK_CLEAR_GATE);
                assert!(
                    run.checkpoints
                        .iter()
                        .all(|&g| (g - k.s).abs() > ROCK_CLEAR_GATE)
                );
                // Off anything built; a bowl's dish or a gully's floor is just snow.
                assert!(run.features_at(k.s, k.offset).abs() <= 0.05);
            }
            let fall = World::for_event(
                Event {
                    course,
                    conditions: Conditions::clear(Season::Fall),
                },
                SurfaceKind::Flat,
                1,
            );
            assert_eq!(fall.cover_rocks().len(), rocks.len());
            assert!(
                World::on_course(course, SurfaceKind::Flat, 1)
                    .cover_rocks()
                    .is_empty()
            );
        }
    }

    #[test]
    fn weather_turns_between_the_first_and_last_lap() {
        assert_eq!(turn_blend(0.0, true, 3), 0.0);
        assert_eq!(turn_blend(0.33, true, 3), 0.0);
        assert_eq!(turn_blend(0.67, true, 3), 1.0);
        assert!((turn_blend(0.5, true, 3) - 0.5).abs() < 1e-6);
        assert_eq!(turn_blend(0.1, false, 1), 0.0);
        assert_eq!(turn_blend(1.0, false, 1), 1.0);
    }
}
