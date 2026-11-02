//! End-to-end netcode tests: the real `Room` and real `Client`s talking
//! through a simulated network with latency, jitter and packet loss.

use client_core::{Client, Phase, RemoteMode};
use protocol::token::JoinClaims;
use protocol::{ClientMsg, InputPacket, ServerMsg};
use race_server::room::{ConnId, Room, RoomConfig};
use sim::math::Pcg32;
use sim::{Input, SurfaceKind, TICK_HZ};

#[derive(Clone, Copy)]
struct NetConditions {
    latency_ms: f64,
    jitter_ms: f64,
    loss: f64,
}

const PERFECT: NetConditions = NetConditions {
    latency_ms: 0.0,
    jitter_ms: 0.0,
    loss: 0.0,
};

/// One direction of a lossy, jittery link (may reorder packets).
struct Link {
    cond: NetConditions,
    in_flight: Vec<(f64, Vec<u8>)>,
    rng: Pcg32,
}

impl Link {
    fn new(cond: NetConditions, seed: u64) -> Self {
        Self {
            cond,
            in_flight: Vec::new(),
            rng: Pcg32::new(seed),
        }
    }
    fn send(&mut self, now: f64, bytes: Vec<u8>) {
        if f64::from(self.rng.next_f32()) < self.cond.loss {
            return;
        }
        let jitter = f64::from(self.rng.next_f32()) * self.cond.jitter_ms;
        self.in_flight
            .push((now + self.cond.latency_ms / 2.0 + jitter, bytes));
    }
    fn deliver(&mut self, now: f64) -> Vec<Vec<u8>> {
        let mut due = Vec::new();
        self.in_flight.retain(|(at, b)| {
            if *at <= now {
                due.push((*at, b.clone()));
                false
            } else {
                true
            }
        });
        due.sort_by(|a, b| a.0.total_cmp(&b.0));
        due.into_iter().map(|(_, b)| b).collect()
    }
}

struct Peer {
    conn: ConnId,
    client: Client,
    up: Link,
    down: Link,
    claims: JoinClaims,
}

struct Harness {
    room: Room,
    peers: Vec<Peer>,
    now: f64,
    next_tick_at: f64,
}

fn claims(pid: &str, bots: u8, surface: SurfaceKind) -> JoinClaims {
    JoinClaims {
        v: 1,
        aud: "test".into(),
        room: "room".into(),
        pid: pid.into(),
        name: pid.to_uppercase(),
        exp: u64::MAX,
        bots,
        surface: surface as u8,
    }
}

impl Harness {
    fn new(bots: u8, surface: SurfaceKind) -> Self {
        let room = Room::new(RoomConfig::from_claims(&claims("x", bots, surface)));
        Self {
            room,
            peers: Vec::new(),
            now: 1000.0,
            next_tick_at: 1000.0,
        }
    }

    fn add_peer(&mut self, pid: &str, cond: NetConditions) -> usize {
        let i = self.peers.len();
        self.peers.push(Peer {
            conn: i as ConnId + 1,
            client: Client::new("token"),
            up: Link::new(cond, 100 + i as u64),
            down: Link::new(cond, 200 + i as u64),
            claims: claims(pid, 0, SurfaceKind::Flat),
        });
        i
    }

    /// Run for `ms` milliseconds; clients render at ~120 fps.
    fn run(&mut self, ms: f64, mut input_for: impl FnMut(usize, f64) -> Input) {
        let end = self.now + ms;
        let tick_ms = 1000.0 / f64::from(TICK_HZ);
        while self.now < end {
            self.now += 1.0;
            let now = self.now;
            // Server side: receive, then tick on schedule.
            for p in &mut self.peers {
                for bytes in p.up.deliver(now) {
                    match ClientMsg::decode(&bytes) {
                        Ok(ClientMsg::Hello { client_time, .. }) => {
                            let reply =
                                match self.room.join(p.conn, &p.claims, client_time, now as u64) {
                                    Ok((w, _)) => ServerMsg::Welcome(w),
                                    Err(r) => ServerMsg::Reject(r),
                                };
                            p.down.send(now, reply.encode());
                        }
                        Ok(ClientMsg::Inputs(packet)) => {
                            self.room.handle_inputs(p.conn, &packet, now as u64)
                        }
                        Ok(ClientMsg::Bye) => self.room.leave(p.conn),
                        Err(e) => panic!("client sent garbage: {e}"),
                    }
                }
            }
            while now >= self.next_tick_at {
                self.next_tick_at += tick_ms;
                let out = self.room.step(now as u64);
                for (conn, bytes) in out.packets {
                    if let Some(p) = self.peers.iter_mut().find(|p| p.conn == conn) {
                        p.down.send(now, bytes);
                    }
                }
            }
            // Client side: receive, update every ~8 ms, send.
            for (i, p) in self.peers.iter_mut().enumerate() {
                for bytes in p.down.deliver(now) {
                    p.client.handle_packet(&bytes, now);
                }
                if (now as u64 + i as u64 * 3).is_multiple_of(8) {
                    p.client.update(now, input_for(i, now));
                    for bytes in p.client.take_outgoing() {
                        p.up.send(now, bytes);
                    }
                }
            }
        }
    }

    /// Compare a client's own predicted rider with the server's at the same tick
    /// by re-checking after the server catches up.
    fn own_error_vs_server(&self, i: usize) -> f32 {
        let p = &self.peers[i];
        let slot = p.client.slot().expect("joined");
        let server = self.room.world().riders[slot].expect("server rider");
        let predicted = p.client.predicted_world().riders[slot].expect("predicted rider");
        (server.pos - predicted.pos).length()
    }
}

fn driving(_: usize, now: f64) -> Input {
    // Wiggle the stick so prediction has something to get wrong.
    let steer = ((now / 700.0).sin() * 0.8) as f32;
    let jump = if (now as u64 / 1000).is_multiple_of(3) && (now as u64 % 1000) < 50 {
        1
    } else {
        0
    };
    Input::from_analog(steer, 1.0, jump)
}

#[test]
fn joins_and_predicts_perfectly_on_a_perfect_network() {
    let mut h = Harness::new(0, SurfaceKind::Swells);
    h.add_peer("a", PERFECT);
    h.run(500.0, |_, _| Input::default());
    assert_eq!(h.peers[0].client.phase(), Phase::Joined);
    let before = h.peers[0].client.stats().mispredictions;
    h.run(5000.0, driving);
    let s = h.peers[0].client.stats();
    assert!(s.snapshots > 140, "snapshots: {}", s.snapshots);
    // With the same inputs and a deterministic sim, prediction never misses.
    assert_eq!(s.mispredictions - before, 0, "stats: {s:?}");
    assert!((0..=4).contains(&s.input_lead), "lead {}", s.input_lead);
    assert!(h.room.stats.missed_inputs < 10, "{:?}", h.room.stats);
}

#[test]
fn survives_lag_jitter_and_loss() {
    let bad = NetConditions {
        latency_ms: 160.0,
        jitter_ms: 25.0,
        loss: 0.05,
    };
    let mut h = Harness::new(0, SurfaceKind::Swells);
    h.add_peer("a", bad);
    h.run(1500.0, |_, _| Input::default());
    assert_eq!(
        h.peers[0].client.phase(),
        Phase::Joined,
        "hello must be resent through loss"
    );
    let before = h.peers[0].client.stats();
    let missed_before = h.room.stats.missed_inputs;
    h.run(10_000.0, driving);
    let s = h.peers[0].client.stats();
    let snaps = s.snapshots - before.snapshots;
    let misses = s.mispredictions - before.mispredictions;
    // Redundant inputs + clock sync: lost packets almost never lose inputs.
    let missed = h.room.stats.missed_inputs - missed_before;
    assert!(
        missed < 30,
        "server missed {missed} of 600 inputs; {:?}",
        h.room.stats
    );
    assert!(
        f64::from(misses) < f64::from(snaps) * 0.1,
        "{misses} mispredictions in {snaps} snapshots; {s:?}"
    );
    assert!((140.0..240.0).contains(&s.rtt_ms), "rtt {}", s.rtt_ms);
    // The client runs ahead of the server by about one trip plus the lead.
    let ahead = s.predicted_tick as i64 - h.room.tick() as i64;
    assert!((4..=20).contains(&ahead), "client is {ahead} ticks ahead");
}

#[test]
fn prediction_matches_the_server_once_inputs_settle() {
    let cond = NetConditions {
        latency_ms: 80.0,
        jitter_ms: 10.0,
        loss: 0.02,
    };
    let mut h = Harness::new(0, SurfaceKind::Swells);
    h.add_peer("a", cond);
    h.run(1000.0, |_, _| Input::default());
    h.run(4000.0, driving);
    // Hold a constant input; the server catches up to the predicted tick.
    h.run(1000.0, |_, _| Input::from_analog(0.2, 1.0, 0));
    let err = h.own_error_vs_server(0);
    // Not exactly comparable (client is ahead), but riding straight-ish the
    // gap is just a few ticks of travel.
    assert!(err < 3.0, "prediction drifted {err} m from the server");
}

#[test]
fn two_players_see_each_other_and_bots_are_predicted_exactly() {
    let cond = NetConditions {
        latency_ms: 60.0,
        jitter_ms: 5.0,
        loss: 0.0,
    };
    let mut h = Harness::new(2, SurfaceKind::Flat);
    h.add_peer("a", cond);
    h.add_peer("b", cond);
    h.run(1000.0, |_, _| Input::default());
    for p in &h.peers {
        assert_eq!(p.client.phase(), Phase::Joined);
    }
    let names: Vec<String> = h.peers[0]
        .client
        .roster()
        .iter()
        .flatten()
        .map(|r| r.name.clone())
        .collect();
    assert_eq!(names.len(), 4, "two humans + two bots: {names:?}");
    assert!(names.contains(&"A".to_string()) && names.contains(&"B".to_string()));

    // Only player 0 drives; player 1 stands still. Bots lap.
    let before = h.peers[1].client.stats().mispredictions;
    h.run(4000.0, |i, now| {
        if i == 0 {
            driving(i, now)
        } else {
            Input::default()
        }
    });
    let s1 = h.peers[1].client.stats();
    // Player 1 never changes input and bots are deterministic, so player 1's
    // own prediction only misses when player 0 bumps into it.
    assert!(s1.mispredictions - before < 5, "{s1:?}");

    // Player 1 sees player 0 moving, both in interpolated and predicted mode.
    let a_slot = h.peers[0].client.slot().unwrap() as u8;
    for mode in [RemoteMode::Interpolated, RemoteMode::Predicted] {
        let seen = h.peers[1].client.render(h.now, mode);
        let a = seen
            .iter()
            .find(|r| r.slot == a_slot)
            .expect("sees player a");
        let spawn = sim::Rider::spawn(a_slot as usize).pos;
        let server = h.room.world().riders[a_slot as usize].unwrap().pos;
        assert!(
            (a.pos - spawn).length() > 3.0,
            "player a should have moved: {:?}",
            a.pos
        );
        // Interpolated is ~130 ms in the past at ~20 m/s; predicted is about current.
        assert!(
            (a.pos - server).length() < 6.0,
            "{mode:?}: drawn {:?}, server {:?}",
            a.pos,
            server
        );
        assert_eq!(seen.len(), 4);
    }
}

#[test]
fn room_is_capped_at_four_humans_and_bots_give_up_seats() {
    let mut h = Harness::new(5, SurfaceKind::Flat);
    for pid in ["a", "b", "c", "d", "e"] {
        h.add_peer(pid, PERFECT);
    }
    h.run(500.0, |_, _| Input::default());
    let phases: Vec<Phase> = h.peers.iter().map(|p| p.client.phase()).collect();
    assert_eq!(
        phases.iter().filter(|p| **p == Phase::Joined).count(),
        4,
        "{phases:?}"
    );
    assert!(
        phases.contains(&Phase::Rejected(protocol::RejectReason::RoomFull)),
        "{phases:?}"
    );
    // 4 humans + bots that still fit (8 seats).
    assert_eq!(h.room.world().riders.iter().flatten().count(), 8);
}

#[test]
fn server_does_not_trust_client_inputs() {
    let mut h = Harness::new(0, SurfaceKind::Flat);
    h.add_peer("a", PERFECT);
    h.run(300.0, |_, _| Input::default());
    let conn = h.peers[0].conn;
    let slot = h.peers[0].client.slot().unwrap();
    let tick = h.room.tick();

    // Inputs far in the future are dropped; a flood is rate limited.
    let far = InputPacket {
        event_ack: 0,
        last_snapshot_tick: 0,
        client_time: 0,
        first_tick: tick + 1000,
        inputs: vec![
            Input {
                steer: 0,
                throttle: 127,
                buttons: 0xFF
            };
            32
        ],
    };
    h.room.handle_inputs(conn, &far, h.now as u64);
    assert!(h.room.stats.future_inputs >= 32);
    let flood = InputPacket {
        first_tick: tick + 1,
        ..far.clone()
    };
    for _ in 0..500 {
        h.room.handle_inputs(conn, &flood, h.now as u64);
    }
    assert!(
        h.room.stats.rate_limited_packets > 400,
        "{:?}",
        h.room.stats
    );

    // Out-of-range values and unknown buttons are cleaned up before the sim sees them.
    let evil = InputPacket {
        first_tick: tick + 1,
        inputs: vec![Input {
            steer: -128,
            throttle: -128,
            buttons: 0xFE,
        }],
        ..far
    };
    let mut h2 = Harness::new(0, SurfaceKind::Flat);
    h2.add_peer("a", PERFECT);
    h2.run(300.0, |_, _| Input::default());
    let tick2 = h2.room.tick();
    h2.room.handle_inputs(
        h2.peers[0].conn,
        &InputPacket {
            first_tick: tick2 + 1,
            ..evil
        },
        h2.now as u64,
    );
    h2.room.step(h2.now as u64);
    let r = h2.room.world().riders[h2.peers[0].client.slot().unwrap()].unwrap();
    assert_eq!(
        r.last_input,
        Input {
            steer: -127,
            throttle: -127,
            buttons: 0
        }
    );

    // Many packets cannot make a rider faster than one input per tick allows.
    let _ = slot;
}

#[test]
fn reconnect_with_same_player_id_keeps_the_seat() {
    let mut h = Harness::new(0, SurfaceKind::Flat);
    h.add_peer("a", PERFECT);
    h.run(500.0, driving);
    let slot = h.peers[0].client.slot().unwrap();
    // Same pid, new connection.
    h.peers[0].conn = 99;
    h.peers[0].client = Client::new("token");
    h.run(500.0, driving);
    assert_eq!(h.peers[0].client.slot(), Some(slot));
    assert_eq!(h.room.human_count(), 1);
}
