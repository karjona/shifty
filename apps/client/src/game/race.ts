// A race on screen: the connection to the race server, the netcode client
// (WASM), the world drawn from its prediction, and the HUD. A Tilt
// moves from race to race (a circuit in its conditions) in the same
// session, with a short season change in between. Each race starts with its intro (see intro.ts), once
// every screen has told the server its course is on show.
import { type Appearance, SEASONS, SPORT_SEASONS, botAppearance, circuit, decodeAppearance } from "@shifty/rider";
import { WasmClient, raceFields, renderStride, statsFields, weatherFields } from "../wasm/sim.js";
import { RaceAudio } from "../audio/race.ts";
import { messages } from "../i18n/index.ts";
import { type FrameInput, InputReader } from "../input.ts";
import { holdLoading } from "../loading.ts";
import { conditioned, type NetConditions } from "../net/conditioner.ts";
import { connect, type JoinTicket, type Transport } from "../net/transport.ts";
import { Bay } from "../render/bay.ts";
import { Cape } from "../render/cape.ts";
import { Mountain } from "../render/mountain.ts";
import type { Environment, RiderView } from "../render/world.ts";
import { createDebugPanel } from "../ui/debug.ts";
import { Hud, type RaceView } from "../ui/hud.ts";
import { Minimap, RunMap, type CourseMap } from "../ui/minimap.ts";
import { type RosterName, Scoreboard } from "../ui/results.ts";
import { WrongWay } from "../ui/wrong-way.ts";
import { parseCourse, parseEvents, parseGrandPrix, parseRosterNames, parseStandings } from "../wasm-json.ts";
import type { Engine, Stage } from "./engine.ts";
import { Broadcast, onAir } from "./broadcast.ts";
import {
  type Conditions,
  NO_WEATHER,
  type Season,
  WEATHERS,
  type WeatherHere,
  eventKey,
  homeConditions,
  readWeather,
} from "./conditions.ts";
import { disposeTree } from "./dispose.ts";
import { RaceIntro } from "./intro.ts";
import { type PodiumData, podiumData } from "./podium.ts";
import { SeasonCard, SeasonChange } from "./season-change.ts";
import { TouchControls } from "../touch/controls.ts";
import { canTouch, keepAwake, touchScreen } from "../touch/device.ts";

/** Why the race server said no, by client phase (2 + the protocol's reject reason). */
function rejectReason(phase: number): string {
  const r = messages().race.reasons;
  const reasons: Record<number, string> = {
    3: r.version,
    4: r.token,
    5: r.full,
    6: r.draining,
    7: r.kicked,
    8: r.started,
    9: r.over,
  };
  return reasons[phase] ?? String(phase);
}

export interface RaceOptions {
  ticket: JoinTicket;
  /** Where the HUD goes. */
  hud: HTMLElement;
  /** Status line (rejected, connection lost); connecting and joining show on the loading sign. */
  status: (text: string) => void;
  /** false: run the netcode without drawing (netcode tests). */
  render?: boolean;
  /** Dev: ride with the bot's inputs. */
  autopilot?: boolean;
  /** Dev: the netcode debug panel (F1). */
  debug?: boolean;
  /** Called once the race server has said yes or no. */
  onJoin?: (ok: boolean) => void;
  /** Called once the room's plan is over (the last race's results are done), with a Tilt's podium. */
  onOver?: (podium: PodiumData | null) => void;
}

/** What the menus (and tests) can see of a race. */
export interface RaceState {
  /** Netcode: 0 joining, 1 joined, 2+ turned away. */
  phase: number;
  /** The race (`sim::Phase`): 0 on the grid, 4 intro, 1 countdown, 2 racing, 3 results. */
  racePhase: number;
  sport: "jetski" | "snow";
  course: number;
  /** The race's season, weather and time of day (null before the first snapshot). */
  conditions: Conditions | null;
  eventIndex: number;
  eventCount: number;
  /** The plan is over: the last race's results are done. */
  over: boolean;
  /** The race is on television: your rider rides on autopilot (finished, or joined midway), or the results are up. */
  watching: boolean;
  /** What the player rides with: the race's help talks about it. */
  device: "keyboard" | "gamepad" | "touch";
}

/** `sim::Phase`: the countdown, the race, the results. */
const COUNTDOWN = 1;
const RACING = 2;
const RESULTS = 3;

/** Roster JSON comes from our own WASM, but parse it defensively anyway. */
function parseRoster(json: string, seed: number): { names: Map<number, string>; looks: Map<number, Appearance> } {
  const names = new Map<number, string>();
  const looks = new Map<number, Appearance>();
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) return { names, looks };
  for (const e of data as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const slot: unknown = Reflect.get(e, "slot");
    const name: unknown = Reflect.get(e, "name");
    const bot: unknown = Reflect.get(e, "bot");
    const look: unknown = Reflect.get(e, "look");
    if (typeof slot !== "number" || typeof name !== "string") continue;
    names.set(slot, bot === true ? `🤖 ${name}` : name);
    const bytes = Array.isArray(look) && look.every((b) => typeof b === "number") ? Uint8Array.from(look) : null;
    // Bots (and riders without a look) are dressed alike on every screen.
    looks.set(slot, (bytes && decodeAppearance(bytes)) ?? botAppearance(seed, slot));
  }
  return { names, looks };
}

/**
 * The season of a ticket's first race as far as its claims tell (they are
 * readable; only the race server checks them): a Tilt starts in summer, a
 * race may name its season or its circuit. The race server draws the rest,
 * so this is the season card's first guess until the race is known.
 */
function ticketSeason(token: string): Season {
  try {
    const part = (token.split(".")[0] ?? "").replaceAll("-", "+").replaceAll("_", "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0)));
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null || Reflect.get(claims, "tilt") === true) return "summer";
    const races: unknown = Reflect.get(claims, "races");
    const race: unknown = Array.isArray(races) ? races[0] : null;
    const pick = (k: string): unknown => (typeof race === "object" && race !== null ? Reflect.get(race, k) : null);
    const season = SEASONS[Number(pick("season"))];
    if (season) return season;
    const sport = circuit(Number(pick("course")))?.sport;
    return sport ? (SPORT_SEASONS[sport][0] ?? "summer") : "summer";
  } catch {
    return "summer";
  }
}

/** With no frame for this long (ms), a timer runs the netcode. */
const STALLED_MS = 100;

/** How long a course waits for its riders' art before it goes on without the late ones. */
const RIDERS_WAIT_MS = 8000;

/** A number from the room's code, so everyone in it sees the same bots. */
function roomSeed(room: string): number {
  let h = 2166136261;
  for (let i = 0; i < room.length; i++) h = Math.imul(h ^ room.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class RaceSession implements Stage {
  private engine: Engine | null = null;
  private transport: Transport | null = null;
  private client: WasmClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private input = new InputReader(touchScreen());
  /** On a touch screen: the stick and buttons over the race. */
  private touch: TouchControls | null = null;
  /** Lets the screen sleep again. */
  private sleep: (() => void) | null = null;
  private lastInput: FrameInput | null = null;
  private sfx = new RaceAudio();
  private net: NetConditions = { lagMs: 0, jitterMs: 0, lossPct: 0 };
  private hud: Hud;
  private board: Scoreboard;
  private wrongWay = new WrongWay();
  private mapRoot: HTMLDivElement;
  private minimap: CourseMap | null = null;
  private env: Environment | null = null;
  private names = new Map<number, string>();
  private riders = new Map<number, RosterName>();
  private looks = new Map<number, Appearance>();
  /** The seats taken, as of the last roster. */
  private slots: number[] = [];
  private rosterVersion = -1;
  private gpVersion = -1;
  private gpPoints = new Map<number, number>();
  /** The race on screen (`eventKey`; empty: none yet). */
  private event = "";
  private conditions: Conditions = homeConditions("jetski");
  private sport: "jetski" | "snow" = "jetski";
  private closedReason = "";
  private joined = false;
  private last = performance.now();
  private stats: Record<string, number> = {};
  private stopped = false;
  private seasonChange: SeasonChange | null = null;
  /** Covers the course while it loads (joining). */
  private card: SeasonCard | null = null;
  /** A season card is over the course (it loads, or the season changes). */
  private covered = true;
  /** The race whose results came up last: the grid after them waits for the next course. */
  private resultsEvent = -1;
  private intro: RaceIntro | null = null;
  /** The cameras once your race is over. */
  private tv: Broadcast | null = null;
  /** The course on screen is built and ready to draw. */
  private ready = false;
  /** ...and draws smoothly: its card is coming off. */
  private shown = false;
  private debug: ReturnType<typeof createDebugPanel> | null = null;
  private fps = { frames: 0, since: performance.now(), bytesIn: 0, bytesOut: 0, at: performance.now() };
  readonly state: RaceState = {
    phase: 0,
    racePhase: 0,
    sport: "jetski",
    course: -1,
    conditions: null,
    eventIndex: 0,
    eventCount: 1,
    over: false,
    watching: false,
    device: "keyboard",
  };
  /** The last race of the plan has reached its results. */
  private finalResults = false;

  private opts: RaceOptions;

  constructor(opts: RaceOptions) {
    this.opts = opts;
    this.hud = new Hud(opts.hud);
    this.mapRoot = document.createElement("div");
    opts.hud.append(this.mapRoot);
    this.board = new Scoreboard(opts.hud);
  }

  /** Takes down the loading sign put up by `joining`. */
  private joinSign: (() => void) | null = null;

  /** Puts the loading sign up saying how joining goes (null: joined, or turned away). */
  private joining(label: (() => string) | null): void {
    this.joinSign?.();
    this.joinSign = label ? holdLoading(label) : null;
  }

  /** Paused (a menu is open over the race): the rider gets no input. */
  private paused = false;

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Cuts to another television camera (the on-screen button). */
  nextCamera(): void {
    this.input.pressCamera();
  }

  start(engine: Engine): void {
    this.engine = engine;
    if (canTouch()) {
      this.touch = new TouchControls();
      this.input.touch = this.touch;
    }
    this.sleep = keepAwake();
    if (this.opts.render ?? engine.render) {
      this.card = new SeasonCard(ticketSeason(this.opts.ticket.token), false);
      this.card.loading = true;
      this.showHud(false);
      this.intro = new RaceIntro(this.opts.hud);
      this.tv = new Broadcast();
    }
    this.joining(() => messages().race.connecting);
    void this.connect(engine).catch((e: unknown) => {
      this.joining(null);
      this.opts.status(e instanceof Error ? e.message : String(e));
      void this.card?.hide();
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
    this.joining(() => messages().race.joining);
    if (import.meta.env.DEV && this.opts.debug) {
      this.debug = createDebugPanel(this.net, { renderScale: engine.world.renderScale }, (s) => engine.setScale(s));
      this.debug.state.transport = transport.kind;
      this.debug.state.renderer = engine.world.backend;
    }
    // The netcode clock must not stop with drawing: if frames have stopped
    // (a hidden tab, a long stall), a timer runs it. Not between frames that
    // are merely slow: the next frame would then show the world at the
    // timer's later time, and frames would step unevenly.
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - this.last > STALLED_MS) this.step(now);
    }, 25);
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

  private step(at: number): number {
    // A frame's time can be a little behind the timer's last step.
    const now = Math.max(at, this.last);
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
    this.lastInput = i;
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

  private readRace(): RaceView & {
    course: number;
    conditions: Conditions;
    season: Season;
    eventIndex: number;
    eventCount: number;
    gpVersion: number;
  } {
    const client = this.client!;
    const keys = raceFields();
    const view = new Float64Array(this.engine!.wasm.memory.buffer, client.updateRace(), keys.length);
    const f = (key: string) => view[keys.indexOf(key)] ?? 0;
    const conditions: Conditions = {
      season: SEASONS[f("season")] ?? "summer",
      weather: WEATHERS[f("weather")] ?? "clear",
      turns: WEATHERS[f("turns")] ?? "clear",
      time: f("time"),
    };
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
      conditions,
      season: conditions.season,
      eventIndex: f("eventIndex"),
      eventCount: f("eventCount") || 1,
      gpVersion: f("gpVersion"),
      autopilot: f("autopilot") === 1,
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

  /**
   * The course's surroundings and minimap (on joining, and at each Grand
   * Prix course), and every rider's model on it. Resolves once it is ready
   * to draw: its shaders compiled and the riders' art in (or late).
   */
  private async setCourse(engine: Engine, client: WasmClient, render: boolean): Promise<void> {
    const course = parseCourse(client.courseJson());
    this.sport = course.sport;
    this.input.sport = course.sport;
    this.sfx.setCourse(course, client.topSpeed());
    this.hud.tags.sport = course.sport;
    this.mapRoot.replaceChildren();
    if (!render) return;
    this.ready = false;
    this.shown = false;
    const old = this.env;
    const conditions = this.conditions;
    if (course.sport === "snow") {
      this.env = new Mountain(
        course.run,
        {
          ribbon: (rows, offsets) => client.runRibbon(rows, offsets),
          grid: (x0, z0, spacing, nx, nz) => client.terrainGrid(x0, z0, spacing, nx, nz),
          heights: (points) => client.heightsAt(points),
          snow: (points) => client.snowAt(points),
        },
        conditions,
        course.id,
      );
      this.minimap = new RunMap(this.mapRoot, course.run);
    } else {
      const water = {
        water: engine.view.water,
        topSpeed: client.topSpeed(),
        waves: client.waveParams(),
        course: course.bay,
        conditions,
      };
      this.env = course.bay.place === "cape" ? new Cape(water) : new Bay(water);
      this.minimap = new Minimap(this.mapRoot, course.bay);
    }
    engine.world.setEnvironment(this.env);
    const fields = weatherFields();
    const here: WeatherHere = { ...NO_WEATHER };
    engine.world.weatherAt = (x, z) => {
      const ptr = client.updateWeather(x, z);
      return readWeather(fields, new Float32Array(engine.wasm.memory.buffer, ptr, fields.length), here);
    };
    this.intro?.setCourse(this.event, course, this.env);
    this.tv?.setCourse(course, this.env, course.sport === "snow" ? (points) => client.heightsAt(points) : undefined);
    if (old) disposeTree(old.group);
    const env = this.env;
    engine.world.addRiders(this.slots);
    await engine.warm(() => engine.world.compile());
    // (The roster may have come in meanwhile.)
    if (this.client !== client) return;
    this.readRoster(engine, client);
    const riders = engine.world.addRiders(this.slots);
    const late = new Promise<void>((resolve) => setTimeout(resolve, RIDERS_WAIT_MS));
    await Promise.race([Promise.all(riders.map((r) => r.ready)), late]);
    if (this.env !== env || this.stopped) return;
    this.ready = true;
    // It draws behind the card until it runs smoothly.
    await engine.settled();
    if (this.env === env && !this.stopped) this.shown = true;
  }

  /** The HUD is off while a season card is up, and while the start has the screen. */
  private showHud(on: boolean): void {
    const visibility = on ? "" : "hidden";
    if (this.opts.hud.style.visibility !== visibility) this.opts.hud.style.visibility = visibility;
  }

  /** Who rides where, and what they look like (when the roster has changed). */
  private readRoster(engine: Engine, client: WasmClient): void {
    if (client.rosterVersion() === this.rosterVersion) return;
    this.rosterVersion = client.rosterVersion();
    const json = client.rosterJson();
    const roster = parseRoster(json, roomSeed(this.opts.ticket.room));
    this.names = roster.names;
    this.riders = parseRosterNames(json);
    this.looks = roster.looks;
    this.slots = [...roster.looks.keys()];
    for (const [slot, look] of roster.looks) engine.world.setAppearance(slot, look);
  }

  frame(now: number): void {
    const engine = this.engine;
    const client = this.client;
    if (!engine) return;
    const dt = this.step(now);
    if (!client) return;
    const render = this.opts.render ?? engine.render;
    const phase = client.phase();
    this.state.phase = phase;
    const m = messages().race;
    if (phase >= 2) this.opts.status(m.rejected(rejectReason(phase)));
    else if (this.closedReason) this.opts.status(m.lost(this.closedReason));
    else this.opts.status("");
    if (!this.joined && phase !== 0) {
      this.joined = true;
      this.joining(null);
      if (phase !== 1) void this.card?.hide();
      this.opts.onJoin?.(phase === 1);
    }
    if (phase >= 2 || this.closedReason) {
      void this.card?.hide();
      this.joining(null);
    }
    if (phase !== 1) return;

    const race = this.readRace();
    Object.assign(this.state, {
      racePhase: race.phase,
      sport: this.sport,
      course: race.course,
      conditions: race.conditions,
      eventIndex: race.eventIndex,
      eventCount: race.eventCount,
    });
    if (race.phase === RESULTS && race.eventIndex >= race.eventCount - 1) this.finalResults = true;
    else if (this.finalResults && race.phase !== RESULTS && !this.state.over) {
      this.state.over = true;
      const rows = this.board.final(this.gpPoints);
      this.opts.onOver?.(rows && podiumData(rows, this.riders, this.looks, client.slot(), this.conditions.season));
    }
    this.readRoster(engine, client);
    const event = eventKey(race.course, race.conditions);
    if (event !== this.event) {
      const first = this.event === "";
      this.event = event;
      this.conditions = race.conditions;
      if (first || !render) {
        const card = this.card;
        if (card) {
          card.season = race.season;
          card.course = race.course;
        }
        void this.setCourse(engine, client, render).finally(() => {
          if (this.card === card) this.card = null;
          void (card?.hide() ?? Promise.resolve()).then(() => {
            this.covered = false;
          });
        });
      } else {
        // A Tilt moves on: the season changes, and the new course
        // comes up behind the change.
        this.seasonChange?.finish();
        this.covered = true;
        this.seasonChange = new SeasonChange(
          engine,
          race.season,
          () => this.setCourse(engine, client, render),
          () => {
            this.covered = false;
          },
          race.course,
        );
      }
    }
    if (race.gpVersion !== this.gpVersion) {
      this.gpVersion = race.gpVersion;
      this.gpPoints = parseGrandPrix(client.grandPrixJson());
    }

    // The course on screen is this race's, and nothing covers it: the
    // server can start the race as far as this screen goes. (After a
    // race's results, the grid waits for the plan's next course.)
    if (race.phase === RESULTS) this.resultsEvent = race.eventIndex;
    const current = event === this.event && race.eventIndex !== this.resultsEvent;
    const onShow = current && (!render || (this.shown && !this.covered));
    client.setReady(onShow ? race.eventIndex : -1);
    const hud = !this.covered && !RaceIntro.active(race.phase);
    this.showHud(hud);
    const watching = onAir(race, this.sport);
    this.state.watching = watching;
    this.state.device = this.input.lastDevice;
    const touching = this.input.lastDevice === "touch";
    this.touch?.show(
      touching && hud && !watching && !this.paused && (race.phase === COUNTDOWN || race.phase === RACING),
      touching,
    );
    this.hud.showGauges(!watching);
    this.sfx.broadcast = watching;
    if (this.input.takeCamera() && watching && !this.paused) this.tv?.next();

    const riders = this.readRiders();
    const nextBuoy = race.looped && race.nextGate >= 1 ? race.nextGate - 1 : null;
    if (render) {
      const tick = client.renderTick();
      const intro = this.intro?.frame(race, current && this.ready, this.covered, tick, now) ?? null;
      if (!watching) this.tv?.off();
      const tv =
        watching && !intro
          ? (this.tv?.frame(riders, now / 1000, tick / race.tickHz, dt, race.phase === RESULTS) ?? null)
          : null;
      const shot = intro ?? tv;
      if (this.seasonChange?.active) this.seasonChange.frame(dt);
      else if (this.ready) {
        engine.world.render(riders, tick, dt, nextBuoy, shot);
        const tagged = race.phase === RESULTS ? [] : riders;
        this.hud.tags.hidden = shot !== null && shot.chase < 1;
        this.hud.tags.update(engine.world.camera, this.env, tagged, this.names, tick / race.tickHz, dt);
      }
      if (this.seasonChange && !this.seasonChange.active) this.seasonChange = null;
    }
    const me = riders.find((r) => r.isMe);
    race.wrongWay = this.wrongWay.update(race, me);
    const events = parseEvents(client.takeEventsJson());
    this.hud.events(events, client.slot(), race);
    const audible = this.shown && !this.seasonChange?.active;
    this.sfx.frame(riders, race, events, client.slot(), this.lastInput, engine.world.camera, audible, dt);
    const gp = race.eventCount > 1 ? { index: race.eventIndex, count: race.eventCount, points: this.gpPoints } : null;
    this.hud.update(race, (me?.speed ?? 0) * 3.6, me ? !me.grounded : false, gp);
    this.board.update({
      race,
      mySlot: client.slot(),
      standings: () => parseStandings(client.standingsJson()),
      riders: this.riders,
      gp,
    });
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

  /** Test hooks for the Playwright e2e tests (dev server only). */
  private installHooks(engine: Engine, transport: Transport): void {
    if (!import.meta.env.DEV) return;
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
        /** The race's weather where the camera is (null outside a race). */
        weather: () => {
          const eye = engine.world.camera.position;
          const at = engine.world.weatherAt;
          return at ? { ...at(eye.x, eye.z) } : null;
        },
        standings: () => (this.client ? parseStandings(this.client.standingsJson()) : []),
        names: () => Object.fromEntries(this.names),
        grandPrix: () => Object.fromEntries(this.gpPoints),
        ready: () => this.shown,
        /** What the rider got last frame, from whichever device. */
        input: () => this.lastInput,
        touchControls: () => document.querySelector(".touch-controls:not([hidden])") !== null,
        setInput: (v: { steer?: number; throttle?: number; lean?: number; buttons?: number } | null) => {
          this.input.forced = v;
        },
        introAt: (seconds: number | null) => {
          if (this.intro) this.intro.pinned = seconds;
        },
        tv: (camera?: string | null) => {
          if (this.tv && camera !== undefined) this.tv.pinned = camera;
          return { cameras: this.tv?.cameras ?? [], on: this.tv?.onAir ?? null };
        },
        net: this.net,
      },
    });
  }

  stop(): void {
    this.stopped = true;
    this.joining(null);
    if (this.timer) clearInterval(this.timer);
    this.seasonChange?.cancel();
    this.sfx.stop();
    void this.card?.hide();
    this.transport?.close();
    this.client?.free();
    this.client = null;
    this.debug?.destroy();
    this.touch?.dispose();
    this.sleep?.();
    this.opts.hud.replaceChildren();
    if (this.engine) this.engine.world.weatherAt = null;
    if (this.env && this.engine) {
      this.engine.world.clearEnvironment();
      disposeTree(this.env.group);
    }
    this.env = null;
    this.input.dispose();
    if (import.meta.env.DEV) Reflect.deleteProperty(window, "__shifty");
  }
}
