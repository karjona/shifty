//! Race server: one native binary, many rooms. Game traffic is WebTransport
//! over UDP only; plain HTTP on TCP (same port number) serves ops endpoints.
//!
//! `race-server healthcheck` checks a running server's `/healthz` (exit 0
//! when healthy), for container health checks.
//!
//! Env: `LOBBY_PUBLIC_KEY` (required), `PUBLIC_ADDR`, `BIND`, `REGION`,
//! `LOBBY_URL` + `RACE_SERVER_SECRET` (report to the lobby), `TLS_CERT` +
//! `TLS_KEY` (domain mode; otherwise hash mode), `DRAIN_TIMEOUT_SECS`,
//! `RUST_LOG`.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use race_server::config::{Config, TlsMode};
use race_server::lobby::Lobby;
use race_server::rooms::Rooms;
use race_server::tls;
use race_server::transport::{self, AppState};
use tokio::sync::RwLock;
use tracing::{info, warn};
use web_transport_quinn::quinn;

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        let ok = transport::healthy(race_server::config::bind_from_env()?);
        std::process::exit(if ok { 0 } else { 1 });
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    let host = config
        .public_addr
        .rsplit_once(':')
        .map_or(config.public_addr.as_str(), |(h, _)| h);
    let material = tls::load(&config.tls, host)?;
    let cert = Arc::new(RwLock::new(material.info.clone()));
    let endpoint = quinn::Endpoint::server(tls::quic_server_config(&material)?, config.bind)
        .with_context(|| format!("binding UDP {}", config.bind))?;

    let rooms = Rooms::new();
    let state = AppState {
        config: config.clone(),
        rooms: rooms.clone(),
        cert: cert.clone(),
    };

    let tcp = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("binding TCP {}", config.bind))?;
    info!(
        bind = %config.bind,
        public_addr = %config.public_addr,
        region = %config.region,
        tls = if matches!(config.tls, TlsMode::Hash) { "hash" } else { "domain" },
        cert_sha256 = material.info.hashes.first().map_or("-", String::as_str),
        "race server listening (WebTransport on UDP /race; ops HTTP on TCP: /healthz /metrics /cert-hash)"
    );
    match (&config.lobby_url, &config.race_server_secret) {
        (Some(url), Some(secret)) => {
            let lobby = Lobby::new(url, secret)?;
            rooms.report_to(lobby.clone().reporter());
            rooms.report_runs_to(lobby.clone().run_reporter(config.public_addr.clone()));
            tokio::spawn(lobby.heartbeats(config.clone(), rooms.clone(), cert.clone()));
        }
        (Some(_), None) => {
            warn!("LOBBY_URL is set but RACE_SERVER_SECRET is not; running standalone")
        }
        (None, _) => info!("LOBBY_URL not set; running standalone"),
    }

    // Hash mode: rotate the short-lived certificate without dropping sessions.
    if matches!(config.tls, TlsMode::Hash) {
        tokio::spawn(tls::rotate(
            endpoint.clone(),
            cert.clone(),
            host.to_owned(),
            tls::HASH_CERT_ROTATE_AFTER,
            tls::HASH_CERT_HANDOVER,
        ));
    }

    let wt = tokio::spawn(transport::serve_webtransport(
        endpoint.clone(),
        state.clone(),
    ));
    let http = tokio::spawn(async move { axum::serve(tcp, transport::router(state)).await });

    shutdown_signal().await;
    info!("shutdown requested: refusing new rooms, waiting for current rooms to finish");
    rooms.draining.store(true, Ordering::Relaxed);
    let deadline = Instant::now() + config.drain_timeout;
    while rooms.room_count() > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if rooms.room_count() > 0 {
        warn!(
            rooms = rooms.room_count(),
            "drain timeout reached; exiting with rooms still open"
        );
    }
    endpoint.close(0u32.into(), b"server shutting down");
    wt.abort();
    http.abort();
    info!("bye");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}
