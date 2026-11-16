//! Riders bump as capsules along their headings: the hull of a jetski, a
//! snowboard ridden along its length.

use sim::course::Sport;
use sim::math::{PI, Vec3};
use sim::{CourseId, Input, Inputs, MAX_RIDERS, Rider, SurfaceKind, World};

/// A world on flat water (or the snow) with riders riding free at `(x, z)`,
/// heading `yaw` at `speed`.
fn world(course: CourseId, riders: &[(f32, f32, f32, f32)]) -> World {
    let mut w = World::on_course(course, SurfaceKind::Flat, 1);
    for slot in 0..riders.len() {
        w.spawn(slot);
    }
    w.ride_free();
    for (slot, &(x, z, yaw, speed)) in riders.iter().enumerate() {
        let mut r = w.riders[slot].unwrap();
        r.pos.x = x;
        r.pos.z = z;
        r.yaw = yaw;
        r.vel = r.forward() * speed;
        w.riders[slot] = Some(r);
    }
    w
}

fn step(w: &mut World, ticks: usize) {
    let mut inputs: Inputs = [None; MAX_RIDERS];
    for (slot, r) in w.riders.iter().enumerate() {
        if r.is_some() {
            inputs[slot] = Some(Input::from_analog(0.0, 0.0, 0.0, 0));
        }
    }
    for _ in 0..ticks {
        w.step(&inputs);
    }
}

/// How far apart two riders' bodies are (negative: overlapping).
fn gap(sport: Sport, a: &Rider, b: &Rider) -> f32 {
    let body = sport.body();
    let (p, q) = body
        .segment(a.pos.x, a.pos.z, a.yaw)
        .closest(&body.segment(b.pos.x, b.pos.z, b.yaw));
    (q.0 - p.0).hypot(q.1 - p.1) - 2.0 * body.radius
}

/// On the bay's first straight, heading +x.
const EAST: f32 = PI * 0.5;
const Z: f32 = -42.0;

#[test]
fn nose_to_tail_they_stop_at_the_hull() {
    // The one behind rides into the tail of the one ahead.
    let mut w = world(
        CourseId::Oval,
        &[(0.0, Z, EAST, 20.0), (2.0, Z, EAST, 10.0)],
    );
    step(&mut w, 1);
    let (a, b) = (w.riders[0].unwrap(), w.riders[1].unwrap());
    assert!(
        gap(Sport::Jetski, &a, &b) > -0.05,
        "{}",
        gap(Sport::Jetski, &a, &b)
    );
    // A jetski's length apart, along the line they ride.
    assert!(b.pos.x - a.pos.x > 3.1, "{}", b.pos.x - a.pos.x);
    assert!((b.pos.z - a.pos.z).abs() < 0.05);
    // The one behind gave the one ahead some of its speed.
    assert!(
        a.speed() < 19.0 && b.speed() > 11.0,
        "{} {}",
        a.speed(),
        b.speed()
    );
}

#[test]
fn side_by_side_they_ride_closer_than_their_length() {
    // A metre and a quarter apart, beam to beam: not touching.
    let mut w = world(
        CourseId::Oval,
        &[(0.0, Z, EAST, 20.0), (0.0, Z + 1.25, EAST, 20.0)],
    );
    step(&mut w, 1);
    let (a, b) = (w.riders[0].unwrap(), w.riders[1].unwrap());
    assert!(
        (b.pos.z - a.pos.z - 1.25).abs() < 0.02,
        "{}",
        b.pos.z - a.pos.z
    );
    // Closer than that, they push each other apart sideways.
    let mut w = world(
        CourseId::Oval,
        &[(0.0, Z, EAST, 20.0), (0.3, Z + 0.8, EAST, 20.0)],
    );
    step(&mut w, 1);
    let (a, b) = (w.riders[0].unwrap(), w.riders[1].unwrap());
    assert!(gap(Sport::Jetski, &a, &b) > -0.05);
    assert!(b.pos.z - a.pos.z > 1.15, "{}", b.pos.z - a.pos.z);
    assert!(
        (b.pos.x - a.pos.x - 0.3).abs() < 0.05,
        "{}",
        b.pos.x - a.pos.x
    );
}

#[test]
fn head_on_they_bounce_back() {
    let mut w = world(
        CourseId::Oval,
        &[(0.0, Z, EAST, 15.0), (3.4, Z, EAST + PI, 15.0)],
    );
    step(&mut w, 2);
    let (a, b) = (w.riders[0].unwrap(), w.riders[1].unwrap());
    assert!(gap(Sport::Jetski, &a, &b) > -0.05);
    assert!(a.vel.x < 0.0 && b.vel.x > 0.0, "{:?} {:?}", a.vel, b.vel);
}

#[test]
fn exactly_on_top_of_each_other_they_come_apart() {
    let mut w = world(CourseId::Oval, &[(0.0, Z, EAST, 0.0), (0.0, Z, EAST, 0.0)]);
    step(&mut w, 1);
    let (a, b) = (w.riders[0].unwrap(), w.riders[1].unwrap());
    assert!(gap(Sport::Jetski, &a, &b) > -0.05);
    assert!(a.pos.x.is_finite() && b.pos.x.is_finite());
    // Side by side: the second out to the first one's right.
    assert!((a.pos.x - b.pos.x).abs() < 0.05);
    assert!((b.pos - a.pos).dot(a.right()) > 1.15);
}

#[test]
fn boards_bump_along_their_length() {
    let w = World::on_course(CourseId::Mountain, SurfaceKind::Flat, 1);
    let start = w.course().centerline(w.course().start_s + 40.0);
    let (fx, fz) = start.forward();
    let (rx, rz) = start.right();
    let at = |along: f32, across: f32| {
        (
            start.x + fx * along + rx * across,
            start.z + fz * along + rz * across,
        )
    };
    let (x0, z0) = at(0.0, 0.0);
    let (x1, z1) = at(1.0, 0.0);
    let mut w = world(
        CourseId::Mountain,
        &[(x0, z0, start.yaw, 15.0), (x1, z1, start.yaw, 10.0)],
    );
    step(&mut w, 1);
    let (a, b) = (w.riders[0].unwrap(), w.riders[1].unwrap());
    assert!(gap(Sport::Snowboard, &a, &b) > -0.05);
    let d = (b.pos - a.pos).horizontal();
    assert!(d.dot(Vec3::new(fx, 0.0, fz)) > 1.5, "{d:?}");
}

#[test]
fn a_pile_up_comes_apart_the_same_way_on_every_machine() {
    let riders = [
        (0.0, Z, EAST, 18.0),
        (1.0, Z + 0.4, EAST + 0.3, 16.0),
        (0.5, Z - 0.5, EAST - 0.2, 20.0),
        (2.0, Z, EAST + PI, 5.0),
        (1.5, Z + 0.2, EAST, 12.0),
    ];
    let mut a = world(CourseId::Oval, &riders);
    let mut b = world(CourseId::Oval, &riders);
    for _ in 0..30 {
        step(&mut a, 1);
        step(&mut b, 1);
        assert_eq!(a.state_hash(), b.state_hash());
    }
    for i in 0..riders.len() {
        for j in (i + 1)..riders.len() {
            let (p, q) = (a.riders[i].unwrap(), a.riders[j].unwrap());
            assert!(gap(Sport::Jetski, &p, &q) > -0.1, "{i} {j}");
        }
    }
}
