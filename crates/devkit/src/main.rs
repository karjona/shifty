//! Dev-only tools. Never part of a deployment.
//!
//! ```text
//! devkit determinism [ticks]            native determinism hash
//! devkit token --room r --name n [--aud localhost:4433] [--bots 0] [--humans 0] [--surface 1] [--course 0] [--pid p]
//! devkit bots [--server localhost:4433] [--count 3] [--room dev] [--seconds 20] [--lag-ms 0] [--loss 0.0] [--humans 0] [--loading 0]
//! ```
//!
//! Tokens are signed with the dev lobby key in `.dev/lobby-key.json` (created
//! by `pnpm dev`). In production the lobby signs with its own key; race
//! servers only ever hold the public half.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use client_core::{Client, Phase};
use ed25519_dalek::{Signer, SigningKey};
use protocol::token::{JoinClaims, b64, encode_claims, signing_input};
use serde::Deserialize;
use sim::Input;
use sim::math::Pcg32;

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
        iat: now_unix(),
        bots: m.get("bots").map_or(Ok(0), |b| b.parse())?,
        humans: m.get("humans").map_or(Ok(0), |b| b.parse())?,
        surface: m.get("surface").map_or(Ok(1), |b| b.parse())?,
        course: m.get("course").map_or(Ok(0), |b| b.parse())?,
        events: m.get("events").map_or(Ok(vec![]), |list| {
            list.split(',')
                .map(str::parse)
                .collect::<Result<Vec<u8>, _>>()
        })?,
        look: String::new(),
        setups: Vec::new(),
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

/// Headless players: real `client_core::Client`s over real WebTransport,
/// with optional artificial lag and loss. They have nothing to load, so
/// they are ready for every race at once, or after `--loading` seconds (a
/// slow screen holding the grid). Prints their netcode stats.
async fn run_bots(m: &HashMap<String, String>) -> Result<()> {
    let server = m
        .get("server")
        .cloned()
        .unwrap_or_else(|| "localhost:4433".into());
    // Hash mode: trust the race server's self-signed cert by its hash,
    // exactly like browsers do with `serverCertificateHashes`.
    let cert_hash = fetch_cert_hash(&server).await?;
    let wt = web_transport_quinn::ClientBuilder::new()
        .with_server_certificate_hashes(vec![cert_hash])
        .context("building WebTransport client")?;
    let url: url::Url = format!("https://{server}/race").parse()?;
    let count: usize = m.get("count").map_or(Ok(3), |c| c.parse())?;
    let seconds: u64 = m.get("seconds").map_or(Ok(20), |c| c.parse())?;
    let lag_ms: f64 = m.get("lag-ms").map_or(Ok(0.0), |c| c.parse())?;
    let loss: f64 = m.get("loss").map_or(Ok(0.0), |c| c.parse())?;
    let loading: f64 = m.get("loading").map_or(Ok(0.0), |c| c.parse())?;
    let key = load_dev_key()?;
    let mut tasks = Vec::new();
    for i in 0..count {
        let claims = claims_from(m, &format!("headless-{i}"), &format!("Headless {}", i + 1))?;
        let token = mint(&key, &claims);
        let session = wt
            .connect(url.clone())
            .await
            .with_context(|| format!("connecting to {url}"))?;
        tasks.push(tokio::spawn(async move {
            run_bot(i, session, token, seconds, lag_ms, loss, loading).await
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

/// GETs `/cert-hash` from the race server's ops HTTP port (dev only).
async fn fetch_cert_hash(server: &str) -> Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut tcp = tokio::net::TcpStream::connect(server)
        .await
        .with_context(|| format!("race server not reachable at {server}"))?;
    let host = server.rsplit_once(':').map_or(server, |(h, _)| h);
    tcp.write_all(format!("GET /cert-hash HTTP/1.0\r\nHost: {host}\r\n\r\n").as_bytes())
        .await?;
    let mut raw = String::new();
    tcp.read_to_string(&mut raw).await?;
    let body = raw.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    let json: serde_json::Value = serde_json::from_str(body).context("parsing /cert-hash")?;
    let hash = json["hash"]
        .as_str()
        .context("race server has no certificate hash (domain mode?)")?;
    base64_decode(hash)
}

async fn run_bot(
    i: usize,
    session: web_transport_quinn::Session,
    token: String,
    seconds: u64,
    lag_ms: f64,
    loss: f64,
    loading: f64,
) -> Result<()> {
    // Datagrams in, on their own task; this loop owns the client.
    let (in_tx, mut rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(256);
    let reader = {
        let session = session.clone();
        tokio::spawn(async move {
            while let Ok(d) = session.read_datagram().await {
                if in_tx.send(d).await.is_err() {
                    break;
                }
            }
        })
    };
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
                let lean = ((now / 1300.0 + i as f64).cos() * 0.8) as f32;
                let loaded = now >= loading * 1000.0;
                client.set_ready(loaded.then(|| client.event_index()));
                client.update(now, Input::from_analog(steer, 1.0, lean, 0));
                for p in client.take_outgoing() {
                    if f64::from(rng.next_f32()) >= loss {
                        up.push_back((now + lag_ms / 2.0, p));
                    }
                }
                while up.front().is_some_and(|(at, _)| *at <= now) {
                    let (_, bytes) = up.pop_front().expect("front");
                    session.send_datagram(bytes.into())?;
                }
                if let Phase::Rejected(r) = client.phase() {
                    bail!("bot {i} rejected: {r:?}");
                }
            }
            msg = rx.recv() => {
                let Some(b) = msg else { bail!("bot {i}: server closed the session") };
                if f64::from(rng.next_f32()) >= loss {
                    down.push_back((now_ms() + lag_ms / 2.0, b.to_vec()));
                }
            }
            _ = report.tick() => {
                let s = client.stats();
                println!(
                    "bot {i}: {:?} slot={:?} race={:?} rtt={:.0}ms lead={} scale={:.3} tick={} snaps={} mispredict={} lastErr={:.3}m resyncs={} snapBytes={}",
                    client.phase(), client.slot(), client.race().phase, s.rtt_ms, s.input_lead, s.time_scale, s.predicted_tick,
                    s.snapshots, s.mispredictions, s.last_correction_m, s.resyncs, s.last_snapshot_bytes
                );
            }
        }
    }
    let _ = session.send_datagram(protocol::ClientMsg::Bye.encode().into());
    reader.abort();
    session.close(0, b"bye");
    if client.phase() != Phase::Joined {
        bail!("bot {i} never joined");
    }
    Ok(())
}
