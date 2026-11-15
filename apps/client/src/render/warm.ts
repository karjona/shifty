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

/** Compiles the shaders `root` needs before it is drawn (it need not be in the scene yet), counted in `wait`. */
export function warmUp(root: THREE.Object3D, wait: Wait | null = waitNow()): Promise<void> {
  return warmer(root, wait);
}
