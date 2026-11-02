//! Network edges of the race server.
//!
//! - **Game traffic: WebTransport only** (QUIC datagrams over UDP), path
//!   `/race`. Each session becomes "datagrams in / datagrams out" channels
//!   handed to `conn::serve`, so the game logic stays transport-agnostic.
//!   No TCP fallback by design: the browser is for "no download", not for
//!   reaching networks that block UDP (see AGENTS.md).
//! - **Ops over HTTP (TCP):** `/healthz`, `/metrics`, `/cert-hash`. Never
//!   game traffic.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use bytes::Bytes;
use tokio::sync::{RwLock, mpsc};
use tracing::debug;
use web_transport_quinn::quinn;

use crate::config::Config;
use crate::conn::{self, OUT_QUEUE};
use crate::rooms::Rooms;
use crate::tls::CertInfo;

const MAX_MESSAGE: usize = protocol::MAX_DATAGRAM + 64;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub rooms: Arc<Rooms>,
    pub cert: Arc<RwLock<CertInfo>>,
}

// ---------------------------------------------------------------------------
// WebTransport

pub async fn serve_webtransport(endpoint: quinn::Endpoint, state: AppState) {
    let mut server = web_transport_quinn::Server::new(endpoint);
    while let Some(req) = server.accept().await {
        let state = state.clone();
        tokio::spawn(async move {
            if req.url.path() != "/race" {
                let _ = req
                    .reject(web_transport_quinn::http::StatusCode::NOT_FOUND)
                    .await;
                return;
            }
            let session = match req.ok().await {
                Ok(s) => s,
                Err(e) => {
                    debug!(error = %e, "webtransport handshake failed");
                    return;
                }
            };
            let conn = conn::next_conn_id();
            debug!(
                conn,
                max_datagram = session.max_datagram_size(),
                "webtransport session"
            );
            let (in_tx, in_rx) = mpsc::channel::<Bytes>(64);
            let (out_tx, mut out_rx) = mpsc::channel::<Bytes>(OUT_QUEUE);
            let reader = {
                let session = session.clone();
                tokio::spawn(async move {
                    while let Ok(d) = session.read_datagram().await {
                        if d.len() <= MAX_MESSAGE && in_tx.try_send(d).is_err() && in_tx.is_closed()
                        {
                            break;
                        }
                    }
                })
            };
            let writer = {
                let session = session.clone();
                tokio::spawn(async move {
                    while let Some(bytes) = out_rx.recv().await {
                        if let Err(e) = session.send_datagram(bytes) {
                            debug!(error = %e, "datagram send failed");
                            break;
                        }
                    }
                })
            };
            conn::serve(
                conn,
                "webtransport",
                in_rx,
                out_tx,
                state.config,
                state.rooms,
            )
            .await;
            // Let the last messages (e.g. a Reject) go out before closing.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            reader.abort();
            writer.abort();
            session.close(0, b"bye");
        });
    }
}

// ---------------------------------------------------------------------------
// HTTP (ops only): health, metrics, certificate hash

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/cert-hash", get(cert_hash))
        .with_state(state)
}

async fn healthz(State(s): State<AppState>) -> Response {
    if s.rooms.draining.load(Ordering::Relaxed) {
        (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response()
    } else {
        "ok".into_response()
    }
}

async fn metrics(State(s): State<AppState>) -> Response {
    let m = &s.rooms.metrics;
    let ticks = m.ticks.load(Ordering::Relaxed);
    let avg = m
        .tick_us_total
        .load(Ordering::Relaxed)
        .checked_div(ticks)
        .unwrap_or(0);
    let body = format!(
        "# race-server metrics\n\
         region {}\n\
         draining {}\n\
         rooms {}\n\
         connections {}\n\
         ticks_total {ticks}\n\
         tick_us_avg {avg}\n\
         tick_us_max {}\n\
         late_ticks_total {}\n\
         bad_tokens_total {}\n\
         bad_packets_total {}\n",
        s.config.region,
        u8::from(s.rooms.draining.load(Ordering::Relaxed)),
        m.rooms.load(Ordering::Relaxed),
        m.connections.load(Ordering::Relaxed),
        m.tick_us_max.load(Ordering::Relaxed),
        m.late_ticks.load(Ordering::Relaxed),
        m.bad_tokens.load(Ordering::Relaxed),
        m.bad_packets.load(Ordering::Relaxed),
    );
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

/// Public certificate hash (hash mode). In production the lobby gets this
/// through registration; this endpoint is a convenience for dev and LAN play.
async fn cert_hash(State(s): State<AppState>) -> Response {
    let cert = s.cert.read().await.clone();
    let body = serde_json::json!({
        "algorithm": "sha-256",
        "hash": cert.sha256_b64,
        "expires": cert.expires_unix,
        "publicAddr": s.config.public_addr,
    });
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], Json(body)).into_response()
}
