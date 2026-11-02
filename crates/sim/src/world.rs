use crate::MAX_RIDERS;
use crate::input::Input;
use crate::jetski;
use crate::math::{Vec3, cos, sin};
use crate::quant;
use crate::surface::Surface;

/// World-level tuning shared by every sport.
pub mod tuning {
    pub const ARENA_HALF: f32 = 120.0;
    pub const WALL_BOUNCE: f32 = 0.4;
    pub const RIDER_RADIUS: f32 = 0.9;
    pub const RIDER_HALF_HEIGHT: f32 = 0.8;
    pub const BUMP_RESTITUTION: f32 = 0.35;
}

use tuning::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rider {
    /// Bottom of the hull, centred.
    pub pos: Vec3,
    pub vel: Vec3,
    /// Heading in radians, `[0, TAU)`. Yaw 0 faces +Z.
    pub yaw: f32,
    /// Nose up positive.
    pub pitch: f32,
    /// Left side up positive (banked right).
    pub roll: f32,
    pub yaw_rate: f32,
    pub pitch_rate: f32,
    pub roll_rate: f32,
    /// Touching the water (or ground) this tick.
    pub grounded: bool,
    /// Ticks spent in the current state (grounded or airborne), saturating.
    pub state_ticks: u16,
    /// The input applied on the last tick. Part of the state: it drives
    /// button edge detection and lets clients extrapolate other riders.
    pub last_input: Input,
}

impl Rider {
    pub fn spawn(slot: usize) -> Self {
        let col = (slot % 4) as f32;
        let row = (slot / 4) as f32;
        let mut r = Self {
            pos: Vec3::new((col - 1.5) * 4.0, 0.0, row * -6.0),
            vel: Vec3::ZERO,
            yaw: 0.0,
            pitch: 0.0,
            roll: 0.0,
            yaw_rate: 0.0,
            pitch_rate: 0.0,
            roll_rate: 0.0,
            grounded: true,
            state_ticks: 0,
            last_input: Input::default(),
        };
        r.quantize();
        r
    }

    pub fn forward(&self) -> Vec3 {
        Vec3::new(sin(self.yaw), 0.0, cos(self.yaw))
    }

    pub fn right(&self) -> Vec3 {
        let f = self.forward();
        Vec3::new(-f.z, 0.0, f.x)
    }

    pub fn speed(&self) -> f32 {
        self.vel.horizontal().length()
    }

    /// Snap all state onto the network grid. The server does this after every
    /// tick, so a snapshot is an exact copy of the authoritative state and
    /// client re-simulation does not drift.
    pub fn quantize(&mut self) {
        self.pos = quant::pos_roundtrip(self.pos);
        self.vel = quant::vel_roundtrip(self.vel);
        self.yaw = quant::yaw_from_wire(quant::yaw_to_wire(self.yaw));
        self.pitch = quant::angle_roundtrip(self.pitch);
        self.roll = quant::angle_roundtrip(self.roll);
        self.yaw_rate = quant::rate_roundtrip(self.yaw_rate);
        self.pitch_rate = quant::rate_roundtrip(self.pitch_rate);
        self.roll_rate = quant::rate_roundtrip(self.roll_rate);
    }

    fn keep_in_arena(&mut self) {
        if self.pos.x.abs() > ARENA_HALF {
            let side = if self.pos.x > 0.0 { 1.0 } else { -1.0 };
            self.pos.x = side * ARENA_HALF;
            if self.vel.x * side > 0.0 {
                self.vel.x = -self.vel.x * WALL_BOUNCE;
            }
        }
        if self.pos.z.abs() > ARENA_HALF {
            let side = if self.pos.z > 0.0 { 1.0 } else { -1.0 };
            self.pos.z = side * ARENA_HALF;
            if self.vel.z * side > 0.0 {
                self.vel.z = -self.vel.z * WALL_BOUNCE;
            }
        }
    }
}

/// The whole simulated world. Pure data + pure functions: no clocks, no I/O,
/// no randomness that is not seeded. The server and the client run this
/// exact code.
#[derive(Clone, Debug, PartialEq)]
pub struct World {
    /// Number of ticks simulated so far. The state stored here is the state
    /// *after* tick `tick` (tick 0 = initial state).
    pub tick: u32,
    pub surface: Surface,
    pub riders: [Option<Rider>; MAX_RIDERS],
}

pub type Inputs = [Option<Input>; MAX_RIDERS];

impl World {
    pub fn new(surface: Surface) -> Self {
        Self {
            tick: 0,
            surface,
            riders: [None; MAX_RIDERS],
        }
    }

    /// Places a rider at its grid spot, standing on the surface.
    pub fn spawn(&mut self, slot: usize) {
        let mut r = Rider::spawn(slot);
        r.pos.y = jetski::rest_height(self.surface.height(r.pos.x, r.pos.z, self.tick));
        r.quantize();
        self.riders[slot] = Some(r);
    }

    pub fn remove(&mut self, slot: usize) {
        self.riders[slot] = None;
    }

    /// Advance one fixed tick. Riders without an input repeat their last one.
    pub fn step(&mut self, inputs: &Inputs) {
        let tick = self.tick;
        for (slot, rider) in self.riders.iter_mut().enumerate() {
            if let Some(r) = rider {
                let input = inputs[slot].map_or(r.last_input, Input::sanitized);
                jetski::integrate(r, input, &self.surface, tick);
            }
        }
        self.resolve_collisions();
        for r in self.riders.iter_mut().flatten() {
            r.keep_in_arena();
            r.quantize();
        }
        self.tick = tick.wrapping_add(1);
    }

    /// Rider-vs-rider bumps: equal-mass spheres in the XZ plane, resolved in
    /// slot order so every machine gets the same result.
    fn resolve_collisions(&mut self) {
        for i in 0..MAX_RIDERS {
            for j in (i + 1)..MAX_RIDERS {
                let (Some(a), Some(b)) = (self.riders[i], self.riders[j]) else {
                    continue;
                };
                if (a.pos.y - b.pos.y).abs() > RIDER_HALF_HEIGHT * 2.0 {
                    continue;
                }
                let d = (b.pos - a.pos).horizontal();
                let dist = d.length();
                let min_dist = RIDER_RADIUS * 2.0;
                if dist >= min_dist {
                    continue;
                }
                // Exactly overlapping: push apart along a fixed axis.
                let n = if dist > 1e-4 {
                    d * (1.0 / dist)
                } else {
                    Vec3::new(1.0, 0.0, 0.0)
                };
                let push = n * ((min_dist - dist) * 0.5);
                let mut a2 = a;
                let mut b2 = b;
                a2.pos -= push;
                b2.pos += push;
                let rel = (b.vel - a.vel).horizontal().dot(n);
                if rel < 0.0 {
                    let impulse = -(1.0 + BUMP_RESTITUTION) * rel * 0.5;
                    a2.vel -= n * impulse;
                    b2.vel += n * impulse;
                }
                self.riders[i] = Some(a2);
                self.riders[j] = Some(b2);
            }
        }
    }

    /// FNV-1a over the exact bits of the state. Used to prove that native and
    /// WASM builds stay bit-identical.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |v: u32| {
            for b in v.to_le_bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        };
        eat(self.tick);
        for (slot, r) in self.riders.iter().enumerate() {
            let Some(r) = r else { continue };
            eat(slot as u32);
            for v in [
                r.pos.x,
                r.pos.y,
                r.pos.z,
                r.vel.x,
                r.vel.y,
                r.vel.z,
                r.yaw,
                r.pitch,
                r.roll,
                r.yaw_rate,
                r.pitch_rate,
                r.roll_rate,
            ] {
                eat(v.to_bits());
            }
            eat(u32::from(r.grounded) | (u32::from(r.state_ticks) << 8));
            eat(u32::from_le_bytes([
                r.last_input.steer as u8,
                r.last_input.throttle as u8,
                r.last_input.lean as u8,
                r.last_input.buttons,
            ]));
        }
        h
    }
}
