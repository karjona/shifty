//! Message types and their binary encoding.
//!
//! Designed for unreliable datagrams:
//! - Clients send inputs only, numbered by tick, with the recent unacked
//!   inputs repeated in every packet (so a lost packet costs nothing).
//! - Snapshots are self-contained and fit in one datagram. Input packets
//!   acknowledge the latest snapshot received (`last_snapshot_tick`); the
//!   server does not read it, it exists so snapshots can be delta-compressed
//!   against an acknowledged baseline without changing the wire format.
//! - Important events carry IDs and are resent in every snapshot until the
//!   client acknowledges them.

use sim::input::Input;
use sim::math::Vec3;
use sim::quant;
use sim::race::{Phase, Progress, Race};
use sim::world::Rider;
use sim::{CourseId, MAX_RIDERS, SurfaceKind};

use crate::wire::{DecodeError, Reader, Writer};

pub const PROTOCOL_VERSION: u16 = 6;
/// Safe single-datagram payload size (WebTransport over QUIC, IPv6 paths).
pub const MAX_DATAGRAM: usize = 1200;
/// Most inputs one packet may carry (about half a second at 60 Hz).
pub const MAX_INPUTS_PER_PACKET: usize = 32;
/// Most reliable events packed in one snapshot.
pub const MAX_EVENTS_PER_SNAPSHOT: usize = 4;
pub const NAME_MAX_BYTES: usize = 24;
pub const TOKEN_MAX_BYTES: usize = 900;

pub mod kind {
    // Client -> server
    pub const HELLO: u8 = 0x01;
    pub const INPUTS: u8 = 0x02;
    pub const BYE: u8 = 0x03;
    // Server -> client
    pub const WELCOME: u8 = 0x81;
    pub const REJECT: u8 = 0x82;
    pub const SNAPSHOT: u8 = 0x83;
}

// ---------------------------------------------------------------------------
// Client -> server

#[derive(Clone, Debug, PartialEq)]
pub enum ClientMsg {
    /// Resent until a `Welcome` or `Reject` arrives.
    Hello {
        version: u16,
        /// `sim::SIM_VERSION`: both sides must run the exact same sim.
        sim_version: u32,
        token: String,
        client_time: u16,
    },
    Inputs(InputPacket),
    Bye,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InputPacket {
    /// Number of reliable events received in order (the next expected id).
    pub event_ack: u16,
    /// Last snapshot tick received (for future delta compression).
    pub last_snapshot_tick: u32,
    /// Client clock in ms (wrapping), echoed back to measure round-trip time.
    pub client_time: u16,
    /// Tick of `inputs[0]`; `inputs[i]` is for tick `first_tick + i`.
    pub first_tick: u32,
    pub inputs: Vec<Input>,
}

impl InputPacket {
    pub fn last_tick(&self) -> Option<u32> {
        let n = self.inputs.len() as u32;
        (n > 0).then(|| self.first_tick.wrapping_add(n - 1))
    }
}

impl ClientMsg {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(64);
        match self {
            Self::Hello {
                version,
                sim_version,
                token,
                client_time,
            } => {
                w.u8(kind::HELLO);
                w.u16(*version);
                w.u32(*sim_version);
                w.u16(*client_time);
                let t = token.as_bytes();
                w.u16(t.len() as u16);
                w.bytes(t);
            }
            Self::Inputs(p) => {
                w.u8(kind::INPUTS);
                w.u16(p.event_ack);
                w.u32(p.last_snapshot_tick);
                w.u16(p.client_time);
                w.u32(p.first_tick);
                w.u8(p.inputs.len() as u8);
                for i in &p.inputs {
                    write_input(&mut w, i);
                }
            }
            Self::Bye => w.u8(kind::BYE),
        }
        w.buf
    }

    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(buf);
        match r.u8()? {
            kind::HELLO => {
                let version = r.u16()?;
                let sim_version = r.u32()?;
                let client_time = r.u16()?;
                let len = r.u16()? as usize;
                if len > TOKEN_MAX_BYTES {
                    return Err(DecodeError::Invalid("token too long"));
                }
                let token = core::str::from_utf8(r.bytes(len)?)
                    .map_err(|_| DecodeError::Invalid("token not utf-8"))?;
                Ok(Self::Hello {
                    version,
                    sim_version,
                    token: token.to_owned(),
                    client_time,
                })
            }
            kind::INPUTS => {
                let event_ack = r.u16()?;
                let last_snapshot_tick = r.u32()?;
                let client_time = r.u16()?;
                let first_tick = r.u32()?;
                let n = r.u8()? as usize;
                if n > MAX_INPUTS_PER_PACKET {
                    return Err(DecodeError::Invalid("too many inputs"));
                }
                let mut inputs = Vec::with_capacity(n);
                for _ in 0..n {
                    inputs.push(read_input(&mut r)?);
                }
                Ok(Self::Inputs(InputPacket {
                    event_ack,
                    last_snapshot_tick,
                    client_time,
                    first_tick,
                    inputs,
                }))
            }
            kind::BYE => Ok(Self::Bye),
            other => Err(DecodeError::UnknownMessage(other)),
        }
    }
}

// ---------------------------------------------------------------------------
// Server -> client

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RejectReason {
    BadVersion = 1,
    BadToken = 2,
    RoomFull = 3,
    Draining = 4,
    Kicked = 5,
}

impl RejectReason {
    fn from_u8(v: u8) -> Result<Self, DecodeError> {
        Ok(match v {
            1 => Self::BadVersion,
            2 => Self::BadToken,
            3 => Self::RoomFull,
            4 => Self::Draining,
            5 => Self::Kicked,
            _ => return Err(DecodeError::Invalid("reject reason")),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Welcome {
    pub version: u16,
    pub slot: u8,
    pub tick_hz: u8,
    pub snapshot_interval: u8,
    pub max_riders: u8,
    pub course: CourseId,
    pub surface_kind: SurfaceKind,
    pub surface_seed: u32,
    /// Server tick when the welcome was sent.
    pub server_tick: u32,
    pub echo_client_time: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RiderKind {
    Human = 0,
    Bot = 1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventBody {
    RiderJoined {
        slot: u8,
        kind: RiderKind,
        name: String,
    },
    RiderLeft {
        slot: u8,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub id: u16,
    pub body: EventBody,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RiderState {
    pub slot: u8,
    pub rider: Rider,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// The state is the world *after* this tick.
    pub tick: u32,
    /// Highest input tick received from you (inputs up to here need no resend).
    pub input_ack: u32,
    /// How many ticks early your inputs arrive (worst recent case). The client
    /// speeds up or slows down its clock to keep this near a small target.
    pub input_lead: i8,
    pub echo_client_time: u16,
    /// Ms between receiving the echoed packet and sending this snapshot.
    pub echo_hold_ms: u16,
    pub events: Vec<Event>,
    pub race: Race,
    pub riders: Vec<RiderState>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerMsg {
    Welcome(Welcome),
    Reject(RejectReason),
    Snapshot(Snapshot),
}

const FLAG_GROUNDED: u8 = 1;
const FLAG_RACING: u8 = 2;

fn write_input(w: &mut Writer, i: &Input) {
    w.i8(i.steer);
    w.i8(i.throttle);
    w.i8(i.lean);
    w.u8(i.buttons);
}

fn read_input(r: &mut Reader<'_>) -> Result<Input, DecodeError> {
    Ok(Input {
        steer: r.i8()?,
        throttle: r.i8()?,
        lean: r.i8()?,
        buttons: r.u8()?,
    })
}

fn write_rider(w: &mut Writer, s: &RiderState) {
    let r = &s.rider;
    w.u8(s.slot);
    let p = &r.race;
    let mut flags = 0;
    if r.grounded {
        flags |= FLAG_GROUNDED;
    }
    if p.racing {
        flags |= FLAG_RACING;
    }
    w.u8(flags);
    w.i32(quant::pos_to_wire(r.pos.x));
    w.i32(quant::pos_to_wire(r.pos.y));
    w.i32(quant::pos_to_wire(r.pos.z));
    w.i16(quant::vel_to_wire(r.vel.x));
    w.i16(quant::vel_to_wire(r.vel.y));
    w.i16(quant::vel_to_wire(r.vel.z));
    w.u16(quant::yaw_to_wire(r.yaw));
    w.i16(quant::angle_to_wire(r.pitch));
    w.i16(quant::angle_to_wire(r.roll));
    w.i16(quant::rate_to_wire(r.yaw_rate));
    w.i16(quant::rate_to_wire(r.pitch_rate));
    w.i16(quant::rate_to_wire(r.roll_rate));
    w.u16(r.state_ticks);
    w.i16(quant::angle_to_wire(r.air_spin));
    w.u8(r.bail_ticks);
    w.u8(r.charge);
    w.u8(r.grab);
    w.u8(r.grab_ticks);
    write_input(w, &r.last_input);
    w.u8(p.next_gate);
    w.u8(p.lap);
    w.u8(p.meter);
    w.u8(p.misses);
    w.u8(p.tricks);
    w.u16(p.points);
    w.u32(p.finish_ticks);
}

fn read_rider(r: &mut Reader<'_>) -> Result<RiderState, DecodeError> {
    let slot = r.u8()?;
    if slot as usize >= MAX_RIDERS {
        return Err(DecodeError::Invalid("rider slot"));
    }
    let flags = r.u8()?;
    let pos = Vec3::new(
        quant::pos_from_wire(r.i32()?),
        quant::pos_from_wire(r.i32()?),
        quant::pos_from_wire(r.i32()?),
    );
    let vel = Vec3::new(
        quant::vel_from_wire(r.i16()?),
        quant::vel_from_wire(r.i16()?),
        quant::vel_from_wire(r.i16()?),
    );
    let yaw = quant::yaw_from_wire(r.u16()?);
    let pitch = quant::angle_from_wire(r.i16()?);
    let roll = quant::angle_from_wire(r.i16()?);
    let yaw_rate = quant::rate_from_wire(r.i16()?);
    let pitch_rate = quant::rate_from_wire(r.i16()?);
    let roll_rate = quant::rate_from_wire(r.i16()?);
    let state_ticks = r.u16()?;
    let air_spin = quant::angle_from_wire(r.i16()?);
    let bail_ticks = r.u8()?;
    let charge = r.u8()?;
    let grab = r.u8()?;
    let grab_ticks = r.u8()?;
    let last_input = read_input(r)?;
    let race = Progress {
        racing: flags & FLAG_RACING != 0,
        next_gate: r.u8()?,
        lap: r.u8()?,
        meter: r.u8()?,
        misses: r.u8()?,
        tricks: r.u8()?,
        points: r.u16()?,
        finish_ticks: r.u32()?,
    };
    Ok(RiderState {
        slot,
        rider: Rider {
            pos,
            vel,
            yaw,
            pitch,
            roll,
            yaw_rate,
            pitch_rate,
            roll_rate,
            grounded: flags & FLAG_GROUNDED != 0,
            state_ticks,
            air_spin,
            bail_ticks,
            charge,
            grab,
            grab_ticks,
            last_input,
            race,
        },
    })
}

fn write_event(w: &mut Writer, e: &Event) {
    w.u16(e.id);
    match &e.body {
        EventBody::RiderJoined { slot, kind, name } => {
            w.u8(1);
            w.u8(*slot);
            w.u8(*kind as u8);
            let n = truncate_utf8(name, NAME_MAX_BYTES);
            w.u8(n.len() as u8);
            w.bytes(n.as_bytes());
        }
        EventBody::RiderLeft { slot } => {
            w.u8(2);
            w.u8(*slot);
        }
    }
}

fn read_event(r: &mut Reader<'_>) -> Result<Event, DecodeError> {
    let id = r.u16()?;
    let body = match r.u8()? {
        1 => {
            let slot = r.u8()?;
            let kind = match r.u8()? {
                0 => RiderKind::Human,
                1 => RiderKind::Bot,
                _ => return Err(DecodeError::Invalid("rider kind")),
            };
            let len = r.u8()? as usize;
            if len > NAME_MAX_BYTES {
                return Err(DecodeError::Invalid("name too long"));
            }
            let name = core::str::from_utf8(r.bytes(len)?)
                .map_err(|_| DecodeError::Invalid("name not utf-8"))?;
            EventBody::RiderJoined {
                slot,
                kind,
                name: name.to_owned(),
            }
        }
        2 => EventBody::RiderLeft { slot: r.u8()? },
        _ => return Err(DecodeError::Invalid("event kind")),
    };
    Ok(Event { id, body })
}

impl ServerMsg {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(512);
        match self {
            Self::Welcome(m) => {
                w.u8(kind::WELCOME);
                w.u16(m.version);
                w.u8(m.slot);
                w.u8(m.tick_hz);
                w.u8(m.snapshot_interval);
                w.u8(m.max_riders);
                w.u8(m.course as u8);
                w.u8(m.surface_kind as u8);
                w.u32(m.surface_seed);
                w.u32(m.server_tick);
                w.u16(m.echo_client_time);
            }
            Self::Reject(reason) => {
                w.u8(kind::REJECT);
                w.u8(*reason as u8);
            }
            Self::Snapshot(s) => {
                w.u8(kind::SNAPSHOT);
                w.u32(s.tick);
                w.u32(s.input_ack);
                w.i8(s.input_lead);
                w.u16(s.echo_client_time);
                w.u16(s.echo_hold_ms);
                w.u8(s.events.len() as u8);
                for e in &s.events {
                    write_event(&mut w, e);
                }
                w.u8(s.race.phase as u8);
                w.u32(s.race.phase_tick);
                w.u8(s.riders.len() as u8);
                for rs in &s.riders {
                    write_rider(&mut w, rs);
                }
            }
        }
        w.buf
    }

    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(buf);
        match r.u8()? {
            kind::WELCOME => {
                let version = r.u16()?;
                let slot = r.u8()?;
                let tick_hz = r.u8()?;
                let snapshot_interval = r.u8()?;
                let max_riders = r.u8()?;
                let course = CourseId::from_u8(r.u8()?).ok_or(DecodeError::Invalid("course"))?;
                let surface_kind =
                    SurfaceKind::from_u8(r.u8()?).ok_or(DecodeError::Invalid("surface kind"))?;
                let surface_seed = r.u32()?;
                let server_tick = r.u32()?;
                let echo_client_time = r.u16()?;
                if slot as usize >= MAX_RIDERS {
                    return Err(DecodeError::Invalid("slot"));
                }
                Ok(Self::Welcome(Welcome {
                    version,
                    slot,
                    tick_hz,
                    snapshot_interval,
                    max_riders,
                    course,
                    surface_kind,
                    surface_seed,
                    server_tick,
                    echo_client_time,
                }))
            }
            kind::REJECT => Ok(Self::Reject(RejectReason::from_u8(r.u8()?)?)),
            kind::SNAPSHOT => {
                let tick = r.u32()?;
                let input_ack = r.u32()?;
                let input_lead = r.i8()?;
                let echo_client_time = r.u16()?;
                let echo_hold_ms = r.u16()?;
                let n_events = r.u8()? as usize;
                if n_events > MAX_EVENTS_PER_SNAPSHOT {
                    return Err(DecodeError::Invalid("too many events"));
                }
                let events = (0..n_events)
                    .map(|_| read_event(&mut r))
                    .collect::<Result<Vec<_>, _>>()?;
                let race = Race {
                    phase: Phase::from_u8(r.u8()?).ok_or(DecodeError::Invalid("race phase"))?,
                    phase_tick: r.u32()?,
                };
                let n_riders = r.u8()? as usize;
                if n_riders > MAX_RIDERS {
                    return Err(DecodeError::Invalid("too many riders"));
                }
                let riders = (0..n_riders)
                    .map(|_| read_rider(&mut r))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(Self::Snapshot(Snapshot {
                    tick,
                    input_ack,
                    input_lead,
                    echo_client_time,
                    echo_hold_ms,
                    events,
                    race,
                    riders,
                }))
            }
            other => Err(DecodeError::UnknownMessage(other)),
        }
    }
}

/// Cuts a string to at most `max` bytes without splitting a character.
pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
