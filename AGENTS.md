# 23.4° Shifty

23.4° Shifty is an online web game that aims to recreate the great skate, waterski, and snowboarding games of the fifth and sixth console generation era.

## GitHub Game Off 2026

This is a fun little side project by solo-dev Kilian Arjona, a CTO in an enterprise software company with 20+ years of experience on IT. It will be submited as part of the GitHub Game Off game jam running during the month of November 2026.

Kilian is in charge of direction, production, vibes, taste, etc. but all code and art (including sfx) will be created by coding agents.

- Theme: **Shift**.
- We are **not trying to win** the Game Off. Do not consider changes to the game or the repo just to "score more points from the judges". Fun is paramount, jam is second.
- **Build it solid.** Cut scope by cutting content (events, locations, features), never by lowering architecture quality (server authority, cheat protection, proper netcode).

### Concept: one place, four seasons

Following the "shift" theme, we have devised a "Shifting Seasons" arch: a **grand prix** where each event is one season with a different sport. The season does **not** change during a race.

| Order in grand prix | Season | Sport | Inspired by | Where |
|---|---|---|---|---|
| 1 | Summer | Jetski | Wave Race 64, Wave Race: Blue Storm | Beach / sea |
| 2 | Fall | Skateboard | EA's skate (grounded, flick-it controls), the more grounded parts from Tony Hawk | Town |
| 3 | Winter | Snowboard | 1080° Snowboarding, the more grounded parts from SSX Tricky | Mountain |
| 4 | Spring | Downhill mountain bike | No Fear Downhill Mountain Biking, Downhill Domination | Forest trails |

- **Tone: grounded**, not over-the-top. Arcadey feel, but not juvenile humor or grinding on a lava pit. No sim either. Happy, fun in-between.
- **Location:** one "place" (region) for the jam: **Costa Nevada** ("snowy coast"), a fictional region where the beach and the ski slopes are close together. It can feel Mediterranean or Californian (there's a Sierra Nevada in Spain and in California). Each event uses its own part of it; it does **not** have to be the same circuit in every season.
- **Season transitions:** at the end of an event the camera pulls back over the whole place and time-lapses into the next season (inspired by Forza Horizon). This is how the theme shows.
- More locations later, if the jam version is fun.

### Build order

1. **Make it work**: foundation and netcode first (a box riding a plane, two browsers, a server-authoritative room, client prediction).
2. Jetski (summer)
3. Snowboard (winter)
4. Menus and customization
5. Skate (fall)
6. Downhill bike (spring)

## Gameplay

#### Pay respects to our greats

Wave Race, Blue Storm, 1080° Snowboarding, SSX Tricky, SSX 3, Tony Hawk 1-3, skate, No Fear Downhill Mountain Biking, Downhill Domination... They are all legendary, atemporal games. Our tone leans to the grounded ones.

### Design notes

- **Gamepad-first.** skate-style flick tricks need analog sticks. The Gamepad API works in all browsers. Keyboard must work, but second-class citizen.
- **Physics per sport.** Grounded means each sport has its own model: water and buoyancy (jetski), edge carving (snow), board flip physics (skate), suspension and traction (bike).
- **About the name**: 23.4° is the Earth's axial tilt, the reason seasons exist. A shifty is a snowboard and skate trick (twist the board in the air, bring it back). Always write it with the degree sign `°` (U+00B0), never `º`, and never round it to 23.5. Short name for the game is: **Shifty**, like it was **Tricky** for the old SSX 2.


### Customization

Character type, body, name, clothes... (Seasonal outfits fit the season concept.)

### Great multiplayer experience

Time trials with ghosts, matchmaking, rooms. Rocket League-style multiplayer engine: with "rollback netcode" à la FGC where it makes sense.

"Resort" with 2XKO/DBFighterZ/SF6/NBA2K style "matchmaking area", but it inside a "country club" inside of an Arcade/Town.

### Progression

Investigate what the greats did, copy where it makes sense, modern QoL where its better.

## Engineering

### Architecture

```
Browser (Vite + Three.js + TypeScript, Rust sim compiled to WASM)
 ├─ HTTPS / WebSocket ──► Lobby: TypeScript Worker + Durable Objects
 │                        site, login, matchmaking, rooms, Postgres
 │                             │ race servers register here
 │                             │ lobby signs a "join race" token
 │                             ▼
 └─ WebTransport ───────► Race server: native Rust (Docker)
      datagrams: inputs + snapshots (unreliable)
      stream:    start/finish/tricks/chat (reliable)
      fallback:  WebSocket when UDP is blocked
```

### Netcode

- **Server-authoritative**, Rocket League / Quake model (not peer-to-peer FGC rollback).
- Clients send **inputs only**, numbered per tick. Never positions.
- Server runs the sim at a fixed tick rate and sends snapshots.
- **Client prediction + reconciliation** for your own rider (this is our "rollback where it makes sense").
- **Interpolation** for other riders (about 100 ms in the past).
- **Server-side scoring and timing.** Ghosts and leaderboards only come from server-recorded runs, never from client uploads.
- Inputs are validated (clamped, rate-limited, max lag).
- **Protocol designed as if it were UDP**, even over WebSocket: self-contained or delta snapshots against an acknowledged baseline, redundant inputs, important events with IDs that are resent until acknowledged. Transport sits behind an interface (`send` / `onMessage`).
- Snapshots must fit one datagram (about 1,200 bytes). Use compact binary encoding.

### Race server

- One Rust binary, many rooms (one Tokio task per room). Docker image based on distroless, about 10-20 MB.
- WebTransport with **`web-transport-quinn` + `quinn`** (the stack behind Cloudflare's production MoQ relay).
- Ports: 443/UDP (WebTransport), 443/TCP (WebSocket fallback). Docker needs `-p 443:443/udp` explicitly, or `--network host`.
- Config through env vars: `LOBBY_URL`, `REGION`, `PUBLIC_ADDR`, `LOBBY_PUBLIC_KEY`.
- On boot it registers with the lobby and sends heartbeats (region, load).
- Verifies join tokens with the lobby's **public key only**. A race server can check tokens but never create them.
- Reports results to the lobby. **Race servers never touch Postgres.**
- Graceful shutdown on SIGTERM: no new rooms, finish current races, then exit.
- `/healthz`, logs to stdout, tick-time metrics.
- TLS, two modes:
  - **Domain mode:** real certificate (Let's Encrypt) mounted into the container.
  - **Hash mode:** short-lived self-signed cert generated at boot, hash sent to the lobby, browsers trust it via `serverCertificateHashes`. No domain needed (LAN, friend's PC).

### Lobby

- TypeScript Worker + Durable Objects. Runs on Cloudflare, or self-hosted with **`workerd`** (Cloudflare's open-source runtime) in Docker. Same code.
- **Durable Object state is temporary only** (rooms, presence, matchmaking queues), all rebuildable. **Postgres is the source of truth** (accounts, results, ghosts). This also makes workerd's experimental on-disk storage low-risk for self-hosters.
- Use WebSocket hibernation when idle so idle rooms cost nothing.

### Hosting

| Piece | Our official hosting | Self-hosted |
|---|---|---|
| Client | Cloudflare | workerd |
| Lobby | Cloudflare (Workers + Durable Objects) | workerd in Docker |
| Race server | VPS with UDP (provider TBD) | Docker anywhere |
| Postgres | TBD, reached through Hyperdrive | Docker |

Self-hosting target: `docker compose up` runs workerd + race-server + postgres.

### Repo layout

```
crates/
  sim/          # pure game logic: physics, tricks, scoring (no I/O)
  protocol/     # message types + binary encoding
  race-server/  # native binary: WebTransport, rooms, authority
  sim-wasm/     # wasm-bindgen wrapper: sim + protocol for the browser
apps/
  client/       # Vite + Three.js + TypeScript
  lobby/        # Cloudflare Worker + Durable Objects
```

The sim and the protocol are written once in Rust and used by both the race server (native) and the browser (WASM).

### Language

- **TypeScript:** client (rendering, UI, input, audio) and lobby.
- **Rust:** sim, protocol, race server.
- Pass state across the Rust/JS boundary with shared typed arrays, not many small calls.

### Engine

Three.js

### DB

Postgres

### Graphics

Blender. Characters aim for low-poly N64/PSX era. Environment, VFX, resolution, shadows, lighting, etc. with PS2/GC fidelity.
