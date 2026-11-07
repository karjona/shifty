//! Ghosts for the browser: a time trial recording (`protocol::ghost`)
//! unpacked into a flat array of frames ready to draw, and the circuits a
//! time trial can be ridden on.

use protocol::ghost::Ghost;
use serde_json::json;
use sim::course::Sport;
use sim::{CourseId, Input};
use wasm_bindgen::prelude::*;

/// Floats per ghost frame: `[x, y, z, yaw, pitch, roll, grounded, bailing,
/// charge, grab, lean, steer, wobble]`, with charge and wobble 0-1 and the
/// stick -1 to 1, as in the render buffer.
pub const GHOST_STRIDE: usize = 13;

#[wasm_bindgen(js_name = ghostStride)]
pub fn ghost_stride() -> usize {
    GHOST_STRIDE
}

/// A recording's header as JSON (`course`, `season`, `finishTicks`,
/// `frameTicks`, `splits`, `look`), or an empty string if it doesn't decode.
#[wasm_bindgen(js_name = ghostHeader)]
pub fn ghost_header(bytes: &[u8]) -> String {
    Ghost::decode(bytes).map_or_else(
        |_| String::new(),
        |g| {
            json!({
                "course": g.course,
                "season": g.season,
                "finishTicks": g.finish_ticks,
                "frameTicks": protocol::ghost::FRAME_TICKS,
                "splits": g.splits,
                "look": g.look,
            })
            .to_string()
        },
    )
}

/// A recording's frames (see `ghostStride`), empty if it doesn't decode.
#[wasm_bindgen(js_name = ghostFrames)]
pub fn ghost_frames(bytes: &[u8]) -> Vec<f32> {
    let Ok(g) = Ghost::decode(bytes) else {
        return Vec::new();
    };
    let sport = CourseId::from_u8(g.course).map_or(Sport::Jetski, |c| c.course().sport);
    let (charge_full, wobble_full) = match sport {
        Sport::Jetski => (f32::from(sim::jetski::tuning::STUNT_FULL), 1.0),
        Sport::Snowboard => (
            f32::from(sim::snowboard::tuning::CHARGE_TICKS),
            f32::from(sim::snowboard::tuning::WOBBLE_TICKS),
        ),
    };
    let stick = |v: i8| {
        Input {
            steer: v,
            ..Input::default()
        }
        .steer_f()
    };
    let mut out = Vec::with_capacity(g.frames.len() * GHOST_STRIDE);
    for f in &g.frames {
        out.extend_from_slice(&[
            f.pos.x,
            f.pos.y,
            f.pos.z,
            f.yaw,
            f.pitch,
            f.roll,
            f32::from(u8::from(f.grounded)),
            f32::from(u8::from(f.bailing)),
            f32::from(f.charge) / charge_full,
            f32::from(f.grab),
            stick(f.lean),
            stick(f.steer),
            f32::from(f.wobble) / wobble_full,
        ]);
    }
    out
}

/// Every circuit, in id order, as JSON: `[{ "course": 0, "sport":
/// "jetski" | "snow" }, …]`.
#[wasm_bindgen(js_name = circuitsJson)]
pub fn circuits_json() -> String {
    let list: Vec<_> = (0..=u8::MAX)
        .map_while(CourseId::from_u8)
        .map(|c| {
            json!({
                "course": c as u8,
                "sport": match c.course().sport {
                    Sport::Jetski => "jetski",
                    Sport::Snowboard => "snow",
                },
            })
        })
        .collect();
    serde_json::Value::from(list).to_string()
}
