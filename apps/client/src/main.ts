import "./style.css";
import init, { WasmClient, raceFields, renderStride, statsFields } from "./wasm/sim.js";
import { InputReader } from "./input.ts";
import { conditioned, type NetConditions } from "./net/conditioner.ts";
import { connect, WebTransportUnavailable, parseJoinTicket, type JoinTicket, type Transport } from "./net/transport.ts";
import { Bay } from "./render/bay.ts";
import { Mountain } from "./render/mountain.ts";
import { World, type RiderView } from "./render/world.ts";
import { createDebugPanel, type DebugSettings } from "./ui/debug.ts";
import { Hud, type RaceView } from "./ui/hud.ts";
import { Minimap, RunMap, type CourseMap } from "./ui/minimap.ts";
import { parseCourse, parseEvents, parseStandings } from "./wasm-json.ts";

const params = new URLSearchParams(location.search);
/** `?event=snow` races the winter mountain; the summer bay otherwise. */
const snow = params.get("event") === "snow";

const HELP = {
  jetski:
    "<b>23.4° Shifty</b> · summer · prototype<br />" +
    "Gamepad: left stick steer and lean (pull back on a crest to fly) · RT throttle · LT brake<br />" +
    "In the air: hold A + stick to spin and flip, B + stick to barrel roll. Land straight!<br />" +
    "Keyboard: WASD drive · arrows steer and lean · Space / Shift tricks · F1 debug<br />" +
    'Pass <b class="red">red</b> buoys with them on your right, <b class="green">green</b> on your left',
  snow:
    "<b>23.4° Shifty</b> · winter · prototype<br />" +
    "Gamepad: left stick steer · stick up (or RT) tuck · down (or LT) sit back and brake<br />" +
    "Hold A to load a jump, let go at the lip · in the air: X + stick spins and flips, B grabs<br />" +
    "Keyboard: WASD steer, tuck, brake · Space jump · J / Shift spin · K / E grab · F1 debug<br />" +
    "Land flat on the board, along the slope (forward or switch), and let go of the grab first!",
};
/** `?render=0` runs the full netcode without drawing (used by netcode e2e tests). */
const renderEnabled = params.get("render") !== "0";
/** `?autopilot=1` (dev): ride like a bot, to look around the course. */
const autopilot = params.get("autopilot") === "1";
const status = document.querySelector<HTMLDivElement>("#status")!;
const hud = new Hud(document.querySelector<HTMLDivElement>("#ui")!);
const setStatus = (text: string) => {
  status.textContent = text;
  status.hidden = text === "";
};

const REJECT_REASONS: Record<number, string> = {
  3: "the game was updated, please reload the page",
  4: "invalid join ticket",
  5: "room is full (4 players max)",
  6: "server is shutting down",
  7: "disconnected for inactivity",
};

/** Roster JSON comes from our own WASM, but parse it defensively anyway. */
function parseRoster(json: string): Map<number, string> {
  const names = new Map<number, string>();
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) return names;
  for (const e of data as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const slot: unknown = Reflect.get(e, "slot");
    const name: unknown = Reflect.get(e, "name");
    const bot: unknown = Reflect.get(e, "bot");
    if (typeof slot === "number" && typeof name === "string") names.set(slot, bot === true ? `🤖 ${name}` : name);
  }
  return names;
}

async function getTicket(): Promise<JoinTicket> {
  const q = new URLSearchParams({
    name: params.get("name") ?? `Rider ${Math.floor(Math.random() * 900 + 100)}`,
    room: params.get("room") ?? (snow ? "dev-snow" : "dev"),
    bots: params.get("bots") ?? "2",
    surface: params.get("surface") ?? "1",
    course: snow ? "1" : "0",
  });
  const pid = params.get("pid");
  if (pid) q.set("pid", pid);
  // Dev: the Vite dev server stands in for the lobby.
  const res = await fetch(`/__dev/join?${q}`);
  if (!res.ok) throw new Error(await res.text());
  return parseJoinTicket(await res.json());
}

async function main(): Promise<void> {
  setStatus("Loading…");
  const wasm = await init();
  const stride = renderStride();
  const fields = statsFields();
  const raceKeys = raceFields();

  const world = new World(
    document.querySelector<HTMLElement>("#app")!,
    document.querySelector<HTMLElement>("#labels")!,
  );
  await world.init();
  const help = document.querySelector<HTMLDivElement>("#help");
  if (help) help.innerHTML = snow ? HELP.snow : HELP.jetski;

  setStatus("Getting a join ticket…");
  const ticket = await getTicket();
  setStatus("Connecting…");
  const net: NetConditions = { lagMs: 0, jitterMs: 0, lossPct: 0 };
  const raw: Transport = await connect(ticket);
  const transport = conditioned(raw, net);

  const client = new WasmClient(ticket.token);
  transport.onMessage((bytes) => client.handlePacket(bytes, performance.now()));
  let closedReason = "";
  transport.onClose((reason) => {
    closedReason = reason;
  });

  const settings: DebugSettings = {
    renderScale: Number(params.get("scale") ?? 1),
  };
  world.setRenderScale(settings.renderScale);
  const debug = createDebugPanel(net, settings, (s) => world.setRenderScale(s));
  debug.state.transport = transport.kind;
  debug.state.renderer = world.backend;

  const input = new InputReader();
  let names = new Map<number, string>();
  let rosterVersion = -1;
  let courseSet = false;
  let minimap: CourseMap | null = null;
  let sport: "jetski" | "snow" = "jetski";
  let last = performance.now();
  let fpsFrames = 0;
  let fpsSince = last;
  let lastBytes = { in: 0, out: 0, at: last };
  let riders: RiderView[] = [];
  let stats: Record<string, number> = {};

  const sendOutgoing = () => {
    const packed = client.takeOutgoing();
    let o = 0;
    while (o + 2 <= packed.length) {
      const len = packed[o]! | (packed[o + 1]! << 8);
      transport.send(packed.slice(o + 2, o + 2 + len));
      o += 2 + len;
    }
  };

  const step = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let i = input.read(dt);
    if (autopilot && client.phase() === 1) {
      const [steer = 0, throttle = 0, lean = 0, buttons = 0] = client.autoInput();
      i = { steer, throttle, lean, buttons };
    }
    client.update(now, i.steer, i.throttle, i.lean, i.buttons);
    sendOutgoing();
    return dt;
  };

  // The netcode clock must not depend on render speed: if no frame has run
  // the netcode recently (slow GPU, hidden tab), a timer does it.
  setInterval(() => {
    const now = performance.now();
    if (now - last > 20) step(now);
  }, 10);

  // One bulk read of every rider's render state from WASM memory.
  const readRiders = (): RiderView[] => {
    const n = client.render();
    const buf = new Float32Array(wasm.memory.buffer, client.renderPtr(), client.renderLen());
    const out: RiderView[] = [];
    for (let k = 0; k < n; k++) {
      const o = k * stride;
      out.push({
        slot: buf[o]!,
        x: buf[o + 1]!,
        y: buf[o + 2]!,
        z: buf[o + 3]!,
        yaw: buf[o + 4]!,
        pitch: buf[o + 5]!,
        roll: buf[o + 6]!,
        speed: buf[o + 7]!,
        grounded: buf[o + 8] === 1,
        isMe: buf[o + 9] === 1,
        isBot: buf[o + 10] === 1,
        vx: buf[o + 11]!,
        vy: buf[o + 12]!,
        vz: buf[o + 13]!,
        bailing: buf[o + 14] === 1,
        charge: buf[o + 15]!,
        grab: buf[o + 16]!,
        lean: buf[o + 17]!,
        steer: buf[o + 18]!,
      });
    }
    return out;
  };

  const readRace = (): RaceView => {
    const ptr = client.updateRace();
    const view = new Float64Array(wasm.memory.buffer, ptr, raceKeys.length);
    const f = (key: string) => view[raceKeys.indexOf(key)] ?? 0;
    return {
      phase: f("phase"),
      phaseTicks: f("phaseTicks"),
      phaseLength: f("phaseLength"),
      laps: f("laps"),
      racing: f("racing") === 1,
      lap: f("lap"),
      meter: f("meter"),
      meterMax: f("meterMax"),
      nextGate: f("nextGate"),
      finishTicks: f("finishTicks"),
      place: f("place"),
      racers: f("racers"),
      misses: f("misses"),
      tickHz: f("tickHz") || 60,
      wrongWay: f("wrongWay") === 1,
      points: f("points"),
      gates: f("gates"),
      looped: f("looped") === 1,
    };
  };
  const readStandings = () => parseStandings(client.standingsJson());

  const readStats = () => {
    const ptr = client.updateStats();
    const view = new Float64Array(wasm.memory.buffer, ptr, fields.length);
    stats = Object.fromEntries(fields.map((f, i) => [f, view[i] ?? 0]));
  };

  await world.renderer.setAnimationLoop((now: number) => {
    const dt = step(now);
    const phase = client.phase();
    if (phase === 0) setStatus("Joining room…");
    else if (phase >= 2) setStatus(`Rejected: ${REJECT_REASONS[phase] ?? phase}`);
    else if (closedReason) setStatus(`Connection lost: ${closedReason}`);
    else setStatus("");

    if (phase === 1 && !courseSet) {
      const course = parseCourse(client.courseJson());
      const ui = document.querySelector<HTMLDivElement>("#ui")!;
      sport = course.sport;
      input.sport = course.sport;
      if (help) help.innerHTML = course.sport === "snow" ? HELP.snow : HELP.jetski;
      if (course.sport === "snow") {
        world.setEnvironment(
          new Mountain(course.run, {
            ribbon: (rows, offsets) => client.runRibbon(rows, offsets),
            grid: (x0, z0, spacing, nx, nz) => client.terrainGrid(x0, z0, spacing, nx, nz),
            heights: (points) => client.heightsAt(points),
          }),
        );
        world.setSunOffset(-35, 70, -30);
        minimap = new RunMap(ui, course.run);
      } else {
        world.setEnvironment(
          new Bay({
            water: params.get("water") === "basic" ? "basic" : "sea",
            topSpeed: client.topSpeed(),
            waves: client.waveParams(),
            course: course.bay,
          }),
        );
        minimap = new Minimap(ui, course.bay);
      }
      courseSet = true;
    }
    if (client.rosterVersion() !== rosterVersion) {
      rosterVersion = client.rosterVersion();
      names = parseRoster(client.rosterJson());
    }

    riders = readRiders();
    const race = readRace();
    const nextBuoy = race.looped && race.nextGate >= 1 ? race.nextGate - 1 : null;
    if (renderEnabled) world.render(riders, names, client.renderTick(), dt, nextBuoy);

    const me = riders.find((r) => r.isMe);
    if (phase === 1) {
      hud.events(parseEvents(client.takeEventsJson()), client.slot(), race);
      hud.update(race, (me?.speed ?? 0) * 3.6, me ? !me.grounded : false, readStandings, names);
      minimap?.update(riders, nextBuoy);
    }

    fpsFrames++;
    if (now - fpsSince > 250) {
      readStats();
      const s = debug.state;
      s.fps = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0;
      fpsSince = now;
      s.rttMs = stats.rttMs ?? 0;
      s.inputLead = stats.inputLead ?? 0;
      s.timeScale = stats.timeScale ?? 1;
      s.predictedTick = stats.predictedTick ?? 0;
      s.snapshotTick = stats.snapshotTick ?? 0;
      s.lastCorrectionCm = (stats.lastCorrectionM ?? 0) * 100;
      s.mispredictions = stats.mispredictions ?? 0;
      s.resyncs = stats.resyncs ?? 0;
      s.snapshotBytes = stats.lastSnapshotBytes ?? 0;
      s.inputsPerPacket = stats.lastInputCount ?? 0;
      const secs = (now - lastBytes.at) / 1000;
      s.downKbps = (((stats.bytesIn ?? 0) - lastBytes.in) * 8) / 1000 / secs;
      s.upKbps = (((stats.bytesOut ?? 0) - lastBytes.out) * 8) / 1000 / secs;
      lastBytes = { in: stats.bytesIn ?? 0, out: stats.bytesOut ?? 0, at: now };
      debug.refresh();
    }
  });

  // Test hooks (used by the Playwright e2e test).
  Object.assign(window, {
    __shifty: {
      phase: () => client.phase(),
      slot: () => client.slot(),
      transport: transport.kind,
      renderer: world.backend,
      sport: () => sport,
      stats: () => (readStats(), stats),
      // Fresh, not the last rendered frame (frames can be slow without a GPU).
      riders: () => readRiders(),
      race: () => readRace(),
      standings: () => readStandings(),
      names: () => Object.fromEntries(names),
      setInput: (v: { steer?: number; throttle?: number; lean?: number; buttons?: number } | null) => {
        input.forced = v;
      },
      net,
    },
  });
  addEventListener("beforeunload", () => transport.close());
}

main().catch((e: unknown) => {
  console.error(e);
  if (e instanceof WebTransportUnavailable) setStatus(e.message);
  else setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
});
