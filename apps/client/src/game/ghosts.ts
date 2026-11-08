// Ghosts in a time trial: recorded runs (the race server's, kept by the
// lobby) played back by race time next to your rider. Playback, not
// netcode: each ghost's frames are interpolated at the race clock and
// drawn through the same rider models and poses as live riders, in the
// ghost look (render/cel/ghost.ts), with a small label over its head. They
// collide with nothing, and fade as the camera comes close.
import * as THREE from "three/webgpu";
import { type Appearance, decodeAppearance } from "@shifty/rider";
import { messages } from "../i18n/index.ts";
import { type GhostPick, fetchGhost } from "../menu/api.ts";
import { GhostLook } from "../render/cel/ghost.ts";
import { warmUp } from "../render/warm.ts";
import type { Environment, RiderModel, RiderView } from "../render/world.ts";
import { NameTags } from "../ui/tags.ts";
import { ghostFrames, ghostHeader, ghostStride } from "../wasm/sim.js";

/** Ghost riders take seats past the race's own. */
const FIRST_SLOT = 100;
/** A ghost fades out as the camera comes closer than `FAR` (m), and is gone at `NEAR`. */
const NEAR = 2.5;
const FAR = 7;
/** Through its finish a ghost fades out over this long (s). */
const FINISH_FADE = 1;
/** Tints that stand out on blue water and white snow alike: your best, the record, anyone else's. */
const TINTS = { best: 0xff4fd8, record: 0xffb21f, other: 0x8cff4a } as const;

/** A recorded run, unpacked. */
export interface GhostRun {
  pick: GhostPick;
  course: number;
  season: number;
  finishTicks: number;
  frameTicks: number;
  /** Race ticks at each split (checkpoints, laps), the finish last. */
  splits: number[];
  appearance: Appearance | null;
  /** `ghostStride()` floats per frame. */
  frames: Float32Array;
}

const nums = (v: unknown): number[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is number => typeof x === "number") : [];

/** Unpacks a recording (null if it doesn't hold together). */
export function readGhost(pick: GhostPick, bytes: Uint8Array): GhostRun | null {
  const json = ghostHeader(bytes);
  if (!json) return null;
  const h: unknown = JSON.parse(json);
  if (typeof h !== "object" || h === null) return null;
  const get = (k: string): unknown => Reflect.get(h, k);
  const look = nums(get("look"));
  return {
    pick,
    course: Number(get("course")),
    season: Number(get("season")),
    finishTicks: Number(get("finishTicks")),
    frameTicks: Number(get("frameTicks")) || 2,
    splits: nums(get("splits")),
    appearance: look.length > 0 ? decodeAppearance(Uint8Array.from(look)) : null,
    frames: ghostFrames(bytes),
  };
}

/** What a ghost is called over its head and in the splits. */
export function ghostLabel(pick: GhostPick): string {
  const m = messages().trial;
  if (pick.label === "best") return m.yourBest;
  if (pick.label === "record") return m.record;
  return pick.label.replace(/#\d+$/u, "");
}

interface Shown {
  run: GhostRun;
  slot: number;
  look: GhostLook;
  model: RiderModel | null;
  /** Its art is in, in the ghost look, and compiled. */
  ready: boolean;
  view: RiderView;
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Ghosts {
  /** The runs, once fetched (those that failed are left out). */
  readonly loaded: Promise<GhostRun[]>;
  private runs: GhostRun[] = [];
  private shown: Shown[] = [];
  private env: Environment | null = null;
  private scene: THREE.Scene | null = null;
  private tags: NameTags;
  private names = new Map<number, string>();
  private at = new THREE.Vector3();
  /** The ghosts placed this frame, for their labels. */
  private views: RiderView[] = [];
  private on = false;

  constructor(picks: GhostPick[], hud: HTMLElement) {
    this.tags = new NameTags(hud, "ghost-tags");
    this.loaded = Promise.all(
      picks.map(async (pick) => {
        try {
          return readGhost(pick, await fetchGhost(pick.id));
        } catch {
          return null;
        }
      }),
    ).then((runs) => {
      this.runs = runs.filter((r): r is GhostRun => r !== null && r.frames.length > 0);
      return this.runs;
    });
  }

  /** The ghosts' runs (once loaded). */
  get list(): readonly GhostRun[] {
    return this.runs;
  }

  /**
   * Puts the ghosts on a course (its environment makes their models). They
   * show once their art is in and compiled; resolves then.
   */
  async attach(scene: THREE.Scene, env: Environment, course: number): Promise<void> {
    this.detach();
    this.env = env;
    this.scene = scene;
    const runs = (await this.loaded).filter((r) => r.course === course);
    if (this.env !== env) return;
    this.shown = runs.map((run, i) => {
      const slot = FIRST_SLOT + i;
      this.names.set(slot, ghostLabel(run.pick));
      return { run, slot, look: new GhostLook(tintOf(run.pick)), model: null, ready: false, view: blankView(slot) };
    });
    await Promise.all(this.shown.map((g) => this.build(g, env, scene)));
  }

  /** Swaps the ghost labelled `label` for another run (your new best, say), or adds it. */
  async replace(label: string, run: GhostRun): Promise<void> {
    const i = this.runs.findIndex((r) => r.pick.label === label);
    if (i < 0) this.runs.push(run);
    else this.runs[i] = run;
    const env = this.env;
    const scene = this.scene;
    if (!env || !scene) return;
    let g = this.shown.find((s) => s.run.pick.label === label);
    if (g && JSON.stringify(g.run.appearance) === JSON.stringify(run.appearance)) {
      g.run = run;
      return;
    }
    if (g) this.remove(g);
    else {
      const slot = FIRST_SLOT + Math.max(-1, ...this.shown.map((s) => s.slot - FIRST_SLOT)) + 1;
      g = { run, slot, look: new GhostLook(tintOf(run.pick)), model: null, ready: false, view: blankView(slot) };
      this.shown.push(g);
    }
    g.run = run;
    g.ready = false;
    this.names.set(g.slot, ghostLabel(run.pick));
    await this.build(g, env, scene);
  }

  /** Takes the ghost labelled `label` out. */
  drop(label: string): void {
    this.runs = this.runs.filter((r) => r.pick.label !== label);
    for (const g of this.shown.filter((s) => s.run.pick.label === label)) this.remove(g);
    this.shown = this.shown.filter((s) => s.run.pick.label !== label);
  }

  private async build(g: Shown, env: Environment, scene: THREE.Scene): Promise<void> {
    const model = env.makeRider(g.slot, g.run.appearance);
    g.model = model;
    model.mesh.visible = false;
    await model.ready;
    if (g.model !== model || this.env !== env) return;
    g.look.apply(model.mesh);
    await warmUp(model.mesh);
    if (g.model !== model || this.env !== env) return;
    scene.add(model.mesh);
    g.ready = true;
  }

  private remove(g: Shown): void {
    if (!g.model) return;
    g.model.mesh.removeFromParent();
    g.model.dispose?.();
    g.model = null;
  }

  /** Takes the ghosts off the course. */
  detach(): void {
    for (const g of this.shown) this.remove(g);
    this.shown = [];
    this.env = null;
    this.scene = null;
  }

  /**
   * Places the ghosts `ticks` race ticks into the run (fractional; before
   * the start, on the grid). `on`: drawn at all (the race is on the chase
   * camera). Before the frame is drawn.
   */
  place(ticks: number, on: boolean, camera: THREE.PerspectiveCamera, dt: number): void {
    this.on = on;
    this.views.length = 0;
    for (const g of this.shown) {
      const model = g.model;
      if (!model || !g.ready) continue;
      const v = this.sample(g, Math.max(0, ticks), g.view);
      const left = (ticks - g.run.finishTicks) / 60;
      const finishing = left <= 0 ? 1 : Math.max(0, 1 - left / FINISH_FADE);
      const near = camera.position.distanceTo(this.at.set(v.x, v.y + 1, v.z));
      const close = Math.min(1, Math.max(0, (near - NEAR) / (FAR - NEAR)));
      const shown = on ? finishing * close * close * (3 - 2 * close) : 0;
      g.look.shown.value = shown;
      model.mesh.visible = shown > 0.01;
      if (!model.mesh.visible) continue;
      model.update(v, dt);
      model.mesh.updateMatrixWorld();
      if (finishing > 0) this.views.push(v);
    }
  }

  /** The ghosts' labels, once the frame's camera is set (`t`: sim time, s). */
  label(camera: THREE.PerspectiveCamera, t: number, dt: number): void {
    this.tags.hidden = !this.on;
    this.tags.update(camera, this.env, this.views, this.names, t, dt);
  }

  /** A ghost `ticks` into its run, between its two nearest frames. */
  private sample(g: Shown, ticks: number, out: RiderView): RiderView {
    const run = g.run;
    const stride = ghostStride();
    const count = run.frames.length / stride;
    const last = count - 1;
    // Frame k is at k × frameTicks, but the last one at the finish (which may fall between).
    const at = (k: number) => (k >= last ? run.finishTicks : k * run.frameTicks);
    const k = Math.min(last - 1, Math.max(0, Math.floor(ticks / run.frameTicks)));
    const t0 = at(k);
    const t1 = at(k + 1);
    const a = Math.min(1, Math.max(0, (ticks - t0) / Math.max(1e-6, t1 - t0)));
    const f = run.frames;
    const o0 = k * stride;
    const o1 = (k + 1) * stride;
    const lerp = (i: number) => f[o0 + i]! + (f[o1 + i]! - f[o0 + i]!) * a;
    const near = a < 0.5 ? o0 : o1;
    const span = Math.max(1e-6, (t1 - t0) / 60);
    out.x = lerp(0);
    out.y = lerp(1);
    out.z = lerp(2);
    out.yaw = f[o0 + 3]! + wrapPi(f[o1 + 3]! - f[o0 + 3]!) * a;
    out.pitch = lerp(4);
    out.roll = lerp(5);
    out.vx = (f[o1]! - f[o0]!) / span;
    out.vy = (f[o1 + 1]! - f[o0 + 1]!) / span;
    out.vz = (f[o1 + 2]! - f[o0 + 2]!) / span;
    out.speed = Math.hypot(out.vx, out.vz);
    out.grounded = f[near + 6] === 1;
    out.bailing = f[near + 7] === 1;
    out.charge = lerp(8);
    out.grab = f[near + 9]!;
    out.lean = lerp(10);
    out.steer = lerp(11);
    out.wobble = lerp(12);
    return out;
  }

  /** The ghosts on the course: where, and how much of each shows (tests). */
  shownState(): { label: string; ready: boolean; shown: number; x: number; z: number }[] {
    return this.shown.map((g) => ({
      label: g.run.pick.label,
      ready: g.ready,
      shown: g.look.shown.value,
      x: g.view.x,
      z: g.view.z,
    }));
  }

  dispose(): void {
    this.detach();
    this.tags.dispose();
  }
}

function tintOf(pick: GhostPick): number {
  return pick.label === "best" || pick.label === "record" ? TINTS[pick.label] : TINTS.other;
}

function blankView(slot: number): RiderView {
  return {
    slot,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    grounded: true,
    isMe: false,
    isBot: false,
    bailing: false,
    vx: 0,
    vy: 0,
    vz: 0,
    charge: 0,
    grab: 0,
    lean: 0,
    steer: 0,
    wobble: 0,
  };
}
