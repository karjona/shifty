// The race on television, once your race is over: through the finish (or
// watching a race you joined midway), and behind the results. Your rider
// rides on autopilot (the sim's), and a director cuts between cameras:
// each camera (a rig) says who it would show and how good the shot would
// be, and the director holds a shot for a while, cuts when a better one
// comes up or this one is lost, and never while the rider is in the air.
// An operator follows the rider on every shot, a little behind like a
// person would, zooming so the rider stays about the same size in the
// frame (a long lens far away, wide up close). Each course has its own
// cameras: see broadcast-bay.ts and broadcast-snow.ts.
import * as THREE from "three/webgpu";
import type { CameraShot, Environment, RiderView } from "../render/world.ts";
import type { CourseInfo } from "../wasm-json.ts";
import { bayRigs } from "./broadcast-bay.ts";
import type { Aim, Rig, Watch } from "./broadcast-rig.ts";
import { snowRigs } from "./broadcast-snow.ts";

/** Seconds after your finish before the broadcast takes over, by sport (the finish has its moment first). */
const AFTER_FINISH = { jetski: 2.5, snow: 0.8 };
/** A lost shot is cut away from this soon (s), and from a shot in the air after this long. */
const LOST_CUT = 0.5;
const LOST_IN_AIR = 1.5;
/** A shot this much better than the one on air takes over. */
const BETTER = 0.25;
/** The other cameras are rated this often (s) once a shot could end. */
const RATE_EVERY = 0.25;
/** A camera that may follow itself rates this much lower for each shot in a row it has had. */
const SAME_AGAIN = 0.12;
/** Zoom limits (degrees), and how fast the zoom follows (per second): out quickly, in gently. */
const FOV_MIN = 4;
const FOV_MAX = 55;
const ZOOM_OUT = 8;
const ZOOM_IN = 2;
/** Riders slower than this (m/s) are still. */
const STILL = 0.8;
/** With the results up, shots frame at least this much (m), the rider low in the picture under the scoreboard (share of the picture's height above its middle). */
const RESULTS_FRAME = 12;
const RESULTS_LOW = 0.36;

const RACING = 2;
const RESULTS = 3;

/** The race as the broadcast needs it. */
export interface OnAirRace {
  phase: number;
  racing: boolean;
  /** Your rider rides on autopilot (`sim::World::on_autopilot`). */
  autopilot: boolean;
  finishTicks: number;
  phaseTicks: number;
  tickHz: number;
}

/** Whether the broadcast has the screen (else the chase camera behind your rider). */
export function onAir(race: OnAirRace, sport: "jetski" | "snow"): boolean {
  if (!race.autopilot) return false;
  if (race.phase === RESULTS || (race.phase === RACING && !race.racing)) return true;
  return race.phase === RACING && (race.phaseTicks - race.finishTicks) / race.tickHz >= AFTER_FINISH[sport];
}

export class Broadcast {
  private rigs: Rig[] = [];
  private rig: Rig | null = null;
  private slot = -1;
  /** Shots in a row on this camera. */
  private run = 0;
  private cutAt = 0;
  private lostFor = 0;
  private ratedAt = 0;
  private better: { rig: Rig; slot: number; score: number } | null = null;
  private restUntil = new Map<Rig, number>();
  private still = new Map<number, number>();
  private aimed: Aim = {
    eye: new THREE.Vector3(),
    look: new THREE.Vector3(),
    frame: 5,
    fov: null,
    follow: 6,
    roll: 0,
  };
  private look = new THREE.Vector3();
  private fov = 30;
  private fresh = true;
  private wantCut = false;
  private shot: CameraShot = {
    eye: new THREE.Vector3(),
    look: new THREE.Vector3(),
    fov: 30,
    chase: 0,
    roll: 0,
    focus: new THREE.Vector3(),
  };
  /** Dev: the camera held, by name (test shots). */
  pinned: string | null = null;

  /** The course on screen, once it is built. `heights`: the ground at many points at once (the mountain's). */
  setCourse(course: CourseInfo, env: Environment, heights?: (points: Float32Array) => Float32Array): void {
    this.rigs = course.sport === "snow" ? snowRigs(course.run, env, heights) : bayRigs(course.bay, env);
    this.rig = null;
    this.restUntil.clear();
    this.still.clear();
  }

  /** The names of the course's cameras, and the one on the air (dev). */
  get cameras(): string[] {
    return this.rigs.map((r) => r.name);
  }

  get onAir(): string | null {
    return this.rig?.name ?? null;
  }

  /** Cuts to another camera at the next frame. */
  next(): void {
    this.wantCut = true;
  }

  /** Off the air: the next time on starts fresh. */
  off(): void {
    this.rig = null;
  }

  /**
   * The camera this frame (null: no rider to show). `t`: a steady clock
   * (s); `simT`: sim time (s); `results`: the results are up.
   */
  frame(riders: readonly RiderView[], t: number, simT: number, dt: number, results: boolean): CameraShot | null {
    for (const r of riders) this.still.set(r.slot, r.speed < STILL ? (this.still.get(r.slot) ?? 0) + dt : 0);
    const w: Watch = {
      riders,
      me: riders.find((r) => r.isMe),
      t,
      simT,
      dt,
      still: (slot) => this.still.get(slot) ?? 0,
      results,
    };
    let r = riders.find((x) => x.slot === this.slot);
    const rig = this.rig;
    const pinned = import.meta.env.DEV && this.pinned !== null ? this.rigs.find((x) => x.name === this.pinned) : null;
    if (pinned) {
      if (rig !== pinned) this.start(w, pinned, pinned.rate(w)?.slot ?? w.me?.slot ?? -1, t);
    } else {
      const holds = rig !== null && r !== undefined && rig.holds(w, r);
      this.lostFor = holds ? 0 : this.lostFor + dt;
      const age = t - this.cutAt;
      let cut = rig === null || r === undefined || this.wantCut;
      if (!cut && rig && age >= rig.minShot) {
        const steady = r!.grounded || this.lostFor > LOST_IN_AIR;
        if (t - this.ratedAt >= RATE_EVERY) {
          this.ratedAt = t;
          const now = rig.rate(w);
          const current = now && now.slot === this.slot ? now.score : 0;
          const best = this.best(w, rig);
          this.better = best && best.score > current + BETTER ? best : null;
        }
        cut = steady && (age >= rig.maxShot || this.lostFor > LOST_CUT || this.better !== null);
      }
      if (cut) {
        const next = this.best(w, this.wantCut ? rig : null) ?? this.best(w, null);
        this.wantCut = false;
        if (next) this.start(w, next.rig, next.slot, t);
        // Nothing better on offer: hold this shot and look again in a while.
        else this.cutAt = t;
      }
    }
    r = riders.find((x) => x.slot === this.slot);
    if (!this.rig || !r) return null;
    this.place(w, this.rig, r);
    return this.shot;
  }

  /** The best shot on offer from the cameras other than `not` (and not resting). */
  private best(w: Watch, not: Rig | null): { rig: Rig; slot: number; score: number } | null {
    let best: { rig: Rig; slot: number; score: number } | null = null;
    for (const rig of this.rigs) {
      if (rig === not || (rig === this.rig && !rig.repeats)) continue;
      if ((this.restUntil.get(rig) ?? 0) > w.t) continue;
      const rated = rig.rate(w);
      if (!rated) continue;
      const score = rated.score - (rig === this.rig ? this.run * SAME_AGAIN : 0);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { rig, slot: rated.slot, score };
    }
    return best;
  }

  private start(w: Watch, rig: Rig, slot: number, t: number): void {
    if (this.rig && this.rig.rest) this.restUntil.set(this.rig, t + this.rig.rest);
    this.run = rig === this.rig ? this.run + 1 : 0;
    this.rig = rig;
    this.slot = slot;
    this.cutAt = t;
    this.lostFor = 0;
    this.better = null;
    this.ratedAt = t;
    this.fresh = true;
    const r = w.riders.find((x) => x.slot === slot);
    if (r) rig.begin?.(w, r);
  }

  /** The operator: follows the rig's aim a little behind, zooms with the distance. */
  private place(w: Watch, rig: Rig, r: RiderView): void {
    const a = this.aimed;
    a.fov = null;
    a.roll = 0;
    a.follow = 6;
    rig.aim(w, r, a);
    if (w.results) a.frame = Math.max(a.frame, RESULTS_FRAME);
    if (this.fresh) this.look.copy(a.look);
    else this.look.lerp(a.look, 1 - Math.exp(-w.dt * a.follow));
    const distance = Math.max(1, a.eye.distanceTo(this.look));
    const fov = a.fov ?? Math.min(FOV_MAX, Math.max(FOV_MIN, (2 * Math.atan(a.frame / 2 / distance) * 180) / Math.PI));
    const zoom = fov > this.fov ? ZOOM_OUT : ZOOM_IN;
    this.fov = this.fresh ? fov : this.fov + (fov - this.fov) * (1 - Math.exp(-w.dt * zoom));
    this.fresh = false;
    const s = this.shot;
    s.eye.copy(a.eye);
    const half = distance * Math.tan((this.fov * Math.PI) / 360);
    // A hand on the camera: a slow drift, a few centimetres at the rider.
    const sway = half * 0.012;
    s.look.set(
      this.look.x + Math.sin(w.t * 0.71) * sway,
      this.look.y + Math.sin(w.t * 0.53 + 1.1) * sway + (w.results ? half * 2 * RESULTS_LOW : 0),
      this.look.z + Math.cos(w.t * 0.61) * sway,
    );
    s.fov = this.fov;
    s.roll = a.roll;
    s.focus?.set(r.x, r.y, r.z);
  }
}
