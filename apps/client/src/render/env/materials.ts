// The cel materials scenery art is drawn with (see model.ts), one per
// material class: `solid` (stone, wood, iron: a colour per vertex),
// `foliage` (leaves and flowers in the season's colours, moving in the
// breeze), `cloth` (flags, fringes and awnings, flapping) and `glass` (panes
// that mirror the sky). The breeze is a look: how far a vertex moves is in
// the art (its sway weight), which way and when is here.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  dot,
  fract,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  reflect,
  sin,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import { CelMaterial, inkId } from "../cel/material.ts";
import { FOLIAGE, LOOK } from "../cel/look.ts";
import type { EnvParts } from "./model.ts";

/** How the breeze moves a class of things: metres at full sway along the wind (in gusts), across it (flapping) and up and down. */
interface Sway {
  along: number;
  across: number;
  lift: number;
}

const FOLIAGE_SWAY: Sway = { along: 0.3, across: 0.1, lift: 0.16 };
const CLOTH_SWAY: Sway = { along: 0.05, across: 0.16, lift: 0.05 };

export class EnvLook {
  /** Where the breeze blows (x, z; the art's flags fly that way). */
  readonly breeze = uniform(new THREE.Vector2(1, 0));
  private materials = new Map<string, THREE.Material>();

  /** Sets the breeze from the art's `wind` anchor. */
  setBreeze(dir: unknown): void {
    if (!Array.isArray(dir)) return;
    const [x, z]: unknown[] = dir;
    if (typeof x === "number" && typeof z === "number") this.breeze.value.set(x, z).normalize();
  }

  /** A vertex moved by the breeze as far as its sway weight says. */
  private swayed(s: Sway): THREE.Node<"vec3"> {
    const breeze = this.breeze;
    const along = uniform(s.along);
    const across = uniform(s.across);
    const lift = uniform(s.lift);
    return Fn(() => {
      const p = positionLocal;
      const w = attribute<"float">("sway", "float");
      const t = LOOK.time;
      const d = dot(p.xz, breeze);
      // Slow gusts roll down the wind; a quick ripple runs along whatever flies in it.
      const gust = sin(t.mul(1.25).add(d.mul(0.33)).add(p.y.mul(0.21)));
      const flap = sin(t.mul(6.1).sub(d.mul(4.6)).add(p.y.mul(1.9)));
      const bob = sin(t.mul(3.3).sub(d.mul(2.3)).add(p.y.mul(0.9)).add(1.7));
      const a = gust.mul(along);
      const c = flap.mul(across).add(gust.mul(across).mul(0.4));
      const move = vec3(breeze.x.mul(a).sub(breeze.y.mul(c)), bob.mul(lift), breeze.y.mul(a).add(breeze.x.mul(c)));
      return p.add(move.mul(w));
    })();
  }

  /** The material of a class (made once). */
  material(cls: string): THREE.Material {
    let m = this.materials.get(cls);
    if (m) return m;
    if (cls === "foliage") {
      const c = new CelMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        outdoor: FOLIAGE.evergreen,
        crease: 0.35,
      });
      c.positionNode = this.swayed(FOLIAGE_SWAY);
      m = c;
    } else if (cls === "cloth") {
      const c = new CelMaterial({ vertexColors: true, side: THREE.DoubleSide, crease: 0.3, id: inkId("env.cloth") });
      c.positionNode = this.swayed(CLOTH_SWAY);
      m = c;
    } else if (cls === "glass") {
      m = new CelMaterial({ colorNode: glass(), spec: 0.5, specSize: 0.06, crease: 0, id: inkId("env.glass") });
    } else {
      m = new CelMaterial({ vertexColors: true, outdoor: FOLIAGE.none });
    }
    this.materials.set(cls, m);
    return m;
  }

  /** A mesh per class of `parts` (`skip` leaves classes to the caller). */
  meshes(parts: EnvParts, skip: readonly string[] = []): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [cls, geometry] of parts) {
      if (skip.includes(cls)) continue;
      const mesh = new THREE.Mesh(geometry, this.material(cls));
      mesh.name = `env.${cls}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    return out;
  }
}

/** A window pane: the sky it mirrors (paler toward the horizon), tinted by its colour, with slanting glints. */
function glass(): THREE.Node<"vec3"> {
  return Fn(() => {
    const view = positionWorld.sub(cameraPosition).normalize();
    const up = reflect(view, normalWorld).y;
    const sky = mix(LOOK.horizon, LOOK.upper, smoothstep(-0.15, 0.6, up));
    const slant = fract(positionWorld.x.add(positionWorld.z).mul(0.42).add(positionWorld.y.mul(0.7)));
    const glint = smoothstep(0.0, 0.02, slant).mul(smoothstep(0.2, 0.18, slant));
    const tint = attribute<"vec3">("color", "vec3");
    return mix(sky.mul(tint), vec3(1), glint.mul(0.45));
  })();
}
