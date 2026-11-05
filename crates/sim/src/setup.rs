//! A ride's setup: points spread over four stats. Everyone gets the same
//! budget, so a setup trades one strength for another and never adds up to
//! an advantage. Each point off the middle (3) moves its stat a little:
//!
//! - speed: a little more top speed (jetski: thrust too; snowboard: less drag),
//! - handling: turns and grip,
//! - stability: how crooked or hard a landing can be, how long a wobble lasts,
//! - tricks: how fast spins, flips and rolls turn (more points, never more speed).
//!
//! The lobby checks setups before signing them; the sim sanitizes them again.

/// Points per stat, and the total every setup spends.
pub const STAT_MAX: u8 = 6;
pub const STAT_BUDGET: u8 = 12;

/// Stat change per point away from the middle.
pub mod tuning {
    pub const SPEED_PER_POINT: f32 = 0.006;
    pub const HANDLING_PER_POINT: f32 = 0.04;
    pub const STABILITY_PER_POINT: f32 = 0.08;
    pub const TRICKS_PER_POINT: f32 = 0.06;
}

use tuning::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Setup {
    pub speed: u8,
    pub handling: u8,
    pub stability: u8,
    pub tricks: u8,
}

impl Default for Setup {
    fn default() -> Self {
        Self::BALANCED
    }
}

impl Setup {
    pub const BALANCED: Self = Self {
        speed: 3,
        handling: 3,
        stability: 3,
        tricks: 3,
    };

    pub fn from_bytes(b: [u8; 4]) -> Self {
        Self {
            speed: b[0],
            handling: b[1],
            stability: b[2],
            tricks: b[3],
        }
    }

    pub fn to_bytes(self) -> [u8; 4] {
        [self.speed, self.handling, self.stability, self.tricks]
    }

    pub fn is_valid(self) -> bool {
        let b = self.to_bytes();
        b.iter().all(|&v| v <= STAT_MAX)
            && b.iter().map(|&v| u32::from(v)).sum::<u32>() == u32::from(STAT_BUDGET)
    }

    /// This setup if it is valid, balanced otherwise.
    pub fn sanitized(self) -> Self {
        if self.is_valid() {
            self
        } else {
            Self::BALANCED
        }
    }

    /// The setup for `sport` out of a rider's setups (one per sport, in
    /// sport order), sanitized; balanced if there is none.
    pub fn for_sport(setups: &[[u8; 4]], sport: crate::Sport) -> Self {
        let i = match sport {
            crate::Sport::Jetski => 0,
            crate::Sport::Snowboard => 1,
        };
        setups
            .get(i)
            .map_or(Self::BALANCED, |&b| Self::from_bytes(b).sanitized())
    }

    fn factor(points: u8, per: f32) -> f32 {
        1.0 + (f32::from(points) - 3.0) * per
    }

    /// Scales top speed (and jetski thrust).
    pub fn speed(self) -> f32 {
        Self::factor(self.speed, SPEED_PER_POINT)
    }

    /// Scales air drag on the snow: less drag, higher top speed (twice the
    /// speed factor, since top speed goes with one over the root of drag).
    pub fn glide(self) -> f32 {
        Self::factor(self.speed, -2.0 * SPEED_PER_POINT)
    }

    /// Scales turn rates and grip.
    pub fn handling(self) -> f32 {
        Self::factor(self.handling, HANDLING_PER_POINT)
    }

    /// Scales landing tolerances and how hard a hit can be.
    pub fn stability(self) -> f32 {
        Self::factor(self.stability, STABILITY_PER_POINT)
    }

    /// Scales trick rotation speeds.
    pub fn tricks(self) -> f32 {
        Self::factor(self.tricks, TRICKS_PER_POINT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_setups_that_spend_the_budget_are_valid() {
        assert!(Setup::BALANCED.is_valid());
        assert!(Setup::from_bytes([6, 6, 0, 0]).is_valid());
        assert!(!Setup::from_bytes([6, 6, 6, 0]).is_valid());
        assert!(!Setup::from_bytes([7, 5, 0, 0]).is_valid());
        assert!(!Setup::from_bytes([2, 2, 2, 2]).is_valid());
        assert_eq!(Setup::from_bytes([9, 9, 9, 9]).sanitized(), Setup::BALANCED);
    }

    #[test]
    fn balanced_changes_nothing() {
        let s = Setup::BALANCED;
        for f in [
            s.speed(),
            s.glide(),
            s.handling(),
            s.stability(),
            s.tricks(),
        ] {
            assert_eq!(f, 1.0);
        }
    }
}
