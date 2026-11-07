// Things floating on the swell, many copies of one shape drawn as one batch.
import * as THREE from "three/webgpu";
import { waveHeight } from "./waves.ts";

/** One of a batch of things riding the swell: where it floats, and its transform before the swell lifts it. */
export interface Bobbing {
  x: number;
  z: number;
  base: THREE.Matrix4;
}

/** Many copies of one shape riding the swell, drawn as one batch. */
export class BobbingBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly items: Bobbing[] = [];
  private lifted = new THREE.Matrix4();

  constructor(geo: THREE.BufferGeometry, material: THREE.Material, items: (Bobbing & { color?: number })[]) {
    this.mesh = new THREE.InstancedMesh(geo, material, items.length);
    items.forEach((it, i) => {
      this.items.push({ x: it.x, z: it.z, base: it.base });
      this.mesh.setMatrixAt(i, it.base);
      if (it.color !== undefined) this.mesh.setColorAt(i, new THREE.Color(it.color));
    });
    this.mesh.computeBoundingSphere();
  }

  /** Lifts every copy onto the swell. */
  update(waves: Float32Array, t: number): void {
    this.items.forEach((it, i) => {
      this.lifted.makeTranslation(0, waveHeight(waves, it.x, it.z, t), 0).multiply(it.base);
      this.mesh.setMatrixAt(i, this.lifted);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** A translation. */
export const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

/** The transform `x, z` (at the water line), turned `yaw`, then `local` within it. */
export function placed(x: number, z: number, yaw: number, local: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(local);
}
