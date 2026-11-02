//! Dev-only tools. Never part of a deployment.
//!
//! ```text
//! devkit determinism [ticks]            native determinism hash
//! devkit token --room r --name n [--aud localhost:4433] [--bots 0] [--surface 1] [--pid p]
//! devkit bots --url ws://localhost:4433/ws [--count 3] [--room dev] [--seconds 20] [--lag-ms 0] [--loss 0.0]
//! ```
//!
//! Tokens are signed with the dev lobby key in `.dev/lobby-key.json` (created
//! by `pnpm dev`). The real lobby signs with its own key; race servers only
//! ever hold the public half.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use client_core::{Client, Phase};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use protocol::token::{JoinClaims, b64, encode_claims, signing_input};
use serde::Deserialize;
use sim::Input;
use sim::math::Pcg32;
use tokio_tungstenite::tungstenite::Message;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevKey {
    private_key: String,
}

fn args_map(args: &[String]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let mut it = args.iter();
    while let Some(k) = it.next() {
        if let Some(k) = k.strip_prefix("--") {
            m.insert(k.to_owned(), it.next().cloned().unwrap_or_default());
        }
    }
    m
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_dev_key() -> Result<SigningKey> {
    let path = repo_root().join(".dev/lobby-key.json");
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "reading {} (run `pnpm dev` once to create it)",
            path.display()
        )
    })?;
    let key: DevKey = serde_json::from_str(&raw)?;
    let seed = base64_decode(&key.private_key)?;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| anyhow::anyhow!("dev private key must be 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    // Tiny base64url decoder to avoid another dependency here.
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.trim().trim_end_matches('=').bytes() {
        let c = match c {
            b'+' => b'-',
            b'/' => b'_',
            c => c,
        };
        let v = alphabet
            .iter()
            .position(|&a| a == c)
            .context("bad base64")? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

pub fn mint(key: &SigningKey, claims: &JoinClaims) -> String {
    let payload = encode_claims(claims);
    let sig = key.sign(&signing_input(&payload));
    format!("{payload}.{}", b64(&sig.to_bytes()))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn claims_from(m: &HashMap<String, String>, pid: &str, name: &str) -> Result<JoinClaims> {
    Ok(JoinClaims {
        v: 1,
        aud: m
            .get("aud")
            .cloned()
            .unwrap_or_else(|| "localhost:4433".into()),
        room: m.get("room").cloned().unwrap_or_else(|| "dev".into()),
        pid: pid.into(),
        name: name.into(),
        exp: now_unix() + 10 * 60,
        bots: m.get("bots").map_or(Ok(0), |b| b.parse())?,
        surface: m.get("surface").map_or(Ok(1), |b| b.parse())?,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else {
        bail!("usage: devkit <determinism|token|bots> ...")
    };
    let m = args_map(&args[1..]);
    match cmd.as_str() {
        "determinism" => {
            let ticks = args.get(1).map_or(Ok(3000), |t| t.parse())?;
            println!("{:016x}", sim::determinism_scenario(ticks));
        }
        "token" => {
            let name = m.get("name").cloned().unwrap_or_else(|| "Dev".into());
            let pid = m
                .get("pid")
                .cloned()
                .unwrap_or_else(|| format!("dev-{}", name.to_lowercase()));
            println!("{}", mint(&load_dev_key()?, &claims_from(&m, &pid, &name)?));
        }
        "bots" => run_bots(&m).await?,
        other => bail!("unknown command {other}"),
    }
    Ok(())
}

/// Headless players: real `client_core::Client`s over a real WebSocket, with
/// optional artificial lag and loss. Prints their netcode stats.
async fn run_bots(m: &HashMap<String, String>) -> Result<()> {
    let url = m
        .get("url")
        .cloned()
        .unwrap_or_else(|| "ws://localhost:4433/ws".into());
    let count: usize = m.get("count").map_or(Ok(3), |c| c.parse())?;
    let seconds: u64 = m.get("seconds").map_or(Ok(20), |c| c.parse())?;
    let lag_ms: f64 = m.get("lag-ms").map_or(Ok(0.0), |c| c.parse())?;
    let loss: f64 = m.get("loss").map_or(Ok(0.0), |c| c.parse())?;
    let key = load_dev_key()?;
    let mut tasks = Vec::new();
    for i in 0..count {
        let claims = claims_from(m, &format!("headless-{i}"), &format!("Headless {}", i + 1))?;
        let token = mint(&key, &claims);
        let url = url.clone();
        tasks.push(tokio::spawn(async move {
            run_bot(i, url, token, seconds, lag_ms, loss).await
        }));
    }
    let mut failed = false;
    for t in tasks {
        if let Err(e) = t.await? {
            eprintln!("bot failed: {e:#}");
            failed = true;
        }
    }
    if failed {
        bail!("some bots failed");
    }
    Ok(())
}

async fn run_bot(
    i: usize,
    url: String,
    token: String,
    seconds: u64,
    lag_ms: f64,
    loss: f64,
) -> Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .with_context(|| format!("connecting to {url}"))?;
    let (mut tx, mut rx) = ws.split();
    let mut client = Client::new(token);
    let start = Instant::now();
    let now_ms = || start.elapsed().as_secs_f64() * 1000.0;
    let mut rng = Pcg32::new(i as u64 + 1);
    // Artificial one-way delay queues.
    let mut up: VecDeque<(f64, Vec<u8>)> = VecDeque::new();
    let mut down: VecDeque<(f64, Vec<u8>)> = VecDeque::new();
    let mut frame = tokio::time::interval(Duration::from_millis(8));
    let mut report = tokio::time::interval(Duration::from_secs(2));
    let deadline = start + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        tokio::select! {
            _ = frame.tick() => {
                let now = now_ms();
                while down.front().is_some_and(|(at, _)| *at <= now) {
                    let (_, bytes) = down.pop_front().expect("front");
                    client.handle_packet(&bytes, now);
                }
                let steer = ((now / 900.0 + i as f64).sin() * 0.7) as f32;
                let jump = u8::from((now as u64 / 100) % 40 == i as u64);
                client.update(now, Input::from_analog(steer, 1.0, jump));
                for p in client.take_outgoing() {
                    if f64::from(rng.next_f32()) >= loss {
                        up.push_back((now + lag_ms / 2.0, p));
                    }
                }
                while up.front().is_some_and(|(at, _)| *at <= now) {
                    let (_, bytes) = up.pop_front().expect("front");
                    tx.send(Message::Binary(bytes.into())).await?;
                }
                if let Phase::Rejected(r) = client.phase() {
                    bail!("bot {i} rejected: {r:?}");
                }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Binary(b))) => {
                        if f64::from(rng.next_f32()) >= loss {
                            down.push_back((now_ms() + lag_ms / 2.0, b.to_vec()));
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => bail!("bot {i}: server closed the connection"),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                }
            }
            _ = report.tick() => {
                let s = client.stats();
                println!(
                    "bot {i}: {:?} slot={:?} rtt={:.0}ms lead={} scale={:.3} tick={} snaps={} mispredict={} lastErr={:.3}m resyncs={} snapBytes={}",
                    client.phase(), client.slot(), s.rtt_ms, s.input_lead, s.time_scale, s.predicted_tick,
                    s.snapshots, s.mispredictions, s.last_correction_m, s.resyncs, s.last_snapshot_bytes
                );
            }
        }
    }
    let _ = tx
        .send(Message::Binary(protocol::ClientMsg::Bye.encode().into()))
        .await;
    if client.phase() != Phase::Joined {
        bail!("bot {i} never joined");
    }
    Ok(())
}
