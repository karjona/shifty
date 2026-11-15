// Small things that move on the coast: flags flying from their staffs
// (cloth in the wind, see materials.ts) and smoke rising from chimneys and
// grills, drifting off downwind. Scenery adds to a `Life` as it is built;
// `build` makes one mesh of each.
import * as THREE from "three/webgpu";
import { float, fract, instanceIndex, positionLocal, smoothstep, vec3 } from "three/tsl";
import { LOOK } from "../cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId } from "../cel/material.ts";
import { clothMaterial, windNow } from "./materials.ts";
import { Shape, place } from "./shape.ts";

/** The heading flags fly toward: downwind of the coast's usual wind. */
const DOWNWIND = -2.42;
/** Puffs rising from each source of smoke at a time. */
const PUFFS = 5;

/** Costa Nevada's colours: sea, snow and sun. */
export const COSTA_NEVADA = [0x2a6fb0, 0xf6f2ea, 0xf2c14e];

let smokeCel: CelMaterial | null = null;

/** Smoke: each puff rises from its source, swelling and drifting downwind, then thins away; the next follows. */
function smokeMaterial(): CelMaterial {
  if (smokeCel) return smokeCel;
  smokeCel = new CelMaterial({
    color: 0xf2f0ec,
    shade: new THREE.Color(0.86, 0.87, 0.93),
    crease: 0,
    silhouette: 0,
    darkness: 0,
    id: inkId("smoke"),
  });
  const age = fract(LOOK.time.mul(0.1).add(float(instanceIndex).mul(1 / PUFFS + 0.031)));
  const size = age
    .mul(0.75)
    .add(0.2)
    .mul(smoothstep(0, 0.1, age))
    .mul(smoothstep(1, 0.7, age));
  const wind = windNow();
  const drift = age.mul(age).mul(1.5);
  smokeCel.positionNode = positionLocal.mul(size).add(vec3(wind.x.mul(drift), age.mul(4.5), wind.y.mul(drift)));
  smokeCel.name = "smoke";
  return smokeCel;
}

export class Life {
  private cloth = new Shape();
  private flags = 0;
  private sources: THREE.Vector3[] = [];

  /** A flag `w` by `h` m flying from the top of a staff at `(x, y, z)`, in stripes of `colours` from the top down. */
  flag(x: number, y: number, z: number, w: number, h: number, colours: readonly number[]): void {
    const stripe = h / colours.length;
    colours.forEach((colour, k) => {
      const geo = new THREE.PlaneGeometry(w, stripe, 6, 1).translate(w / 2, -(k + 0.5) * stripe, 0);
      this.cloth.take(geo, colour, place(x, y, z, DOWNWIND), { weight: (p) => Math.hypot(p.x - x, p.z - z) });
    });
    this.flags++;
  }

  /** Smoke rising from `(x, y, z)`. */
  smoke(x: number, y: number, z: number): void {
    this.sources.push(new THREE.Vector3(x, y, z));
  }

  /** The flags and the smoke as meshes. */
  build(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    if (this.flags > 0) {
      const mesh = this.cloth.mesh(clothMaterial(), "none");
      mesh.layers.set(UNREFLECTED);
      mesh.frustumCulled = false;
      out.push(mesh);
    }
    if (this.sources.length > 0) {
      const puffs = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 2),
        smokeMaterial(),
        this.sources.length * PUFFS,
      );
      const m = new THREE.Matrix4();
      this.sources.forEach((s, i) => {
        for (let k = 0; k < PUFFS; k++) puffs.setMatrixAt(i * PUFFS + k, m.makeTranslation(s.x, s.y, s.z));
      });
      puffs.layers.set(UNREFLECTED);
      puffs.frustumCulled = false;
      puffs.userData.noMerge = true;
      puffs.name = "smoke";
      out.push(puffs);
    }
    return out;
  }
}
