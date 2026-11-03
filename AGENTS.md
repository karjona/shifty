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
- **Tricks never make you faster**, in any sport: races are won on the line and the clock. Tricks score style points (what style earns is decided later, maybe customization), and a bail still costs you.
- **Split times:** at every checkpoint (and the finish) the HUD shows your gap to the first rider through it, or your time if you are first.
- **About the name**: 23.4° is the Earth's axial tilt, the reason seasons exist. A shifty is a snowboard and skate trick (twist the board in the air, bring it back). Always write it with the degree sign `°` (U+00B0), never `º`. Short name for the game is: **Shifty**, like it was **Tricky** for the old SSX 2.

### Jetski (summer)

- **Course:** an oval in the bay around a breakwater, past a small island and along the town quay (land is solid, in the sim); buoys to pass on the correct side (red on your right, green on your left), floating ramps, three laps. Rooms loop warm-up → countdown → race → results.
- **Air comes from waves and ramps only.** No jump button: pulling back (lean) as you leave a crest pops you higher.
- **One speed meter, passive:** clean buoy passes fill it and raise top speed; a missed buoy or a bail empties it. Missing buoys never disqualifies.
- **Tricks:** hold a trick button in the air and push the stick (spins, flips, barrel rolls). Land crooked and you bail.

### Snowboard (winter)

- **Course:** one run down the mountain (~2.2 km, about 90 s), from the summit start hut to the village: wide open slopes with sweeping turns, rollers and tables, tree-lined S-turns past the chairlift, a bench ending in a cliff drop, a winding gully, side kickers, a final pitch. Checkpoints across the run (you can't miss them), then the finish. Rooms loop warm-up → countdown → race → results.
- **The mountain is one height function in `crates/sim/src/mountain.rs`:** slope bands along Z, a valley that follows the run, noise; the run carved into it (a level bench, banked in turns, tables, rollers, a gully, berms where the slope falls away). The client draws the snow from those same heights, so what you see is what you ride.
- **Gravity is the engine:** carve (the edge turns sideways speed into speed along the board; fast turns are wide), tuck for speed (stick up), sit back to skid and brake (stick down), skate when slow. The board flies wherever the snow falls away faster than gravity can follow (lips, knuckles, the cliff).
- **Jump button:** hold to crouch and load, let go to pop (bigger the longer you loaded). Letting go at a lip adds to the lip's launch; a few ticks late still pops.
- **Tricks only score points** (no speed meter): the trick button + stick spins (in 180s) and flips, the grab button grabs (the stick picks Indy, nose, tail, melon or method). Let go and the rider finishes toward the nearest way to land, forward or switch. Land along the direction of travel, flat on the slope and not still grabbing, or you fall. In between is **sketchy**: a little crooked, or slammed into the snow, and you lose some speed, wobble for a moment (weaker edge, no loading a jump) and the trick scores half. Trees, rocks and lift towers knock you down.
- **Look:** 1080° Avalanche framing. The camera is close and low, the rider fills about half the screen's height, the view tips down the slope so the snow rushing past fills the screen to about a third from the top, the horizon leans with the slope, and in the air the camera's height lags so the rider drops in the frame.
- **Snow you can read:** a low sun ahead of the riders, shade baked into faces that rise toward you and into hollows (so rollers and kickers show even in flat light), blue dye lines on lips, knuckles and the cliff edge, old tracks streaking down the run, and every board carves a fading track of its own. Fog closes in at a few hundred metres.

### Grand Prix

- A room races a plan: one event over and over, or the **Grand Prix** (summer then winter for now; each season in turn as they're built), then from the top again.
- Points by finishing place: 10, 8, 6, 5, 4, 3, 2, 1. Tricks don't count. Riders who haven't finished when the race ends get last place's points. The last race breaks ties.
- Nobody new joins a Grand Prix once its first countdown starts (reconnecting is fine). A rider who leaves keeps the points already reported; a bot takes the seat.
- Between races the camera lifts off the course while the screen washes into the next season's colours and name, and the next course comes up behind (the simple version of the season change).

### Menus

- **Every menu works with a controller, the keyboard and the mouse.** The stick, the d-pad and the arrows move the focus to the nearest item in that direction; the mouse focuses what it hovers. A / ✕ / Enter picks, B / ○ / Esc goes back, Y / △ / P plays, LB RB / L1 R1 / Q E change tabs, Start / Esc opens the race menu. Button glyphs follow the device you last touched (Xbox, PlayStation, Nintendo, keyboard; none for the mouse).
- Screens (Kilian's sketch): **login** (GitHub, or a 6-digit code by email; Costa Nevada flies by behind), **handle** (first time in), **main menu** (Play, tabs home / collection / settings, the social card; home has your rider, a banner, missions, news; the seasons' colours drift behind), **mode select** at the country club (time trial (soon), single player, room, matchmaking; your rider on the terrace, "add party member" (soon)), **rooms** (a 6-letter code to share, ready-up, the host starts), and the race with its menu.
- **Handles** are `Name#1234`: 3-20 letters (any script, accents, the Catalan `l·l`), digits, spaces and `_ - . ·`; the lobby picks the number. Reserved names and a list of rude words (English, Spanish, Catalan) are refused. A new name once a week.
- **Single player** is a race against bots on our servers, but it never counts (no times, no progression). Rooms and matchmaking are recorded (`match`, `race_result`).
- **Banners and news** are rows in Postgres, one language each (a player sees their language only), shown without a deploy. For now edit them with `pnpm --filter lobby db:studio`; an admin screen comes later. Banner actions: `play`, `news:<slug>`, `url:<https url>`.
- **Languages:** English, Spanish, Catalan (`apps/client/src/i18n/`; `en.ts` is the reference and the type checker makes the others match). The lobby's emails come in the player's language too. No hard-coded UI text.
- Look: frosted panels over the 3D, big type you can read from the couch, an accent colour that follows the season on screen. The diamond logo is a placeholder. No component library (shadcn & co. look like a dashboard): our own handful of components.

### Customization

Character type, body, name, clothes... (Seasonal outfits fit the season concept.)

### Great multiplayer experience

Time trials with ghosts, matchmaking, rooms. Rocket League-style multiplayer engine: with "rollback netcode" à la FGC where it makes sense.

"Resort" with 2XKO/DBFighterZ/SF6/NBA2K style "matchmaking area", but it inside a "country club" instead of an Arcade/Town.

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
```

- **Race traffic is WebTransport (UDP) only**. We use the browser so players don't have to download anything, not to reach office/school networks that block UDP. Like console games: if your network blocks UDP, you can't race online. The lobby (menus, matchmaking) still uses HTTPS/WebSocket, which is fine since it isn't real-time racing.

### Netcode

- **Server-authoritative**, Rocket League / Quake model (not peer-to-peer FGC rollback).
- Clients send **inputs only**, numbered per tick. Never positions.
- Server runs the sim at a fixed tick rate and sends snapshots.
- **Client prediction + reconciliation** for your own rider (this is our "rollback where it makes sense").
- **Other riders are predicted too**: everyone is drawn in the predicted present, extrapolated with their last known input and smoothed on correction, so what you see is what you bump into. No interpolation mode for live riders.
- **Ghosts and replays are playback, not netcode:** the server's authoritative snapshot stream of a run (or a whole race) is the recording; the client plays it back by race time. Independent from the live prediction above.
- **Server-side scoring and timing.** Ghosts and leaderboards only come from server-recorded runs, never from client uploads.
- Inputs are validated (clamped, rate-limited, max lag).
- **Protocol designed for UDP**: self-contained or delta snapshots against an acknowledged baseline, redundant inputs, important events with IDs that are resent until acknowledged. Transport sits behind an interface (`send` / `onMessage`).
- Snapshots must fit one datagram (about 1,200 bytes; Chrome reports 1,211 for WebTransport). Use compact binary encoding.
- **Numbers:** sim at 60 Hz, snapshots at 30 Hz. **4 humans max per room**, 8 rider slots so bots can fill the field.
- **Determinism:** native (server) and WASM (browser) sims must be bit-identical. No SIMD math crates, no platform libm (use `sim::math`, backed by `libm`), no `mul_add`, no hash-map iteration in the sim. Authoritative state is snapped onto the network grid every tick, so snapshots are lossless and re-simulation does not drift. CI checks native vs WASM hashes (`pnpm check:determinism`).
- **Rider collisions: yes.** The server resolves them; clients predict them by running the whole world forward (other humans extrapolated by repeating their last input, bots predicted exactly because their AI is deterministic sim code).
- **Bots** are server-side riders whose inputs come from `sim::bot` instead of the network, through the same sim path. Single player later builds on this.
- **Clock sync:** the server reports how early each client's inputs arrive; clients speed up or slow down up to 6% (hard resync when far off) to keep a 2-tick lead.
- **Netcode lives in `crates/client-core`** (pure Rust: prediction, reconciliation, clock sync, smoothing). The browser uses it through `sim-wasm`; headless bots and tests use it natively. The race server's `Room` is a pure state machine too, so `crates/race-server/tests/netcode.rs` tests the whole loop over a simulated lossy network.

### Race server

- One Rust binary, many rooms (one Tokio task per room). Docker image based on distroless, about 10-20 MB.
- WebTransport with **`web-transport-quinn` + `quinn`** (the stack behind Cloudflare's production MoQ relay).
- Ports: 443/UDP (WebTransport, all game traffic). 443/TCP serves only ops HTTP (`/healthz`, `/metrics`, `/cert-hash`). Docker needs `-p 443:443/udp` explicitly, or `--network host`.
- Config through env vars: `LOBBY_URL`, `RACE_SERVER_SECRET`, `REGION`, `PUBLIC_ADDR`, `LOBBY_PUBLIC_KEY`, plus `BIND` (default `[::]:443`), `TLS_CERT`/`TLS_KEY` (domain mode), `DRAIN_TIMEOUT_SECS`, `RUST_LOG`.
- Join tokens: `base64url(claims JSON) "." base64url(Ed25519 sig over "shifty-join-v1." + payload)`. Claims carry `aud` = the race server's `PUBLIC_ADDR`, so a token only works on the server it was issued for, and `events` (the room's plan of courses). Format lives in `crates/protocol/src/token.rs`; the lobby signs them (`apps/lobby/src/tickets.ts`; a test pins one token both sides must agree on). `scripts/dev-lobby.ts` signs dev quick-race tickets with the same dev key.
- Paths: WebTransport `/race`; ops HTTP `/healthz`, `/metrics`, `/cert-hash`.
- On boot it registers with the lobby and sends heartbeats (region, load).
- Verifies join tokens with the lobby's **public key only**. A race server can check tokens but never create them.
- Heartbeats to the lobby every 5 s (address, region, certificate hash, rooms, humans, draining) and reports every finished race (`POST /api/servers/results`, retried), both with the shared `RACE_SERVER_SECRET`. **Race servers never touch Postgres.**
- Graceful shutdown on SIGTERM: no new rooms, finish current races, then exit.
- `/healthz`, logs to stdout, tick-time metrics.
- TLS, two modes:
  - **Domain mode:** real certificate (Let's Encrypt) mounted into the container.
  - **Hash mode:** short-lived self-signed cert generated at boot, hash sent to the lobby, browsers trust it via `serverCertificateHashes`. No domain needed (LAN, friend's PC). ECDSA P-256, valid 13 days (Chrome rejects more than 14), rotated every 6 days without dropping sessions.

### Lobby

- `apps/lobby`: a Worker (Hono) with **Better Auth** (GitHub OAuth and email one-time codes, sessions in Postgres, the admin plugin for roles and bans) on **Drizzle + Postgres** (`src/db/schema.ts`; migrations in `drizzle/`, made with `pnpm --filter lobby db:generate`). Postgres comes from Hyperdrive in production, `DATABASE_URL` in dev and self-hosting.
- Durable Objects: `RoomLobby` (one per room code: members over hibernatable WebSockets, host settings, ready, start), `Matchmaker` (the Grand Prix queue: a race starts with four, or when the first in line has waited `MATCH_WAIT_SECS`, 20 by default; bots fill the seats), `ServerRegistry` (race servers from their heartbeats; picks the least busy).
- API under `/api`: `auth/*` (Better Auth), `me`, `me/handle`, `me/card`, `content`, `play/single`, `rooms`, `rooms/:code/ws`, `matchmaking/ws`; race servers use `servers/heartbeat` and `servers/results`. Our own endpoints only take requests from the game's origin.
- Secrets: `BETTER_AUTH_SECRET`, `LOBBY_SIGNING_KEY` (Ed25519 seed for join tokens), `RACE_SERVER_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`; `BETTER_AUTH_URL` is the public origin. Email: `MAIL_MODE=console` prints codes (dev); production sends through Cloudflare Email Sending once the game has a domain (not wired yet). `DEV_MAILBOX=1` (dev and tests only) exposes the last code per address at `/api/dev/mailbox`.
- Client and lobby share one origin (the lobby serves `/api`), so the session cookie just works.
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
  protocol/     # message types + binary encoding + join token verification
  client-core/  # client netcode: prediction, reconciliation, clock sync (pure)
  race-server/  # native binary: WebTransport, rooms, authority
  sim-wasm/     # wasm-bindgen wrapper: client-core + sim for the browser
  devkit/       # dev-only: mint tokens, headless bot clients, determinism hash
apps/
  client/       # Vite + Three.js + TypeScript
  lobby/        # Cloudflare Worker + Durable Objects: accounts, rooms, matchmaking
scripts/        # dev.ts (one-command dev), build-wasm, determinism check, dev lobby
e2e/            # Playwright tests (real browsers, two players)
```

The sim and the protocol are written once in Rust and used by both the race server (native) and the browser (WASM).

### Language

- **TypeScript:** client (rendering, UI, input, audio) and lobby. Menus are React (TanStack Router and Query) DOM over the canvas; the race HUD stays plain DOM (it updates every frame).
- **Rust:** sim, protocol, race server.
- Pass state across the Rust/JS boundary with shared typed arrays, not many small calls.

### Engine

Three.js, using **`WebGPURenderer` + TSL** (Three.js Shading Language) from `three/webgpu` and `three/tsl`, never the classic `WebGLRenderer` + hand-written GLSL. Browsers without WebGPU fall back to WebGL2 automatically. The three.js version is pinned (TSL still changes between releases); upgrade on purpose.

- **Water:** physics-relevant swells are a pure function in `crates/sim` (sum of directional waves); the client shader evaluates the same parameters, so the water you see is the water the physics rides. Visual-only detail (FFT chop, foam, spray, wake textures) lives in the client and never touches physics. No paid water kits: their licenses forbid a public repo.

### DB

Postgres

### Graphics

Blender. Characters aim for low-poly N64/PSX era. Environment, VFX, resolution, shadows, lighting, etc. with PS2/GC fidelity.

Taste call: PS2/GC era, but modern VFX and techniques are welcome, and so is rendering at a lower resolution than we could. Detailed environments with low-poly characters are fine. The picture to aim for: Square Enix's "HD-2D" (Octopath Traveler), but fully 3D. Needs lots of look testing. Water: "Wave Race: Blue Storm, remastered", not a photoreal naval sim.

Blender runs headless for asset work: `/Applications/Blender.app/Contents/MacOS/Blender --background --python-expr ...` (glTF export works).

## Workflow

- **Run everything:** `pnpm install`, then `pnpm dev` (Postgres in a container, the lobby, the race server, Vite), then open `http://localhost:5173` and log in: sign-in codes show up in the lobby's log. For GitHub sign-in put a dev OAuth app (callback `http://localhost:5173/api/auth/callback/github`) in `.dev/lobby.env` as `GITHUB_CLIENT_ID=` / `GITHUB_CLIENT_SECRET=`. Postgres keeps running after `pnpm dev` (`container stop shifty-postgres`); set `DATABASE_URL` to use another one. **Quick race without the menus:** `http://localhost:5173/?name=You` in two windows. URL options: `event` (`snow` = the winter mountain, `gp` = the Grand Prix; the summer bay otherwise), `room`, `bots` (0-7), `surface` (0 flat, 1 swells as designed, 2 calm, 3 rough), `scale` (render scale), `water` (`basic` = swells only, for slow machines; the default adds GPU chop, ripples, wake and shore foam, and reflections), `render=0` (nothing drawn: netcode and menu tests; works on the menus too), `autopilot=1` (dev: ride with the bot's inputs, to look around a course). F1 toggles the debug panel (stats, fake lag/jitter/loss).
- **Physics tuning:** `cargo run -p sim --example jetski_lab --release [seed]` prints the jetski's draft, top speed, how turns build up and carry on, how long tricks take off a ramp, and how often and how high swells launch it and how deep it dives (into, with and across the swell, with and without pulling back). `cargo run -p sim --example bot_race --release [seed]` runs a bots-only race and prints times, missed buoys, tricks and bails. `cargo run -p sim --example snow_lab --release` prints the mountain run's profile (pitch, banks, widths), snowboard speeds standing, tucked and braking, the air off every table and the cliff with and without a pop, and a bots-only race down the run (times, falls, tricks, points, cost per tick).
- **Checks:** `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo deny check`, `pnpm audit`, `pnpm check:determinism`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm --filter lobby test`, `pnpm test:e2e` (menus against the real lobby, and the netcode). CI runs all of them on every PR. The race server image (`.github/workflows/image.yml`) builds on every push to `main`, and on PRs only when packaging changes (Dockerfile, Cargo manifests and lockfile, toolchain, notices config). CI actions are pinned by commit SHA (with the version in a comment).
- **Tooling:** pnpm, TypeScript 7 (the Go-native `tsc`), Vite 8, **oxlint** (type-aware) and **oxfmt** for TS/JSON/MD/CSS. Their configs changed a lot recently: read the current docs before changing `.oxlintrc.json` / `.oxfmtrc.json`. Rust: rustfmt + clippy, toolchain pinned in `rust-toolchain.toml`.
- **WASM:** `pnpm build:wasm` (cargo + `wasm-bindgen` CLI, which must match the `wasm-bindgen` version in `Cargo.lock`). Generated files in `apps/client/src/wasm/` are not committed.
- **Containers:** Kilian's Mac has no Docker; use Apple's `container` CLI (Docker-compatible): `container build -f crates/race-server/Dockerfile -t shifty-race-server .`. For UDP from the host use `127.0.0.1`, not `::1`.
- **Git:** never push to `main`. Work on a branch per piece of work and open a PR; PRs are squash-merged, so the PR title becomes the commit on `main`.
  - **PR titles are Conventional Commits** (`feat: …`, `fix(netcode): …`), checked in CI by commitlint. Scopes (optional): `sim`, `protocol`, `netcode`, `server`, `client`, `lobby`, `devkit`, `art`, `audio`, `ci`, `deps`. Local commits are checked too, by a lefthook `commit-msg` hook that `pnpm install` sets up.
  - **PR bodies are one short paragraph at most** (what and why). Details go in commits, AGENTS.md or code.
- **Releases:** release-please keeps a release PR open on `main`; merging it tags `vX.Y.Z` and publishes a GitHub release with the release notes (there is no `CHANGELOG.md`; GitHub releases are the changelog). **One version for the whole game** (Cargo workspace, `Cargo.lock`, both `package.json`), 0.x for now: `feat` and breaking changes bump the minor, `fix` and `perf` the patch. It runs as a GitHub App (`RELEASE_APP_CLIENT_ID` variable, `RELEASE_APP_PRIVATE_KEY` secret) so CI runs on its PRs.
- **Dependencies:** Dependabot opens weekly grouped PRs (actions, cargo, npm, Rust toolchain, Docker base images; `three` comes on its own). `cargo deny check` (`deny.toml`) allows only permissive licenses, known sources and no RustSec advisories; `pnpm audit` checks npm packages for advisories (GitHub's dependency graph can't read pnpm's two-document lockfile, so Dependabot alerts miss most npm packages). Shipped builds carry third-party notices rendered by `cargo-about` (`about.toml`, `about.hbs`): the race server image in `/usr/share/doc/shifty/`, the client in `dist/licenses/` (`rust.md` for the WASM sim, `npm.md` from Vite), so `pnpm build` needs `cargo-about` installed.
- **License: Apache-2.0** (`LICENSE`, unmodified) with attribution in `NOTICE` (Copyright 2026 Kilian Arjona). Every crate and package declares `Apache-2.0`.
