//! TLS for WebTransport. Two modes:
//! - **Domain:** a real certificate from disk (PEM).
//! - **Hash:** a self-signed ECDSA P-256 certificate valid for 13 days
//!   (browsers refuse `serverCertificateHashes` certs valid for more than
//!   14), regenerated every few days without dropping connections.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use web_transport_quinn::quinn;

use crate::config::TlsMode;

pub const HASH_CERT_VALID_DAYS: i64 = 13;
/// Rotate well before expiry so clients holding the old hash still connect.
pub const HASH_CERT_ROTATE_AFTER: Duration = Duration::from_secs(6 * 24 * 3600);

#[derive(Clone, Debug)]
pub struct CertInfo {
    /// SHA-256 of the DER certificate, base64. Only meaningful in hash mode.
    pub sha256_b64: Option<String>,
    pub expires_unix: Option<i64>,
}

pub struct Material {
    pub chain: Vec<CertificateDer<'static>>,
    pub key: PrivateKeyDer<'static>,
    pub info: CertInfo,
}

pub fn load(mode: &TlsMode, hostname: &str) -> Result<Material> {
    match mode {
        TlsMode::Domain { cert, key } => {
            let chain = CertificateDer::pem_file_iter(cert)
                .with_context(|| format!("reading {}", cert.display()))?
                .collect::<Result<Vec<_>, _>>()?;
            let key = PrivateKeyDer::from_pem_file(key)
                .with_context(|| format!("reading {}", key.display()))?;
            Ok(Material {
                chain,
                key,
                info: CertInfo {
                    sha256_b64: None,
                    expires_unix: None,
                },
            })
        }
        TlsMode::Hash => self_signed(hostname),
    }
}

pub fn self_signed(hostname: &str) -> Result<Material> {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
    let mut names = vec!["localhost".to_string()];
    if hostname != "localhost" {
        names.push(hostname.to_string());
    }
    let mut params = rcgen::CertificateParams::new(names)?;
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::hours(1);
    let not_after = now + time::Duration::days(HASH_CERT_VALID_DAYS);
    params.not_after = not_after;
    let cert = params.self_signed(&key)?;
    let der = cert.der().clone();
    let provider = web_transport_quinn::crypto::default_provider();
    let hash = web_transport_quinn::crypto::sha256(&provider, &der);
    Ok(Material {
        chain: vec![der],
        key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        info: CertInfo {
            sha256_b64: Some(base64::engine::general_purpose::STANDARD.encode(hash.as_ref())),
            expires_unix: Some(not_after.unix_timestamp()),
        },
    })
}

pub fn quic_server_config(m: &Material) -> Result<quinn::ServerConfig> {
    let mut tls = rustls::ServerConfig::builder_with_provider(
        web_transport_quinn::crypto::default_provider(),
    )
    .with_protocol_versions(&[&rustls::version::TLS13])?
    .with_no_client_auth()
    .with_single_cert(m.chain.clone(), m.key.clone_key())?;
    tls.alpn_protocols = vec![web_transport_quinn::ALPN.as_bytes().to_vec()];
    let tls: quinn::crypto::rustls::QuicServerConfig = tls.try_into()?;
    let mut cfg = quinn::ServerConfig::with_crypto(Arc::new(tls));
    let mut t = quinn::TransportConfig::default();
    t.max_idle_timeout(Some(Duration::from_secs(10).try_into()?));
    t.keep_alive_interval(Some(Duration::from_secs(2)));
    cfg.transport_config(Arc::new(t));
    Ok(cfg)
}
