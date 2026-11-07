//! Join tokens. The lobby signs them with its Ed25519 private key; race
//! servers verify them with the lobby's public key only. This module can
//! verify but deliberately cannot sign.
//!
//! Format (JWS-like, compact): `base64url(claims_json) "." base64url(signature)`
//! where the signature covers `"shifty-join-v1." + base64url(claims_json)`.
//! The domain prefix stops a signature made for anything else from being
//! replayed as a join token.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Signature;
pub use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

pub const SIGNING_DOMAIN: &[u8] = b"shifty-join-v1.";
/// Tokens valid for longer than this are refused, even if correctly signed.
pub const MAX_TOKEN_LIFETIME_SECS: u64 = 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinClaims {
    pub v: u8,
    /// Audience: the race server's public address. A token for one server
    /// cannot be used on another.
    pub aud: String,
    pub room: String,
    /// Player id (stable account id). Rejoining with the same id replaces the
    /// old connection.
    pub pid: String,
    pub name: String,
    /// Expiry, unix seconds.
    pub exp: u64,
    /// When the lobby signed the token, unix seconds (0 = unknown). A room
    /// whose plan is over refuses tokens signed before it ended.
    #[serde(default)]
    pub iat: u64,
    /// Room settings, applied when this token creates the room.
    #[serde(default)]
    pub bots: u8,
    /// How many people the lobby sent to this room: its first race waits on
    /// the grid until they have all arrived (or the wait is over). 0 = just
    /// whoever has joined.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub humans: u8,
    #[serde(default)]
    pub surface: u8,
    /// The course (`sim::CourseId`): 0 = the bay, 1 = the mountain run, 3 =
    /// the glades.
    #[serde(default)]
    pub course: u8,
    /// Every course the room races, in order (a Tilt has several).
    /// Empty = just `course`.
    #[serde(default)]
    pub events: Vec<u8>,
    /// The rider's appearance (look and outfits; `@shifty/rider` bytes,
    /// base64url). The race server passes it on to the room unread.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub look: String,
    /// The rider's setup per sport, in sport order (summer, winter):
    /// `sim::Setup` bytes, locked for the whole room plan.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setups: Vec<[u8; 4]>,
}

/// Most races in one room's plan.
pub const MAX_EVENTS: usize = 8;

fn is_zero(n: &u8) -> bool {
    *n == 0
}

impl JoinClaims {
    /// The appearance bytes (empty if absent).
    pub fn look_bytes(&self) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(&self.look).unwrap_or_default()
    }

    /// The courses the room races, in order.
    pub fn plan(&self) -> Vec<sim::CourseId> {
        let ids = if self.events.is_empty() {
            std::slice::from_ref(&self.course)
        } else {
            &self.events[..]
        };
        ids.iter()
            .filter_map(|&c| sim::CourseId::from_u8(c))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    BadSignature,
    Expired,
    TooLongLived,
    WrongAudience,
    BadClaims(&'static str),
}

impl core::fmt::Display for TokenError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for TokenError {}

/// Parses a base64url (or standard base64) Ed25519 public key.
pub fn parse_public_key(s: &str) -> Result<VerifyingKey, TokenError> {
    let s = s.trim();
    let bytes = URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(s))
        .map_err(|_| TokenError::Malformed)?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| TokenError::Malformed)?;
    VerifyingKey::from_bytes(&arr).map_err(|_| TokenError::Malformed)
}

/// The exact bytes a lobby signs for a given claims payload segment.
pub fn signing_input(payload_b64: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(SIGNING_DOMAIN.len() + payload_b64.len());
    m.extend_from_slice(SIGNING_DOMAIN);
    m.extend_from_slice(payload_b64.as_bytes());
    m
}

pub fn verify(
    token: &str,
    key: &VerifyingKey,
    expected_aud: &str,
    now_unix: u64,
) -> Result<JoinClaims, TokenError> {
    let (payload_b64, sig_b64) = token.split_once('.').ok_or(TokenError::Malformed)?;
    let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| TokenError::Malformed)?
        .try_into()
        .map_err(|_| TokenError::Malformed)?;
    let sig = Signature::from_bytes(&sig_bytes);
    key.verify_strict(&signing_input(payload_b64), &sig)
        .map_err(|_| TokenError::BadSignature)?;

    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| TokenError::Malformed)?;
    let claims: JoinClaims = serde_json::from_slice(&payload).map_err(|_| TokenError::Malformed)?;
    if claims.v != 1 {
        return Err(TokenError::BadClaims("version"));
    }
    if claims.exp <= now_unix {
        return Err(TokenError::Expired);
    }
    if claims.exp > now_unix + MAX_TOKEN_LIFETIME_SECS {
        return Err(TokenError::TooLongLived);
    }
    if claims.aud != expected_aud {
        return Err(TokenError::WrongAudience);
    }
    let id_ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !id_ok(&claims.room) {
        return Err(TokenError::BadClaims("room"));
    }
    if !id_ok(&claims.pid) {
        return Err(TokenError::BadClaims("pid"));
    }
    if claims.name.trim().is_empty() || claims.name.chars().any(char::is_control) {
        return Err(TokenError::BadClaims("name"));
    }
    if claims.bots as usize > sim::MAX_RIDERS {
        return Err(TokenError::BadClaims("bots"));
    }
    if sim::SurfaceKind::from_u8(claims.surface).is_none() {
        return Err(TokenError::BadClaims("surface"));
    }
    if sim::CourseId::from_u8(claims.course).is_none()
        || claims.events.len() > MAX_EVENTS
        || claims
            .events
            .iter()
            .any(|&c| sim::CourseId::from_u8(c).is_none())
    {
        return Err(TokenError::BadClaims("course"));
    }
    if claims.look.len() > crate::LOOK_MAX_BYTES.div_ceil(3) * 4
        || URL_SAFE_NO_PAD
            .decode(&claims.look)
            .map_or(true, |b| b.len() > crate::LOOK_MAX_BYTES)
    {
        return Err(TokenError::BadClaims("look"));
    }
    if claims.setups.len() > crate::MAX_SETUPS
        || claims
            .setups
            .iter()
            .any(|&b| !sim::Setup::from_bytes(b).is_valid())
    {
        return Err(TokenError::BadClaims("setups"));
    }
    Ok(claims)
}

/// Helper for tests and dev tools: encodes claims into the payload segment.
pub fn encode_claims(claims: &JoinClaims) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("claims serialize"))
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sign(claims: &JoinClaims, key: &SigningKey) -> String {
        let payload = encode_claims(claims);
        let sig = key.sign(&signing_input(&payload));
        format!("{payload}.{}", b64(&sig.to_bytes()))
    }

    fn claims() -> JoinClaims {
        JoinClaims {
            v: 1,
            aud: "race.example:443".into(),
            room: "room-1".into(),
            pid: "p_1".into(),
            name: "Kilian".into(),
            exp: 1_000_060,
            iat: 1_000_000,
            bots: 2,
            humans: 0,
            surface: 1,
            course: 1,
            events: vec![0, 1],
            look: b64(&[1, 0, 2, 3]),
            setups: vec![[3, 3, 3, 3], [6, 2, 2, 2]],
        }
    }

    #[test]
    fn rejects_bad_setups_and_looks() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let vk = key.verifying_key();
        let mut c = claims();
        c.setups = vec![[6, 6, 6, 6]];
        assert_eq!(
            verify(&sign(&c, &key), &vk, "race.example:443", 1_000_000),
            Err(TokenError::BadClaims("setups"))
        );
        let mut c = claims();
        c.look = b64(&[0; 200]);
        assert_eq!(
            verify(&sign(&c, &key), &vk, "race.example:443", 1_000_000),
            Err(TokenError::BadClaims("look"))
        );
        let mut c = claims();
        c.look = "not base64!".into();
        assert_eq!(
            verify(&sign(&c, &key), &vk, "race.example:443", 1_000_000),
            Err(TokenError::BadClaims("look"))
        );
    }

    #[test]
    fn valid_token_verifies() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let token = sign(&claims(), &key);
        let got = verify(&token, &key.verifying_key(), "race.example:443", 1_000_000).unwrap();
        assert_eq!(got, claims());
    }

    #[test]
    fn rejects_forgery_expiry_and_wrong_server() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[8; 32]);
        let vk = key.verifying_key();
        let token = sign(&claims(), &key);
        assert_eq!(
            verify(&sign(&claims(), &other), &vk, "race.example:443", 1_000_000),
            Err(TokenError::BadSignature)
        );
        assert_eq!(
            verify(&token, &vk, "race.example:443", 1_000_060),
            Err(TokenError::Expired)
        );
        assert_eq!(
            verify(&token, &vk, "elsewhere:443", 1_000_000),
            Err(TokenError::WrongAudience)
        );
        // Tampering with the payload breaks the signature.
        let (_, sig) = token.split_once('.').unwrap();
        let mut evil = claims();
        evil.name = "Admin".into();
        let forged = format!("{}.{sig}", encode_claims(&evil));
        assert_eq!(
            verify(&forged, &vk, "race.example:443", 1_000_000),
            Err(TokenError::BadSignature)
        );
        // Correctly signed but absurdly long-lived.
        let mut long = claims();
        long.exp = 1_000_000 + MAX_TOKEN_LIFETIME_SECS + 10;
        assert_eq!(
            verify(&sign(&long, &key), &vk, "race.example:443", 1_000_000),
            Err(TokenError::TooLongLived)
        );
        assert_eq!(
            verify("garbage", &vk, "race.example:443", 1_000_000),
            Err(TokenError::Malformed)
        );
    }

    /// The lobby's signer (apps/lobby/src/tickets.ts) signs this exact token
    /// for a Tilt (see apps/lobby/test/tickets.test.ts).
    #[test]
    fn verifies_a_token_signed_by_the_lobby() {
        const LOBBY_TOKEN: &str = "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjcsInN1cmZhY2UiOjEsImNvdXJzZSI6MCwiZXZlbnRzIjpbMCwxXX0.3_soaIfoUK8Ujek_VchbKyUP_9Fzzep3homz5Mz1J0rWm1SkUsVAEEB8Kj1khh6aS7SSpSR8584JgtKMg7M0DA";
        let vk = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let claims = verify(LOBBY_TOKEN, &vk, "race.example:443", 1_000_000).unwrap();
        assert_eq!(claims.room, "m_test");
        assert_eq!(claims.pid, "user_1");
        assert_eq!(claims.name, "Lord Kylian#0042");
        assert_eq!(claims.bots, 7);
        assert_eq!(claims.iat, 1_000_000);
        assert_eq!(
            claims.plan(),
            vec![sim::CourseId::Oval, sim::CourseId::Mountain]
        );
    }

    /// The same Tilt with a rider on it (see tickets.test.ts too).
    #[test]
    fn verifies_a_lobby_token_with_a_rider() {
        const LOBBY_TOKEN: &str = "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjcsInN1cmZhY2UiOjEsImNvdXJzZSI6MCwiZXZlbnRzIjpbMCwxXSwibG9vayI6IkFRQUJBZ00iLCJzZXR1cHMiOltbMywzLDMsM10sWzYsMiwyLDJdXX0.1tSmr7BgiTu6PSO6_gr6O_t5PqiFcJX9mDsXAyW8lYHBoAn9LD5NKL6NxyeTqhZQhIkQQ607nZsMmVAY-U1JBw";
        let vk = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let claims = verify(LOBBY_TOKEN, &vk, "race.example:443", 1_000_000).unwrap();
        assert_eq!(claims.look_bytes(), vec![1, 0, 1, 2, 3]);
        assert_eq!(claims.setups, vec![[3, 3, 3, 3], [6, 2, 2, 2]]);
    }

    /// A Tilt the lobby sent three people to (see tickets.test.ts too).
    #[test]
    fn verifies_a_lobby_token_with_its_humans() {
        const LOBBY_TOKEN: &str = "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjUsInN1cmZhY2UiOjEsImNvdXJzZSI6MCwiZXZlbnRzIjpbMCwxXSwiaHVtYW5zIjozfQ.GisI8PPr26yGWDatniD0Cfb_Sd978ZlgfunycDWm2rcxn--37s3Jur7AEo_VYNzipROuAHDJLHiwtYtVpllMBQ";
        let vk = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let claims = verify(LOBBY_TOKEN, &vk, "race.example:443", 1_000_000).unwrap();
        assert_eq!((claims.humans, claims.bots), (3, 5));
    }

    #[test]
    fn public_key_parses_both_base64_flavours() {
        let vk = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let url = b64(&vk.to_bytes());
        let std = base64::engine::general_purpose::STANDARD.encode(vk.to_bytes());
        assert_eq!(parse_public_key(&url).unwrap(), vk);
        assert_eq!(parse_public_key(&std).unwrap(), vk);
    }
}
