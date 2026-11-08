//! The ground (or water) riders move on, as a pure function of position and
//! tick. Nothing about the surface is ever sent over the network: server and
//! clients build the same surface from the same seed.
//!
//! A flat plane, or ocean swells (as designed for the course, calmer, or
//! rougher). Swells are a sum of directional waves with deep-water
//! dispersion. Each wave can be "sharpened": its sine is raised to an
//! integer power, which gives pointed crests and long flat troughs, like
//! real swells, and makes crests launch riders.
//!
//! A race's sea can turn: each wave has a height at the start and one at
//! the end, and the race's clock (see [`SeaClock`]) blends between them, so
//! a storm builds lap by lap. The waves' lengths and directions stay.
//!
//! The client's water shader evaluates the same wave parameters with the
//! same formula (see [`Surface::wave_params`]), so the water you see is the
//! water the physics rides.

use crate::DT;
use crate::conditions::turn_blend;
use crate::math::{Pcg32, TAU, Vec3, clamp, cos, sin, sqrt};

pub const MAX_WAVES: usize = 8;
/// Floats per wave in [`Surface::wave_params`].
pub const WAVE_FIELDS: usize = 8;
const GRAVITY_WAVES: f32 = 9.81;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SurfaceKind {
    Flat = 0,
    /// The course's sea, as designed.
    Swells = 1,
    /// Gentler: the same swell, less steep.
    Calm = 2,
    /// Steeper, taller waves.
    Rough = 3,
}

impl SurfaceKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Flat),
            1 => Some(Self::Swells),
            2 => Some(Self::Calm),
            3 => Some(Self::Rough),
            _ => None,
        }
    }

    /// Steepness and height multipliers on the sea state.
    fn scale(self) -> Option<(f32, f32)> {
        match self {
            Self::Flat => None,
            Self::Swells => Some((1.0, 1.0)),
            Self::Calm => Some((0.6, 0.6)),
            Self::Rough => Some((1.25, 1.35)),
        }
    }
}

/// Recipe for a sea: the seed picks the exact waves within these ranges.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SeaState {
    /// Direction the swell travels (radians, same convention as rider yaw:
    /// 0 = +Z, PI/2 = +X). `None` = picked by the seed.
    pub direction: Option<f32>,
    /// Random spread of each wave's direction around the main one.
    pub spread: f32,
    pub waves: usize,
    /// Wavelength range of the first (longest) wave, metres.
    pub wavelength: (f32, f32),
    /// Later waves are progressively shorter: wave `i` is the first one's
    /// length divided by `1 + shortening * i`.
    pub shortening: f32,
    /// Steepness range (`amplitude * k`) per wave.
    pub steepness: (f32, f32),
    pub max_amplitude: f32,
    /// Sharpness (power) of the first `sharp_waves` waves. 1 = plain sine.
    pub sharpness: u8,
    pub sharp_waves: usize,
}

impl SeaState {
    /// Open-sea swell: long rolling waves, the longest with pointed crests
    /// that throw you in the air when you meet them at speed. Shorter waves
    /// stay gentle: steep short ones would launch you off every bump (fine
    /// chop is the renderer's job).
    pub const OPEN_SEA: Self = Self {
        direction: None,
        spread: 0.35,
        waves: 4,
        wavelength: (55.0, 68.0),
        shortening: 0.3,
        steepness: (0.055, 0.08),
        max_amplitude: 1.15,
        sharpness: 3,
        sharp_waves: 1,
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Wave {
    /// Unit direction of travel in the XZ plane.
    pub dir_x: f32,
    pub dir_z: f32,
    /// Wavenumber `2π / wavelength`.
    pub k: f32,
    /// Half the crest-to-trough height at the start of the race...
    pub amplitude: f32,
    /// ...and at the end (see [`SeaClock`]).
    pub amplitude_to: f32,
    /// Angular frequency (rad/s), from deep-water dispersion `ω = √(g·k)`.
    pub omega: f32,
    pub phase: f32,
    /// Integer power the wave shape is raised to: 1 (sine), 2 or 3. Any
    /// other value is treated as 1.
    pub sharpness: u8,
}

impl Wave {
    /// Half the crest-to-trough height `turn` of the way from the start to
    /// the end.
    pub fn amplitude_at(&self, turn: f32) -> f32 {
        self.amplitude + (self.amplitude_to - self.amplitude) * turn
    }

    /// Height and `d height / d argument` for argument `a`, at amplitude `amp`.
    ///
    /// With `u = (1 + sin a) / 2`, the shape is `2A (uᵖ - mean(uᵖ))`: zero
    /// mean, crest-to-trough `2A`, crests sharper as `p` grows.
    fn shape(&self, a: f32, amp: f32) -> (f32, f32) {
        let s = sin(a);
        let c = cos(a);
        let u = (1.0 + s) * 0.5;
        match self.sharpness {
            2 => (2.0 * amp * (u * u - 0.375), 2.0 * amp * u * c),
            3 => (2.0 * amp * (u * u * u - 0.3125), 3.0 * amp * u * u * c),
            _ => (amp * s, amp * c),
        }
    }
}

/// The surface around one point: height and its derivatives.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WaterSample {
    pub height: f32,
    pub dhdx: f32,
    pub dhdz: f32,
    /// How fast the surface rises at this fixed point, m/s.
    pub dhdt: f32,
}

impl WaterSample {
    pub fn normal(&self) -> Vec3 {
        Vec3::new(-self.dhdx, 1.0, -self.dhdz).normalize_or(Vec3::UP)
    }
}

/// How a sea runs against its recipe: its waves' heights multiplied at the
/// start and at the end of the race, and how far (radians) the swell veers
/// from the recipe's direction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SeaTurn {
    pub from: f32,
    pub to: f32,
    pub veer: f32,
}

impl SeaTurn {
    /// The sea as its recipe has it, all race long.
    pub const STEADY: Self = Self {
        from: 1.0,
        to: 1.0,
        veer: 0.0,
    };
}

/// Where the race's clock stands for the sea: before the start it is the
/// start's sea, through the race it turns (from `from`, the tick the race
/// started, at a par pace of `par` ticks for `laps` laps; see
/// [`turn_blend`]), and after it it is the end's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SeaClock {
    #[default]
    Start,
    Racing {
        from: u32,
        par: u32,
        laps: u8,
    },
    End,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Surface {
    pub kind: SurfaceKind,
    pub seed: u32,
    /// The race's clock, set by the world (see `World::sync_weather`).
    pub clock: SeaClock,
    waves: [Wave; MAX_WAVES],
    wave_count: usize,
}

impl Surface {
    pub fn new(kind: SurfaceKind, seed: u32) -> Self {
        Self::with_sea(kind, seed, &SeaState::OPEN_SEA)
    }

    pub fn with_sea(kind: SurfaceKind, seed: u32, sea: &SeaState) -> Self {
        Self::turning(kind, seed, sea, SeaTurn::STEADY)
    }

    /// A sea that runs as `turn` says against its recipe (the waves are the
    /// same; their heights change).
    pub fn turning(kind: SurfaceKind, seed: u32, sea: &SeaState, turn: SeaTurn) -> Self {
        let mut waves = [Wave::default(); MAX_WAVES];
        let mut wave_count = 0;
        if let Some((steep, height)) = kind.scale() {
            let mut rng = Pcg32::new(u64::from(seed) ^ 0x5157_E115);
            let picked = rng.range(0.0, TAU);
            let main_dir = sea.direction.unwrap_or(picked) + turn.veer;
            wave_count = sea.waves.min(MAX_WAVES);
            for (i, w) in waves.iter_mut().take(wave_count).enumerate() {
                let angle = main_dir + rng.range(-sea.spread, sea.spread);
                let wavelength = rng.range(sea.wavelength.0, sea.wavelength.1)
                    / (1.0 + i as f32 * sea.shortening);
                let k = TAU / wavelength;
                let amplitude = (steep * rng.range(sea.steepness.0, sea.steepness.1) / k)
                    .min(sea.max_amplitude * height);
                *w = Wave {
                    // Yaw convention: direction (sin, cos).
                    dir_x: sin(angle),
                    dir_z: cos(angle),
                    k,
                    amplitude: amplitude * turn.from,
                    amplitude_to: amplitude * turn.to,
                    omega: sqrt(GRAVITY_WAVES * k),
                    phase: rng.range(0.0, TAU),
                    sharpness: if i < sea.sharp_waves {
                        sea.sharpness
                    } else {
                        1
                    },
                };
            }
        }
        Self {
            kind,
            seed,
            clock: SeaClock::Start,
            waves,
            wave_count,
        }
    }

    /// How far the sea has turned from its start (0) to its end (1) at a tick.
    pub fn turn(&self, tick: u32) -> f32 {
        match self.clock {
            SeaClock::Start => 0.0,
            SeaClock::End => 1.0,
            SeaClock::Racing { from, par, laps } => {
                let progress = tick.saturating_sub(from) as f32 / par.max(1) as f32;
                turn_blend(clamp(progress, 0.0, 1.0), true, laps)
            }
        }
    }

    /// Whether the waves change height along the race.
    pub fn turns(&self) -> bool {
        self.waves().iter().any(|w| w.amplitude != w.amplitude_to)
    }

    /// The main direction the swell travels (yaw convention), if there is a swell.
    pub fn heading(&self) -> Option<f32> {
        self.waves()
            .first()
            .map(|w| crate::math::atan2(w.dir_x, w.dir_z))
    }

    pub fn flat() -> Self {
        Self::new(SurfaceKind::Flat, 0)
    }

    fn time(tick: u32) -> f32 {
        tick as f32 * DT
    }

    fn argument(w: &Wave, x: f32, z: f32, t: f32) -> f32 {
        w.k * (w.dir_x * x + w.dir_z * z) - w.omega * t + w.phase
    }

    /// Height of the surface at `(x, z)` at the given tick.
    pub fn height(&self, x: f32, z: f32, tick: u32) -> f32 {
        let t = Self::time(tick);
        let turn = self.turn(tick);
        let mut h = 0.0;
        for w in &self.waves[..self.wave_count] {
            h += w.shape(Self::argument(w, x, z, t), w.amplitude_at(turn)).0;
        }
        h
    }

    /// Height, slope and vertical speed of the surface at `(x, z)`.
    pub fn sample(&self, x: f32, z: f32, tick: u32) -> WaterSample {
        let t = Self::time(tick);
        let turn = self.turn(tick);
        let mut s = WaterSample::default();
        for w in &self.waves[..self.wave_count] {
            let (h, dh) = w.shape(Self::argument(w, x, z, t), w.amplitude_at(turn));
            s.height += h;
            s.dhdx += dh * w.k * w.dir_x;
            s.dhdz += dh * w.k * w.dir_z;
            s.dhdt -= dh * w.omega;
        }
        s
    }

    /// Unit surface normal at `(x, z)` at the given tick.
    pub fn normal(&self, x: f32, z: f32, tick: u32) -> Vec3 {
        self.sample(x, z, tick).normal()
    }

    pub fn waves(&self) -> &[Wave] {
        &self.waves[..self.wave_count]
    }

    /// Flat array for shaders: `[dir_x, dir_z, k, amplitude, omega, phase,
    /// sharpness, amplitude_to]` per wave, `MAX_WAVES` entries (unused ones
    /// are zero). The amplitude now is `amplitude` blended toward
    /// `amplitude_to` by [`Surface::turn`].
    pub fn wave_params(&self) -> [f32; MAX_WAVES * WAVE_FIELDS] {
        let mut out = [0.0; MAX_WAVES * WAVE_FIELDS];
        for (i, w) in self.waves[..self.wave_count].iter().enumerate() {
            out[i * WAVE_FIELDS..(i + 1) * WAVE_FIELDS].copy_from_slice(&[
                w.dir_x,
                w.dir_z,
                w.k,
                w.amplitude,
                w.omega,
                w.phase,
                f32::from(w.sharpness),
                w.amplitude_to,
            ]);
        }
        out
    }
}
