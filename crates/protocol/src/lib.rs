//! Wire protocol shared by the race server (native) and the browser (WASM).

pub mod msg;
pub mod token;
pub mod wire;

pub use msg::*;
pub use wire::DecodeError;

#[cfg(test)]
mod tests {
    use super::*;
    use sim::{Input, MAX_RIDERS, Surface, SurfaceKind, World};

    fn full_snapshot() -> Snapshot {
        let mut world = World::new(Surface::new(SurfaceKind::Swells, 9));
        for slot in 0..MAX_RIDERS {
            world.spawn(slot);
        }
        let inputs = [Some(Input::from_analog(0.4, 1.0, 1)); MAX_RIDERS];
        for _ in 0..120 {
            world.step(&inputs);
        }
        Snapshot {
            tick: world.tick,
            input_ack: 1234,
            input_lead: 3,
            echo_client_time: 999,
            echo_hold_ms: 12,
            events: (0..MAX_EVENTS_PER_SNAPSHOT as u16)
                .map(|i| Event {
                    id: i,
                    body: EventBody::RiderJoined {
                        slot: i as u8,
                        kind: RiderKind::Human,
                        name: "Ñandú the Shifty Rider".into(), // exactly NAME_MAX_BYTES
                    },
                })
                .collect(),
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
        // Keep plenty of headroom for future fields (scores, race state).
        assert!(bytes.len() < 500, "snapshot grew to {} bytes", bytes.len());
    }

    #[test]
    fn snapshot_roundtrip_is_lossless() {
        let snap = full_snapshot();
        let decoded = ServerMsg::decode(&ServerMsg::Snapshot(snap.clone()).encode()).unwrap();
        assert_eq!(decoded, ServerMsg::Snapshot(snap));
    }

    #[test]
    fn worst_case_input_packet_fits() {
        let msg = ClientMsg::Inputs(InputPacket {
            event_ack: 7,
            last_snapshot_tick: 100,
            client_time: 55,
            first_tick: 90,
            inputs: vec![Input::from_analog(-1.0, 1.0, 1); MAX_INPUTS_PER_PACKET],
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
        let mut bad = vec![kind::INPUTS, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200];
        bad.extend(std::iter::repeat_n(0, 600));
        assert!(ClientMsg::decode(&bad).is_err());
    }

    #[test]
    fn names_are_cut_on_char_boundaries() {
        assert_eq!(truncate_utf8("ññññññññññññññññ", 5), "ññ");
    }
}
