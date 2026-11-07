// A ghost's look: the rider's own cel paint washed toward one tint and seen
// through, a bright rim on the silhouette, and the ink outline at half
// strength. Ghosts leave the ink pass alone (no lines of their own), throw
// no shadows and stay out of reflections. One shader for every ghost: the
// tint and how much shows are uniforms.
import * as THREE from "three/webgpu";
import { abs, dot, float, mix, normalView, output, positionViewDirection, pow, uniform, vec4 } from "three/tsl";
import { UNREFLECTED, inkNode } from "./material.ts";

/** How much of a ghost shows at most (0-1), and how far its paint is washed toward the tint. */
const OPACITY = 0.5;
const WASH = 0.45;
/** The outline's share of the ghost's opacity. */
const INK = 0.5;
/** Strength of the rim of tint on the silhouette. */
const RIM = 0.7;

export class GhostLook {
  /** 0-1: how much of the ghost shows (fades as the camera comes close, and as it finishes). */
  readonly shown = uniform(1);
  readonly tint: THREE.UniformNode<"color", THREE.Color>;

  constructor(tint: THREE.ColorRepresentation) {
    this.tint = uniform(new THREE.Color(tint));
  }

  /** Turns every mesh under `root` (a rider's model, its art in) into this ghost. */
  apply(root: THREE.Object3D): void {
    const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2).mul(RIM);
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = false;
      o.receiveShadow = false;
      o.layers.set(UNREFLECTED);
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) {
        if (!(m instanceof THREE.NodeMaterial) || m.userData.ghost === true) continue;
        m.userData.ghost = true;
        m.transparent = true;
        m.depthWrite = false;
        const outline = o.userData.outline === true;
        const alpha = this.shown.mul(OPACITY);
        m.outputNode = outline
          ? vec4(output.rgb, alpha.mul(INK))
          : vec4(mix(mix(output.rgb, this.tint, WASH), this.tint, rim), alpha.mul(rim.mul(0.6).add(0.75)));
        m.mrtNode = inkNode(0, 0, 0, 0);
        m.needsUpdate = true;
      }
    });
  }
}
