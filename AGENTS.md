# 23.4° Shifty

23.4° Shifty is an online web game that aims to recreate the great jetski and snowboarding games of the fifth and sixth console generation era.

## GitHub Game Off 2026

This is a fun little side project by solo-dev Kilian Arjona, a CTO in an enterprise software company with 20+ years of experience on IT. It will be submited as part of the GitHub Game Off game jam running during the month of November 2026.

Kilian is in charge of direction, production, vibes, taste, etc. but all code and art (including sfx) will be created by coding agents.

- Theme: **Shift**.
- We are **not trying to win** the Game Off. Do not consider changes to the game or the repo just to "score more points from the judges". Fun is paramount, jam is second.
- **Build it solid.** Cut scope by cutting content (events, locations, features), never by lowering architecture quality (server authority, cheat protection, proper netcode).

### Concept: one place, four seasons

Following the "shift" theme, we have devised a "Shifting Seasons" arch: **the Tilt** is one year in Costa Nevada, one race per season: summer → fall → winter → spring. Two sports for the jam:

| Sport | Inspired by | Where | Seasons |
|---|---|---|---|
| Jetski | Wave Race 64, Wave Race: Blue Storm | The sea | All four |
| Snowboard | 1080° Snowboarding, the more grounded parts from SSX Tricky | The mountain | Fall, winter, spring (no snow in summer) |

- **A circuit is a place, not a season.** Any circuit can come up in any season its sport rides, in any weather and at any time of day (see Conditions). The season does **not** change during a race; the weather can.
- **Tone: grounded**, not over-the-top. Arcadey feel, but not juvenile humor or grinding on a lava pit. No sim either. Happy, fun in-between.
- **Location:** one "place" (region) for the jam: **Costa Nevada** ("snowy coast"), a fictional region where the beach and the ski slopes are close together. It can feel Mediterranean or Californian (there's a Sierra Nevada in Spain and in California). Each circuit is its own part of it.
- **Season transitions:** at the end of a race the camera pulls back over the whole place and time-lapses into the next season (inspired by Forza Horizon). This is how the theme shows.
- Skateboard (EA's skate) and downhill mountain bike (No Fear, Downhill Domination) are out for the jam. Maybe later, like more locations, if the jam version is fun.

### Build order

1. **Make it work**: foundation and netcode first (a box riding a plane, two browsers, a server-authoritative room, client prediction).
2. Jetski (the bay)
3. Snowboard (the mountain)
4. Menus and customization
5. Polish both sports: audio, real jetskis and boards, feel (tricks, landings, particles, camera)
6. Conditions: season, weather and time of day on every circuit
7. More circuits, enough for a Tilt without repeats
8. The full season change: the camera pulls back over Costa Nevada while the season time-lapses
9. Time trial with ghosts

## Gameplay

#### Pay respects to our greats

Wave Race, Blue Storm, 1080° Snowboarding, SSX Tricky, SSX 3, Tony Hawk 1-3, skate, No Fear Downhill Mountain Biking, Downhill Domination... They are all legendary, atemporal games. Our tone leans to the grounded ones.

### Design notes

- **Gamepad-first.** Carving, leaning and trick input need analog sticks. The Gamepad API works in all browsers. Keyboard must work, but second-class citizen.
- **Physics per sport.** Grounded means each sport has its own model: water and buoyancy (jetski), edge carving (snow).
- **Tricks never make you faster**, in any sport: races are won on the line and the clock. Tricks score style points (what style earns is decided later, maybe customization), and a bail still costs you.
- **Split times:** at every checkpoint (and the finish) the HUD shows your gap to the first rider through it, or your time if you are first.
- **Every race starts with its intro, no warm-up.** Riders wait lined up on the grid, held still, until every screen has the course loaded. Then the camera flies over the circuit in a few shots (`game/flyover.ts`; the same shots at the same moment on every screen) under a title card (the circuit, the place, the season, laps or the run's length; weather and time of day join it as rows), comes down behind your rider, and the countdown runs. While the grid waits, the opening shot holds with the card and "waiting for the other riders".
- **Wrong way** goes up after half a second of riding against the course, and down once you've ridden the right way for a moment. Time in the air, in a bail or crawling along doesn't count either way.
- **Name tags** only for other people (bots ride untagged, like the CPU riders of the greats): a small paper tag pointing at the head, only within about 30 m, fading out by 40 m, at the screen's edges and behind the ground (a roller, a swell). The handle's number is left off. No tags in the results or under any camera but the chase camera (`hud.tags.hidden`).
- **About the name**: 23.4° is the Earth's axial tilt, the reason seasons exist. A shifty is a snowboard and skate trick (twist the board in the air, bring it back). Always write it with the degree sign `°` (U+00B0), never `º`. Short name for the game is: **Shifty**, like it was **Tricky** for the old SSX 2. The year of four races is **the Tilt**, after the same tilt (`el Tilt` in Spanish and Catalan; never "Grand Prix", which sounds like Formula 1).

### Jetski

- **The bay** (the first circuit): an oval in the bay around a breakwater, past a small island and along the town quay (land is solid, in the sim); buoys to pass on the correct side (red on your right, green on your left), floating ramps, three laps. A race goes grid → intro → countdown → race → results.
- **Air comes from waves and ramps only.** No jump button: pulling back (lean) as you leave a crest pops you higher.
- **One speed meter, passive:** clean buoy passes fill it and raise top speed; a missed buoy or a bail empties it. Missing buoys never disqualifies.
- **Tricks:** hold a trick button in the air and push the stick (spins, flips, barrel rolls). Land crooked and you bail.

### Snowboard

- **The mountain run** (the first circuit): one run down the mountain (~2.2 km, about 90 s), from the summit start hut to the village: wide open slopes with sweeping turns, rollers and tables, tree-lined S-turns past the chairlift, a bench ending in a cliff drop, a winding gully, side kickers, a final pitch. Checkpoints across the run (you can't miss them), then the finish. A race goes grid → intro → countdown → race → results.
- **The mountain is one height function in `crates/sim/src/mountain.rs`:** slope bands along Z, a valley that follows the run, noise; the run carved into it (a level bench, banked in turns, tables, rollers, a gully, berms where the slope falls away). The client draws the snow from those same heights, so what you see is what you ride.
- **Gravity is the engine:** carve (the edge turns sideways speed into speed along the board; fast turns are wide), tuck for speed (stick up), sit back to skid and brake (stick down), skate when slow. The board flies wherever the snow falls away faster than gravity can follow (lips, knuckles, the cliff).
- **Jump button:** hold to crouch and load, let go to pop (bigger the longer you loaded). Letting go at a lip adds to the lip's launch; a few ticks late still pops.
- **Tricks only score points** (no speed meter): the trick button + stick spins (in 180s) and flips, the grab button grabs (the stick picks Indy, nose, tail, melon or method). Let go and the rider finishes toward the nearest way to land, forward or switch. Land along the direction of travel, flat on the slope and not still grabbing, or you fall. In between is **sketchy**: a little crooked, or slammed into the snow, and you lose some speed, wobble for a moment (weaker edge, no loading a jump) and the trick scores half. Trees, rocks and lift towers knock you down.
- **Look:** 1080° Avalanche framing. The camera is close and low, the rider fills about half the screen's height, the view tips down the slope so the snow rushing past fills the screen to about a third from the top, the horizon leans with the slope, and in the air the camera's height lags so the rider drops in the frame.
- **Snow you can read:** the sun ahead of the riders, shade baked into faces that rise toward you and into hollows (so rollers and kickers show even in flat light), blue dye lines on lips, knuckles and the cliff edge, old tracks streaking down the run, and every board carves a fading track of its own. Fog closes in at a few hundred metres.

### Conditions

- **A race is a circuit plus its conditions:** season, weather and time of day. The circuit is only the place (terrain, buoys, scenery). Conditions are picked for each race and carried in the room's plan; the server draws them from a seed, so every screen agrees. In a room the host picks the circuit and its conditions, or leaves them to the draw; single player and matchmaking draw them.
- **Seasons:** the jetski rides all four, the snowboard fall, winter and spring (no snow in summer).
- **Weather follows the season's climate:** each season draws from its own weathers (storms mostly in fall, no snowfall in summer).
- **Time of day:** dawn to dusk. No night races for now: they need real lights and make the snow hard to read.
- **What touches the physics lives in the sim**, deterministic like the rest: swell size and direction, wind, the snow's type (powder, packed, slush) and how deep it covers the ground. Everything else is a look driven by shader values: snow line, foliage, sea colour, sky, sun, rain, falling snow, fog.
- **The sun's height follows the season** (the 23.4° tilt at work): Costa Nevada sits at about 37°N, like Spain's Sierra Nevada, so the noon sun stands about 76° high in summer, 53° at the equinoxes and 30° in winter.
- **On the mountain**, fall is early season: a thin cover, a white run through brown slopes, rocks poking through that knock you down. Winter is powder, falling snow and a low sun. Spring is hard snow up top and slush below (slow and grippy), with green meadows by the lower run.
- **On the water**, the cold puts snow on the hills down to the shore and the riders in cold-water gear: always in winter, and in cold weather in fall and spring.
- **The weather can change during a race** (the season never does): on the water a storm builds lap by lap (swell, wind, rain); on the mountain the weather and the snow change with altitude (cloud and wind at the top, sun below; in spring, hard snow above and slush below). In the sim it's a function of race time and position, so it stays deterministic.
- **Every circuit is built for every season it can come up in.** Snow cover, foliage, water and light follow the conditions' values (snow settles on upward faces above the snow line), never painted per season. Every combination keeps the snow readable and holds 60 fps, the heaviest one (a storm at dusk) included.

### The Tilt

- A room races a plan once: one event, or **the Tilt**: a year, summer → fall → winter → spring, one race per season. Each race draws a circuit that suits its season (summer is always on the water) and its weather from the season's climate, **every Tilt has both sports** (summer is always on the water, so at least one of the other three is on the mountain), and **no circuit repeats** in a Tilt, so a year takes at least four circuits (until there are, it's summer on the bay, then winter on the mountain). After the last race's results everyone goes back where they came from (the room screen, or mode select), and a room stops offering "rejoin" once its plan is over.
- Points by finishing place: 10, 8, 6, 5, 4, 3, 2, 1. Tricks don't count. Riders who haven't finished when the race ends get last place's points. The last race breaks ties.
- Nobody new joins a Tilt once its first race leaves the grid (reconnecting is fine). A rider who leaves keeps the points already reported; a bot takes the seat.
- Between races the camera lifts off the course while the screen washes into the next season's colours and name, and the next course comes up behind (the simple version of the season change). The same season card covers a race's first course while it loads. Every race waits on its grid until every screen has its course, then runs its intro.

### Menus

- **Every menu works with a controller, the keyboard and the mouse.** The stick, the d-pad and the arrows move the focus to the nearest item in that direction; the mouse focuses what it hovers. A / ✕ / Enter picks, B / ○ / Esc goes back, Y / △ / P plays, LB RB / L1 R1 / Q E change tabs, Start / Esc opens the race menu. Button glyphs follow the device you last touched (Xbox, PlayStation, Nintendo, keyboard; none for the mouse).
- Screens (Kilian's sketch): **login** (GitHub, or a 6-digit code by email; Costa Nevada flies by behind), **handle** (first time in), **main menu** (Play, tabs home / collection / settings, the social card; home has your rider up close (from the knees up, like a fighting game's menu), a banner, missions, news; the seasons' colours drift behind), **mode select** at the country club (time trial (soon), single player, room, matchmaking; your rider on the terrace, "add party member" (soon)), **rooms** (a 6-letter code to share, ready-up, the host starts), and the race with its menu.
- **Handles** are `Name#1234`: 3-20 letters (any script, accents, the Catalan `l·l`), digits, spaces and `_ - . ·`; the lobby picks the number. Reserved names and a list of rude words (English, Spanish, Catalan) are refused. A new name once a week.
- **Sign-ups are invite-only** until we open them (`SIGNUPS=open`). The login screen opens on the invite code (an invite link, `/invite/XXXX-XXXX`, fills it in and lands on "You're in!", where you make your account with GitHub or email); players who already have an account log in behind "Already invited? Log in". Making an account takes one use of the code. Nothing fails silently: an email or a GitHub without an account, and without an invite, is told so. Make links with `pnpm --filter lobby invite` (`--uses`, `--days`, `--note`, `--count`, `--list`; `--prod` for production's database and site).
- **Single player** is a race against bots on our servers, but it never counts (no times, no progression). Rooms and matchmaking are recorded (`match`, `race_result`).
- **Banners and news** are rows in Postgres, one language each (a player sees their language only), shown without a deploy. For now edit them with `pnpm --filter lobby db:studio`; an admin screen comes later. Banner actions: `play`, `news:<slug>`, `url:<https url>`.
- **Languages:** English, Spanish, Catalan (`apps/client/src/i18n/`; `en.ts` is the reference and the type checker makes the others match). The lobby's emails come in the player's language too. No hard-coded UI text.
- Look ("Riviera"): opaque paper panels floating over the 3D (no blur, square corners, a 1px ink edge and a soft drop), ink type in Archivo using its widths (expanded italic for display, condensed for numbers), numbered rows, and one accent per season that follows the season on screen (summer Riviera blue, fall brick, winter piste red, spring fern). Focus is the accent filling the row, text turned to paper. Laid out on a 1920×1080 canvas and scaled to the window (`menu/scale.ts`). Anything loading (the boot, a course behind its season card, joining a race, a screen or art that takes a moment) shows one loading sign in the bottom right corner, saying what loads (`loading.ts`). The "23.4° / SHIFTY" wordmark (the slash tilted 23.4°) is a placeholder logo. No component library (shadcn & co. look like a dashboard): our own handful of components.

### Customization

- **Your rider from presets, no sliders** (Mii Maker, Tony Hawk's create-a-skater): male or female, then a row of presets per part: skin (6), hair (5 per body), hair colour (6), eyes, eye colour, eyebrows, nose, mouth (5 each), beard and moustache (5, male only), height and build (5 each). Every body and face preset is free from the start, and you can change them any time. New players make their rider right after picking their handle.
- **Looks never touch the physics:** every body rides with the same hitbox and the same speed.
- **Clothes and gear per sport**, with made-up Costa Nevada brands named after the Mediterranean winds (Tramuntana, Garbí, Llevant, Xaloc, Ponent). Jetski (`summer` in the catalog): head, eyes, top, life vest, bottom, feet, jetski. Snowboard (`winter`): head, eyes, top, bottom, hands, feet, board. Each item is a model in one colourway (main, second and accent colours). Everyone starts with a free starter kit that already gives some variety, and **gear is cosmetic only**. Your jetski and snowboard kits swap with the sport in a Tilt. The jetski kit also needs cold-water gear for cold conditions (see Conditions); how it's picked and shown isn't designed yet.
- **Setups:** every rider spreads the same 12 points over speed, handling, stability and tricks (0-6 each), per sport. A point is a small change (top speed about 0.6%, turns and grip 4%, landing tolerance 8%, rotation speed 6%), so a setup is a style, not an advantage, and the budget is never earned. Set before entering a match; a match keeps the setups it started with (no changes between seasons). `cargo run -p sim --example setup_lab --release` races bots with each setup to keep them fair (racing builds within about ±0.6% of balanced).
- **The catalog, looks, setups and appearance bytes live in `packages/rider`** (`@shifty/rider`, shared by the client and the lobby). Item numbers are stable forever: add items at the end, never reuse a number.
- Riders are modelled in Blender (`art/rider/`; the head comes from MakeHuman's CC0 assets) with painted and baked textures and heroic proportions, exported to `apps/client/public/riders/` and drawn in the cel look. The same riders ride in races (`render/rider.ts` on the jetski, `render/boarder.ts` on the board, poses in `render/rider/ride.ts`); jetskis and boards are still boxes in the colours of the rider's ride. Both bodies are modelled, each with its five hair styles and both starter kits; an item whose model isn't built yet shows the starter's model in its own colours where the slot is required, and nothing elsewhere. The bodies share one builder (`art/rider/figure.py`; their tables in `male.py` and `female.py`), both 1.78 m tall, scaled to the height presets in the game; hair styles are in `art/rider/hairdo.py`. Eye, nose and mouth presets are MakeHuman shape targets (morph targets on the face), each with its own paint over the face (ink lines, the iris, and how its shape moves the shade line); brows and beards are painted overlays in the hair's colour.

### Great multiplayer experience

Time trials with ghosts, matchmaking, rooms. Rocket League-style multiplayer engine: with "rollback netcode" à la FGC where it makes sense.

"Resort" with 2XKO/DBFighterZ/SF6/NBA2K style "matchmaking area", but it inside a "country club" instead of an Arcade/Town.

### Progression

Investigate what the greats did, copy where it makes sense, modern QoL where its better.

- **Credits** (SSX 3 / Tony Hawk 2 style) buy clothes and gear in the **pro shop at the country club**. Pointing at an item tries it on your rider. The collection tab is your wardrobe.
- Online races pay by finishing place (100, 85, 72, 62, 54, 47, 41, 36), plus style (trick points ÷ 25, at most 80 a race) and 80 for finishing a Tilt. Matchmaking always pays, even when bots fill the seats. A private room pays only races with two or more people in it. Single player never pays.
- Pacing: an average Tilt earns about a fifth of an average item. Missions and unlocks you can't buy come later.
- The lobby keeps a **ledger**: every change to a player's credits with its reason, and each race pays out once (retried reports pay nothing more). Buying checks ownership and balance in one transaction.

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
- **A race starts when everyone has loaded:** every input packet says which race of the plan its screen has on show (course loaded, season card lifted). A race waits on the grid until everyone the lobby sent (the ticket's `humans`) has arrived and every connected screen is ready, or for 30 s at most (a late screen joins the race wherever it is). People who left don't count; bots never wait. The server then starts the intro (7 s), and the countdown (4 s) and the race follow by the sim's clock, so clients predict them; race phases are sim state, numbered for the wire (grid 0, countdown 1, racing 2, results 3, intro 4). `devkit bots --loading <s>` plays a screen that loads slowly.
- **Netcode lives in `crates/client-core`** (pure Rust: prediction, reconciliation, clock sync, smoothing). The browser uses it through `sim-wasm`; headless bots and tests use it natively. The race server's `Room` is a pure state machine too, so `crates/race-server/tests/netcode.rs` tests the whole loop over a simulated lossy network.

### Race server

- One Rust binary, many rooms (one Tokio task per room). Docker image based on distroless, about 10-20 MB.
- WebTransport with **`web-transport-quinn` + `quinn`** (the stack behind Cloudflare's production MoQ relay).
- Ports: 4433/UDP (WebTransport, all game traffic). 4433/TCP serves only ops HTTP (`/healthz`, `/metrics`, `/cert-hash`), never published in production. Docker needs `-p 4433:4433/udp` explicitly, or `--network host`. The image's `HEALTHCHECK` runs `race-server healthcheck` (GETs `/healthz` inside the container; 503 while draining).
- Config through env vars: `LOBBY_URL`, `RACE_SERVER_SECRET`, `REGION`, `PUBLIC_ADDR`, `LOBBY_PUBLIC_KEY`, plus `BIND` (default `[::]:4433`), `TLS_CERT`/`TLS_KEY` (domain mode), `DRAIN_TIMEOUT_SECS`, `RUST_LOG`.
- Join tokens: `base64url(claims JSON) "." base64url(Ed25519 sig over "shifty-join-v1." + payload)`. Claims carry `aud` = the race server's `PUBLIC_ADDR`, so a token only works on the server it was issued for, `events` (the room's plan of courses), `humans` (how many people the lobby sent, so the first race waits for them), `look` (the rider's appearance bytes, passed on to the room unread) and `setups` (per sport, checked again by the sim). The lobby checks a rider only wears what they own before signing. Every `RiderJoined` event tells the room each rider's look and setups (clients need the setups to predict them), and bots dress alike on every screen. Format lives in `crates/protocol/src/token.rs`; the lobby signs them (`apps/lobby/src/tickets.ts`; a test pins one token both sides must agree on). `scripts/dev-lobby.ts` signs dev quick-race tickets with the same dev key.
- Paths: WebTransport `/race`; ops HTTP `/healthz`, `/metrics`, `/cert-hash`.
- On boot it registers with the lobby and sends heartbeats (region, load).
- Verifies join tokens with the lobby's **public key only**. A race server can check tokens but never create them.
- Heartbeats to the lobby every 5 s (address, region, version, certificate hashes, rooms, humans, draining) and reports every finished race (`POST /api/servers/results`, retried), both with the shared `RACE_SERVER_SECRET`. **Race servers never touch Postgres.**
- Versions must match: the lobby only sends players to race servers of its own version (the Cargo workspace version, one for the whole game), tickets carry it, and a client on another build asks the player to reload instead of racing.
- A room closes a few seconds after its plan ends, and for 15 minutes refuses tickets issued before the end (`iat` in the claims).
- Graceful shutdown on SIGTERM: no new rooms, wait for the current plans to end (`DRAIN_TIMEOUT_SECS`, 900 by default), then exit.
- `/healthz`, logs to stdout, tick-time metrics.
- TLS, two modes:
  - **Domain mode:** real certificate (Let's Encrypt) mounted into the container.
  - **Hash mode:** short-lived self-signed cert generated at boot, hash sent to the lobby, browsers trust it via `serverCertificateHashes`. No domain needed (LAN, friend's PC). ECDSA P-256, valid 13 days (Chrome rejects more than 14), rotated every 6 days without dropping sessions. The next certificate is made an hour before the switch: heartbeats and tickets carry every live hash (the current one first), so tickets signed around the switch still connect.

### Lobby

- `apps/lobby`: a Worker (Hono) with **Better Auth** (GitHub OAuth and email one-time codes, sessions in Postgres, the admin plugin for roles and bans) on **Drizzle + Postgres** (`src/db/schema.ts`; migrations in `drizzle/`, made with `pnpm --filter lobby db:generate`). Postgres comes from Hyperdrive in production, `DATABASE_URL` in dev and self-hosting.
- Durable Objects: `RoomLobby` (one per room code: members over hibernatable WebSockets, host settings, ready, start), `Matchmaker` (the Tilt queue: a race starts with four, or when the first in line has waited `MATCH_WAIT_SECS`, 20 by default; bots fill the seats), `ServerRegistry` (race servers from their heartbeats; picks the least busy one on the lobby's version).
- API under `/api`: `health` (the lobby's version and the live race servers' versions, no addresses), `auth/*` (Better Auth), `me` (with the rider: appearance, setups, credits, owned items), `me/handle`, `me/card`, `me/rider`, `me/setups`, `me/earnings`, `shop/buy`, `content`, `play/single`, `rooms`, `rooms/:code/ws`, `matchmaking/ws`; race servers use `servers/heartbeat` and `servers/results` (which also pays the race's credits). Our own endpoints only take requests from the game's origin.
- Secrets: `BETTER_AUTH_SECRET`, `LOBBY_SIGNING_KEY` (Ed25519 seed for join tokens), `RACE_SERVER_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`; `BETTER_AUTH_URL` is the public origin. Email: `MAIL_MODE=console` prints codes (dev); production sends them through Cloudflare Email Service (the `EMAIL` binding, from `MAIL_FROM` = `noreply@4shifty.gg`; `4shifty.gg` is onboarded for sending). workerd has no Email Service, so self-hosted lobbies log the codes as errors for now. `DEV_MAILBOX=1` (dev and tests only) exposes the last code per address at `/api/dev/mailbox`. `SIGNUPS=open` lets anyone make an account; otherwise new accounts need an invite code (`src/invites.ts`, the `invite` table).
- Client and lobby share one origin (the lobby serves `/api`), so the session cookie just works.
- TypeScript Worker + Durable Objects. Runs on Cloudflare, or self-hosted with **`workerd`** (Cloudflare's open-source runtime) in Docker. Same code.
- **Durable Object state is temporary only** (rooms, presence, matchmaking queues), all rebuildable. **Postgres is the source of truth** (accounts, results, ghosts). This also makes workerd's experimental on-disk storage low-risk for self-hosters.
- Use WebSocket hibernation when idle so idle rooms cost nothing.

### Hosting

| Piece | Our official hosting | Self-hosted |
|---|---|---|
| Client | Cloudflare (the lobby Worker's static assets) | workerd |
| Lobby | Cloudflare (Workers + Durable Objects) | workerd in Docker |
| Race server | Hetzner CX23 (Nuremberg) running Coolify: `eu1.4shifty.gg` (DNS-only, UDP 4433), project Shifty, app `race-server-eu1`, image `ghcr.io/karjona/shifty-race-server` (`:live` is what runs) | Docker anywhere |
| Postgres | Neon (Frankfurt), reached through Hyperdrive | Docker |

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
packages/
  rider/        # @shifty/rider: looks, catalog, setups, appearance bytes (client + lobby)
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
- **Nothing compiles a shader mid-frame.** Shader compiles block the page (Safari's WebGPU, every WebGL2), so a stage's shaders compile ahead with three's `compileAsync`, which doesn't (`Engine.warm`; riders whose art arrives later warm up through `render/warm.ts`). Nothing is drawn meanwhile: the canvas holds its last frame under the boot screen, the loading sign or the season card (a race's course loads behind its card while the netcode keeps running), and the boot screen and the card stay up until what the screen shows is in (its riders, `Stage.loaded`) and frames run without a stall (`Engine.settled`). The page's entry (`main.tsx`) is a small script that puts the loading sign's "Loading…" up in the player's language; the game (`start.tsx`) loads after it. The club's terrace (mode select) loads behind the main menu (`Engine.preload`), so Play shows it at once. Environments keep one `Fog` each: a new one rebuilds every shader drawn in it. A rider's colours and size repaint in place; only a new shape or outfit rebuilds them. A material's numbers are uniforms, not constants, so materials that differ only in them share one shader. Rider textures decode off the main thread (`ImageBitmapLoader`). Check stalls in Safari's engine too (Playwright `webkit`), not only Chromium.
- **60 frames a second on modest machines.** Resolution is automatic unless the player fixes it in Settings (`game/resolution.ts`): fewer pixels when frames come slower than 60 a second, more again once they keep up, and a step that doesn't help (short of CPU, a slow display) is undone. Pixels stay cheap: no Perlin noise per pixel where the noise texture (`render/cel/noise.ts`) or the vertex stage will do, what never changes is baked (the bay's shore distance), and the sky draws last so only uncovered pixels shade it. Draws stay few: static scenery merges per material (`render/merge.ts`), things that repeat or float are instanced, models made of boxes are one vertex-coloured mesh (`render/parts.ts`), and identical cel materials are made once. Riders are drawn only in view, outlined within 45 m, reflected (the body alone) within 30 m and cast shadows inside the sun's shadow box. Measure with `?bench=1`: `window.__shiftyBench` draws the held frame back to back (`bench(n)`: CPU and total ms a frame) with parts turned off (`ablate("noink,noshadow")`), in WebKit too.

### DB

Postgres

### Graphics

**The look is cel-shaded**, like an anime or a hand drawing: Guilty Gear Strive and Dragon Ball Z are the bar, XIII the floor. Code in `apps/client/src/render/cel/`.

- Every surface has two tones, lit and shade, split on a hard line. Shade is a cool tone, richer than the colour. Cast shadows fall in the shade tone, and the shade side catches a rim of sky light.
- Ink lines come from a post pass: silhouettes from depth, creases from normals, edges between objects. Each line is a darker version of the colour under it.
- Riders get an outline (an inverted hull). Their normals bend toward simple shapes (an ellipsoid head, capsule limbs) so shade falls in clean shapes, and their poses are held on twos.
- The sky is a painted gradient with cel cumulus. The sea is banded (shelves near the shore, strokes along the swells, cut-out foam) and still rides the sim's swells.

Blender for models. Characters are low-poly; environments, VFX, shadows and lighting aim for PS2/GC fidelity. Modern techniques are welcome, and so is rendering at a lower resolution than we could. Detailed environments with low-poly characters are fine. Every look change is checked side by side against references.

Blender runs headless for asset work: `/Applications/Blender.app/Contents/MacOS/Blender --background --python-expr ...` (glTF export works).

## Workflow

- **Run everything:** `pnpm install`, then `pnpm dev` (Postgres in a container, the lobby, the race server, Vite), then open `http://localhost:5173` and log in: sign-in codes show up in the lobby's log. For GitHub sign-in put a dev OAuth app (callback `http://localhost:5173/api/auth/callback/github`) in `.dev/lobby.env` as `GITHUB_CLIENT_ID=` / `GITHUB_CLIENT_SECRET=`. Postgres keeps running after `pnpm dev` (`container stop shifty-postgres`); set `DATABASE_URL` to use another one. **Quick race without the menus**: `http://localhost:5173/?name=You` in two windows. URL options (all dev-only, see below): `event` (`snow` = the winter mountain, `gp` = the Tilt; the summer bay otherwise), `room`, `bots` (0-7), `surface` (0 flat, 1 swells as designed, 2 calm, 3 rough), `scale` (render scale), `water` (`basic` = swells only, for slow machines; the default adds GPU chop, ripples, wake and shore foam, and reflections), `render=0` (nothing drawn: netcode and menu tests; works on the menus too), `lookdev=1` (dev: riders on the club terrace for look testing; `&ride=1` puts them on the sport's ride, with `steer`, `lean`, `grab`, `air`, `bail`), `celshot=flyover|club|hero` (dev: cel look test shots; `inkdebug=line|normal|ink|depth` shows the ink pass), `autopilot=1` (dev: ride with the bot's inputs, to look around a course), `bench=1` (dev: the frame-cost bench, see Engine). F1 toggles the debug panel (stats, fake lag/jitter/loss). `SIGNUPS=invite pnpm dev` tries the invite gate (dev is open otherwise).
- **URL switches, test hooks and debug tools are dev-server only.** A production build reads nothing from the URL's query (the router reads only its own routes, like `/play?mode=`). Players set resolution and water in Settings. Every switch is read through `apps/client/src/dev-params.ts`, behind `import.meta.env.DEV`. Lint forbids reading `location.search` / `searchParams` anywhere else in the client, and `pnpm build` fails if the bundle has a switch read outside `import.meta.env.DEV`, the quick race (`/__dev/`), the e2e hooks (`window.__shifty`) or the debug panel.
- **Physics tuning:** `cargo run -p sim --example jetski_lab --release [seed]` prints the jetski's draft, top speed, how turns build up and carry on, how long tricks take off a ramp, and how often and how high swells launch it and how deep it dives (into, with and across the swell, with and without pulling back). `cargo run -p sim --example bot_race --release [seed]` runs a bots-only race and prints times, missed buoys, tricks and bails. `cargo run -p sim --example snow_lab --release` prints the mountain run's profile (pitch, banks, widths), snowboard speeds standing, tucked and braking, the air off every table and the cliff with and without a pop, and a bots-only race down the run (times, falls, tricks, points, cost per tick).
- **Checks:** `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo deny check`, `pnpm audit`, `pnpm check:determinism`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, `pnpm --filter lobby test`, `pnpm --filter @shifty/rider test`, `pnpm test:e2e` (menus against the real lobby, and the netcode). CI runs all of them on every PR. The race server image (`.github/workflows/image.yml`) builds on every push to `main`, and on PRs only when packaging changes (Dockerfile, Cargo manifests and lockfile, toolchain, notices config). CI actions are pinned by commit SHA (with the version in a comment).
- **Tooling:** pnpm, TypeScript 7 (the Go-native `tsc`), Vite 8, **oxlint** (type-aware) and **oxfmt** for TS/JSON/MD/CSS. Their configs changed a lot recently: read the current docs before changing `.oxlintrc.json` / `.oxfmtrc.json`. Rust: rustfmt + clippy, toolchain pinned in `rust-toolchain.toml`.
- **WASM:** `pnpm build:wasm` (cargo + `wasm-bindgen` CLI, which must match the `wasm-bindgen` version in `Cargo.lock`). Generated files in `apps/client/src/wasm/` are not committed.
- **Deploy:** the game lives at `https://23.4shifty.gg` (`4shifty.gg` and `www` redirect there). Merging the release-please PR publishes the release, and `.github/workflows/deploy.yml` deploys it: the race server image to GHCR (`ghcr.io/karjona/shifty-race-server:X.Y.Z`), Neon migrations, the Worker (which serves `apps/client/dist`; `wrangler versions upload` then `versions deploy`, so the token never touches the custom domain: change routes or domains by hand with `wrangler triggers deploy`), then the race server through Coolify (moves `:live` to the version, redeploys, and waits until the lobby sees it; the old server finishes its races first). To redeploy or roll back, run Deploy on a release tag. Secrets live in the GitHub `production` environment (tags `v*` only): `CLOUDFLARE_API_TOKEN` (account token, Workers Editor on `shifty-lobby` only), `NEON_DATABASE_URL`, `COOLIFY_TOKEN` (deploy-only); variables `CLOUDFLARE_ACCOUNT_ID`, `COOLIFY_URL`, `COOLIFY_APP_UUID`. Worker secrets and the race server's env vars are set once by hand (`wrangler secret put`, the Coolify app); their values live in `.dev/prod.env` and `.dev/prod-race-server.env` (gitignored). By hand, if ever needed: `pnpm build`, then `pnpm --filter lobby exec wrangler deploy --secrets-file ../../.dev/prod.env`, and `pnpm --filter lobby db:migrate` with `.dev/neon.env` loaded.
- **Migrations must keep working with the previous release's code** (add first, drop a release later): the old Worker keeps serving while a deploy runs.
- **Containers:** Kilian's Mac has no Docker; use Apple's `container` CLI (Docker-compatible): `container build -f crates/race-server/Dockerfile -t shifty-race-server .`. For UDP from the host use `127.0.0.1`, not `::1`.
- **Git:** never push to `main`. Work on a branch per piece of work and open a PR; PRs are squash-merged, so the PR title becomes the commit on `main`.
  - **PR titles are Conventional Commits** (`feat: …`, `fix(netcode): …`), checked in CI by commitlint. Scopes (optional): `sim`, `protocol`, `netcode`, `server`, `client`, `lobby`, `devkit`, `art`, `audio`, `ci`, `deps`. Local commits are checked too, by a lefthook `commit-msg` hook that `pnpm install` sets up.
  - **PR bodies are one short paragraph at most** (what and why). Details go in commits, AGENTS.md or code.
- **Releases:** release-please keeps a release PR open on `main`; merging it tags `vX.Y.Z` and publishes a GitHub release with the release notes (there is no `CHANGELOG.md`; GitHub releases are the changelog). **One version for the whole game** (Cargo workspace, `Cargo.lock`, every `package.json`), 0.x for now: `feat` and breaking changes bump the minor, `fix` and `perf` the patch. It runs as a GitHub App (`RELEASE_APP_CLIENT_ID` variable, `RELEASE_APP_PRIVATE_KEY` secret) so CI runs on its PRs.
- **Dependencies:** Dependabot opens weekly grouped PRs (actions, cargo, npm, Rust toolchain, Docker base images; `three` comes on its own). `cargo deny check` (`deny.toml`) allows only permissive licenses, known sources and no RustSec advisories; `pnpm audit` checks npm packages for advisories (GitHub's dependency graph can't read pnpm's two-document lockfile, so Dependabot alerts miss most npm packages). Shipped builds carry third-party notices rendered by `cargo-about` (`about.toml`, `about.hbs`): the race server image in `/usr/share/doc/shifty/`, the client in `dist/licenses/` (`rust.md` for the WASM sim, `npm.md` from Vite), so `pnpm build` needs `cargo-about` installed.
- **License: Apache-2.0** (`LICENSE`, unmodified) with attribution in `NOTICE` (Copyright 2026 Kilian Arjona). Every crate and package declares `Apache-2.0`.
