use crate::input::{Input, buttons};
use crate::math::{Vec3, atan2, clamp, cos, sin, wrap_angle};
use crate::quant;
use crate::surface::Surface;
use crate::{DT, MAX_RIDERS};

/// Physics tuning for the generic arcade rider: it carves, jumps and rides
/// swells.
pub mod tuning {
    pub const GRAVITY: f32 = 14.0;
    pub const MAX_SPEED: f32 = 22.0;
    pub const MAX_REVERSE: f32 = 5.0;
    pub const ACCEL: f32 = 14.0;
    pub const BRAKE: f32 = 20.0;
    pub const REVERSE_ACCEL: f32 = 6.0;
    pub const DRAG: f32 = 0.12;
    pub const GRIP: f32 = 6.0;
    pub const TURN_RATE: f32 = 2.4;
    pub const TURN_RESPONSE: f32 = 10.0;
    pub const AIR_SPIN_RATE: f32 = 5.0;
    pub const AIR_SPIN_RESPONSE: f32 = 6.0;
    pub const JUMP_SPEED: f32 = 6.0;
    /// How much the surface slope pushes you downhill.
    pub const SLOPE_PUSH: f32 = 1.0;
    /// Vertical speed margin before the surface "drops away" and you launch.
    pub const LAUNCH_MARGIN: f32 = 0.3;
    /// Cap on surface-following vertical speed (sanity bound).
    pub const MAX_FOLLOW_SPEED: f32 = 8.0;
    pub const ARENA_HALF: f32 = 120.0;
    pub const WALL_BOUNCE: f32 = 0.4;
    pub const RIDER_RADIUS: f32 = 0.9;
    pub const RIDER_HALF_HEIGHT: f32 = 0.8;
    pub const BUMP_RESTITUTION: f32 = 0.35;
}

use tuning::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rider {
    pub pos: Vec3,
    pub vel: Vec3,
    /// Heading in radians, `[0, TAU)`. Yaw 0 faces +Z.
    pub yaw: f32,
    pub yaw_rate: f32,
    pub grounded: bool,
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
            yaw_rate: 0.0,
            grounded: true,
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
        self.yaw_rate = quant::yaw_rate_from_wire(quant::yaw_rate_to_wire(self.yaw_rate));
    }

    /// Pitch and roll for rendering only (not part of physics).
    pub fn visual_tilt(&self, surface: &Surface, tick: u32) -> (f32, f32) {
        if self.grounded {
            let n = surface.normal(self.pos.x, self.pos.z, tick);
            let pitch = -atan2(n.dot(self.forward()), n.y);
            let roll = atan2(n.dot(self.right()), n.y);
            (pitch, roll)
        } else {
            let horizontal = self.speed().max(0.1);
            (clamp(-atan2(self.vel.y, horizontal) * 0.6, -0.6, 0.6), 0.0)
        }
    }

    fn integrate(&mut self, input: Input, surface: &Surface, tick: u32) {
        let steer = input.steer_f();
        let throttle = input.throttle_f();
        let jump_pressed = input.pressed(buttons::JUMP) && !self.last_input.pressed(buttons::JUMP);
        let next_tick = tick.wrapping_add(1);

        if self.grounded {
            let forward = self.forward();
            let right = self.right();
            let speed_fwd = self.vel.horizontal().dot(forward);

            // Steering: stronger with speed, reversed when going backwards.
            let speed_factor = clamp(speed_fwd.abs() / 6.0, 0.2, 1.0);
            let dir = if speed_fwd < -0.5 { -1.0 } else { 1.0 };
            let target_rate = -steer * TURN_RATE * speed_factor * dir;
            self.yaw_rate += (target_rate - self.yaw_rate) * clamp(TURN_RESPONSE * DT, 0.0, 1.0);

            // Throttle, brake, reverse.
            let accel = if throttle >= 0.0 {
                throttle * ACCEL * (1.0 - clamp(speed_fwd / MAX_SPEED, 0.0, 1.0))
            } else if speed_fwd > 0.5 {
                throttle * BRAKE
            } else {
                throttle * REVERSE_ACCEL * (1.0 - clamp(-speed_fwd / MAX_REVERSE, 0.0, 1.0))
            };
            self.vel += forward * (accel * DT);

            // Grip: bleed sideways velocity so the rider carves instead of drifting forever.
            let lateral = self.vel.dot(right);
            self.vel -= right * (lateral * clamp(GRIP * DT, 0.0, 1.0));

            // Slopes push you downhill.
            let n = surface.normal(self.pos.x, self.pos.z, tick);
            self.vel.x += n.x * GRAVITY * SLOPE_PUSH * DT;
            self.vel.z += n.z * GRAVITY * SLOPE_PUSH * DT;

            // Drag.
            self.vel.x -= self.vel.x * DRAG * DT;
            self.vel.z -= self.vel.z * DRAG * DT;

            self.yaw = wrap_angle(self.yaw + self.yaw_rate * DT);
            let h_here = surface.height(self.pos.x, self.pos.z, tick);
            self.pos.x += self.vel.x * DT;
            self.pos.z += self.vel.z * DT;

            // Follow the surface, unless it drops away faster than gravity
            // pulls us down: then we launch (riding a swell crest at speed).
            // The follow speed is how fast the *surface* moves under us,
            // never the gap between us and it (snapping must not launch).
            let h_next = surface.height(self.pos.x, self.pos.z, next_tick);
            let vy_follow = clamp((h_next - h_here) / DT, -MAX_FOLLOW_SPEED, MAX_FOLLOW_SPEED);
            let vy_ballistic = self.vel.y - GRAVITY * DT;
            if jump_pressed {
                self.vel.y = vy_follow.max(0.0) + JUMP_SPEED;
                self.pos.y += self.vel.y * DT;
                self.grounded = false;
            } else if vy_follow < vy_ballistic - LAUNCH_MARGIN {
                self.vel.y = vy_ballistic;
                self.pos.y += self.vel.y * DT;
                self.grounded = false;
            } else {
                self.vel.y = vy_follow;
                self.pos.y = h_next;
            }
        } else {
            // In the air: the stick spins you (this is where shifties live).
            let target_rate = -steer * AIR_SPIN_RATE;
            self.yaw_rate +=
                (target_rate - self.yaw_rate) * clamp(AIR_SPIN_RESPONSE * DT, 0.0, 1.0);
            self.yaw = wrap_angle(self.yaw + self.yaw_rate * DT);
            self.vel.y -= GRAVITY * DT;
            self.pos += self.vel * DT;

            let h = surface.height(self.pos.x, self.pos.z, next_tick);
            if self.pos.y <= h {
                self.pos.y = h;
                let n = surface.normal(self.pos.x, self.pos.z, next_tick);
                let vn = self.vel.dot(n);
                if vn < 0.0 {
                    self.vel -= n * vn;
                }
                self.grounded = true;
            }
        }

        self.last_input = input;
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
        r.pos.y = self.surface.height(r.pos.x, r.pos.z, self.tick);
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
                r.integrate(input, &self.surface, tick);
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
                r.pos.x, r.pos.y, r.pos.z, r.vel.x, r.vel.y, r.vel.z, r.yaw, r.yaw_rate,
            ] {
                eat(v.to_bits());
            }
            eat(u32::from(r.grounded));
            eat(u32::from_le_bytes([
                r.last_input.steer as u8,
                r.last_input.throttle as u8,
                r.last_input.buttons,
                0,
            ]));
        }
        h
    }
}
