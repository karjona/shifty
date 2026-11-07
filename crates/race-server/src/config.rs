use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use protocol::token::VerifyingKey;

#[derive(Clone, Debug)]
pub enum TlsMode {
    /// Real certificate (e.g. Let's Encrypt) mounted into the container.
    Domain { cert: PathBuf, key: PathBuf },
    /// Short-lived self-signed certificate generated at boot; browsers trust
    /// it through `serverCertificateHashes`. No domain needed.
    Hash,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Address to listen on: UDP for WebTransport, TCP for ops HTTP.
    pub bind: SocketAddr,
    /// Public `host:port` clients use. Join tokens must name it as audience.
    pub public_addr: String,
    pub region: String,
    pub lobby_url: Option<String>,
    /// Shared secret for heartbeats and results sent to the lobby.
    pub race_server_secret: Option<String>,
    pub lobby_public_key: VerifyingKey,
    pub tls: TlsMode,
    /// On SIGTERM: how long to wait for rooms to finish before exiting.
    pub drain_timeout: Duration,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// `BIND`: where to listen (UDP for WebTransport, TCP for ops HTTP).
pub fn bind_from_env() -> Result<SocketAddr> {
    let bind = env("BIND").unwrap_or_else(|| "[::]:4433".into());
    bind.parse()
        .with_context(|| format!("BIND={bind} is not a socket address"))
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let key = env("LOBBY_PUBLIC_KEY")
            .context("LOBBY_PUBLIC_KEY is required (base64 Ed25519 public key of the lobby)")?;
        let tls = match (env("TLS_CERT"), env("TLS_KEY")) {
            (Some(cert), Some(key)) => TlsMode::Domain {
                cert: cert.into(),
                key: key.into(),
            },
            (None, None) => TlsMode::Hash,
            _ => {
                anyhow::bail!("set both TLS_CERT and TLS_KEY (domain mode) or neither (hash mode)")
            }
        };
        Ok(Self {
            bind: bind_from_env()?,
            public_addr: env("PUBLIC_ADDR").unwrap_or_else(|| "localhost:4433".into()),
            region: env("REGION").unwrap_or_else(|| "local".into()),
            lobby_url: env("LOBBY_URL"),
            race_server_secret: env("RACE_SERVER_SECRET"),
            lobby_public_key: protocol::token::parse_public_key(&key)
                .map_err(|e| anyhow::anyhow!("LOBBY_PUBLIC_KEY: {e}"))?,
            tls,
            drain_timeout: Duration::from_secs(
                env("DRAIN_TIMEOUT_SECS").map_or(Ok(900), |s| s.parse())?,
            ),
        })
    }
}
