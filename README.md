# 23.4° Shifty

An online racing game about one place and four seasons: jetski in summer, skateboard in fall, snowboard in winter, downhill bike in spring. A love letter to Wave Race, 1080°, SSX, skate and Downhill Domination. Made for GitHub Game Off 2026 (theme: **Shift**).

> 23.4° is Earth's axial tilt, the reason seasons exist. A shifty is a board trick: twist in the air, bring it back.

**Status:** milestone 1, "make it work". Boxes ride gentle ocean swells with up to 4 friends and some bots. The game logic and netcode are real: server-authoritative, client prediction, WebTransport. The art isn't there yet.

## Play locally

Needs Rust (the toolchain is pinned in `rust-toolchain.toml`), Node 24+ and pnpm, plus the `wasm-bindgen` CLI:

```sh
cargo install wasm-bindgen-cli --version 0.2.130 --locked
pnpm install
pnpm dev
```

Open <http://localhost:5173/?name=You> in two browser windows. Controls: gamepad (left stick, RT/LT, A) or keyboard (WASD/arrows, Space). F1 opens the netcode debug panel, which has fake lag and packet-loss sliders.

## How it works

```
Browser (Three.js WebGPU + Rust sim in WASM)
   │  inputs (60 Hz, redundant)        ▲ snapshots (30 Hz, ~150 B)
   ▼                                   │
Race server (Rust, WebTransport over UDP)
   └─ one authoritative room per race, same Rust sim, bit-identical to the WASM build
```

- The sim is written once in Rust. It runs natively on the server and as WASM in the browser, and CI checks that both give bit-identical results.
- Clients send only inputs. The server simulates. The client predicts everyone (your rider and the others, Rocket League style) and smooths corrections.
- Join tokens are signed by the lobby (Ed25519). Race servers can verify tokens but never create them.

See [AGENTS.md](AGENTS.md) for the full design, decisions and workflow.

## Layout

| Path                 | What                                                   |
| -------------------- | ------------------------------------------------------ |
| `crates/sim`         | Game logic and physics (pure, deterministic)           |
| `crates/protocol`    | Binary wire format, join tokens                        |
| `crates/client-core` | Client netcode: prediction, reconciliation, clock sync |
| `crates/race-server` | The authoritative server (WebTransport over UDP)       |
| `crates/sim-wasm`    | Browser bindings                                       |
| `crates/devkit`      | Dev tools: tokens, headless bots, determinism hash     |
| `apps/client`        | Vite + Three.js client                                 |
| `e2e`                | Playwright tests with real browsers                    |

## License

[Apache-2.0](LICENSE). If you redistribute this project, modified or not, keep the attribution in [NOTICE](NOTICE). The license grants no rights to the "23.4° Shifty" name.
