// The game's one renderer and WASM sim, shared by the menus and the races.
// What is on screen is a stage: a menu backdrop or a race. The page never
// reloads between them, so going from a menu into a race is instant.
import type * as THREE from "three/webgpu";
import init, { type InitOutput } from "../wasm/sim.js";
import { setWarmer } from "../render/warm.ts";
import { World } from "../render/world.ts";
import { devParams } from "../dev-params.ts";
import { booted, setBusy } from "./loading.ts";

/** Something on screen, drawn every frame. */
export interface Stage {
  start(engine: Engine): void;
  /** Compiles the shaders its scene (or `root`, about to join it) needs (see `Engine.warm`). */
  compile?(root?: THREE.Object3D): Promise<void>;
  frame(now: number, dt: number): void;
  stop(): void;
}

/** Viewer settings that survive reloads. */
export interface ViewSettings {
  /** Render resolution scale (0.25-1). */
  scale: number;
  /** "sea" = full water; "basic" = swells only (slow machines). */
  water: "sea" | "basic";
}

const SETTINGS_KEY = "shifty.view";

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
  const scale = Number(devScale ?? stored("scale") ?? 1);
  const water = (devWater ?? stored("water")) === "basic" ? "basic" : "sea";
  return { scale: Number.isFinite(scale) ? Math.min(1, Math.max(0.25, scale)) : 1, water };
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
  /** Warm-ups running or queued: nothing is drawn while there are any. */
  private warming = 0;
  private warmed: Promise<void> = Promise.resolve();

  readonly wasm: InitOutput;

  private constructor(wasm: InitOutput, world: World) {
    this.wasm = wasm;
    this.world = world;
    this.view = loadViewSettings();
    world.setRenderScale(this.view.scale);
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
      setWarmer((root) => (engine.render ? engine.warm(() => engine.compile(root)) : Promise.resolve()));
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
    if (stage.compile && this.render) void this.warm(() => stage.compile!());
    else requestAnimationFrame(booted);
  }

  /** Compiles what `root` needs, for the stage on screen (the world's scene if it has none of its own). */
  private compile(root: THREE.Object3D): Promise<void> {
    return this.stage?.compile?.(root) ?? this.world.compile(root);
  }

  /**
   * Runs `compile` (shader compiles that don't block the page), one at a
   * time. Nothing is drawn until it is done: the canvas holds its last frame
   * and the page (menus, timers, the netcode) carries on.
   */
  warm(compile: () => Promise<void>): Promise<void> {
    if (this.warming++ === 0) setBusy(true);
    const run = this.warmed
      .then(compile)
      .catch((e: unknown) => console.error(e))
      .finally(() => {
        if (--this.warming > 0) return;
        setBusy(false);
        // Once the first backdrop has been drawn, the page is up.
        requestAnimationFrame(() => requestAnimationFrame(booted));
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

  setScale(scale: number): void {
    this.view.scale = scale;
    this.world.setRenderScale(scale);
    saveViewSettings(this.view);
  }

  setWater(water: "sea" | "basic"): void {
    this.view.water = water;
    saveViewSettings(this.view);
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.warming > 0) return;
    if (this.stage) this.stage.frame(now, dt);
    else if (this.render) this.world.renderer.render(this.world.scene, this.world.camera);
  }
}
