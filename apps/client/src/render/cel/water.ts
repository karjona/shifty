// The sea in the cel look: flat bands of colour instead of light, the way
// a background painter lays in water. Cobalt in the deep, cerulean on the
// slopes that face you, a pale sheen toward the horizon, turquoise over
// the shallows; white wave lines drawn where the ripples cross, glints of
// sun, the reflections laid in as flat darker shapes, and foam as cut-out
// white with a pale blue rim.
import * as THREE from "three/webgpu";
import {
  Fn,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  fwidth,
  max,
  mix,
  mx_noise_float,
  normalWorldGeometry,
  positionWorld,
  reflect,
  sin,
  smoothstep,
  vec2,
  vec3,
  vertexStage,
} from "three/tsl";
import { SUN_DIR, inkNode, inkOnlyInPass } from "./material.ts";
import { flowNoise, noise4 } from "./noise.ts";
import { SKY } from "./sky.ts";

export interface CelWaterInputs {
  position: THREE.Node<"vec3">;
  /** Per-pixel normal with the fine ripples (world). */
  surfaceNormal: THREE.Node<"vec3">;
  shore: THREE.Node<"float">;
  wake: THREE.Node<"float">;
  /** The reflected scene (rgb). */
  mirror: THREE.Node<"vec4">;
  time: THREE.Node<"float">;
  /** Which way the main swell runs (xz, unit). */
  swellDir: THREE.Node<"vec2">;
  /** Where the water is hidden (under the land); `null`: past the bay's coastal plain. */
  hidden?: THREE.Node<"bool"> | null;
}

/** An anti-aliased step of `x` at `edge`. */
const cut = (edge: THREE.Node<"float"> | number, x: THREE.Node<"float">) => {
  const w = max(fwidth(x), float(1e-4)).mul(0.8);
  const e = typeof edge === "number" ? float(edge) : edge;
  return smoothstep(e.sub(w), e.add(w), x);
};

export function celWaterMaterial(i: CelWaterInputs): THREE.MeshBasicNodeMaterial {
  const deep = color(0x0f62b2);
  const mid = color(0x1690c8);
  const light = color(0x46b9de);
  const shallow = color(0x37cdc8);
  const foamShade = color(0xbfe8f6);
  const white = color(0xffffff);

  const colour = Fn(() => {
    const p = positionWorld;
    const xz = p.xz;
    const v = cameraPosition.sub(p).normalize();
    const dist = cameraPosition.distance(p);
    const ng = normalWorldGeometry.normalize();
    const facing = clamp(dot(v, ng), 0, 1);
    const h = p.y;
    // Large, slow patches: the painter's darker and lighter washes (tens of metres across: per vertex).
    const washes = vertexStage(
      vec2(
        mx_noise_float(vec3(xz.mul(0.006), i.time.mul(0.01))),
        mx_noise_float(vec3(xz.mul(0.021).add(7.3), i.time.mul(0.02))),
      ),
    );
    const wash = washes.x;
    const wash2 = washes.y;
    // Depth: turquoise shelves round every shore, cerulean, then cobalt out in the bay.
    const shelf = i.shore.add(wash2.mul(9)).add(wash.mul(14));
    let c: THREE.Node<"vec3"> = mix(shallow, light, cut(9, shelf));
    c = mix(c, mid, cut(26, shelf));
    // Cobalt out in open water, its edge wandering slowly.
    c = mix(c, deep, cut(0.5, smoothstep(70, 420, i.shore).add(wash.mul(0.3)).add(wash2.mul(0.08))));
    // Swells: the faces that tip toward you catch the sky in lighter bands.
    const tip = float(1).sub(facing).add(h.mul(0.16)).add(wash2.mul(0.05));
    c = mix(c, mix(c, light, 0.6), cut(0.7, tip).mul(smoothstep(30, 0, i.shore).oneMinus()));
    // A pale sheen toward the horizon.
    c = mix(c, SKY.horizon, cut(0.9, float(1).sub(facing).add(wash.mul(0.04))).mul(0.65));
    // Reflections of anything darker than the sky, laid in as flat, darker shapes.
    const refl = i.mirror.rgb;
    const horizon = SKY.horizon.rgb;
    const dark = cut(0.08, dot(horizon.sub(refl), vec3(0.3, 0.5, 0.2)));
    c = mix(c, c.mul(0.7), dark.mul(0.75));
    // Swell lines: thin light strokes along the crests, broken into dashes, near you.
    const along = dot(xz, i.swellDir);
    const across = dot(xz, vec2(i.swellDir.y.negate(), i.swellDir.x));
    const n = mx_noise_float(vec3(along.mul(0.3), across.mul(0.05), i.time.mul(0.12)));
    const lineW = max(fwidth(n), float(1e-4)).mul(1.0);
    const lineN = float(1).sub(smoothstep(lineW.mul(0.5), lineW, n.abs()));
    const dashes = cut(0.32, noise4(vec2(along.mul(0.07), across.mul(0.09))).w);
    const near = smoothstep(140, 30, dist);
    c = mix(c, mix(c, white, 0.6), lineN.mul(dashes).mul(near));
    // Glints of sun.
    const r = reflect(v.negate(), i.surfaceNormal);
    const glint = cut(0.9972, dot(r, SUN_DIR)).mul(smoothstep(220, 40, dist));
    c = mix(c, white, glint);
    // Foam: crests, wakes and the surf on every shore, cut out with a pale rim.
    // Whitecaps: small, only on the highest crests.
    const crest = smoothstep(1.5, 1.85, h)
      .mul(0.7)
      .mul(cut(0.35, flowNoise(xz.mul(0.25), i.time, 0.2)));
    const wake = smoothstep(0.04, 0.7, i.wake).mul(
      mix(float(0.55), float(1), flowNoise(xz.mul(0.7), i.time, 1).mul(0.5).add(0.5)),
    );
    const bands = sin(i.shore.mul(1.3).sub(i.time.mul(1.6)).add(wash2.mul(4)));
    const surf = smoothstep(1.8, 0.6, i.shore).add(cut(0.82, bands).mul(smoothstep(7, 3, i.shore)));
    const foam = clamp(crest.add(wake).add(surf), 0, 1);
    c = mix(c, foamShade, cut(0.28, foam));
    c = mix(c, white, cut(0.55, foam));
    return c;
  })();

  const m = new THREE.MeshBasicNodeMaterial({ fog: true });
  m.positionNode = i.position;
  // Low land stands just above the sea: keep swells from showing through it.
  m.maskNode = i.hidden ? i.hidden.not() : positionWorld.z.lessThan(120.5);
  m.colorNode = colour;
  return inkOnlyInPass(m, inkNode(0, 0, 0, 0));
}
