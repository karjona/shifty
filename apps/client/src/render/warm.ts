// Shader warm-ups for things that join a scene later (a rider whose art has
// just arrived): what compiles them without blocking the page. The engine
// sets it; without one (look tests) nothing is warmed up ahead.
import type * as THREE from "three/webgpu";

let warmer: (root: THREE.Object3D) => Promise<void> = () => Promise.resolve();

/** Sets what compiles an object's shaders ahead of drawing it. */
export function setWarmer(w: (root: THREE.Object3D) => Promise<void>): void {
  warmer = w;
}

/** Compiles the shaders `root` needs before it is drawn (it need not be in the scene yet). */
export function warmUp(root: THREE.Object3D): Promise<void> {
  return warmer(root);
}
