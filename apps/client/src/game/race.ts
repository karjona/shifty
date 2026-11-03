// A race on screen: the connection to the race server, the netcode client
// (WASM), the world drawn from its prediction, and the HUD. A Grand Prix
// moves from course to course in the same session, with a short season
// change in between.
import { WasmClient, raceFields, renderStride, statsFields } from "../wasm/sim.js";
import { InputReader } from "../input.ts";
import { conditioned, type NetConditions } from "../net/conditioner.ts";
import { connect, type JoinTicket, type Transport } from "../net/transport.ts";
import { Bay } from "../render/bay.ts";
import { Mountain } from "../render/mountain.ts";
import type { Environment, RiderView } from "../render/world.ts";
import { createDebugPanel } from "../ui/debug.ts";
import { Hud, type RaceView } from "../ui/hud.ts";
import { Minimap, RunMap, type CourseMap } from "../ui/minimap.ts";
import { parseCourse, parseEvents, parseGrandPrix, parseStandings } from "../wasm-json.ts";
import type { Engine, Stage } from "./engine.ts";
import { disposeTree } from "./dispose.ts";
import { SeasonChange } from "./season-change.ts";

export const REJECT_REASONS: Record<number, string> = {
  3: "the game was updated, please reload the page",
  4: "invalid join ticket",
  5: "room is full (4 players max)",
  6: "server is shutting down",
  7: "disconnected for inactivity",
  8: "this Grand Prix has already started",
};

export interface RaceOptions {
  ticket: JoinTicket;
  /** Where the HUD goes. */
  hud: HTMLElement;
  /** Status line (joining, rejected, connection lost). */
  status: (text: string) => void;
  /** false: run the netcode without drawing (netcode tests). */
  render?: boolean;
  /** Dev: ride with the bot's inputs. */
  autopilot?: boolean;
  /** Dev: the netcode debug panel (F1). */
  debug?: boolean;
  /** Called once the race server has said yes or no. */
  onJoin?: (ok: boolean) => void;
}

/** What the menus (and tests) can see of a race. */
export interface RaceState {
  phase: number;
  course: number;
  eventIndex: number;
  eventCount: number;
}

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

export class RaceSession implements Stage {
  private engine: Engine | null = null;
  private transport: Transport | null = null;
  private client: WasmClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private input = new InputReader();
  private net: NetConditions = { lagMs: 0, jitterMs: 0, lossPct: 0 };
  private hud: Hud;
  private mapRoot: HTMLDivElement;
  private minimap: CourseMap | null = null;
  private env: Environment | null = null;
  private names = new Map<number, string>();
  private rosterVersion = -1;
  private gpVersion = -1;
  private gpPoints = new Map<number, number>();
  private course = -1;
  private sport: "jetski" | "snow" = "jetski";
  private closedReason = "";
  private joined = false;
  private last = performance.now();
  private stats: Record<string, number> = {};
  private stopped = false;
  private seasonChange: SeasonChange | null = null;
  private debug: ReturnType<typeof createDebugPanel> | null = null;
  private fps = { frames: 0, since: performance.now(), bytesIn: 0, bytesOut: 0, at: performance.now() };
  readonly state: RaceState = { phase: 0, course: -1, eventIndex: 0, eventCount: 1 };

  private opts: RaceOptions;

  constructor(opts: RaceOptions) {
    this.opts = opts;
    this.hud = new Hud(opts.hud);
    this.mapRoot = document.createElement("div");
    opts.hud.append(this.mapRoot);
  }

  /** Paused (a menu is open over the race): the rider gets no input. */
  private paused = false;

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  start(engine: Engine): void {
    this.engine = engine;
    this.opts.status("Connecting…");
    void this.connect(engine).catch((e: unknown) => {
      this.opts.status(e instanceof Error ? e.message : String(e));
      this.opts.onJoin?.(false);
    });
  }

  private async connect(engine: Engine): Promise<void> {
    const raw = await connect(this.opts.ticket);
    if (this.stopped) {
      raw.close();
      return;
    }
    const transport = conditioned(raw, this.net);
    this.transport = transport;
    const client = new WasmClient(this.opts.ticket.token);
    this.client = client;
    transport.onMessage((bytes) => client.handlePacket(bytes, performance.now()));
    transport.onClose((reason) => {
      this.closedReason = reason;
    });
    this.opts.status("Joining room…");
    if (this.opts.debug) {
      this.debug = createDebugPanel(this.net, { renderScale: engine.view.scale }, (s) => engine.setScale(s));
      this.debug.state.transport = transport.kind;
      this.debug.state.renderer = engine.world.backend;
    }
    // The netcode clock must not depend on render speed: if no frame has run
    // the netcode recently (slow GPU, hidden tab), a timer does it.
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - this.last > 20) this.step(now);
    }, 10);
    this.installHooks(engine, transport);
  }

  private sendOutgoing(client: WasmClient, transport: Transport): void {
    const packed = client.takeOutgoing();
    let o = 0;
    while (o + 2 <= packed.length) {
      const len = packed[o]! | (packed[o + 1]! << 8);
      transport.send(packed.slice(o + 2, o + 2 + len));
      o += 2 + len;
    }
  }

  private step(now: number): number {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const client = this.client;
    const transport = this.transport;
    if (!client || !transport) return dt;
    let i = this.input.read(dt);
    if (this.paused && !this.input.forced) i = { steer: 0, throttle: 0, lean: 0, buttons: 0 };
    // Test hooks that force the input win over the autopilot.
    if (this.opts.autopilot && client.phase() === 1 && !this.input.forced) {
      const [steer = 0, throttle = 0, lean = 0, buttons = 0] = client.autoInput();
      i = { steer, throttle, lean, buttons };
    }
    client.update(now, i.steer, i.throttle, i.lean, i.buttons);
    this.sendOutgoing(client, transport);
    return dt;
  }

  private readRiders(): RiderView[] {
    const client = this.client;
    const engine = this.engine;
    if (!client || !engine) return [];
    const stride = renderStride();
    const n = client.render();
    const buf = new Float32Array(engine.wasm.memory.buffer, client.renderPtr(), client.renderLen());
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
        wobble: buf[o + 19]!,
      });
    }
    return out;
  }

  private readRace(): RaceView & { course: number; eventIndex: number; eventCount: number; gpVersion: number } {
    const client = this.client!;
    const keys = raceFields();
    const view = new Float64Array(this.engine!.wasm.memory.buffer, client.updateRace(), keys.length);
    const f = (key: string) => view[keys.indexOf(key)] ?? 0;
    return {
      phase: f("phase"),
      phaseStart: f("phaseStart"),
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
      course: f("course"),
      eventIndex: f("eventIndex"),
      eventCount: f("eventCount") || 1,
      gpVersion: f("gpVersion"),
    };
  }

  private readStats(): Record<string, number> {
    const client = this.client;
    if (!client || !this.engine) return this.stats;
    const fields = statsFields();
    const view = new Float64Array(this.engine.wasm.memory.buffer, client.updateStats(), fields.length);
    this.stats = Object.fromEntries(fields.map((f, i) => [f, view[i] ?? 0]));
    return this.stats;
  }

  /** The course's surroundings and minimap (on joining, and at each Grand Prix course). */
  private setCourse(engine: Engine, client: WasmClient, render: boolean): void {
    const course = parseCourse(client.courseJson());
    this.sport = course.sport;
    this.input.sport = course.sport;
    this.mapRoot.replaceChildren();
    if (!render) return;
    const old = this.env;
    if (course.sport === "snow") {
      this.env = new Mountain(course.run, {
        ribbon: (rows, offsets) => client.runRibbon(rows, offsets),
        grid: (x0, z0, spacing, nx, nz) => client.terrainGrid(x0, z0, spacing, nx, nz),
        heights: (points) => client.heightsAt(points),
      });
      engine.world.setSunOffset(-30, 35, 60);
      this.minimap = new RunMap(this.mapRoot, course.run);
    } else {
      this.env = new Bay({
        water: engine.view.water,
        topSpeed: client.topSpeed(),
        waves: client.waveParams(),
        course: course.bay,
      });
      engine.world.setSunOffset(30, 60, 15);
      this.minimap = new Minimap(this.mapRoot, course.bay);
    }
    engine.world.setEnvironment(this.env);
    if (old) disposeTree(old.group);
  }

  frame(now: number): void {
    const engine = this.engine;
    const client = this.client;
    if (!engine) return;
    const dt = this.step(now);
    if (!client) {
      if (engine.render) engine.world.renderer.render(engine.world.scene, engine.world.camera);
      return;
    }
    const render = this.opts.render ?? engine.render;
    const phase = client.phase();
    this.state.phase = phase;
    if (phase === 0) this.opts.status("Joining room…");
    else if (phase >= 2) this.opts.status(`Rejected: ${REJECT_REASONS[phase] ?? phase}`);
    else if (this.closedReason) this.opts.status(`Connection lost: ${this.closedReason}`);
    else this.opts.status("");
    if (!this.joined && phase !== 0) {
      this.joined = true;
      this.opts.onJoin?.(phase === 1);
    }
    if (phase !== 1) {
      if (render) engine.world.renderer.render(engine.world.scene, engine.world.camera);
      return;
    }

    const race = this.readRace();
    Object.assign(this.state, { course: race.course, eventIndex: race.eventIndex, eventCount: race.eventCount });
    if (race.course !== this.course) {
      const first = this.course === -1;
      this.course = race.course;
      if (first || !render) {
        this.setCourse(engine, client, render);
      } else {
        // A Grand Prix moves on: the season changes, and the new course
        // comes up behind the change.
        this.seasonChange?.finish();
        this.seasonChange = new SeasonChange(engine, race.course === 1 ? "winter" : "summer", () =>
          this.setCourse(engine, client, render),
        );
      }
    }
    if (client.rosterVersion() !== this.rosterVersion) {
      this.rosterVersion = client.rosterVersion();
      this.names = parseRoster(client.rosterJson());
    }
    if (race.gpVersion !== this.gpVersion) {
      this.gpVersion = race.gpVersion;
      this.gpPoints = parseGrandPrix(client.grandPrixJson());
    }

    const riders = this.readRiders();
    const nextBuoy = race.looped && race.nextGate >= 1 ? race.nextGate - 1 : null;
    if (render) {
      if (this.seasonChange?.active) this.seasonChange.frame(dt);
      else engine.world.render(riders, this.names, client.renderTick(), dt, nextBuoy);
      if (this.seasonChange && !this.seasonChange.active) this.seasonChange = null;
    }
    const me = riders.find((r) => r.isMe);
    this.hud.events(parseEvents(client.takeEventsJson()), client.slot(), race);
    const gp = race.eventCount > 1 ? { index: race.eventIndex, count: race.eventCount, points: this.gpPoints } : null;
    this.hud.update(
      race,
      (me?.speed ?? 0) * 3.6,
      me ? !me.grounded : false,
      () => parseStandings(client.standingsJson()),
      this.names,
      gp,
    );
    this.minimap?.update(riders, nextBuoy);
    this.updateDebug(now);
  }

  private updateDebug(now: number): void {
    const debug = this.debug;
    if (!debug) return;
    const f = this.fps;
    f.frames++;
    if (now - f.since < 250) return;
    const stats = this.readStats();
    const s = debug.state;
    s.fps = (f.frames * 1000) / (now - f.since);
    f.frames = 0;
    f.since = now;
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
    const secs = (now - f.at) / 1000;
    s.downKbps = (((stats.bytesIn ?? 0) - f.bytesIn) * 8) / 1000 / secs;
    s.upKbps = (((stats.bytesOut ?? 0) - f.bytesOut) * 8) / 1000 / secs;
    f.bytesIn = stats.bytesIn ?? 0;
    f.bytesOut = stats.bytesOut ?? 0;
    f.at = now;
    debug.refresh();
  }

  /** Test hooks (used by the Playwright e2e tests). */
  private installHooks(engine: Engine, transport: Transport): void {
    Object.assign(window, {
      __shifty: {
        phase: () => this.client?.phase() ?? 0,
        slot: () => this.client?.slot() ?? -1,
        transport: transport.kind,
        renderer: engine.world.backend,
        sport: () => this.sport,
        stats: () => this.readStats(),
        // Fresh, not the last rendered frame (frames can be slow without a GPU).
        riders: () => this.readRiders(),
        race: () => this.readRace(),
        standings: () => (this.client ? parseStandings(this.client.standingsJson()) : []),
        names: () => Object.fromEntries(this.names),
        grandPrix: () => Object.fromEntries(this.gpPoints),
        setInput: (v: { steer?: number; throttle?: number; lean?: number; buttons?: number } | null) => {
          this.input.forced = v;
        },
        net: this.net,
      },
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.seasonChange?.cancel();
    this.transport?.close();
    this.client?.free();
    this.client = null;
    this.debug?.destroy();
    this.opts.hud.replaceChildren();
    if (this.env && this.engine) {
      this.engine.world.clearEnvironment();
      disposeTree(this.env.group);
    }
    this.env = null;
    this.input.dispose();
    Reflect.deleteProperty(window, "__shifty");
  }
}
