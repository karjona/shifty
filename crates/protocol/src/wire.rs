//! Minimal little-endian byte writer/reader. Hand-rolled on purpose: every
//! byte on the wire is visible here, and decoding never panics on hostile
//! input.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    UnexpectedEnd,
    UnknownMessage(u8),
    Invalid(&'static str),
}

impl core::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnexpectedEnd => write!(f, "message ended early"),
            Self::UnknownMessage(t) => write!(f, "unknown message type {t:#04x}"),
            Self::Invalid(why) => write!(f, "invalid message: {why}"),
        }
    }
}

impl std::error::Error for DecodeError {}

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn with_capacity(n: usize) -> Self {
        Self {
            buf: Vec::with_capacity(n),
        }
    }
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub fn i8(&mut self, v: i8) {
        self.buf.push(v as u8);
    }
    pub fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i16(&mut self, v: i16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn bytes(&mut self, v: &[u8]) {
        self.buf.extend_from_slice(v);
    }
    pub fn len(&self) -> usize {
        self.buf.len()
    }
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }
    fn take<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        let (head, rest) = self
            .buf
            .split_first_chunk::<N>()
            .ok_or(DecodeError::UnexpectedEnd)?;
        self.buf = rest;
        Ok(*head)
    }
    pub fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take::<1>()?[0])
    }
    pub fn i8(&mut self) -> Result<i8, DecodeError> {
        Ok(self.take::<1>()?[0] as i8)
    }
    pub fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    pub fn i16(&mut self) -> Result<i16, DecodeError> {
        Ok(i16::from_le_bytes(self.take()?))
    }
    pub fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    pub fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(i32::from_le_bytes(self.take()?))
    }
    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.buf.len() < n {
            return Err(DecodeError::UnexpectedEnd);
        }
        let (head, rest) = self.buf.split_at(n);
        self.buf = rest;
        Ok(head)
    }
    pub fn remaining(&self) -> usize {
        self.buf.len()
    }
}
