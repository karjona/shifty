// The cel look's sky: a painted gradient from a deep zenith to a pale
// horizon, warmer toward the sun, and towering cumulus made of cel-shaded
// puffs (flat bottoms, lobes that each catch the light), far out over the
// sea and behind the sierra.
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  Fn,
  color,
  dot,
  float,
  fwidth,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  vec3,
} from "three/tsl";
import { CelMaterial, SUN_DIR, inkId, inklessBasic } from "./material.ts";

export const SKY = {
  zenith: color(0x1f6dd2),
  upper: color(0x4b9ff0),
  horizon: color(0xc4e9f8),
  glow: color(0xfff1d2),
  /** The horizon colour as a THREE.Color, for fog. */
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

/** The sky dome: centred on the camera, drawn behind everything. */
export function skyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(3800, 48, 24);
  const m = inklessBasic({ side: THREE.BackSide, depthWrite: false, fog: false });
  m.colorNode = Fn(() => {
    const d = normalize(positionLocal);
    const y = max(d.y, float(0));
    let c: THREE.Node<"vec3"> = mix(SKY.horizon, SKY.upper, smoothstep(0.0, 0.28, pow(y, 0.8)));
    c = mix(c, SKY.zenith, smoothstep(0.25, 0.9, y));
    const sun = max(dot(d, SUN_DIR), float(0));
    c = mix(c, SKY.glow, pow(sun, 24).mul(0.55).add(pow(sun, 4).mul(0.12)));
    // Wisps of cirrus high up: thin streaks along one wind, broken up, hard-edged.
    const plane = d.xz.div(max(d.y, float(0.05)));
    const n = mx_noise_float(vec3(plane.x.mul(0.22), plane.y.mul(3.2), 0.5));
    const band = n.sub(0.25).abs();
    const w = max(fwidth(band), float(1e-4));
    const patch = smoothstep(0.1, 0.35, mx_noise_float(vec3(plane.x.mul(0.5), plane.y.mul(0.7), 7.7)));
    const wisp = smoothstep(float(0.05).add(w), float(0.05).sub(w), band)
      .mul(patch)
      .mul(smoothstep(0.16, 0.26, y))
      .mul(smoothstep(0.55, 0.35, y));
    c = mix(c, mix(c, vec3(1), 0.3), wisp);
    return c;
  })();
  const dome = new THREE.Mesh(geo, m);
  dome.renderOrder = -10;
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
      const g = new THREE.IcosahedronGeometry(rad, 3);
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

/** Clouds in a ring round the bay, far out (they never fog). */
export function clouds(centre: THREE.Vector2): THREE.Group {
  const g = new THREE.Group();
  const r = rng(77);
  const shade = new THREE.Color(0.66, 0.72, 0.93);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + (r() - 0.5) * 0.3;
    // More, bigger clouds over the sierra (north, +z) and out to sea.
    const north = Math.max(0, Math.sin(a));
    const dist = 2500 + r() * 800;
    const size = 260 + r() * 300 + north * 260;
    const mesh = new THREE.Mesh(
      cumulus(size, 100 + i * 13),
      new CelMaterial({
        color: 0xffffff,
        shade,
        lit: new THREE.Color(1.02, 1.0, 0.97),
        threshold: 0.1,
        fog: false,
        silhouette: 1,
        crease: 0,
        darkness: 0.45,
        id: inkId(`cloud${i}`),
      }),
    );
    const x = centre.x + Math.cos(a) * dist;
    const z = centre.y + Math.sin(a) * dist;
    mesh.position.set(x, 60 + r() * 220 + north * 100, z);
    // Broadside to the bay.
    mesh.rotation.y = Math.atan2(centre.x - x, centre.y - z);
    mesh.scale.y = 0.85 + r() * 0.35;
    g.add(mesh);
  }
  return g;
}
