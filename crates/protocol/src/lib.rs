//! Wire protocol shared by the race server (native) and the browser (WASM).

pub mod ghost;
pub mod msg;
pub mod token;
pub mod wire;

pub use msg::*;
pub use wire::DecodeError;

#[cfg(test)]
mod tests {
    use super::*;
    use sim::{CourseId, Input, MAX_RIDERS, SurfaceKind, World};

    fn full_snapshot() -> Snapshot {
        full_snapshot_on(CourseId::Oval)
    }

    fn full_snapshot_on(course: CourseId) -> Snapshot {
        let mut world = World::for_event(
            sim::conditions::Event {
                course,
                conditions: sim::Conditions {
                    season: sim::Season::Fall,
                    weather: sim::Weather::Storm,
                    turns: sim::Weather::Rain,
                    time: 100,
                },
            },
            SurfaceKind::Swells,
            9,
        );
        for slot in 0..MAX_RIDERS {
            world.spawn(slot);
        }
        let inputs = [Some(Input::from_analog(0.4, 1.0, -0.7, 0xFF)); MAX_RIDERS];
        for _ in 0..120 {
            world.step(&inputs);
        }
        Snapshot {
            tick: world.tick,
            input_ack: 1234,
            input_lead: 3,
            echo_client_time: 999,
            echo_hold_ms: 12,
            race: world.race,
            course: world.course,
            conditions: world.conditions,
            event_index: 1,
            event_count: 2,
            events: events_for_snapshot(
                &(0..MAX_EVENTS_PER_SNAPSHOT as u16)
                    .map(|i| Event {
                        id: i,
                        body: EventBody::RiderJoined {
                            slot: i as u8,
                            kind: RiderKind::Human,
                            name: "Ñandú the Shifty Rider, Ñandú the Shift#1234".into(), // exactly NAME_MAX_BYTES
                            look: vec![0xAB; LOOK_MAX_BYTES],
                            setups: vec![[6, 2, 1, 3]; MAX_SETUPS],
                        },
                    })
                    .collect::<Vec<_>>(),
            ),
            riders: world
                .riders
                .iter()
                .enumerate()
                .filter_map(|(slot, r)| {
                    r.map(|rider| RiderState {
                        slot: slot as u8,
                        rider,
                    })
                })
                .collect(),
        }
    }

    #[test]
    fn worst_case_snapshot_fits_one_datagram() {
        let bytes = ServerMsg::Snapshot(full_snapshot()).encode();
        assert!(
            bytes.len() <= MAX_DATAGRAM,
            "snapshot is {} bytes",
            bytes.len()
        );
        // Keep plenty of headroom for future fields.
        assert!(bytes.len() < 1000, "snapshot grew to {} bytes", bytes.len());
    }

    #[test]
    fn snapshot_roundtrip_is_lossless() {
        for course in [CourseId::Oval, CourseId::Mountain, CourseId::Cape] {
            let snap = full_snapshot_on(course);
            let decoded = ServerMsg::decode(&ServerMsg::Snapshot(snap.clone()).encode()).unwrap();
            assert_eq!(decoded, ServerMsg::Snapshot(snap));
        }
    }

    #[test]
    fn welcome_carries_the_race() {
        let w = Welcome {
            version: PROTOCOL_VERSION,
            slot: 3,
            tick_hz: 60,
            snapshot_interval: 2,
            max_riders: 8,
            course: CourseId::Mountain,
            conditions: sim::Conditions {
                season: sim::Season::Spring,
                weather: sim::Weather::Windy,
                turns: sim::Weather::Clear,
                time: 50,
            },
            surface_kind: SurfaceKind::Swells,
            surface_seed: 77,
            server_tick: 1234,
            echo_client_time: 5,
            trial: true,
        };
        let msg = ServerMsg::Welcome(w);
        assert_eq!(ServerMsg::decode(&msg.encode()).unwrap(), msg);
        let mut bytes = msg.encode();
        bytes[8] = 9; // season
        assert!(ServerMsg::decode(&bytes).is_err());
    }

    #[test]
    fn worst_case_input_packet_fits() {
        let msg = ClientMsg::Inputs(InputPacket {
            event_ack: 7,
            last_snapshot_tick: 100,
            client_time: 55,
            ready: 2,
            retry: 9,
            first_tick: 90,
            inputs: vec![Input::from_analog(-1.0, 1.0, 1.0, 0xFF); MAX_INPUTS_PER_PACKET],
        });
        let bytes = msg.encode();
        assert!(bytes.len() <= MAX_DATAGRAM);
        assert_eq!(ClientMsg::decode(&bytes).unwrap(), msg);
    }

    #[test]
    fn hostile_bytes_never_panic() {
        let snap = ServerMsg::Snapshot(full_snapshot()).encode();
        for cut in 0..snap.len() {
            let _ = ServerMsg::decode(&snap[..cut]);
        }
        let mut rng = sim::math::Pcg32::new(1);
        for _ in 0..5000 {
            let n = (rng.next_u32() % 64) as usize;
            let buf: Vec<u8> = (0..n).map(|_| rng.next_u32() as u8).collect();
            let _ = ServerMsg::decode(&buf);
            let _ = ClientMsg::decode(&buf);
        }
        // Too many inputs is refused.
        let mut bad = vec![kind::INPUTS, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200];
        bad.extend(std::iter::repeat_n(0, 600));
        assert!(ClientMsg::decode(&bad).is_err());
    }

    #[test]
    fn names_are_cut_on_char_boundaries() {
        assert_eq!(truncate_utf8("ññññññññññññññññ", 5), "ññ");
    }
}
