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

use crate::course::{CourseId, Sport};
use crate::math::{PI, Pcg32, cos, sin};

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
    fn weather_turns_between_the_first_and_last_lap() {
        assert_eq!(turn_blend(0.0, true, 3), 0.0);
        assert_eq!(turn_blend(0.33, true, 3), 0.0);
        assert_eq!(turn_blend(0.67, true, 3), 1.0);
        assert!((turn_blend(0.5, true, 3) - 0.5).abs() < 1e-6);
        assert_eq!(turn_blend(0.1, false, 1), 0.0);
        assert_eq!(turn_blend(1.0, false, 1), 1.0);
    }
}
