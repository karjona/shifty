// The game's one renderer and WASM sim, shared by the menus and the races.
// What is on screen is a stage: a menu backdrop or a race. The page never
// reloads between them, so going from a menu into a race is instant.
import type * as THREE from "three/webgpu";
import init, { type InitOutput } from "../wasm/sim.js";
import { setWarmer } from "../render/warm.ts";
import { AutoResolution } from "./resolution.ts";
import { World } from "../render/world.ts";
import { devParams } from "../dev-params.ts";
import { booted, whileLoading } from "../loading.ts";

/** Something on screen, drawn every frame. */
export interface Stage {
  start(engine: Engine): void;
  /** Compiles the shaders its scene (or `root`, about to join it) needs (see `Engine.warm`). */
  compile?(root?: THREE.Object3D): Promise<void>;
  /** Resolves once what it shows has arrived and gone on (a rider's art). */
  loaded?(): Promise<void>;
  frame(now: number, dt: number): void;
  stop(): void;
}

/** Viewer settings that survive reloads. */
export interface ViewSettings {
  /** Render resolution: a scale of the screen's (0.25-1), or "auto" (as much as keeps frames smooth). */
  scale: number | "auto";
  /** "sea" = full water; "basic" = swells only (slow machines). */
  water: "sea" | "basic";
}

const SETTINGS_KEY = "shifty.view";

/** A frame later than this (ms) is a stall. */
const STALL_MS = 100;
/** Drawing has settled once it has gone this long (ms) without a stall. */
const SETTLE_MS = 800;
/** Nothing waits longer than this (ms) for drawing to settle (a slow machine never does). */
const SETTLE_MAX_MS = 8000;
/** Nothing waits longer than this (ms) for a stage's art (it shows without what is late). */
const LOAD_MAX_MS = 15000;
/** Automatic resolution draws at most this many pixels, and at least this many rows. */
const AUTO_MAX_PIXELS = 2560 * 1440;
const AUTO_MIN_ROWS = 540;

/** Someone waiting for drawing to settle, since `since` (ms). */
interface Settling {
  since: number;
  resolve: () => void;
}

export function loadViewSettings(): ViewSettings {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    // Bad JSON: defaults.
  }
  const stored = (k: string): unknown =>
    typeof saved === "object" && saved !== null && k in saved ? Reflect.get(saved, k) : undefined;
  // Dev: `?scale=` and `?water=` override the saved settings.
  const devScale = import.meta.env.DEV ? devParams.get("scale") : null;
  const devWater = import.meta.env.DEV ? devParams.get("water") : null;
  const raw = devScale ?? stored("scale") ?? "auto";
  const scale = Number(raw);
  const water = (devWater ?? stored("water")) === "basic" ? "basic" : "sea";
  return { scale: raw !== "auto" && Number.isFinite(scale) ? Math.min(1, Math.max(0.25, scale)) : "auto", water };
}

export function saveViewSettings(s: ViewSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export class Engine {
  readonly world: World;
  readonly view: ViewSettings;
  /** Dev: `?render=0` runs everything but draws nothing (tests on machines without a GPU). */
  readonly render = !(import.meta.env.DEV && devParams.get("render") === "0");
  private stage: Stage | null = null;
  private last = performance.now();
  /** Warm-ups running or queued. */
  private warming = 0;
  /** ...of them, the ones that hold drawing (a stage's): nothing is drawn while there are any. */
  private holding = 0;
  private warmed: Promise<void> = Promise.resolve();
  /** When the current run of frames without a stall began (null: none is running). */
  private smoothSince: number | null = null;
  private settling: Settling[] = [];
  /** Dev: frames are skipped (the frame-cost bench draws its own, see bench.ts). */
  paused = false;

  readonly wasm: InitOutput;

  private auto = new AutoResolution();

  private constructor(wasm: InitOutput, world: World) {
    this.wasm = wasm;
    this.world = world;
    this.view = loadViewSettings();
    this.applyScale();
    addEventListener("resize", () => {
      if (this.view.scale === "auto") this.applyScale();
    });
  }

  /** Puts the view's resolution on the renderer (automatic: from the top again). */
  private applyScale(): void {
    const scale = this.view.scale;
    if (scale !== "auto") {
      this.world.setRenderScale(scale, scale < 1);
      return;
    }
    this.auto.bounds(innerWidth, innerHeight, devicePixelRatio, AUTO_MAX_PIXELS, AUTO_MIN_ROWS);
    this.auto.reset();
    this.world.setRenderScale(this.auto.scale, false);
  }

  private static booting: Promise<Engine> | null = null;

  /** The engine, created on first use. */
  static get(): Promise<Engine> {
    Engine.booting ??= (async () => {
      const wasm = await init().catch((e: unknown) => {
        booted();
        throw e;
      });
      const world = new World(document.querySelector<HTMLElement>("#app")!, document.querySelector("#labels")!);
      await world.init().catch((e: unknown) => {
        booted();
        throw e;
      });
      const engine = new Engine(wasm, world);
      if (import.meta.env.DEV && devParams.has("bench")) {
        const { installBench } = await import("./bench.ts");
        installBench(world, (paused) => {
          engine.paused = paused;
        });
      }
      setWarmer((root) => (engine.render ? engine.warm(() => engine.compile(root), false) : Promise.resolve()));
      if (!engine.render) booted();
      await world.renderer.setAnimationLoop((now: number) => engine.frame(now));
      return engine;
    })();
    return Engine.booting;
  }

  get current(): Stage | null {
    return this.stage;
  }

  /** Puts a stage on screen (stopping the one before). */
  show(stage: Stage): void {
    if (this.stage === stage) return;
    this.stage?.stop();
    this.stage = stage;
    stage.start(this);
    void this.prepare(stage);
  }

  /**
   * Gets a stage that has just gone on ready: its shaders compiled (nothing
   * is drawn meanwhile), what it shows in, and drawing smoothly. The loading
   * sign is up until it shows; the boot screen comes off after.
   */
  private async prepare(stage: Stage): Promise<void> {
    const late = new Promise<void>((resolve) => setTimeout(resolve, LOAD_MAX_MS));
    await whileLoading(
      (async () => {
        if (this.render && stage.compile) await this.warm(() => stage.compile!());
        await Promise.race([stage.loaded?.(), late]);
      })(),
    );
    await this.settled();
    booted();
  }

  /** Compiles what `root` needs, for the stage on screen (the world's scene if it has none of its own). */
  private compile(root: THREE.Object3D): Promise<void> {
    return this.stage?.compile?.(root) ?? this.world.compile(root);
  }

  /**
   * Runs `compile` (shader compiles that don't block the page), one at a
   * time; the page (menus, timers, the netcode) carries on. With `hold`
   * (what is in the scene is new), nothing is drawn until it is done: the
   * canvas holds its last frame. Without (what compiles isn't in the scene
   * yet), frames go on being drawn in between.
   */
  warm(compile: () => Promise<void>, hold = true): Promise<void> {
    this.warming++;
    if (hold) this.holding++;
    const run = this.warmed
      .then(compile)
      .catch((e: unknown) => console.error(e))
      .finally(() => {
        this.warming--;
        if (hold) this.holding--;
      });
    this.warmed = run;
    return run;
  }

  /** Takes a stage off screen, if it is the one showing. */
  hide(stage: Stage): void {
    if (this.stage !== stage) return;
    stage.stop();
    this.stage = null;
  }

  setScale(scale: number | "auto"): void {
    this.view.scale = scale;
    this.applyScale();
    saveViewSettings(this.view);
  }

  setWater(water: "sea" | "basic"): void {
    this.view.water = water;
    saveViewSettings(this.view);
  }

  /**
   * Resolves once frames have been drawn for a while without a stall: what
   * the first frames of something new still do (the few shaders a warm-up
   * can't reach, uploads, the clean-up after loading) is over.
   */
  private draw(now: number, dt: number): void {
    if (this.stage) this.stage.frame(now, dt);
    else if (this.render) this.world.renderer.render(this.world.scene, this.world.camera);
  }

  /** A frame while a warm-up waits: it has left the renderer pointed at its own targets. */
  private drawBetweenCompiles(now: number, dt: number): void {
    const r = this.world.renderer;
    const target = r.getRenderTarget();
    const outputs = r.getMRT();
    r.setRenderTarget(null);
    r.setMRT(null);
    try {
      this.draw(now, dt);
    } finally {
      r.setRenderTarget(target);
      r.setMRT(outputs);
    }
  }

  settled(): Promise<void> {
    if (!this.render) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { since: performance.now(), resolve };
      this.settling.push(waiter);
      setTimeout(() => this.settle(waiter), SETTLE_MAX_MS);
    });
  }

  private settle(waiter: Settling): void {
    const i = this.settling.indexOf(waiter);
    if (i < 0) return;
    this.settling.splice(i, 1);
    waiter.resolve();
  }

  /** Automatic resolution: follows how fast frames come (not while something new is still settling in). */
  private adapt(gap: number, now: number): void {
    if (this.view.scale !== "auto" || !this.render) return;
    if (this.warming > 0 || this.settling.length > 0) {
      this.auto.forget();
      return;
    }
    const scale = this.auto.frame(gap, now);
    if (scale !== null) this.world.setRenderScale(scale, false);
  }

  private frame(now: number): void {
    const gap = now - this.last;
    const dt = Math.min(0.1, gap / 1000);
    this.last = now;
    if (import.meta.env.DEV && this.paused) return;
    if (this.holding > 0) {
      this.smoothSince = null;
      return;
    }
    if (this.warming > 0) this.drawBetweenCompiles(now, dt);
    else this.draw(now, dt);
    const end = performance.now();
    this.adapt(gap, end);
    if (gap > STALL_MS || end - now > STALL_MS) this.smoothSince = null;
    else this.smoothSince ??= end;
    const since = this.smoothSince;
    if (since === null) return;
    const done = this.settling.filter((w) => end - Math.max(since, w.since) >= SETTLE_MS);
    for (const w of done) this.settle(w);
  }
}
