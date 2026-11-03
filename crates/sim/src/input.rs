/// One tick of player intent. Already quantized: the client quantizes analog
/// sticks into this before predicting, so client and server feed the sim the
/// exact same numbers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Input {
    /// -127 = full left, 127 = full right.
    pub steer: i8,
    /// -127 = full brake/reverse, 127 = full throttle.
    pub throttle: i8,
    /// Rider weight, front to back: -127 = lean back (nose up),
    /// 127 = lean forward (nose down).
    pub lean: i8,
    /// Bitfield of [`buttons`].
    pub buttons: u8,
}

pub mod buttons {
    /// In the air: the stick spins (left/right) and flips (front/back).
    pub const TRICK: u8 = 1 << 0;
    /// In the air: the stick barrel-rolls (left/right) and flips.
    pub const ROLL: u8 = 1 << 1;
    /// All bits the sim understands. Anything else is stripped by validation.
    pub const ALL: u8 = TRICK | ROLL;
}

impl Input {
    pub const WIRE_SIZE: usize = 4;

    /// Builds an input from analog values in `[-1, 1]`.
    pub fn from_analog(steer: f32, throttle: f32, lean: f32, buttons: u8) -> Self {
        Self {
            steer: quantize_axis(steer),
            throttle: quantize_axis(throttle),
            lean: quantize_axis(lean),
            buttons: buttons & buttons::ALL,
        }
    }

    /// Clamps out-of-range values. The server runs every received input
    /// through this.
    pub fn sanitized(self) -> Self {
        Self {
            steer: self.steer.max(-127),
            throttle: self.throttle.max(-127),
            lean: self.lean.max(-127),
            buttons: self.buttons & buttons::ALL,
        }
    }

    pub fn steer_f(self) -> f32 {
        f32::from(self.steer.max(-127)) / 127.0
    }

    pub fn throttle_f(self) -> f32 {
        f32::from(self.throttle.max(-127)) / 127.0
    }

    pub fn lean_f(self) -> f32 {
        f32::from(self.lean.max(-127)) / 127.0
    }

    pub fn pressed(self, button: u8) -> bool {
        self.buttons & button != 0
    }
}

fn quantize_axis(v: f32) -> i8 {
    let v = if v.is_nan() {
        0.0
    } else {
        crate::math::clamp(v, -1.0, 1.0)
    };
    crate::math::round(v * 127.0) as i8
}
