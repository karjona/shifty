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
//! Sheltered water (a harbour behind its mole, the lee of a headland) takes
//! less of the swell: the height is scaled down near each shelter, smoothly,
//! as a pure function of position.
//!
//! The client's water shader evaluates the same wave parameters with the
//! same formula (see [`Surface::wave_params`]), so the water you see is the
//! water the physics rides.

use crate::DT;
use crate::math::{Pcg32, TAU, Vec3, cos, sin, sqrt};

pub const MAX_WAVES: usize = 8;
/// Floats per wave in [`Surface::wave_params`].
pub const WAVE_FIELDS: usize = 8;
/// Shelters a sea can have, and floats per shelter in [`Surface::wave_params`]
/// (after the waves).
pub const MAX_SHELTERS: usize = 4;
pub const SHELTER_FIELDS: usize = 8;
/// Length of [`Surface::wave_params`].
pub const PARAMS_LEN: usize = MAX_WAVES * WAVE_FIELDS + MAX_SHELTERS * SHELTER_FIELDS;
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
    /// Sheltered water (at most [`MAX_SHELTERS`]).
    pub shelter: &'static [Shelter],
}

/// Sheltered water round a point: the swell is `calm` times its height
/// within `inner` metres of it, and comes back to full by `outer`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shelter {
    pub x: f32,
    pub z: f32,
    pub inner: f32,
    pub outer: f32,
    pub calm: f32,
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
        shelter: &[],
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Wave {
    /// Unit direction of travel in the XZ plane.
    pub dir_x: f32,
    pub dir_z: f32,
    /// Wavenumber `2π / wavelength`.
    pub k: f32,
    /// Half the crest-to-trough height.
    pub amplitude: f32,
    /// Angular frequency (rad/s), from deep-water dispersion `ω = √(g·k)`.
    pub omega: f32,
    pub phase: f32,
    /// Integer power the wave shape is raised to: 1 (sine), 2 or 3. Any
    /// other value is treated as 1.
    pub sharpness: u8,
}

impl Wave {
    /// Height and `d height / d argument` for argument `a`.
    ///
    /// With `u = (1 + sin a) / 2`, the shape is `2A (uᵖ - mean(uᵖ))`: zero
    /// mean, crest-to-trough `2A`, crests sharper as `p` grows.
    fn shape(&self, a: f32) -> (f32, f32) {
        let s = sin(a);
        let c = cos(a);
        let u = (1.0 + s) * 0.5;
        let amp = self.amplitude;
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

#[derive(Clone, Debug, PartialEq)]
pub struct Surface {
    pub kind: SurfaceKind,
    pub seed: u32,
    waves: [Wave; MAX_WAVES],
    wave_count: usize,
    shelter: &'static [Shelter],
}

impl Surface {
    pub fn new(kind: SurfaceKind, seed: u32) -> Self {
        Self::with_sea(kind, seed, &SeaState::OPEN_SEA)
    }

    pub fn with_sea(kind: SurfaceKind, seed: u32, sea: &SeaState) -> Self {
        let mut waves = [Wave::default(); MAX_WAVES];
        let mut wave_count = 0;
        if let Some((steep, height)) = kind.scale() {
            let mut rng = Pcg32::new(u64::from(seed) ^ 0x5157_E115);
            let picked = rng.range(0.0, TAU);
            let main_dir = sea.direction.unwrap_or(picked);
            wave_count = sea.waves.min(MAX_WAVES);
            for (i, w) in waves.iter_mut().take(wave_count).enumerate() {
                let angle = main_dir + rng.range(-sea.spread, sea.spread);
                let wavelength = rng.range(sea.wavelength.0, sea.wavelength.1)
                    / (1.0 + i as f32 * sea.shortening);
                let k = TAU / wavelength;
                let amplitude = steep * rng.range(sea.steepness.0, sea.steepness.1) / k;
                *w = Wave {
                    // Yaw convention: direction (sin, cos).
                    dir_x: sin(angle),
                    dir_z: cos(angle),
                    k,
                    amplitude: amplitude.min(sea.max_amplitude * height),
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
            waves,
            wave_count,
            shelter: &sea.shelter[..sea.shelter.len().min(MAX_SHELTERS)],
        }
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

    /// How much of the swell reaches `(x, z)` (0-1), and how fast that
    /// changes along x and z.
    pub fn exposure(&self, x: f32, z: f32) -> (f32, f32, f32) {
        let (mut f, mut gx, mut gz) = (1.0, 0.0, 0.0);
        for sh in self.shelter {
            let dx = x - sh.x;
            let dz = z - sh.z;
            let d = sqrt(dx * dx + dz * dz);
            if d >= sh.outer {
                continue;
            }
            let span = sh.outer - sh.inner;
            let (k, dk) = if d <= sh.inner {
                (0.0, 0.0)
            } else {
                let t = (d - sh.inner) / span;
                (t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / span)
            };
            let fi = sh.calm + (1.0 - sh.calm) * k;
            let dfi = (1.0 - sh.calm) * dk;
            let (ux, uz) = if d > 1e-4 {
                (dx / d, dz / d)
            } else {
                (0.0, 0.0)
            };
            gx = gx * fi + f * dfi * ux;
            gz = gz * fi + f * dfi * uz;
            f *= fi;
        }
        (f, gx, gz)
    }

    /// Height of the surface at `(x, z)` at the given tick.
    pub fn height(&self, x: f32, z: f32, tick: u32) -> f32 {
        let t = Self::time(tick);
        let mut h = 0.0;
        for w in &self.waves[..self.wave_count] {
            h += w.shape(Self::argument(w, x, z, t)).0;
        }
        if self.shelter.is_empty() {
            h
        } else {
            h * self.exposure(x, z).0
        }
    }

    /// Height, slope and vertical speed of the surface at `(x, z)`.
    pub fn sample(&self, x: f32, z: f32, tick: u32) -> WaterSample {
        let t = Self::time(tick);
        let mut s = WaterSample::default();
        for w in &self.waves[..self.wave_count] {
            let (h, dh) = w.shape(Self::argument(w, x, z, t));
            s.height += h;
            s.dhdx += dh * w.k * w.dir_x;
            s.dhdz += dh * w.k * w.dir_z;
            s.dhdt -= dh * w.omega;
        }
        if !self.shelter.is_empty() {
            let (f, gx, gz) = self.exposure(x, z);
            s.dhdx = s.dhdx * f + s.height * gx;
            s.dhdz = s.dhdz * f + s.height * gz;
            s.dhdt *= f;
            s.height *= f;
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
    /// sharpness, 0]` per wave, `MAX_WAVES` entries (unused ones are zero),
    /// then `[x, z, inner, outer, calm, 0, 0, 0]` per shelter, `MAX_SHELTERS`
    /// entries (unused ones have `calm` 1: no shelter).
    pub fn wave_params(&self) -> [f32; PARAMS_LEN] {
        let mut out = [0.0; PARAMS_LEN];
        for i in 0..MAX_SHELTERS {
            let o = MAX_WAVES * WAVE_FIELDS + i * SHELTER_FIELDS;
            out[o + 4] = 1.0;
            if let Some(sh) = self.shelter.get(i) {
                out[o..o + 5].copy_from_slice(&[sh.x, sh.z, sh.inner, sh.outer, sh.calm]);
            }
        }
        for (i, w) in self.waves[..self.wave_count].iter().enumerate() {
            out[i * WAVE_FIELDS..(i + 1) * WAVE_FIELDS].copy_from_slice(&[
                w.dir_x,
                w.dir_z,
                w.k,
                w.amplitude,
                w.omega,
                w.phase,
                f32::from(w.sharpness),
                0.0,
            ]);
        }
        out
    }
}
