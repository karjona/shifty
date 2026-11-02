//! Tiny, explicit f32 math.
//!
//! No SIMD math crate: the order of every float
//! operation is written out here, so native (server) and WASM (browser)
//! builds produce bit-identical results. Transcendental functions go through
//! `libm`, never the platform's libm.

use core::ops::{Add, AddAssign, Mul, Neg, Sub, SubAssign};

pub const TAU: f32 = core::f32::consts::TAU;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);
    pub const UP: Self = Self::new(0.0, 1.0, 0.0);

    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, o: Self) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn length(self) -> f32 {
        sqrt(self.dot(self))
    }

    /// Returns `fallback` when the vector is (nearly) zero.
    pub fn normalize_or(self, fallback: Self) -> Self {
        let len = self.length();
        if len > 1e-6 {
            self * (1.0 / len)
        } else {
            fallback
        }
    }

    pub fn horizontal(self) -> Self {
        Self::new(self.x, 0.0, self.z)
    }
}

impl Add for Vec3 {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Self) {
        *self = *self + o;
    }
}

impl Sub for Vec3 {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl SubAssign for Vec3 {
    fn sub_assign(&mut self, o: Self) {
        *self = *self - o;
    }
}

impl Mul<f32> for Vec3 {
    type Output = Self;
    fn mul(self, s: f32) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Neg for Vec3 {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z)
    }
}

pub fn sin(x: f32) -> f32 {
    libm::sinf(x)
}

pub fn cos(x: f32) -> f32 {
    libm::cosf(x)
}

pub fn sqrt(x: f32) -> f32 {
    libm::sqrtf(x)
}

pub fn atan2(y: f32, x: f32) -> f32 {
    libm::atan2f(y, x)
}

pub fn round(x: f32) -> f32 {
    libm::roundf(x)
}

pub fn clamp(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

/// Wraps an angle to `[0, TAU)`.
pub fn wrap_angle(a: f32) -> f32 {
    let r = a - TAU * libm::floorf(a / TAU);
    if r >= TAU { 0.0 } else { r }
}

/// Shortest signed difference `b - a`, in `(-PI, PI]`.
pub fn angle_diff(a: f32, b: f32) -> f32 {
    let d = wrap_angle(b - a);
    if d > core::f32::consts::PI {
        d - TAU
    } else {
        d
    }
}

/// Small deterministic PRNG (PCG32). Used for seeded content (waves, bots),
/// never for anything that differs between server and client.
#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
}

impl Pcg32 {
    pub fn new(seed: u64) -> Self {
        let mut rng = Self { state: 0 };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform float in `[0, 1)` with 24 bits of precision (exact in f32).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next_f32()
    }
}
