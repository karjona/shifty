//! The ground (or water) riders move on, as a pure function of position and
//! tick. Nothing about the surface is ever sent over the network: server and
//! clients build the same surface from the same seed.
//!
//! Today: a flat plane, or gentle ocean swells (a sum of directional sine
//! waves, deep-water dispersion). The client's water shader evaluates the same
//! wave parameters (see [`Surface::wave_params`]), so the water you see is the
//! water the physics rides.

use crate::DT;
use crate::math::{Pcg32, TAU, Vec3, cos, sin, sqrt};

pub const MAX_WAVES: usize = 8;
const GRAVITY_WAVES: f32 = 9.81;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SurfaceKind {
    Flat = 0,
    Swells = 1,
}

impl SurfaceKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Flat),
            1 => Some(Self::Swells),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Wave {
    /// Unit direction of travel in the XZ plane.
    pub dir_x: f32,
    pub dir_z: f32,
    /// Wavenumber `2π / wavelength`.
    pub k: f32,
    pub amplitude: f32,
    /// Angular frequency (rad/s), from deep-water dispersion `ω = √(g·k)`.
    pub omega: f32,
    pub phase: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Surface {
    pub kind: SurfaceKind,
    pub seed: u32,
    waves: [Wave; MAX_WAVES],
    wave_count: usize,
}

impl Surface {
    pub fn new(kind: SurfaceKind, seed: u32) -> Self {
        let mut waves = [Wave::default(); MAX_WAVES];
        let mut wave_count = 0;
        if kind == SurfaceKind::Swells {
            let mut rng = Pcg32::new(u64::from(seed) ^ 0x5157_E115);
            // A dominant swell direction with spread, longer waves first.
            let main_dir = rng.range(0.0, TAU);
            wave_count = 5;
            for (i, w) in waves.iter_mut().take(wave_count).enumerate() {
                let spread = rng.range(-0.6, 0.6);
                let angle = main_dir + spread;
                let wavelength = rng.range(26.0, 48.0) / (1.0 + i as f32 * 0.45);
                let k = TAU / wavelength;
                // Keep steepness (amplitude * k) low so that even all waves
                // stacked stay a rideable slope (< ~0.3): gentle swells.
                let amplitude = rng.range(0.035, 0.06) / k;
                *w = Wave {
                    dir_x: cos(angle),
                    dir_z: sin(angle),
                    k,
                    amplitude: amplitude.min(0.55),
                    omega: sqrt(GRAVITY_WAVES * k),
                    phase: rng.range(0.0, TAU),
                };
            }
        }
        Self {
            kind,
            seed,
            waves,
            wave_count,
        }
    }

    pub fn flat() -> Self {
        Self::new(SurfaceKind::Flat, 0)
    }

    fn time(tick: u32) -> f32 {
        tick as f32 * DT
    }

    /// Height of the surface at `(x, z)` at the given tick.
    pub fn height(&self, x: f32, z: f32, tick: u32) -> f32 {
        let t = Self::time(tick);
        let mut h = 0.0;
        for w in &self.waves[..self.wave_count] {
            h += w.amplitude * sin(w.k * (w.dir_x * x + w.dir_z * z) - w.omega * t + w.phase);
        }
        h
    }

    /// Unit surface normal at `(x, z)` at the given tick.
    pub fn normal(&self, x: f32, z: f32, tick: u32) -> Vec3 {
        let t = Self::time(tick);
        let mut dhdx = 0.0;
        let mut dhdz = 0.0;
        for w in &self.waves[..self.wave_count] {
            let c =
                w.amplitude * w.k * cos(w.k * (w.dir_x * x + w.dir_z * z) - w.omega * t + w.phase);
            dhdx += c * w.dir_x;
            dhdz += c * w.dir_z;
        }
        Vec3::new(-dhdx, 1.0, -dhdz).normalize_or(Vec3::UP)
    }

    pub fn waves(&self) -> &[Wave] {
        &self.waves[..self.wave_count]
    }

    /// Flat array for shaders: `[dir_x, dir_z, k, amplitude, omega, phase]`
    /// per wave, `MAX_WAVES` entries (unused ones are zero).
    pub fn wave_params(&self) -> [f32; MAX_WAVES * 6] {
        let mut out = [0.0; MAX_WAVES * 6];
        for (i, w) in self.waves[..self.wave_count].iter().enumerate() {
            out[i * 6..i * 6 + 6].copy_from_slice(&[
                w.dir_x,
                w.dir_z,
                w.k,
                w.amplitude,
                w.omega,
                w.phase,
            ]);
        }
        out
    }
}
