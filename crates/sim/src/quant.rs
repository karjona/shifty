//! The network grid. Authoritative state always lives exactly on this grid
//! (see `Rider::quantize`), so encoding a snapshot loses nothing.

use crate::math::{TAU, Vec3, clamp, round, wrap_angle};

/// Position: 1/1024 m in an i32 (about ±2,000 km of range).
pub const POS_SCALE: f32 = 1024.0;
/// Velocity: 1/256 m/s in an i16 (±127 m/s).
pub const VEL_SCALE: f32 = 256.0;
pub const VEL_MAX: f32 = 127.0;
/// Angular rates: 1/1024 rad/s in an i16 (±32 rad/s).
pub const RATE_SCALE: f32 = 1024.0;
pub const RATE_MAX: f32 = 31.9;
/// Unwrapped angles (pitch, roll): 1/1024 rad in an i16 (±32 rad, five
/// full turns, enough for any flip).
pub const ANGLE_SCALE: f32 = 1024.0;
pub const ANGLE_MAX: f32 = 31.9;

pub fn pos_to_wire(v: f32) -> i32 {
    round(v * POS_SCALE) as i32
}

pub fn pos_from_wire(v: i32) -> f32 {
    v as f32 / POS_SCALE
}

pub fn pos_roundtrip(v: Vec3) -> Vec3 {
    Vec3::new(
        pos_from_wire(pos_to_wire(v.x)),
        pos_from_wire(pos_to_wire(v.y)),
        pos_from_wire(pos_to_wire(v.z)),
    )
}

pub fn vel_to_wire(v: f32) -> i16 {
    round(clamp(v, -VEL_MAX, VEL_MAX) * VEL_SCALE) as i16
}

pub fn vel_from_wire(v: i16) -> f32 {
    f32::from(v) / VEL_SCALE
}

pub fn vel_roundtrip(v: Vec3) -> Vec3 {
    Vec3::new(
        vel_from_wire(vel_to_wire(v.x)),
        vel_from_wire(vel_to_wire(v.y)),
        vel_from_wire(vel_to_wire(v.z)),
    )
}

pub fn yaw_to_wire(yaw: f32) -> u16 {
    (round(wrap_angle(yaw) / TAU * 65536.0) as u32 & 0xFFFF) as u16
}

pub fn yaw_from_wire(v: u16) -> f32 {
    f32::from(v) * (TAU / 65536.0)
}

pub fn rate_to_wire(v: f32) -> i16 {
    round(clamp(v, -RATE_MAX, RATE_MAX) * RATE_SCALE) as i16
}

pub fn rate_from_wire(v: i16) -> f32 {
    f32::from(v) / RATE_SCALE
}

pub fn rate_roundtrip(v: f32) -> f32 {
    rate_from_wire(rate_to_wire(v))
}

pub fn angle_to_wire(v: f32) -> i16 {
    round(clamp(v, -ANGLE_MAX, ANGLE_MAX) * ANGLE_SCALE) as i16
}

pub fn angle_from_wire(v: i16) -> f32 {
    f32::from(v) / ANGLE_SCALE
}

pub fn angle_roundtrip(v: f32) -> f32 {
    angle_from_wire(angle_to_wire(v))
}
