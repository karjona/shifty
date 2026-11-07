//! Talking to the lobby: heartbeats (so it can send players here) and race
//! results. Both authenticate with the shared `RACE_SERVER_SECRET`.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{RwLock, mpsc};
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::room::RaceReport;
use crate::rooms::Rooms;
use crate::tls::CertInfo;

pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(5);
const REPORT_RETRIES: u32 = 5;
const REPORT_QUEUE: usize = 256;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat<'a> {
    addr: &'a str,
    region: &'a str,
    /// The release this server runs; the lobby only sends players to its own.
    version: &'static str,
    cert_hashes: Vec<String>,
    rooms: usize,
    humans: usize,
    draining: bool,
}

#[derive(Clone)]
pub struct Lobby {
    http: reqwest::Client,
    url: String,
    secret: String,
}

impl Lobby {
    pub fn new(url: &str, secret: &str) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?,
            url: url.trim_end_matches('/').to_owned(),
            secret: secret.to_owned(),
        })
    }

    async fn post<T: Serialize + ?Sized>(&self, path: &str, body: &T) -> anyhow::Result<()> {
        let res = self
            .http
            .post(format!("{}{path}", self.url))
            .bearer_auth(&self.secret)
            .json(body)
            .send()
            .await?;
        if !res.status().is_success() {
            anyhow::bail!("{path}: lobby answered {}", res.status());
        }
        Ok(())
    }

    /// Tells the lobby this server is up, every few seconds, until the process ends.
    pub async fn heartbeats(
        self,
        config: Arc<Config>,
        rooms: Arc<Rooms>,
        cert: Arc<RwLock<CertInfo>>,
    ) {
        let mut ok = false;
        let mut interval = tokio::time::interval(HEARTBEAT_EVERY);
        loop {
            interval.tick().await;
            let cert_hashes = cert.read().await.hashes.clone();
            let beat = Heartbeat {
                addr: &config.public_addr,
                region: &config.region,
                version: env!("CARGO_PKG_VERSION"),
                cert_hashes,
                rooms: rooms.room_count(),
                humans: rooms.metrics.humans.load(Ordering::Relaxed),
                draining: rooms.draining.load(Ordering::Relaxed),
            };
            match self.post("/api/servers/heartbeat", &beat).await {
                Ok(()) if !ok => {
                    info!(lobby = %self.url, "registered with the lobby");
                    ok = true;
                }
                Ok(()) => {}
                Err(e) if ok => {
                    warn!(error = %e, "lobby heartbeat failed");
                    ok = false;
                }
                Err(e) => debug!(error = %e, "lobby heartbeat failed"),
            }
        }
    }

    /// A channel for finished races; a task sends them to the lobby, retrying
    /// a few times when it can't be reached.
    pub fn reporter(self) -> mpsc::Sender<RaceReport> {
        let (tx, mut rx) = mpsc::channel::<RaceReport>(REPORT_QUEUE);
        tokio::spawn(async move {
            while let Some(report) = rx.recv().await {
                let mut wait = Duration::from_secs(1);
                for attempt in 1..=REPORT_RETRIES {
                    match self.post("/api/servers/results", &report).await {
                        Ok(()) => break,
                        Err(e) if attempt == REPORT_RETRIES => {
                            warn!(room = %report.room, error = %e, "race result not reported")
                        }
                        Err(_) => {
                            tokio::time::sleep(wait).await;
                            wait *= 3;
                        }
                    }
                }
            }
        });
        tx
    }
}
