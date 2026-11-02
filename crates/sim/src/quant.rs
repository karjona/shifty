//! The network grid. Authoritative state always lives exactly on this grid
//! (see `Rider::quantize`), so encoding a snapshot loses nothing.

use crate::math::{TAU, Vec3, clamp, round, wrap_angle};

/// Position: 1/1024 m in an i32 (about ±2,000 km of range).
pub const POS_SCALE: f32 = 1024.0;
/// Velocity: 1/256 m/s in an i16 (±127 m/s).
pub const VEL_SCALE: f32 = 256.0;
pub const VEL_MAX: f32 = 127.0;
/// Yaw rate: 1/1024 rad/s in an i16 (±32 rad/s).
pub const YAW_RATE_SCALE: f32 = 1024.0;
pub const YAW_RATE_MAX: f32 = 31.9;

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

pub fn yaw_rate_to_wire(v: f32) -> i16 {
    round(clamp(v, -YAW_RATE_MAX, YAW_RATE_MAX) * YAW_RATE_SCALE) as i16
}

pub fn yaw_rate_from_wire(v: i16) -> f32 {
    f32::from(v) / YAW_RATE_SCALE
}
