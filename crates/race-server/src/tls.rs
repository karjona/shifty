//! TLS for WebTransport. Two modes:
//! - **Domain:** a real certificate from disk (PEM).
//! - **Hash:** a self-signed ECDSA P-256 certificate valid for 13 days
//!   (browsers refuse `serverCertificateHashes` certs valid for more than
//!   14), regenerated every few days without dropping connections. The next
//!   certificate's hash is announced an hour before the switch, so every
//!   ticket in use names both.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::sync::RwLock;
use tracing::{info, warn};
use web_transport_quinn::quinn;

use crate::config::TlsMode;

pub const HASH_CERT_VALID_DAYS: i64 = 13;
/// Rotate well before expiry so clients holding the old hash still connect.
pub const HASH_CERT_ROTATE_AFTER: Duration = Duration::from_secs(6 * 24 * 3600);
/// The next certificate's hash is announced this long before the switch:
/// longer than a join token lives, so every ticket in use names both.
pub const HASH_CERT_HANDOVER: Duration = Duration::from_secs(3600);

#[derive(Clone, Debug, Default)]
pub struct CertInfo {
    /// Base64 SHA-256 of every certificate a client may meet (hash mode):
    /// the one served now first, then the next one during a hand-over.
    /// Empty in domain mode.
    pub hashes: Vec<String>,
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
                info: CertInfo::default(),
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
            hashes: vec![base64::engine::general_purpose::STANDARD.encode(hash.as_ref())],
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

/// Hash mode: replaces the endpoint's certificate every `every`, announcing
/// the next one in `cert` `handover` before the switch. Runs forever.
pub async fn rotate(
    endpoint: quinn::Endpoint,
    cert: Arc<RwLock<CertInfo>>,
    hostname: String,
    every: Duration,
    handover: Duration,
) {
    loop {
        tokio::time::sleep(every.saturating_sub(handover)).await;
        let (config, next) = loop {
            match self_signed(&hostname).and_then(|m| Ok((quic_server_config(&m)?, m.info))) {
                Ok(n) => break n,
                Err(e) => {
                    warn!(error = %e, "making the next certificate failed; retrying in a minute");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
        };
        {
            let mut now = cert.write().await;
            now.hashes.truncate(1);
            now.hashes.extend(next.hashes.iter().cloned());
        }
        info!(next_sha256 = %next.hashes.join(","), "next certificate announced");
        tokio::time::sleep(handover).await;
        endpoint.set_server_config(Some(config));
        info!(cert_sha256 = %next.hashes.join(","), "rotated self-signed certificate");
        *cert.write().await = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn announces_the_next_certificate_before_switching() {
        let m = self_signed("localhost").unwrap();
        let first = m.info.hashes.clone();
        assert_eq!(first.len(), 1);
        let endpoint = quinn::Endpoint::server(
            quic_server_config(&m).unwrap(),
            "127.0.0.1:0".parse().unwrap(),
        )
        .unwrap();
        let cert = Arc::new(RwLock::new(m.info));
        tokio::spawn(rotate(
            endpoint,
            cert.clone(),
            "localhost".into(),
            Duration::from_secs(2),
            Duration::from_secs(1),
        ));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let during = cert.read().await.hashes.clone();
        assert_eq!(during.len(), 2, "both certificates during the hand-over");
        assert_eq!(during[0], first[0]);
        assert_ne!(during[1], first[0]);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(cert.read().await.hashes, vec![during[1].clone()]);
    }
}
