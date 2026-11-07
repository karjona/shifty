// Landforms for the cel look: mountains with ridges and gullies (so the
// sun cuts clean light and shade shapes across them), snow caps with
// crisp, ragged edges, and the distance laid in as an illustrator's haze.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  float,
  fwidth,
  max,
  min,
  mix,
  mx_noise_float,
  normalLocal,
  pow,
  smoothstep,
  uniform,
} from "three/tsl";
import { CelMaterial } from "./material.ts";

/** Seeded hash in [0, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(z | 0, 2147483647) ^
    Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth value noise in [-1, 1]. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const l = lerp;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return (
    l(
      l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
      l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
      w,
    ) *
      2 -
    1
  );
}

/** Ridged fractal noise in [0, 1]: sharp crests, soft valleys. */
function ridged(x: number, y: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(x * freq, y * freq, z * freq, seed + i * 31));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

export interface PeakStyle {
  rock: THREE.ColorRepresentation;
  snow: THREE.ColorRepresentation;
  /** Fraction of the height above which snow lies (0-1). */
  snowline: number;
  /** How far toward the sky the whole peak is hazed (0-1), and more at its foot. */
  haze: number;
  footHaze: number;
  sky: THREE.Color;
}

/** A mountain about `radius` across its base and `height` tall, its foot at y = 0. */
export function celPeak(radius: number, height: number, seed: number, s: PeakStyle): THREE.Mesh {
  const geo = new THREE.ConeGeometry(radius, height, 48, 24, true);
  geo.translate(0, height / 2, 0);
  const pos = geo.attributes.position!;
  const rock = new THREE.Color(s.rock);
  const snow = new THREE.Color(s.snow);
  const v = new THREE.Vector3();
  // The apex sits off-centre, and the flanks fold into ridges and gullies.
  const lean = new THREE.Vector2(noise3(seed, 0, 0, 5) * radius * 0.25, noise3(0, seed, 0, 6) * radius * 0.25);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = v.y / height;
    const a = Math.atan2(v.z, v.x);
    const r = Math.hypot(v.x, v.z);
    const ridge = ridged(Math.cos(a) * 2.2, t * 2.5, Math.sin(a) * 2.2, seed, 4);
    const bump = noise3(Math.cos(a) * 1.3, t * 1.4, Math.sin(a) * 1.3, seed + 9);
    const k = 1 + (ridge - 0.45) * 0.55 * (1 - t * 0.6) + bump * 0.18;
    const nr = r * k;
    v.x = (v.x / Math.max(r, 1e-3)) * nr + lean.x * t;
    v.z = (v.z / Math.max(r, 1e-3)) * nr + lean.y * t;
    v.y = v.y * (1 + (ridge - 0.5) * 0.12 * t);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.deleteAttribute("uv");
  // What the shader needs of this peak rides on its vertices, so peaks
  // share one material and can be drawn as one batch.
  const n = pos.count;
  const local = new Float32Array(n * 3);
  const shape = new Float32Array(n * 4);
  const foot = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    local.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
    shape.set([height, seed, s.snowline, s.haze], i * 4);
    foot[i] = s.footHaze;
  }
  geo.setAttribute("peakLocal", new THREE.BufferAttribute(local, 3));
  geo.setAttribute("peakShape", new THREE.BufferAttribute(shape, 4));
  geo.setAttribute("peakFoot", new THREE.BufferAttribute(foot, 1));
  const mat = peakMaterial(rock, snow, s.sky);
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

const peakMaterials = new Map<string, CelMaterial>();

/** The peaks' material for one set of colours (shared: each peak's numbers are on its vertices). */
function peakMaterial(rock: THREE.Color, snow: THREE.Color, sky: THREE.Color): CelMaterial {
  const key = `${rock.getHex()} ${snow.getHex()} ${sky.getHex()}`;
  const cached = peakMaterials.get(key);
  if (cached) return cached;
  const mat = new CelMaterial({
    fog: false,
    threshold: 0.1,
    shade: new THREE.Color(0.68, 0.7, 0.92),
    richness: 1.15,
    silhouette: 0.8,
    crease: 0,
    darkness: 0.4,
  });
  // Snow per pixel, so its edge is crisp: above a ragged line, and off the steepest faces.
  const rockC = uniform(rock);
  const snowC = uniform(snow);
  const skyC = uniform(sky.clone());
  mat.colorNode = Fn(() => {
    const p = attribute<"vec3">("peakLocal", "vec3");
    const shape = attribute<"vec4">("peakShape", "vec4");
    const footHaze = attribute<"float">("peakFoot", "float");
    const top = shape.x;
    const offset = shape.y;
    const snowline = shape.z;
    const haze = shape.w;
    const t = p.y.div(top);
    const n = mx_noise_float(p.mul(0.012).add(offset))
      .mul(0.1)
      .add(mx_noise_float(p.mul(0.05).add(offset.mul(3))).mul(0.04));
    const up = normalLocal.y;
    const line = t.sub(snowline).add(n).add(up.sub(0.45).mul(0.18));
    const w = max(fwidth(line), float(1e-4));
    const snowy = smoothstep(w.negate(), w, line);
    const base = mix(rockC, snowC, snowy);
    return mix(base, skyC, min(float(1), haze.add(footHaze.mul(pow(float(1).sub(t), 2)))));
  })();
  peakMaterials.set(key, mat);
  return mat;
}
