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
use ed25519_dalek::{Signature, VerifyingKey};
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
    /// Room settings, applied when this token creates the room.
    #[serde(default)]
    pub bots: u8,
    #[serde(default)]
    pub surface: u8,
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
            bots: 2,
            surface: 1,
        }
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

    #[test]
    fn public_key_parses_both_base64_flavours() {
        let vk = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let url = b64(&vk.to_bytes());
        let std = base64::engine::general_purpose::STANDARD.encode(vk.to_bytes());
        assert_eq!(parse_public_key(&url).unwrap(), vk);
        assert_eq!(parse_public_key(&std).unwrap(), vk);
    }
}
