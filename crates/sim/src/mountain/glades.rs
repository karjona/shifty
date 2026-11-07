//! The glades: a ~2 km run from the ridge at the top of the second chairlift
//! down to the lodge by the lake. A flat start on the ridge, a short steep
//! couloir between rocks to drop in, a wide bowl with wind lips and a spine,
//! pine glades (tight turns, trees close, rollers, side hits, a log and a
//! rock lip), a winding creek gully, a step-down, and a last pitch to the
//! finish by the lake.

use super::{
    Feature, LipKind, Piece, Run, Valley, Width, pine, rock, slope, tower, turn, valley, w,
};
use crate::course::{Course, Line, Sport};
use crate::surface::SeaState;

const fn lip(s: f32, offset: f32, half_width: f32, height: f32, kind: LipKind) -> Feature {
    let (ramp, fall) = match kind {
        LipKind::Wind => (height * 5.0, height * 4.5),
        LipKind::Rock => (height * 3.6, height * 3.4),
        LipKind::Log => (height * 3.2, height * 3.2),
    };
    Feature::Lip {
        s,
        offset,
        half_width,
        height,
        ramp,
        fall,
        kind,
    }
}

const PIECES: &[Piece] = &[
    // The ridge, the start hut and the lift's top station.
    Piece::Straight(62.0),
    // The couloir: a dog-leg between the rocks.
    turn(110.0, -14.0),
    Piece::Straight(40.0),
    turn(100.0, 18.0),
    // The bowl: long sweeping turns.
    Piece::Straight(40.0),
    turn(240.0, 22.0),
    Piece::Straight(60.0),
    turn(220.0, -38.0),
    Piece::Straight(50.0),
    turn(200.0, 18.0),
    Piece::Straight(30.0),
    // The glades: tight turns through the pines.
    turn(75.0, 32.0),
    turn(65.0, -55.0),
    Piece::Straight(35.0),
    turn(70.0, 48.0),
    turn(80.0, -30.0),
    Piece::Straight(45.0),
    turn(65.0, -30.0),
    turn(70.0, 52.0),
    Piece::Straight(50.0),
    turn(75.0, -40.0),
    turn(90.0, 25.0),
    Piece::Straight(40.0),
    // The creek gully, winding.
    turn(80.0, 30.0),
    turn(70.0, -50.0),
    turn(70.0, 45.0),
    turn(75.0, -35.0),
    Piece::Straight(30.0),
    turn(90.0, 22.0),
    // The bench to the step-down, and its landing.
    Piece::Straight(70.0),
    Piece::Straight(60.0),
    // The last pitch, the finish and the lake.
    turn(150.0, -20.0),
    Piece::Straight(80.0),
    turn(160.0, 10.0),
    Piece::Straight(300.0),
];

const WIDTH: &[Width] = &[
    w(0.0, 12.0, 6.0),
    w(56.0, 12.0, 6.0),
    w(70.0, 7.5, 7.5),
    w(140.0, 7.5, 7.5),
    w(190.0, 26.0, 8.0),
    w(560.0, 26.0, 8.0),
    w(625.0, 12.0, 8.0),
    w(1190.0, 11.0, 8.0),
    w(1220.0, 8.0, 9.0),
    w(1470.0, 8.0, 9.0),
    w(1500.0, 14.0, 8.0),
    w(1620.0, 18.0, 10.0),
    w(1900.0, 22.0, 10.0),
    w(2000.0, 30.0, 10.0),
];

const SLOPE: &[super::Slope] = &[
    // Behind the start the ridge falls away the other side.
    slope(0.0, -0.15),
    slope(16.0, 0.02),
    slope(56.0, 0.04),
    // The drop into the couloir.
    slope(64.0, 0.72),
    slope(120.0, 0.7),
    slope(140.0, 0.45),
    slope(175.0, 0.36),
    slope(330.0, 0.38),
    slope(350.0, 0.32),
    slope(560.0, 0.34),
    // A bench out of the bowl, then the glades.
    slope(595.0, 0.16),
    slope(630.0, 0.18),
    slope(665.0, 0.27),
    slope(1180.0, 0.28),
    slope(1210.0, 0.33),
    slope(1470.0, 0.3),
    // The step-down: a bench, its knuckle, the landing.
    slope(1495.0, 0.18),
    slope(1534.0, 0.16),
    slope(1539.0, 0.9),
    slope(1547.0, 0.9),
    slope(1551.0, 0.5),
    slope(1580.0, 0.5),
    slope(1600.0, 0.32),
    slope(1880.0, 0.33),
    slope(1915.0, 0.14),
    slope(1950.0, 0.04),
    slope(2040.0, -0.12),
];

const VALLEY: &[Valley] = &[
    // A col on the ridge, between two peaks.
    valley(0.0, 40.0, 0.5, 50.0),
    valley(40.0, 40.0, 0.5, 50.0),
    // Rock rising close round the couloir.
    valley(90.0, 18.0, 0.6, 20.0),
    valley(150.0, 18.0, 0.6, 20.0),
    // The bowl's walls.
    valley(220.0, 36.0, 0.7, 30.0),
    valley(560.0, 36.0, 0.7, 30.0),
    valley(650.0, 34.0, 0.5, 50.0),
    valley(1180.0, 34.0, 0.5, 50.0),
    // The creek's valley.
    valley(1250.0, 24.0, 0.55, 30.0),
    valley(1470.0, 24.0, 0.55, 30.0),
    valley(1560.0, 45.0, 0.5, 60.0),
    valley(1880.0, 50.0, 0.5, 60.0),
    // A wide floor at the bottom, round the lake.
    valley(1990.0, 90.0, 0.4, 80.0),
];

const FEATURES: &[Feature] = &[
    // The couloir, dug in between its rock walls.
    Feature::Gully {
        s: 85.0,
        length: 45.0,
        depth: 5.5,
        ease: 35.0,
    },
    // The bowl, with wind lips and a spine.
    Feature::Bowl {
        s: 215.0,
        length: 330.0,
        depth: 5.0,
        ease: 40.0,
    },
    lip(262.0, -11.0, 6.0, 1.3, LipKind::Wind),
    lip(318.0, 10.0, 7.0, 1.5, LipKind::Wind),
    Feature::Spine {
        s: 368.0,
        length: 70.0,
        ease: 25.0,
        offset: -2.0,
        half_width: 8.0,
        height: 2.6,
    },
    lip(522.0, 0.0, 9.0, 1.6, LipKind::Wind),
    // The glades: side hits, rollers, a log and a rock lip.
    lip(752.0, -7.0, 2.5, 1.0, LipKind::Rock),
    Feature::Rollers {
        s: 884.0,
        count: 2,
        length: 16.0,
        height: 0.6,
    },
    lip(1030.0, 1.0, 7.0, 0.9, LipKind::Log),
    lip(1140.0, 6.5, 2.5, 1.0, LipKind::Rock),
    lip(1168.0, -3.0, 4.0, 1.1, LipKind::Rock),
    // The creek gully.
    Feature::Gully {
        s: 1245.0,
        length: 200.0,
        depth: 5.5,
        ease: 40.0,
    },
    // The last pitch.
    Feature::Rollers {
        s: 1700.0,
        count: 4,
        length: 18.0,
        height: 0.8,
    },
    lip(1800.0, -10.0, 4.0, 1.3, LipKind::Wind),
    lip(1846.0, 9.0, 4.0, 1.3, LipKind::Wind),
];

const CHECKPOINTS: &[f32] = &[240.0, 480.0, 720.0, 960.0, 1200.0, 1450.0, 1700.0];

const OBSTACLES: &[super::ObstacleDef] = &[
    // Rocks at the couloir's sides.
    rock(96.0, -7.0, 1.3),
    rock(121.0, 6.8, 1.1),
    // The second chairlift, up the side of the bowl.
    tower(250.0, 21.0),
    tower(340.0, 20.0),
    tower(430.0, 21.0),
    tower(520.0, 20.0),
    // Rocks at the bowl's edges.
    rock(292.0, -23.0, 1.6),
    rock(470.0, 24.0, 1.4),
    // The glades: pines close on both sides, at the apex of every turn
    // and out wide on its far side.
    pine(676.0, -3.5),
    pine(700.0, -9.5),
    pine(716.0, 3.5),
    pine(740.0, -9.0),
    pine(772.0, 2.0),
    pine(800.0, -3.0),
    pine(826.0, 9.5),
    pine(852.0, 4.0),
    pine(874.0, -10.5),
    pine(898.0, -8.5),
    pine(920.0, 5.0),
    pine(942.0, 3.5),
    pine(972.0, -2.5),
    pine(996.0, 9.5),
    pine(1014.0, -4.0),
    pine(1052.0, -5.5),
    pine(1066.0, 6.0),
    pine(1090.0, 3.0),
    pine(1112.0, -9.5),
    pine(1150.0, -4.0),
    pine(1196.0, -8.5),
    // Boulders by the creek.
    rock(1300.0, 6.4, 1.0),
    rock(1392.0, 6.0, 1.2),
    // The last pitch.
    rock(1660.0, -16.0, 1.5),
    pine(1760.0, 16.5),
    rock(1880.0, 18.0, 1.3),
];

/// The glades' line down the mountain.
pub static GLADES_RUN: Run = Run::new(
    (0.0, 0.0, 0.0),
    PIECES,
    WIDTH,
    480.0,
    SLOPE,
    VALLEY,
    FEATURES,
    CHECKPOINTS,
    1950.0,
    OBSTACLES,
    0x61_ADE5,
);

/// The glades, raced once from the ridge.
pub static GLADES: Course = Course {
    sport: Sport::Snowboard,
    line: Line::Run(&GLADES_RUN),
    lane_half: 8.0,
    laps: 1,
    start_s: 40.0,
    buoys: &[],
    ramps: &[],
    land: &[],
    sea: SeaState::OPEN_SEA,
};
