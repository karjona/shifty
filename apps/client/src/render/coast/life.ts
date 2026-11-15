// Small things that move on the coast: flags flying from their staffs
// (cloth in the wind, see materials.ts). Scenery adds to a `Life` as it is
// built; `build` makes one mesh of them.
import * as THREE from "three/webgpu";
import { UNREFLECTED } from "../cel/material.ts";
import { clothMaterial } from "./materials.ts";
import { Shape, place } from "./shape.ts";

/** The heading flags fly toward: downwind of the coast's usual wind. */
const DOWNWIND = -2.42;

/** Costa Nevada's colours: sea, snow and sun. */
export const COSTA_NEVADA = [0x2a6fb0, 0xf6f2ea, 0xf2c14e];

export class Life {
  private cloth = new Shape();
  private flags = 0;

  /** A flag `w` by `h` m flying from the top of a staff at `(x, y, z)`, in stripes of `colours` from the top down. */
  flag(x: number, y: number, z: number, w: number, h: number, colours: readonly number[]): void {
    const stripe = h / colours.length;
    colours.forEach((colour, k) => {
      const geo = new THREE.PlaneGeometry(w, stripe, 6, 1).translate(w / 2, -(k + 0.5) * stripe, 0);
      this.cloth.take(geo, colour, place(x, y, z, DOWNWIND), { weight: (p) => Math.hypot(p.x - x, p.z - z) });
    });
    this.flags++;
  }

  /** The flags as a mesh (none if there are no flags). */
  build(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    if (this.flags > 0) {
      const mesh = this.cloth.mesh(clothMaterial(), "none");
      mesh.layers.set(UNREFLECTED);
      mesh.frustumCulled = false;
      out.push(mesh);
    }
    return out;
  }
}
