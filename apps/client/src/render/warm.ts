// Shader warm-ups for things that join a scene later (a rider whose art has
// just arrived): what compiles them without blocking the page. The engine
// sets it; without one (look tests) nothing is warmed up ahead.
import type * as THREE from "three/webgpu";
import { type Wait, waitNow } from "../loading.ts";

type Warmer = (root: THREE.Object3D, wait: Wait | null) => Promise<void>;

let warmer: Warmer = () => Promise.resolve();

/** Sets what compiles an object's shaders ahead of drawing it. */
export function setWarmer(w: Warmer): void {
  warmer = w;
}

/** What counts the compiles under way: how many of the shaders asked for are done (null: nobody counts). */
let counter: ((done: number, total: number) => void) | null = null;

/** Runs `compile` (one at a time) with its shaders counted by `count` as they are done. */
export async function countingCompiles(
  count: (done: number, total: number) => void,
  compile: () => Promise<void>,
): Promise<void> {
  counter = count;
  try {
    await compile();
  } finally {
    counter = null;
  }
}

/** What counts the compile starting now (see `countingCompiles`). */
export function compileCounter(): ((done: number, total: number) => void) | null {
  return counter;
}

/** Compiles the shaders `root` needs before it is drawn (it need not be in the scene yet), counted in `wait`. */
export function warmUp(root: THREE.Object3D, wait: Wait | null = waitNow()): Promise<void> {
  return warmer(root, wait);
}
