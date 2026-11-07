//! Ghosts: a time trial run as the race server recorded it, played back by
//! race time. Not netcode: the race server keeps the rider's authoritative
//! state at snapshot rate from the start signal to the finish, the lobby
//! stores it, and clients draw it.
//!
//! Format (version 1), little-endian:
//!
//! ```text
//! u8   version (1)
//! u8   course (`sim::CourseId`)
//! u8   season (0 summer, 1 fall, 2 winter, 3 spring)
//! u8   frame_ticks (2: a frame every two sim ticks, 30 Hz)
//! u32  finish_ticks: race ticks at the finish
//! u16  frames: finish_ticks.div_ceil(frame_ticks) + 1
//! u8   n, then n × u32: race ticks at each split (checkpoints, laps), the finish last
//! u8   look length, then the rider's appearance bytes
//! frames: a LEB128 mask of the fields that differ from their prediction,
//!         then a zigzag LEB128 residual for each, lowest bit first
//! ```
//!
//! Frame `k` is the rider after race tick `k × frame_ticks`, and the last
//! one the rider at the finish (an odd tick lands between). Positions,
//! heading, pitch and roll are predicted from the two frames before (steady
//! motion costs nothing); the rest from the frame before.

use sim::course::Sport;
use sim::math::Vec3;
use sim::world::Rider;
use sim::{buttons, quant};

use crate::wire::{DecodeError, Reader, Writer};

pub const GHOST_VERSION: u8 = 1;
/// Sim ticks between frames.
pub const FRAME_TICKS: u32 = 2;
/// Most bytes a ghost may take (a six-minute run fits easily).
pub const MAX_GHOST_BYTES: usize = 128 * 1024;
/// Most splits in a ghost.
pub const MAX_SPLITS: usize = 64;
/// Most bytes of appearance in a ghost.
pub const MAX_LOOK: usize = crate::LOOK_MAX_BYTES;

/// One recorded moment of a rider, as drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GhostFrame {
    pub pos: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    pub grounded: bool,
    pub bailing: bool,
    /// Snowboard: ticks the jump has been loaded. Jetski: how far into a stunt.
    pub charge: u8,
    /// The grab (snowboard) or stunt (jetski) on show (0 = none).
    pub grab: u8,
    /// Snowboard: ticks left wobbling.
    pub wobble: u8,
    pub steer: i8,
    pub lean: i8,
}

impl GhostFrame {
    /// A rider as drawn on `sport`: the grab only while it shows.
    pub fn of(r: &Rider, sport: Sport) -> Self {
        let grab = match sport {
            Sport::Jetski if r.charge > 0 => r.grab,
            Sport::Snowboard if !r.grounded && r.last_input.pressed(buttons::GRAB) => r.grab,
            _ => 0,
        };
        Self {
            pos: r.pos,
            yaw: r.yaw,
            pitch: r.pitch,
            roll: r.roll,
            grounded: r.grounded,
            bailing: r.bailing(),
            charge: r.charge,
            grab,
            wobble: r.wobble,
            steer: r.last_input.steer,
            lean: r.last_input.lean,
        }
    }
}

/// A recorded run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ghost {
    pub course: u8,
    pub season: u8,
    pub finish_ticks: u32,
    pub splits: Vec<u32>,
    pub look: Vec<u8>,
    pub frames: Vec<GhostFrame>,
}

/// Fields per frame, in mask order: the ones that change most come first,
/// so a frame's mask usually fits one byte.
const FIELDS: usize = 12;
/// Fields predicted from the two frames before (the rest: the one before).
const SECOND_ORDER: [bool; FIELDS] = [
    true, true, true, true, true, true, false, false, false, false, false, false,
];

const FLAG_GROUNDED: i32 = 1;
const FLAG_BAILING: i32 = 2;

/// Frames needed for a run that finished after `finish_ticks` race ticks.
pub fn frames_for(finish_ticks: u32) -> usize {
    finish_ticks.div_ceil(FRAME_TICKS) as usize + 1
}

/// A frame's fields as integers on the wire grid. Yaw is unwrapped against
/// the previous frame's, so a spin is steady motion and not a jump.
fn fields(f: &GhostFrame, prev_yaw: i32) -> [i32; FIELDS] {
    let yaw = i32::from(quant::yaw_to_wire(f.yaw));
    let turn = (yaw - prev_yaw).rem_euclid(65536);
    let turn = if turn >= 32768 { turn - 65536 } else { turn };
    let flags =
        if f.grounded { FLAG_GROUNDED } else { 0 } | if f.bailing { FLAG_BAILING } else { 0 };
    [
        quant::pos_to_wire(f.pos.x),
        quant::pos_to_wire(f.pos.y),
        quant::pos_to_wire(f.pos.z),
        prev_yaw.wrapping_add(turn),
        i32::from(quant::angle_to_wire(f.pitch)),
        i32::from(quant::angle_to_wire(f.roll)),
        i32::from(f.steer),
        i32::from(f.lean),
        flags,
        i32::from(f.charge),
        i32::from(f.grab),
        i32::from(f.wobble),
    ]
}

fn frame_of(v: &[i32; FIELDS]) -> GhostFrame {
    GhostFrame {
        pos: Vec3::new(
            quant::pos_from_wire(v[0]),
            quant::pos_from_wire(v[1]),
            quant::pos_from_wire(v[2]),
        ),
        yaw: quant::yaw_from_wire((v[3] & 0xFFFF) as u16),
        pitch: quant::angle_from_wire(v[4].clamp(i16::MIN.into(), i16::MAX.into()) as i16),
        roll: quant::angle_from_wire(v[5].clamp(i16::MIN.into(), i16::MAX.into()) as i16),
        steer: v[6].clamp(-127, 127) as i8,
        lean: v[7].clamp(-127, 127) as i8,
        grounded: v[8] & FLAG_GROUNDED != 0,
        bailing: v[8] & FLAG_BAILING != 0,
        charge: v[9].clamp(0, 255) as u8,
        grab: v[10].clamp(0, 255) as u8,
        wobble: v[11].clamp(0, 255) as u8,
    }
}

fn write_varint(w: &mut Writer, mut v: u32) {
    while v >= 0x80 {
        w.u8((v as u8) | 0x80);
        v >>= 7;
    }
    w.u8(v as u8);
}

fn read_varint(r: &mut Reader<'_>) -> Result<u32, DecodeError> {
    let mut v = 0u32;
    for i in 0..5 {
        let b = r.u8()?;
        v |= u32::from(b & 0x7F) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err(DecodeError::Invalid("varint too long"))
}

fn zigzag(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

fn unzigzag(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

/// The prediction state shared by the encoder and the decoder.
#[derive(Default)]
struct Predictor {
    last: [i32; FIELDS],
    step: [i32; FIELDS],
}

impl Predictor {
    fn predict(&self, i: usize) -> i32 {
        if SECOND_ORDER[i] {
            self.last[i].wrapping_add(self.step[i])
        } else {
            self.last[i]
        }
    }

    fn push(&mut self, v: &[i32; FIELDS]) {
        for (i, &x) in v.iter().enumerate() {
            self.step[i] = x.wrapping_sub(self.last[i]);
            self.last[i] = x;
        }
    }
}

impl Ghost {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(64 + self.frames.len() * 8);
        w.u8(GHOST_VERSION);
        w.u8(self.course);
        w.u8(self.season);
        w.u8(FRAME_TICKS as u8);
        w.u32(self.finish_ticks);
        w.u16(self.frames.len().min(usize::from(u16::MAX)) as u16);
        let splits = &self.splits[..self.splits.len().min(MAX_SPLITS)];
        w.u8(splits.len() as u8);
        for &s in splits {
            w.u32(s);
        }
        let look = &self.look[..self.look.len().min(MAX_LOOK)];
        w.u8(look.len() as u8);
        w.bytes(look);
        let mut p = Predictor::default();
        for f in self.frames.iter().take(usize::from(u16::MAX)) {
            let v = fields(f, p.last[3]);
            let mut mask = 0u32;
            let mut residuals = [0i32; FIELDS];
            for i in 0..FIELDS {
                residuals[i] = v[i].wrapping_sub(p.predict(i));
                if residuals[i] != 0 {
                    mask |= 1 << i;
                }
            }
            write_varint(&mut w, mask);
            for (i, &r) in residuals.iter().enumerate() {
                if mask & (1 << i) != 0 {
                    write_varint(&mut w, zigzag(r));
                }
            }
            p.push(&v);
        }
        w.buf
    }

    /// Reads a ghost, checking that it holds together: the frames cover the
    /// run to its finish, the splits end there, and nothing is left over.
    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        if buf.len() > MAX_GHOST_BYTES {
            return Err(DecodeError::Invalid("ghost too big"));
        }
        let mut r = Reader::new(buf);
        if r.u8()? != GHOST_VERSION {
            return Err(DecodeError::Invalid("ghost version"));
        }
        let course = r.u8()?;
        let season = r.u8()?;
        if season > 3 {
            return Err(DecodeError::Invalid("season"));
        }
        if u32::from(r.u8()?) != FRAME_TICKS {
            return Err(DecodeError::Invalid("frame ticks"));
        }
        let finish_ticks = r.u32()?;
        let n_frames = usize::from(r.u16()?);
        if finish_ticks == 0 || n_frames != frames_for(finish_ticks) {
            return Err(DecodeError::Invalid("frames"));
        }
        let n_splits = usize::from(r.u8()?);
        if n_splits == 0 || n_splits > MAX_SPLITS {
            return Err(DecodeError::Invalid("splits"));
        }
        let mut splits = Vec::with_capacity(n_splits);
        for _ in 0..n_splits {
            let s = r.u32()?;
            if s > finish_ticks || splits.last().is_some_and(|&l| s < l) {
                return Err(DecodeError::Invalid("splits"));
            }
            splits.push(s);
        }
        if splits.last() != Some(&finish_ticks) {
            return Err(DecodeError::Invalid("splits"));
        }
        let look_len = usize::from(r.u8()?);
        if look_len > MAX_LOOK {
            return Err(DecodeError::Invalid("look"));
        }
        let look = r.bytes(look_len)?.to_vec();
        let mut p = Predictor::default();
        let mut frames = Vec::with_capacity(n_frames);
        for _ in 0..n_frames {
            let mask = read_varint(&mut r)?;
            if mask >> FIELDS != 0 {
                return Err(DecodeError::Invalid("frame mask"));
            }
            let mut v = [0i32; FIELDS];
            for (i, x) in v.iter_mut().enumerate() {
                let residual = if mask & (1 << i) != 0 {
                    unzigzag(read_varint(&mut r)?)
                } else {
                    0
                };
                *x = p.predict(i).wrapping_add(residual);
            }
            p.push(&v);
            frames.push(frame_of(&v));
        }
        if r.remaining() != 0 {
            return Err(DecodeError::Invalid("trailing bytes"));
        }
        Ok(Self {
            course,
            season,
            finish_ticks,
            splits,
            look,
            frames,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::{CourseId, SurfaceKind, World};

    /// A bot's run on a course, recorded as the race server does.
    fn bot_run(course: CourseId) -> Ghost {
        let mut world = World::on_course(course, SurfaceKind::Swells, 3);
        world.spawn(0);
        world.start_intro();
        let sport = world.course().sport;
        let mut ghost = Ghost {
            course: course as u8,
            season: 2,
            look: vec![1, 2, 3],
            ..Ghost::default()
        };
        let mut start = None;
        for _ in 0..sim::TICK_HZ * 60 * 6 {
            let input = sim::bot::bot_input(&world, 0);
            let events = world.step(&[Some(input), None, None, None, None, None, None, None]);
            if start.is_none() && world.race.phase == sim::Phase::Racing {
                start = Some(world.tick);
            }
            let Some(start) = start else { continue };
            let at = world.tick - start;
            for e in events {
                if let sim::race::EventKind::Checkpoint { .. }
                | sim::race::EventKind::Lap { lap: 2.. } = e.kind
                {
                    ghost.splits.push(at);
                }
            }
            let r = world.riders[0].expect("rider");
            if r.race.finished() {
                ghost.frames.push(GhostFrame::of(&r, sport));
                ghost.finish_ticks = r.race.finish_ticks;
                ghost.splits.push(r.race.finish_ticks);
                break;
            }
            if at.is_multiple_of(FRAME_TICKS) {
                ghost.frames.push(GhostFrame::of(&r, sport));
            }
        }
        assert!(ghost.finish_ticks > 0, "the bot finished");
        ghost
    }

    #[test]
    fn a_run_round_trips_within_budget() {
        for course in [CourseId::Oval, CourseId::Mountain] {
            let ghost = bot_run(course);
            assert_eq!(ghost.frames.len(), frames_for(ghost.finish_ticks));
            let bytes = ghost.encode();
            eprintln!(
                "{course:?}: {} frames, {} bytes for {:.1} s",
                ghost.frames.len(),
                bytes.len(),
                ghost.finish_ticks as f32 / 60.0
            );
            let back = Ghost::decode(&bytes).expect("decodes");
            assert_eq!(back, ghost, "lossless on {course:?}");
            // A few dozen KB for a three-minute run at most.
            let per_minute = bytes.len() as f32 / (ghost.finish_ticks as f32 / 3600.0);
            assert!(
                per_minute * 3.0 < 48_000.0,
                "{course:?}: {} bytes for {} s ({per_minute:.0} B/min)",
                bytes.len(),
                ghost.finish_ticks / 60
            );
        }
    }

    #[test]
    fn broken_ghosts_are_refused() {
        let bytes = bot_run(CourseId::Mountain).encode();
        for cut in 0..bytes.len() {
            assert!(Ghost::decode(&bytes[..cut]).is_err(), "cut at {cut}");
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(Ghost::decode(&longer).is_err());
        let mut wrong_time = bytes.clone();
        wrong_time[4] = wrong_time[4].wrapping_add(10);
        assert!(Ghost::decode(&wrong_time).is_err());
        let mut rng = sim::math::Pcg32::new(5);
        for _ in 0..2000 {
            let n = (rng.next_u32() % 200) as usize;
            let buf: Vec<u8> = (0..n).map(|_| rng.next_u32() as u8).collect();
            let _ = Ghost::decode(&buf);
        }
    }

    /// The lobby walks this exact ghost (see apps/lobby/test/ghosts.test.ts).
    #[test]
    fn a_tiny_ghost_for_the_lobby() {
        let ghost = Ghost {
            course: 1,
            season: 2,
            finish_ticks: 5,
            splits: vec![3, 5],
            look: vec![9, 8],
            frames: (0..4)
                .map(|i| GhostFrame {
                    pos: Vec3::new(i as f32, 0.5, -2.0 * i as f32),
                    yaw: 0.1 * i as f32,
                    grounded: i != 2,
                    steer: if i == 3 { -64 } else { 0 },
                    ..GhostFrame::default()
                })
                .collect(),
        };
        let bytes = ghost.encode();
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "0101020205000000040002030000000500000002090882028008020f8010ff07ff1fa610800201c0027f02"
        );
        let back = Ghost::decode(&bytes).unwrap();
        assert_eq!(back.frames.len(), 4);
        assert_eq!(back.frames[3].steer, -64);
    }
}
