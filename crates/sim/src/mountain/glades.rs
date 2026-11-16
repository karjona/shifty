//! The glades: a ~2 km run from the ridge at the top of the second chairlift
//! down to the lodge by the lake. A flat start on the ridge, a short steep
//! couloir between rock walls to drop in (10 m wide), a bowl whose banks
//! rise, with wind lips and a spine, pine glades (13 m between the trees,
//! tight turns, pines in the run, rollers, side hits, a log and a rock lip),
//! a winding creek gully between rock walls, a step-down, and a last pitch
//! fenced with netting to the finish by the lake.

use super::{
    Edge, EdgeKind, Feature, GateDef, LipKind, Piece, Run, Valley, Width, edge, gate, pine, rock,
    slope, tower, turn, valley, w,
};
use crate::course::{Course, Line, Sport};
use crate::surface::SeaState;
use EdgeKind::{Bank, Netting, Rock, Trees};

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
    w(0.0, 8.0, 6.0),
    w(56.0, 8.0, 6.0),
    w(66.0, 4.75, 2.5),
    w(140.0, 4.75, 2.5),
    w(185.0, 11.5, 8.0),
    w(545.0, 11.5, 8.0),
    w(600.0, 7.0, 6.0),
    w(640.0, 6.5, 5.0),
    w(1190.0, 6.5, 5.0),
    w(1215.0, 5.0, 2.5),
    w(1470.0, 5.0, 2.5),
    w(1500.0, 7.0, 6.0),
    w(1600.0, 8.0, 7.0),
    w(1900.0, 9.0, 8.0),
    w(1960.0, 12.0, 10.0),
    w(2010.0, 16.0, 10.0),
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
        depth: 2.5,
        ease: 40.0,
    },
    lip(262.0, -6.0, 4.0, 1.3, LipKind::Wind),
    lip(318.0, 6.0, 4.0, 1.5, LipKind::Wind),
    Feature::Spine {
        s: 368.0,
        length: 70.0,
        ease: 25.0,
        offset: 0.0,
        half_width: 4.5,
        height: 2.4,
    },
    lip(522.0, 0.0, 7.0, 1.6, LipKind::Wind),
    // The glades: side hits, rollers, a log and a rock lip.
    lip(752.0, -4.0, 2.5, 1.0, LipKind::Rock),
    Feature::Rollers {
        s: 884.0,
        count: 2,
        length: 16.0,
        height: 0.6,
    },
    lip(1030.0, 0.0, 6.5, 0.9, LipKind::Log),
    lip(1140.0, 4.0, 2.5, 1.0, LipKind::Rock),
    lip(1168.0, -3.0, 3.0, 1.1, LipKind::Rock),
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
    lip(1800.0, -5.0, 3.0, 1.3, LipKind::Wind),
    lip(1846.0, 5.0, 3.0, 1.3, LipKind::Wind),
];

const CHECKPOINTS: &[f32] = &[240.0, 480.0, 720.0, 960.0, 1200.0, 1450.0, 1700.0];

const OBSTACLES: &[super::ObstacleDef] = &[
    // The second chairlift, up the side of the bowl.
    tower(250.0, 10.4),
    tower(340.0, 10.4),
    tower(430.0, 10.4),
    tower(520.0, 10.4),
    // Rocks at the bowl's edge.
    rock(292.0, -10.2, 1.2),
    // The glades: pines close on both sides of every turn, and in the
    // middle of the straights.
    pine(676.0, -5.0),
    pine(718.0, 5.0),
    pine(772.0, 1.0),
    pine(798.0, -5.3),
    pine(826.0, 5.0),
    pine(874.0, -5.0),
    pine(922.0, 2.5),
    pine(942.0, 5.0),
    pine(996.0, 5.0),
    pine(1012.0, -5.0),
    pine(1052.0, -2.5),
    pine(1066.0, 3.0),
    pine(1088.0, 5.2),
    pine(1112.0, -5.0),
    pine(1152.0, -4.5),
    // Boulders by the creek.
    rock(1300.0, 3.0, 0.8),
    rock(1392.0, -2.8, 0.9),
    // The last pitch.
    rock(1660.0, -6.5, 1.1),
    pine(1760.0, 7.0),
    rock(1880.0, 7.6, 1.0),
];

const EDGES: &[Edge] = &[
    edge(0.0, Bank, Bank),
    edge(60.0, Rock, Rock),
    edge(150.0, Bank, Bank),
    edge(580.0, Trees, Trees),
    edge(1208.0, Rock, Rock),
    edge(1482.0, Trees, Trees),
    edge(1600.0, Netting, Netting),
];

const GATES: &[GateDef] = &[
    // The bowl: either side of the wind lips and round the spine.
    gate(210.0, -3.0, 8.0),
    gate(295.0, 5.5, 7.0),
    gate(395.0, -7.5, 7.0),
    gate(455.0, -7.5, 7.0),
    gate(618.0, -1.0, 8.0),
    // The glades: on the fast line between the trees.
    gate(700.0, 2.0, 7.0),
    gate(812.0, -1.5, 7.0),
    gate(900.0, 1.5, 7.0),
    gate(990.0, -2.0, 7.0),
    gate(1100.0, 2.0, 7.0),
    // The creek gully.
    gate(1230.0, -1.0, 7.0),
    gate(1335.0, -0.5, 7.0),
    gate(1430.0, 1.0, 7.0),
    gate(1500.0, 0.0, 8.0),
    // The last pitch.
    gate(1640.0, 3.0, 8.0),
    gate(1685.0, -3.0, 8.0),
    gate(1928.0, 1.5, 8.0),
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
    EDGES,
    GATES,
    &[],
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
