//! Time trials: one rider, the run recorded to the finish, the results held
//! until a retry, and a retry straight to the countdown.

use protocol::InputPacket;
use protocol::ghost::{Ghost, frames_for};
use protocol::token::JoinClaims;
use race_server::record::RunReport;
use race_server::room::{Room, RoomConfig};
use sim::race::tuning::RESULTS_TICKS;
use sim::{CourseId, Phase, SurfaceKind, TICK_HZ};

fn claims(pid: &str, course: CourseId, season: u8) -> JoinClaims {
    JoinClaims {
        v: 1,
        aud: "test".into(),
        room: "t_trial".into(),
        pid: pid.into(),
        name: pid.into(),
        exp: u64::MAX,
        iat: 0,
        bots: 5,
        humans: 0,
        surface: SurfaceKind::Swells as u8,
        course: course as u8,
        events: vec![course as u8],
        look: protocol::token::b64(&[4, 5, 6]),
        setups: Vec::new(),
        trial: true,
        season,
    }
}

struct Run {
    room: Room,
    now: u64,
    retries: u8,
}

impl Run {
    fn new(course: CourseId, season: u8) -> Self {
        let ana = claims("ana", course, season);
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        room.join(1, &ana, 0, 0).expect("joins");
        Self {
            room,
            now: 0,
            retries: 0,
        }
    }

    /// One tick, the screen ready and riding like a bot (or idle).
    fn tick(&mut self, ride: bool) -> Vec<RunReport> {
        self.now += 16;
        let slot = self.room.slot_of(1).expect("seated");
        let input = if ride {
            sim::bot::bot_input(self.room.world(), slot)
        } else {
            sim::Input::default()
        };
        let packet = InputPacket {
            event_ack: 0,
            last_snapshot_tick: 0,
            client_time: 0,
            ready: 1,
            retry: self.retries,
            first_tick: self.room.tick() + 1,
            inputs: vec![input],
        };
        self.room.handle_inputs(1, &packet, self.now);
        self.room.step(self.now).runs
    }

    fn until(&mut self, ride: bool, done: impl Fn(&Room) -> bool) -> Vec<RunReport> {
        let mut runs = Vec::new();
        for _ in 0..TICK_HZ * 60 * 7 {
            runs.extend(self.tick(ride));
            if done(&self.room) {
                return runs;
            }
        }
        panic!("never got there");
    }

    fn phase(&self) -> Phase {
        self.room.world().race.phase
    }
}

#[test]
fn a_run_to_the_finish_is_recorded_and_the_results_wait_for_a_retry() {
    let mut run = Run::new(CourseId::Mountain, 2);
    // No bots in a time trial, and nobody else gets in.
    assert_eq!(run.room.world().riders.iter().flatten().count(), 1);
    let bea = JoinClaims {
        pid: "bea".into(),
        ..claims("bea", CourseId::Mountain, 2)
    };
    assert!(run.room.join(2, &bea, 0, 0).is_err());

    run.until(false, |r| r.world().race.phase == Phase::Intro);
    let runs = run.until(true, |r| r.world().race.phase == Phase::Results);
    let [report] = &runs[..] else {
        panic!("one run, one report: {runs:?}")
    };
    assert_eq!(
        (report.room.as_str(), report.run, report.pid.as_str()),
        ("t_trial", 1, "ana")
    );
    assert_eq!(
        (report.course, report.season),
        (CourseId::Mountain as u8, 2)
    );
    let bytes = base64_decode(&report.ghost);
    let ghost = Ghost::decode(&bytes).expect("a good ghost");
    assert_eq!(report.time_ms, ghost.finish_ticks * 1000 / TICK_HZ);
    assert_eq!(ghost.frames.len(), frames_for(ghost.finish_ticks));
    assert_eq!(ghost.look, vec![4, 5, 6]);
    assert!(
        ghost.splits.len() > 1,
        "checkpoints and the finish: {:?}",
        ghost.splits
    );
    // The first frame is the grid spot.
    let spot = run.room.world().course().grid_spot(0);
    assert!((ghost.frames[0].pos.x - spot.x).abs() < 0.01);

    // The results stay up...
    for _ in 0..RESULTS_TICKS + 120 {
        run.tick(false);
    }
    assert_eq!(run.phase(), Phase::Results);
    // ...until a retry: straight to the countdown, everyone on the grid.
    run.retries += 1;
    run.tick(false);
    assert_eq!(run.phase(), Phase::Countdown);
    let r = run.room.world().riders[0].unwrap();
    assert!(r.race.racing && !r.race.finished());
    assert!(
        run.room
            .join(1, &claims("ana", CourseId::Mountain, 2), 0, run.now)
            .is_ok()
    );
}

#[test]
fn a_run_given_up_is_not_recorded() {
    let mut run = Run::new(CourseId::Oval, 0);
    run.until(false, |r| r.world().race.phase == Phase::Racing);
    for _ in 0..TICK_HZ * 10 {
        assert!(run.tick(true).is_empty());
    }
    run.retries = run.retries.wrapping_add(1);
    run.tick(true);
    assert_eq!(run.phase(), Phase::Countdown);
    let runs = run.until(true, |r| r.world().race.phase == Phase::Results);
    let [report] = &runs[..] else {
        panic!("only the finished run: {runs:?}")
    };
    assert_eq!(report.run, 2);
    let ghost = Ghost::decode(&base64_decode(&report.ghost)).unwrap();
    // Three laps: two lap lines, then the finish.
    assert_eq!(ghost.splits.len(), 3);
}

fn base64_decode(s: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() {
        let v = alphabet.iter().position(|&a| a == c).expect("base64url") as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
