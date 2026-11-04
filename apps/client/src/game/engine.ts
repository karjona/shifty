// The game's one renderer and WASM sim, shared by the menus and the races.
// What is on screen is a stage: a menu backdrop or a race. The page never
// reloads between them, so going from a menu into a race is instant.
import init, { type InitOutput } from "../wasm/sim.js";
import { World } from "../render/world.ts";

/** Something on screen, drawn every frame. */
export interface Stage {
  start(engine: Engine): void;
  frame(now: number, dt: number): void;
  stop(): void;
}

const params = new URLSearchParams(location.search);

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
  const scale = Number(params.get("scale") ?? stored("scale") ?? 1);
  const water = (params.get("water") ?? stored("water")) === "basic" ? "basic" : "sea";
  return { scale: Number.isFinite(scale) ? Math.min(1, Math.max(0.25, scale)) : 1, water };
}

export function saveViewSettings(s: ViewSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export class Engine {
  readonly world: World;
  readonly view: ViewSettings;
  /** `?render=0`: run everything but draw nothing (tests on machines without a GPU). */
  readonly render = params.get("render") !== "0";
  private stage: Stage | null = null;
  private last = performance.now();

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
      const wasm = await init();
      const world = new World(document.querySelector<HTMLElement>("#app")!, document.querySelector("#labels")!);
      await world.init();
      const engine = new Engine(wasm, world);
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
    if (this.stage) this.stage.frame(now, dt);
    else if (this.render) this.world.renderer.render(this.world.scene, this.world.camera);
  }
}
