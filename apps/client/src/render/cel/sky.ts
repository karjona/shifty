// The cel look's sky: a painted gradient from a deep zenith to a pale
// horizon, warmer toward the sun (and along the horizon at dawn and dusk),
// cirrus wisps the wind streaks, a cloud deck that closes in with the
// weather, and towering cumulus made of cel-shaded puffs (flat bottoms,
// lobes that each catch the light), far out over the sea and behind the
// sierra. Its colours are the conditions' (see look.ts).
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  Fn,
  attribute,
  cameraProjectionMatrix,
  clamp,
  dot,
  float,
  fwidth,
  max,
  mix,
  modelViewMatrix,
  mx_noise_float,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { LOOK, cut0 } from "./look.ts";
import { CelMaterial, SUN_DIR, inkId, inklessBasic } from "./material.ts";
import { noise4 } from "./noise.ts";

/** Where the sky sits in the depth range (1 = the far plane): behind all else, but never clipped by it. */
const SKY_DEPTH = 0.999999;

/** The sky's colours (the conditions' uniforms), and the clear summer horizon as a THREE.Color. */
export const SKY = {
  zenith: LOOK.zenith,
  upper: LOOK.upper,
  horizon: LOOK.horizon,
  glow: LOOK.glow,
  /** The clear summer horizon, for what starts out tinted toward it. */
  fog: new THREE.Color(0xc4e9f8),
};

/** Seeded noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * The sky dome: centred on the camera, behind everything. It is drawn after
 * the rest, at the very back of the depth range, so only the pixels nothing
 * else covers pay for its shader.
 */
export function skyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(3800, 48, 24);
  const m = inklessBasic({ side: THREE.BackSide, depthWrite: false, fog: false });
  m.vertexNode = Fn(() => {
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1));
    return vec4(clip.x, clip.y, clip.w.mul(SKY_DEPTH), clip.w);
  })();
  m.colorNode = Fn(() => {
    const d = normalize(positionLocal);
    const y = max(d.y, float(0));
    let c: THREE.Node<"vec3"> = mix(LOOK.horizon, LOOK.upper, smoothstep(0.0, 0.28, pow(y, 0.8)));
    c = mix(c, LOOK.zenith, smoothstep(0.25, 0.9, y));
    // Low sun: its warmth spreads along the horizon, most on its side of the sky.
    const flat = d.xz.div(max(d.xz.length(), float(1e-3)));
    const sunFlat = SUN_DIR.xz.div(max(SUN_DIR.xz.length(), float(1e-3)));
    const side = dot(flat, sunFlat).mul(0.5).add(0.5);
    const low = float(1).sub(smoothstep(0.0, 0.32, y));
    c = mix(c, LOOK.glow, pow(side, 3).mul(low).mul(LOOK.dusk).mul(0.75));
    const sun = max(dot(d, SUN_DIR), float(0));
    c = mix(c, LOOK.glow, pow(sun, 24).mul(0.55).add(pow(sun, 4).mul(0.12)));
    // Where a ray through this pixel meets a flat ceiling of cloud.
    const plane = d.xz.div(max(d.y, float(0.05)));
    const drift = LOOK.wind.mul(LOOK.time.mul(0.0015));
    // Wisps of cirrus high up: thin streaks along one wind, broken up, hard-edged; the wind draws them out.
    const n = mx_noise_float(vec3(plane.x.add(drift.x).mul(0.22), plane.y.add(drift.y).mul(3.2), 0.5));
    const band = n.sub(0.25).abs();
    const w = max(fwidth(band), float(1e-4));
    const thick = float(0.05).add(LOOK.streaks.mul(0.05));
    const patch = smoothstep(
      float(0.1).sub(LOOK.streaks.mul(0.35)),
      0.35,
      noise4(vec2(plane.x.mul(0.5), plane.y.mul(0.7)).add(drift)).x,
    );
    const wisp = smoothstep(thick.add(w), thick.sub(w), band)
      .mul(patch)
      .mul(smoothstep(0.16, 0.26, y))
      .mul(smoothstep(0.55, 0.35, y))
      .mul(LOOK.cirrus);
    c = mix(c, mix(c, vec3(1), 0.3), wisp);
    // The cloud deck: masses that close in with the weather, lighter at their edges, fading into the horizon.
    const q = plane.mul(0.32).add(drift.mul(4));
    const mass = noise4(q.mul(0.55))
      .x.mul(0.6)
      .add(noise4(q.mul(1.6)).y.mul(0.28))
      .add(noise4(q.mul(4.3)).z.mul(0.1));
    const edge = mass.sub(mix(float(0.62), float(-0.55), LOOK.overcast));
    const cloud = cut0(edge)
      .mul(smoothstep(0.015, 0.14, y))
      .mul(LOOK.overcast.greaterThan(0.001).select(1, 0));
    const deck = mix(LOOK.deck, LOOK.deckShade, cut0(edge.sub(0.14)));
    c = mix(c, deck, cloud);
    return c;
  })();
  const dome = new THREE.Mesh(geo, m);
  // After everything opaque.
  dome.renderOrder = 10;
  dome.frustumCulled = false;
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  return dome;
}

/** One cumulus: tiers of puffs on a flat base, wider than tall, about `size` metres across. */
function cumulus(size: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const tiers = [
    { n: 6 + Math.floor(r() * 3), rad: 0.15, y: 0.05, spread: 0.5 },
    { n: 4 + Math.floor(r() * 2), rad: 0.19, y: 0.2, spread: 0.32 },
    { n: 2 + Math.floor(r() * 2), rad: 0.21, y: 0.38, spread: 0.18 },
    { n: 1, rad: 0.17, y: 0.55, spread: 0.06 },
  ];
  for (const t of tiers) {
    for (let i = 0; i < t.n; i++) {
      const rad = size * t.rad * (0.75 + r() * 0.5);
      const g = new THREE.IcosahedronGeometry(rad, 2);
      const x = (t.n === 1 ? 0 : (i / (t.n - 1) - 0.5) * 2 * t.spread + (r() - 0.5) * 0.08) * size;
      g.translate(x + (t.n === 1 ? (r() - 0.5) * 0.2 * size : 0), t.y * size + rad * 0.5, (r() - 0.5) * size * 0.25);
      parts.push(g);
    }
  }
  const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  // A flat base, facing down.
  const pos = geo.attributes.position!;
  const nor = geo.attributes.normal!;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 0) {
      pos.setY(i, 0);
      nor.setXYZ(i, 0, -1, 0);
    }
  }
  return geo;
}

/** How many cumulus a sky can hold. */
const CUMULUS = 24;

/**
 * Cumulus in a ring round a circuit, far out (they never fog), all in one
 * batch: as many of them as the weather's cover asks for (each one grows
 * from nothing as the cover reaches it), as tall as it lets them stand, in
 * its colours.
 */
export class Cumulus {
  readonly mesh: THREE.Mesh;
  /** How much of the sky they fill (0-1; a fair day is about 0.6), and how tall they stand (1 = as built). */
  private cover = uniform(0.5);
  private tower = uniform(1);

  /** `centre`: the ring's middle (x, z) and the height its clouds stand on (y). */
  constructor(centre: THREE.Vector3) {
    const r = rng(77);
    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < CUMULUS; i++) {
      const a = (i / CUMULUS) * Math.PI * 2 + (r() - 0.5) * 0.3;
      // More, bigger clouds over the sierra (north, +z) and out to sea.
      const north = Math.max(0, Math.sin(a));
      const dist = 2500 + r() * 800;
      const size = 260 + r() * 300 + north * 260;
      const geo = cumulus(size, 100 + i * 13);
      const x = centre.x + Math.cos(a) * dist;
      const z = centre.z + Math.sin(a) * dist;
      const y = centre.y + 60 + r() * 220 + north * 100;
      // Broadside to the circuit, its height varied.
      m.makeRotationY(Math.atan2(centre.x - x, centre.z - z)).scale(new THREE.Vector3(1, 0.85 + r() * 0.35, 1));
      geo.applyMatrix4(m);
      // A fair day's clouds are spread all round the sky; the rest come with the clouds.
      const rank = i % 3 !== 2 ? (((i * 7) % 16) / 16) * 0.5 : 0.5 + (((i * 5) % 8) / 8) * 0.5;
      const n = geo.attributes.position!.count;
      const at = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) at.set([x, y, z, rank], k * 4);
      geo.setAttribute("cloud", new THREE.BufferAttribute(at, 4));
      parts.push(geo);
    }
    const geo = mergeGeometries(parts);
    const material = new CelMaterial({
      colorNode: LOOK.cloud.rgb,
      lit: new THREE.Color(1.02, 1.0, 0.97),
      threshold: 0.1,
      fog: false,
      silhouette: 1,
      crease: 0,
      darkness: 0.45,
      id: inkId("cloud"),
    });
    material.shadeNode = LOOK.cloudShade.rgb;
    const cloud = attribute<"vec4">("cloud", "vec4");
    const grow = clamp(this.cover.sub(cloud.w).div(0.06), 0, 1);
    const s = grow.greaterThan(0.01).select(grow.mul(0.6).add(0.4), 0);
    material.positionNode = cloud.xyz.add(positionLocal.mul(vec3(s, s.mul(this.tower), s)));
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = "cumulus";
    // (Placed in the shader: its bounds are the ring's.)
    this.mesh.frustumCulled = false;
  }

  /** Shows `cover` of the clouds (0-1; a fair day is about 0.6), `tower` as tall as built. */
  update(cover: number, tower: number): void {
    this.cover.value = cover;
    this.tower.value = tower;
  }
}
