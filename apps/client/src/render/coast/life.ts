// Small things that move on the coast: flags flying from their staffs,
// awnings' skirts and washing on its lines (cloth in the wind, see
// materials.ts). Scenery adds to a `Life` as it is
// built; `build` makes one mesh of them.
import * as THREE from "three/webgpu";
import { UNREFLECTED } from "../cel/material.ts";
import { clothMaterial } from "./materials.ts";
import { Shape, place } from "./shape.ts";

/** The heading flags fly toward: downwind of the coast's usual wind. */
export const DOWNWIND = -2.42;

/** Costa Nevada's colours: sea, snow and sun. */
export const COSTA_NEVADA = [0x2a6fb0, 0xf6f2ea, 0xf2c14e];

/** `v`, `d` m lower. */
const down = (v: THREE.Vector3, d: number) => v.clone().setY(v.y - d);

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

  /**
   * A valance hanging `drop` m along the edge from `a` to `b` (an
   * awning's skirt), in stripes of `colours` about `stripe` m wide.
   */
  valance(a: THREE.Vector3, b: THREE.Vector3, drop: number, colours: readonly number[], stripe = 0.5): void {
    const n = Math.max(2, Math.round(a.distanceTo(b) / stripe));
    for (let k = 0; k < n; k++) {
      const p = a.clone().lerp(b, k / n);
      const q = a.clone().lerp(b, (k + 1) / n);
      // (Scalloped: each stripe hangs to a point.)
      const tip = p
        .clone()
        .lerp(q, 0.5)
        .setY(p.y - drop);
      const low = (v: THREE.Vector3) => v.clone().setY(v.y - drop * 0.65);
      const colour = colours[k % colours.length]!;
      const weight = (v: THREE.Vector3) => (a.y - v.y) * 1.6;
      this.cloth.quad(low(p), low(q), q, p, colour);
      this.cloth.tri(low(p), tip, low(q), colour);
      this.weigh(9, weight);
    }
    this.flags++;
  }

  /** Washing on a line from `a` to `b`: shirts, sheets and towels pegged along it, in `colours` picked by `r`. */
  washing(a: THREE.Vector3, b: THREE.Vector3, colours: readonly number[], r: () => number): void {
    const length = a.distanceTo(b);
    let at = 0.25;
    while (at < length - 0.7) {
      const w = 0.45 + r() * 0.5;
      const h = 0.6 + r() * 0.5;
      const p = a.clone().lerp(b, at / length);
      const q = a.clone().lerp(b, Math.min(1, (at + w) / length));
      const colour = colours[Math.floor(r() * colours.length)] ?? colours[0]!;
      const top = (p.y + q.y) / 2;
      this.cloth.quad(down(p, h / 2), down(q, h / 2), q, p, colour);
      this.cloth.quad(down(p, h), down(q, h), down(q, h / 2), down(p, h / 2), colour);
      this.weigh(12, (v) => (top - v.y) * 1.4);
      at += w + 0.12 + r() * 0.25;
    }
    this.flags++;
  }

  /** Sets the wind's hold on the last `count` vertices added to the cloth. */
  private weigh(count: number, weight: (p: THREE.Vector3) => number): void {
    this.cloth.reweigh(count, weight);
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
