// A race's sound, from what the race already reads every frame: the riders
// (predicted), the race state and its events. Your own ride gets full
// voices; the nearest few riders get cheap ones placed around the camera
// (distance, pan, air absorption, Doppler). Landings, pops, bumps and
// crashes are one-shots at the rider. The countdown follows the sim's
// countdown phase, tick by tick. While the race is on television, your
// rider is heard from the camera like everyone else.
//
// Nothing here allocates per frame: per-seat state lives in typed arrays.
import type { FrameInput } from "../input.ts";
import type { ObstacleData } from "../render/mountain.ts";
import type { RiderView } from "../render/world.ts";
import type { RaceEvent, RaceView } from "../ui/hud.ts";
import type { CourseInfo } from "../wasm-json.ts";
import { audio } from "./index.ts";
import type { SoundName } from "./library.ts";
import { clamp01, gain, Glide } from "./dsp.ts";
import { type Heard, Hearing } from "./hearing.ts";
import { AIR_LOAD, Board, FarBoard, FarJetski, Hull, JetEngine, type Kit, REV_IDLE, stepRevs, Wind } from "./voices.ts";

/** `sim::Phase`. */
const COUNTDOWN = 1;
const RACING = 2;

const SLOTS = 8;
/** Other riders with a voice of their own, at most (the nearest). */
const FAR_VOICES = 3;
/** The music ducks to this on the grid, under the intro, the countdown and the results. */
const DUCK = 0.35;
/** The wrong-way cue sounds as the warning goes up, and again this often (s) while it stays up. */
const WRONG_WAY_REPEAT = 3;
/** Hops shorter than this (s) land without a sound (the hull skipping over chop makes its own). */
const MIN_AIR_S = 0.12;
/** A landing and its judgement (an event) belong together within this long (s). */
const LANDING_WINDOW_S = 0.25;

/** The world moving on more than this in one frame is a resync, not riding. */
const RESYNC_TICKS = 30;

/** How a landing went, from its event. */
const CLEAN = 0;
const SKETCHY = 1;
const FALL = 2;

/** The camera: where the listener is and which way it faces. */
export interface Listener {
  matrixWorld: { elements: ArrayLike<number> };
}

const wrapPi = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** How far (rad, 0 to π/2) the board points off its direction of travel, either way round. */
function slipAngle(r: RiderView): number {
  if (r.speed < 1) return 0;
  const d = Math.abs(wrapPi(r.yaw - Math.atan2(r.vx, r.vz)));
  return d > Math.PI / 2 ? Math.PI - d : d;
}

export class RaceAudio {
  /** The race is on television: your ride is heard from the camera, not ridden. */
  broadcast = false;
  private sport: "jetski" | "snow" = "jetski";
  private top = 30;
  private obstacles: readonly ObstacleData[] = [];
  private clock = 0;

  private builtFor: "jetski" | "snow" | null = null;
  private bus: GainNode | null = null;
  private busLevel: Glide | null = null;
  /** Your own ride's voices, faded out on television. */
  private mineLevel: Glide | null = null;
  private engine: JetEngine | null = null;
  private hull: Hull | null = null;
  private board: Board | null = null;
  private wind: Wind | null = null;
  private farJet: FarJetski[] = [];
  private farBoard: FarBoard[] = [];
  /** The seat each far voice follows (-1: none). */
  private farSlot = new Int8Array(FAR_VOICES).fill(-1);
  private voiceOf = new Int8Array(SLOTS).fill(-1);

  // Per seat: last frame's state...
  private known = new Uint8Array(SLOTS);
  private lastX = new Float32Array(SLOTS);
  private lastZ = new Float32Array(SLOTS);
  private grounded = new Uint8Array(SLOTS);
  private bailing = new Uint8Array(SLOTS);
  private vx = new Float32Array(SLOTS);
  private vy = new Float32Array(SLOTS);
  private vz = new Float32Array(SLOTS);
  private speed = new Float32Array(SLOTS);
  private charge = new Float32Array(SLOTS);
  private airTime = new Float32Array(SLOTS);
  private revs = new Float32Array(SLOTS);
  private load = new Float32Array(SLOTS);
  // ...what happened when (s, on `clock`)...
  private landAt = new Float64Array(SLOTS).fill(-10);
  private landedClean = new Uint8Array(SLOTS);
  private bailAt = new Float64Array(SLOTS).fill(-10);
  private bumpAt = new Float64Array(SLOTS).fill(-10);
  /** A landing's judgement that came before the landing itself (0: none; else 1 + kind). */
  private pending = new Uint8Array(SLOTS);
  private pendingAt = new Float64Array(SLOTS);
  // ...and where each rider is, heard from the camera.
  private px = new Float32Array(SLOTS);
  private pz = new Float32Array(SLOTS);
  private dist = new Float32Array(SLOTS);
  private level = new Float32Array(SLOTS);
  private pan = new Float32Array(SLOTS);
  private cutoff = new Float32Array(SLOTS);
  private doppler = new Float32Array(SLOTS);
  private heard = new Uint8Array(SLOTS);
  private rank = new Uint8Array(SLOTS);

  private hearing = new Hearing();
  private heardNow: Heard = { level: 0, pan: 0, cutoff: 0, doppler: 1 };
  private jolt = 0;

  /** The predicted world's tick last frame. */
  private tick = -1;
  private countStart = -1;
  private countN = 4;
  private goStart = -1;
  private wrongUp = false;
  private wrongAt = -10;

  /** A new course (on joining, and at each race of a Tilt). */
  setCourse(course: CourseInfo, topSpeed: number): void {
    this.sport = course.sport;
    this.top = topSpeed > 0 ? topSpeed : 30;
    this.obstacles = course.sport === "snow" ? course.run.obstacles : [];
    this.known.fill(0);
    this.pending.fill(0);
  }

  /**
   * Every frame. `input`: this frame's input to your rider; `audible`: the
   * course is on screen (not under a card or a season change).
   */
  frame(
    riders: readonly RiderView[],
    race: RaceView,
    events: readonly RaceEvent[],
    mySlot: number,
    input: FrameInput | null,
    listener: Listener,
    audible: boolean,
    dt: number,
  ): void {
    audio.setDuck(race.phase === RACING ? 1 : DUCK);
    const ctx = audio.ctx;
    const kit = audio.kit;
    const sfx = audio.sfx;
    if (!ctx || !kit || !sfx || dt <= 0) return;
    this.clock += dt;
    if (this.builtFor !== this.sport) this.build(ctx, kit, sfx);
    const t = ctx.currentTime;
    this.busLevel?.to(audible ? 1 : 0, t, audible ? 0.3 : 0.06);
    this.mineLevel?.to(this.broadcast ? 0 : 1, t, 0.2);
    this.hearing.follow(listener.matrixWorld.elements, dt);
    // A clock resync replays or skips the world: what riders did across it is no news.
    const tick = race.phaseStart + race.phaseTicks;
    if (tick < this.tick || tick > this.tick + RESYNC_TICKS) this.known.fill(0);
    this.tick = tick;
    for (const r of riders) this.place(r);
    this.onEvents(events, mySlot, race);
    this.cues(race);
    for (const r of riders) this.ride(r, input, t, dt);
    this.updateFar(riders, t);
  }

  /** Silences the race (it is over, or left). */
  stop(): void {
    audio.setDuck(1);
    this.teardown();
  }

  private build(ctx: BaseAudioContext, kit: Kit, sfx: AudioNode): void {
    this.teardown();
    const bus = gain(ctx, 0);
    bus.connect(sfx);
    this.bus = bus;
    this.busLevel = new Glide(bus.gain, 0.3, 0.001);
    const mine = gain(ctx, 1);
    mine.connect(bus);
    this.mineLevel = new Glide(mine.gain, 1, 0.001);
    this.wind = new Wind(ctx, kit);
    this.wind.out.connect(mine);
    if (this.sport === "jetski") {
      this.engine = new JetEngine(ctx, kit);
      this.engine.out.connect(mine);
      this.hull = new Hull(ctx, kit);
      this.hull.out.connect(mine);
      for (let i = 0; i < FAR_VOICES; i++) this.farJet.push(new FarJetski(ctx, kit, bus));
    } else {
      this.board = new Board(ctx, kit);
      this.board.out.connect(mine);
      for (let i = 0; i < FAR_VOICES; i++) this.farBoard.push(new FarBoard(ctx, kit, bus));
    }
    this.builtFor = this.sport;
    this.known.fill(0);
    this.farSlot.fill(-1);
  }

  private teardown(): void {
    const ctx = audio.ctx;
    const bus = this.bus;
    if (ctx && bus) {
      const t = ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setTargetAtTime(0, t, 0.03);
      const end = t + 0.2;
      for (const v of [this.engine, this.hull, this.board, this.wind, ...this.farJet, ...this.farBoard]) v?.stop(end);
      setTimeout(() => bus.disconnect(), 400);
    }
    this.bus = null;
    this.busLevel = null;
    this.mineLevel = null;
    this.engine = null;
    this.hull = null;
    this.board = null;
    this.wind = null;
    this.farJet = [];
    this.farBoard = [];
    this.builtFor = null;
  }

  /** Where a rider is heard from the camera. */
  private place(r: RiderView): void {
    const s = r.slot;
    if (s < 0 || s >= SLOTS) return;
    this.px[s] = r.x;
    this.pz[s] = r.z;
    if (r.isMe && !this.broadcast) {
      this.dist[s] = 0;
      this.level[s] = 1;
      this.pan[s] = 0;
      this.cutoff[s] = 20000;
      this.doppler[s] = 1;
      return;
    }
    const h = this.heardNow;
    this.dist[s] = this.hearing.hear(r.x, r.y, r.z, r.vx, r.vy, r.vz, h);
    this.level[s] = h.level;
    this.pan[s] = h.pan;
    this.cutoff[s] = h.cutoff;
    this.doppler[s] = h.doppler;
  }

  /** A one-shot at a rider: yours in the middle, others where they are. */
  private emit(name: SoundName, s: number, me: boolean, level: number, rate = 1): void {
    const jitter = 1 + (Math.random() - 0.5) * 0.08;
    if (me) audio.play(name, level, 0, rate * jitter, true, this.bus ?? undefined);
    else {
      const l = level * 0.8 * (this.level[s] ?? 0);
      if (l > 0.01) audio.play(name, l, this.pan[s] ?? 0, rate * jitter, false, this.bus ?? undefined);
    }
  }

  private onEvents(events: readonly RaceEvent[], mySlot: number, race: RaceView): void {
    for (const e of events) {
      const s = e.slot;
      // On autopilot nothing counts: your rider's tricks and buoys go unmarked.
      const mine = s === mySlot && !race.autopilot;
      const heardHere = s === mySlot && !this.broadcast;
      switch (e.kind) {
        case "buoy":
          if (!mine || race.phase !== RACING || !race.racing) break;
          // Each step of the meter a whole tone higher.
          if (e.ok) audio.play("buoy", 0.9, 0, 2 ** ((Math.max(1, e.meter ?? 1) - 1) / 6));
          else audio.play("buoyMiss");
          break;
        case "checkpoint":
          if (mine && race.racing && race.phase === RACING) audio.play("checkpoint");
          break;
        case "lap":
          if (mine && (e.lap ?? 0) > 1) audio.play((e.lap ?? 0) === race.laps ? "finalLap" : "lap");
          break;
        case "finish":
          if (s === mySlot) audio.play("finish");
          break;
        case "trick":
          if (mine) audio.play("trick", e.sketchy ? 0.45 : 1, 0, e.sketchy ? 0.84 : 1);
          if (e.sketchy) this.judged(s, SKETCHY, heardHere);
          break;
        case "sketchy":
          this.judged(s, SKETCHY, heardHere);
          break;
        case "bail":
          if (s >= 0 && s < SLOTS) this.bailAt[s] = this.clock;
          this.judged(s, FALL, heardHere);
          break;
      }
    }
  }

  /** A landing's judgement (or a crash): sounds with the landing, whichever comes first. */
  private judged(s: number, kind: number, me: boolean): void {
    if (s < 0 || s >= SLOTS) return;
    if (!this.known[s] || !this.grounded[s]) {
      // Still in the air as last seen: the landing is this frame or next.
      this.pending[s] = Math.max(this.pending[s] ?? 0, kind + 1);
      this.pendingAt[s] = this.clock;
      return;
    }
    if (this.clock - (this.landAt[s] ?? -10) < LANDING_WINDOW_S) {
      // It landed a moment ago and sounded clean: add what it really was.
      if (this.landedClean[s]) {
        this.landedClean[s] = 0;
        this.landing(s, kind, me, 0, 1);
      }
      return;
    }
    if (kind === FALL) this.crash(s, me);
  }

  /** Knocked down on the ground: into a tree, a rock or a lift tower (or off the jetski). */
  private crash(s: number, me: boolean): void {
    if (this.sport === "jetski") {
      this.emit("bailSplash", s, me, 1);
      return;
    }
    const x = this.px[s] ?? 0;
    const z = this.pz[s] ?? 0;
    let hit: ObstacleData | null = null;
    let best = Infinity;
    for (const o of this.obstacles) {
      const d = Math.hypot(o.x - x, o.z - z) - o.radius;
      if (d < best) {
        best = d;
        hit = o;
      }
    }
    const name: SoundName =
      hit && best < 3 ? (hit.kind === "pine" ? "hitPine" : hit.kind === "rock" ? "hitRock" : "hitTower") : "fall";
    this.emit(name, s, me, 1);
  }

  /** A landing's sound: by sport, how it went, how hard it hit (m/s) and how long it flew (s). */
  private landing(s: number, kind: number, me: boolean, impact: number, air: number): void {
    if (this.sport === "snow") {
      if (kind === FALL) this.emit("fall", s, me, 1);
      else if (kind === SKETCHY) this.emit("landSketchy", s, me, 1);
      else this.emit("landSnow", s, me, 0.6 + 0.4 * clamp01(impact / 12));
      return;
    }
    if (kind === FALL) this.emit("bailSplash", s, me, 1);
    else if (kind === SKETCHY || impact > 7 || air > 0.9) {
      this.emit("splashBig", s, me, 0.75 + 0.25 * clamp01((impact - 7) / 8));
    } else if (air >= 0.15) this.emit("splashSmall", s, me, 0.45 + 0.55 * clamp01(impact / 7));
    else if (impact > 1.2) this.emit("splashSmall", s, me, 0.25 * clamp01(impact / 4), 1.15);
  }

  /** The race's cues: the countdown, GO, wrong way; the music's duck. */
  private cues(race: RaceView): void {
    if (race.phase === COUNTDOWN) {
      if (race.phaseStart !== this.countStart) {
        this.countStart = race.phaseStart;
        this.countN = 4;
      }
      // The same seconds the HUD counts: 3, 2, 1 as each whole second is left.
      const n = Math.ceil((race.phaseLength - race.phaseTicks) / race.tickHz);
      if (n >= 1 && n <= 3 && n < this.countN) {
        this.countN = n;
        audio.play("count");
      }
    } else if (race.phase === RACING && race.phaseStart !== this.goStart) {
      this.goStart = race.phaseStart;
      if (race.phaseTicks < race.tickHz / 2) audio.play("go");
    }
    // `wrongWay` is the HUD's steadied warning, so the cue and the banner agree.
    if (race.wrongWay && (!this.wrongUp || this.clock - this.wrongAt > WRONG_WAY_REPEAT)) {
      this.wrongAt = this.clock;
      audio.play("wrongWay");
    }
    this.wrongUp = race.wrongWay;
  }

  /** One rider's frame: landings, pops, bumps; your own voices. */
  private ride(r: RiderView, input: FrameInput | null, t: number, dt: number): void {
    const s = r.slot;
    if (s < 0 || s >= SLOTS) return;
    const me = r.isMe && !this.broadcast;
    const air = !r.grounded;
    const speedN = r.speed / this.top;
    // Put somewhere (the start grid, back on the course): no news either.
    if (Math.hypot(r.x - this.lastX[s]!, r.z - this.lastZ[s]!) > (this.speed[s]! + 5) * dt + 2) this.known[s] = 0;
    if (this.known[s]) {
      if (!air && !this.grounded[s] && this.airTime[s]! >= MIN_AIR_S) this.landed(r, s, me);
      else if (!air && !this.grounded[s] && this.pending[s]) this.landed(r, s, me);
      this.pops(r, s, me);
      this.bumps(r, s, me, dt);
      // A judgement whose landing never showed: sound it anyway.
      if (this.pending[s] && this.clock - this.pendingAt[s]! > 0.5) {
        const kind = this.pending[s] - 1;
        this.pending[s] = 0;
        if (kind === FALL) this.crash(s, me);
        else this.landing(s, kind, me, 0, 1);
      }
    }
    // Engine revs, for the far voices (yours runs its own).
    const accel = (r.speed - this.speed[s]!) / dt;
    const throttle = r.bailing ? 0 : clamp01(0.35 + 0.65 * speedN + accel / 10);
    this.load[s] = this.load[s]! + ((air ? AIR_LOAD : throttle) - this.load[s]!) * (1 - Math.exp(-6 * dt));
    if (this.revs[s] === 0) this.revs[s] = REV_IDLE;
    this.revs[s] = stepRevs(this.revs[s]!, dt, throttle, speedN, air, r.bailing);

    if (me) this.mine(r, input, t, dt, speedN, air, s);

    this.known[s] = 1;
    this.grounded[s] = air ? 0 : 1;
    this.bailing[s] = r.bailing ? 1 : 0;
    this.airTime[s] = air ? this.airTime[s]! + dt : 0;
    this.lastX[s] = r.x;
    this.lastZ[s] = r.z;
    this.vx[s] = r.vx;
    this.vy[s] = r.vy;
    this.vz[s] = r.vz;
    this.speed[s] = r.speed;
    this.charge[s] = r.charge;
  }

  private landed(r: RiderView, s: number, me: boolean): void {
    const impact = Math.max(0, r.vy - this.vy[s]!);
    const recent = this.pending[s] && this.clock - this.pendingAt[s]! < LANDING_WINDOW_S;
    const kind = recent ? this.pending[s]! - 1 : CLEAN;
    this.pending[s] = 0;
    this.landAt[s] = this.clock;
    this.landedClean[s] = kind === CLEAN ? 1 : 0;
    this.landing(s, kind, me, impact, this.airTime[s]!);
  }

  /** Snowboard: the crouch as a jump loads (yours), the pop as it goes (everyone's). */
  private pops(r: RiderView, s: number, me: boolean): void {
    if (this.sport !== "snow" || r.bailing || this.bailing[s]) return;
    const was = this.charge[s]!;
    if (me && r.charge > 0 && was === 0) this.emit("crouch", s, me, 1);
    if (was > 0.04 && r.charge === 0 && r.wobble === 0 && this.clock - this.landAt[s]! > 0.1) {
      this.emit("pop", s, me, 0.45 + 0.55 * was);
    }
  }

  /**
   * Bumps (into another rider, the quay, a fence): the velocity jumps more
   * in one frame than riding can turn it, and not up into the air (a ramp
   * or a crest turns speed into climb). Riders predicted from a guessed
   * input (other people) jump more on corrections, so they need more.
   */
  private bumps(r: RiderView, s: number, me: boolean, dt: number): void {
    if (r.bailing || this.bailing[s] || !r.grounded || !this.grounded[s]) return;
    const c = this.clock;
    if (c - this.bailAt[s]! < 0.5 || c - this.landAt[s]! < 0.3 || c - this.bumpAt[s]! < 0.35) return;
    const across = Math.hypot(r.vx - this.vx[s]!, r.vz - this.vz[s]!);
    const dv = across - 75 * dt;
    const threshold = me || r.isBot ? 2.2 : 4.5;
    if (dv <= threshold || Math.abs(r.vy - this.vy[s]!) > across * 0.5) return;
    this.bumpAt[s] = c;
    const k = clamp01((dv - threshold) / 6);
    if (this.sport === "snow") this.emit("landSnow", s, me, 0.4 + 0.6 * k, 1.25);
    else this.emit("bump", s, me, 0.4 + 0.6 * k);
  }

  /** Your own ride's voices. */
  private mine(
    r: RiderView,
    input: FrameInput | null,
    t: number,
    dt: number,
    speedN: number,
    air: boolean,
    s: number,
  ): void {
    this.wind?.update(t, speedN, air);
    if (this.sport === "jetski") {
      const throttle = input ? input.throttle : (this.load[s] ?? 0);
      this.engine?.update(t, dt, throttle, speedN, air, r.bailing);
      const shake = this.known[s] && !air ? clamp01(Math.abs(r.vy - this.vy[s]!) / 2.5) : 0;
      this.jolt = Math.max(this.jolt * Math.exp(-10 * dt), shake);
      this.hull?.update(t, speedN, air, r.bailing, r.steer, this.jolt);
      return;
    }
    let skid = 0;
    let edge = 0;
    if (r.bailing) skid = 1;
    else if (r.speed > 1.5) {
      skid = Math.max(clamp01((-r.lean - 0.15) / 0.85), clamp01((slipAngle(r) - 0.2) / 0.6));
      edge = clamp01(Math.abs(r.steer)) * (1 - skid);
    }
    this.board?.update(t, speedN, edge, skid, air, r.wobble);
  }

  /** The nearest few riders get the far voices; a voice keeps its rider until others are clearly nearer. */
  private updateFar(riders: readonly RiderView[], t: number): void {
    this.heard.fill(0);
    for (const r of riders) {
      const s = r.slot;
      if (s >= 0 && s < SLOTS && (!r.isMe || this.broadcast) && this.level[s]! > 0) this.heard[s] = 1;
    }
    for (let s = 0; s < SLOTS; s++) {
      let rank = 0;
      if (this.heard[s]) for (let o = 0; o < SLOTS; o++) if (this.heard[o] && this.dist[o]! < this.dist[s]!) rank++;
      this.rank[s] = rank;
    }
    this.voiceOf.fill(-1);
    for (let v = 0; v < FAR_VOICES; v++) {
      const s = this.farSlot[v]!;
      if (s >= 0 && (!this.heard[s] || this.rank[s]! > FAR_VOICES)) this.farSlot[v] = -1;
      else if (s >= 0) this.voiceOf[s] = v;
    }
    for (let s = 0; s < SLOTS; s++) {
      if (!this.heard[s] || this.voiceOf[s]! >= 0 || this.rank[s]! >= FAR_VOICES) continue;
      const v = this.farSlot.indexOf(-1);
      if (v < 0) break;
      this.farSlot[v] = s;
      this.voiceOf[s] = v;
    }
    for (const r of riders) {
      const s = r.slot;
      const v = s >= 0 && s < SLOTS ? this.voiceOf[s]! : -1;
      if (v < 0) continue;
      const air = !r.grounded;
      const speedN = r.speed / this.top;
      if (this.sport === "jetski") {
        this.farJet[v]?.update(
          t,
          this.revs[s]!,
          this.load[s]!,
          speedN,
          air,
          this.doppler[s]!,
          this.level[s]!,
          this.pan[s]!,
          this.cutoff[s]!,
        );
      } else {
        const skid = r.bailing ? 1 : clamp01((slipAngle(r) - 0.2) / 0.6) + clamp01(-r.lean - 0.2);
        const edge = clamp01(Math.abs(r.steer));
        this.farBoard[v]?.update(t, speedN, edge, clamp01(skid), air, this.level[s]!, this.pan[s]!, this.cutoff[s]!);
      }
    }
    for (let v = 0; v < FAR_VOICES; v++) {
      if (this.farSlot[v]! >= 0) continue;
      this.farJet[v]?.update(t, REV_IDLE, 0, 0, false, 1, 0, 0, 8000);
      this.farBoard[v]?.update(t, 0, 0, 0, false, 0, 0, 8000);
    }
  }
}
