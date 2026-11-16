//! Time trial sessions: one rider lapping alone, every lap that ranks
//! recorded for the lobby, a retry straight to the countdown, and a session
//! the room closes when the player stops riding or after an hour.

use protocol::ghost::{Ghost, frames_for};
use protocol::token::{JoinClaims, RaceClaims};
use protocol::{EventBody, InputPacket, ServerMsg, SessionEnd};
use race_server::record::RunReport;
use race_server::room::{
    Room, RoomConfig, TRIAL_IDLE_TICKS, TRIAL_RESULTS_TICKS, TRIAL_SESSION_TICKS,
};
use sim::race::EventKind;
use sim::{CourseId, Input, Phase, Season, SurfaceKind, TICK_HZ, Weather};

fn claims(pid: &str, course: CourseId, season: u8, weather: Weather) -> JoinClaims {
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
        tilt: false,
        races: vec![RaceClaims {
            course: Some(course as u8),
            season: Some(season),
            weather: Some(weather as u8),
            turns: Some(Weather::Storm as u8),
            time: Some(70),
        }],
        seed: 7,
        look: protocol::token::b64(&[4, 5, 6]),
        setups: Vec::new(),
        trial: true,
        rejoin: false,
    }
}

struct Session {
    room: Room,
    now: u64,
    retries: u8,
    /// Reliable events the screen has been sent, by id.
    events: std::collections::BTreeMap<u16, EventBody>,
}

impl Session {
    fn new(course: CourseId, season: u8, weather: Weather) -> Self {
        let ana = claims("ana", course, season, weather);
        let mut room = Room::new(RoomConfig::from_claims(&ana));
        room.join(1, &ana, 0, 0).expect("joins");
        Self {
            room,
            now: 0,
            retries: 0,
            events: std::collections::BTreeMap::new(),
        }
    }

    fn slot(&self) -> usize {
        self.room.slot_of(1).expect("seated")
    }

    /// One tick, the screen ready and sending `input`.
    fn tick_with(&mut self, input: Input) -> Vec<RunReport> {
        self.now += 16;
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
        let out = self.room.step(self.now);
        for (_, bytes) in &out.packets {
            if let Ok(ServerMsg::Snapshot(snap)) = ServerMsg::decode(bytes) {
                for e in snap.events {
                    self.events.insert(e.id, e.body);
                }
            }
        }
        out.runs
    }

    /// One tick, riding like a bot (or idle).
    fn tick(&mut self, ride: bool) -> Vec<RunReport> {
        let input = if ride {
            sim::bot::bot_input(self.room.world(), self.slot())
        } else {
            Input::default()
        };
        self.tick_with(input)
    }

    fn until(&mut self, ride: bool, done: impl Fn(&Room) -> bool) -> Vec<RunReport> {
        let mut runs = Vec::new();
        for _ in 0..TICK_HZ * 60 * 10 {
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

    fn laps(&self) -> sim::race::Laps {
        self.room.world().riders[self.slot()]
            .expect("rider")
            .race
            .laps
    }
}

fn decode(report: &RunReport) -> Ghost {
    Ghost::decode(&base64_decode(&report.ghost)).expect("a good ghost")
}

#[test]
fn every_lap_that_ranks_is_reported_with_its_ghost() {
    let mut s = Session::new(CourseId::Oval, 0, Weather::Clear);
    // The weather picked, held steady.
    let c = s.room.world().conditions;
    assert_eq!(
        (c.season, c.weather, c.turns, c.time),
        (Season::Summer, Weather::Clear, Weather::Clear, 70)
    );
    assert!(s.room.world().trial && !s.room.world().disqualify);
    // No bots in a time trial, and nobody else gets in.
    assert_eq!(s.room.world().riders.iter().flatten().count(), 1);
    assert!(
        s.room
            .join(2, &claims("bea", CourseId::Oval, 0, Weather::Clear), 0, 0)
            .is_err()
    );

    let runs = s.until(true, |r| {
        r.world()
            .riders
            .iter()
            .flatten()
            .any(|r| r.race.laps.done >= 3)
    });
    let laps = s.laps();
    assert_eq!(laps.done, 3);
    // Lap 1 is the session's first best; later ones only when faster.
    assert!(!runs.is_empty() && runs.len() <= 3, "{runs:?}");
    let mut last = u32::MAX;
    for report in &runs {
        assert_eq!(
            (report.room.as_str(), report.pid.as_str()),
            ("t_trial", "ana")
        );
        assert_eq!(
            (
                report.course,
                report.season,
                report.revision,
                report.weather
            ),
            (0, 0, 1, 0)
        );
        assert!(report.time_ms < last, "each report beats the one before");
        last = report.time_ms;
        let ghost = decode(report);
        assert_eq!(report.time_ms, ghost.finish_ticks * 1000 / TICK_HZ);
        assert_eq!(ghost.frames.len(), frames_for(ghost.finish_ticks));
        assert_eq!(ghost.look, vec![4, 5, 6]);
        assert_eq!(ghost.revision, 1);
        let buoys = s.room.world().course().buoys.len();
        assert_eq!(ghost.splits.len(), buoys + 1, "every buoy and the line");
    }
    assert_eq!(runs.last().unwrap().time_ms, laps.best * 1000 / TICK_HZ);
    assert_eq!(
        runs.iter().map(|r| r.run).collect::<Vec<_>>(),
        runs.iter()
            .map(|r| r.run)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>(),
        "each lap reported names itself"
    );
}

#[test]
fn practice_weather_is_timed_and_never_reported() {
    let mut s = Session::new(CourseId::Mountain, 2, Weather::Snow);
    let c = s.room.world().conditions;
    assert_eq!((c.weather, c.turns), (Weather::Snow, Weather::Snow));
    let runs = s.until(true, |r| {
        r.world()
            .riders
            .iter()
            .flatten()
            .any(|r| r.race.laps.done >= 1)
    });
    assert!(runs.is_empty(), "{runs:?}");
    let laps = s.laps();
    assert!(laps.best > 0 && laps.best == laps.last);
}

#[test]
fn a_run_goes_back_to_the_top_and_a_retry_starts_any_lap_over() {
    let mut s = Session::new(CourseId::Mountain, 2, Weather::Clear);
    let runs = s.until(true, |r| {
        r.world().race.phase == Phase::Countdown
            && r.world()
                .riders
                .iter()
                .flatten()
                .any(|r| r.race.laps.done == 1)
    });
    let [report] = &runs[..] else {
        panic!("the run, reported: {runs:?}")
    };
    let ghost = decode(report);
    // The first frame is the grid spot.
    let spot = s.room.world().course().grid_spot(s.slot());
    assert!((ghost.frames[0].pos.x - spot.x).abs() < 0.01);
    assert_eq!(s.laps().done, 1);
    // Back at the top: the next lap's countdown, then the run.
    s.until(true, |r| r.world().race.phase == Phase::Racing);
    for _ in 0..TICK_HZ * 10 {
        s.tick(true);
    }
    // A retry mid-run: straight to the countdown, the lap dropped.
    s.retries += 1;
    s.tick(true);
    assert_eq!(s.phase(), Phase::Countdown);
    let laps = s.laps();
    assert_eq!((laps.start, laps.done), (0, 1));
    // A slower lap is not reported; the session goes on.
    let more = s.until(true, |r| {
        r.world()
            .riders
            .iter()
            .flatten()
            .any(|r| r.race.laps.done >= 2)
    });
    assert!(more.len() <= 1);
    if let [better] = &more[..] {
        assert!(better.time_ms < report.time_ms);
    }
}

/// The session-over events the player's screen was sent.
fn session_over(s: &Session) -> Vec<SessionEnd> {
    s.events
        .values()
        .filter_map(|b| match b {
            EventBody::SessionOver { reason } => Some(*reason),
            _ => None,
        })
        .collect()
}

#[test]
fn a_session_ends_after_three_minutes_without_input() {
    let mut s = Session::new(CourseId::Oval, 0, Weather::Clear);
    s.until(true, |r| r.world().race.phase == Phase::Racing);
    // Riding keeps it going...
    for _ in 0..TICK_HZ * 30 {
        s.tick(true);
    }
    // ...hands off, it ends three minutes later.
    for _ in 0..TRIAL_IDLE_TICKS - 2 {
        s.tick(false);
    }
    assert_eq!(s.phase(), Phase::Racing);
    assert!(session_over(&s).is_empty());
    for _ in 0..3 {
        s.tick(false);
    }
    assert_eq!(s.phase(), Phase::Results);
    assert_eq!(session_over(&s), [SessionEnd::Idle]);
    // Nothing starts it again; the room closes a little later.
    s.retries += 1;
    s.tick(true);
    assert_eq!(s.phase(), Phase::Results);
    for _ in 0..TRIAL_RESULTS_TICKS {
        s.tick(true);
    }
    assert!(s.room.is_over() && s.room.is_done());
}

#[test]
fn a_session_ends_after_an_hour_whatever_the_player_does() {
    let mut s = Session::new(CourseId::Oval, 0, Weather::Clear);
    while s.room.tick() < TRIAL_SESSION_TICKS - 1 {
        s.tick(true);
        assert_ne!(s.phase(), Phase::Results);
    }
    for _ in 0..3 {
        s.tick(true);
    }
    assert_eq!(s.phase(), Phase::Results);
    assert_eq!(session_over(&s), [SessionEnd::Hour]);
    let laps = s.laps();
    assert_eq!(laps.start, 0, "the lap under way is dropped");
    assert!(laps.done > 50, "{laps:?}");
    // Any lap counted is in the sim's own events: none since.
    let w = s.room.world().clone();
    let mut copy = w.clone();
    let events = copy.step(&[None; sim::MAX_RIDERS]);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.kind, EventKind::LapTime { .. }))
    );
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
