// Gradient noise from a texture: four channels of tileable 2D Perlin noise
// (the same kind as MaterialX's `mx_noise_float`, with its gradients and
// scale), baked once. A lookup costs one texture fetch where the shader
// function costs a hundred-odd instructions per pixel.
import * as THREE from "three/webgpu";
import { texture, vec2 } from "three/tsl";

/** Lattice cells across the texture (it repeats every `CELLS` units of noise space). */
export const NOISE_CELLS = 32;
const SIZE = 256;

let baked: THREE.DataTexture | null = null;

/** MaterialX's 2D gradients: (±1, ±2) and (±2, ±1). */
function gradient(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = 2 * (h < 4 ? y : x);
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

function hash3(i: number, j: number, c: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(c + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A lattice coordinate wrapped into the texture. */
const wrap = (k: number) => ((k % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Tileable noise at `(x, y)` in lattice units, channel `c`: about -1 to 1. */
function perlin(x: number, y: number, c: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const g = (di: number, dj: number) => gradient(hash3(wrap(i + di), wrap(j + dj), c), fx - di, fy - dj);
  const u = fade(fx);
  const v = fade(fy);
  const a = g(0, 0) + (g(1, 0) - g(0, 0)) * u;
  const b = g(0, 1) + (g(1, 1) - g(0, 1)) * u;
  return 0.6616 * (a + (b - a) * v);
}

/** The noise texture (shared). */
export function noiseTexture(): THREE.DataTexture {
  if (baked) return baked;
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      for (let c = 0; c < 4; c++) {
        const n = perlin((x / SIZE) * NOISE_CELLS, (y / SIZE) * NOISE_CELLS, c);
        data[(y * SIZE + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, n * 0.5 + 0.5)) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  baked = t;
  return t;
}

/** Noise at 2D point `p` (noise-space units, like `mx_noise_float`'s input): four independent channels, each about -1 to 1. */
export function noise4(p: THREE.Node<"vec2">): THREE.Node<"vec4"> {
  return texture(noiseTexture(), p.div(NOISE_CELLS)).mul(2).sub(1);
}

/**
 * Noise at 2D point `p` that changes over time `t` (in place of a 3D noise
 * with time as its third axis): two layers drifting apart, `rate` noise
 * units a second, so their sum keeps changing shape.
 */
export function flowNoise(p: THREE.Node<"vec2">, t: THREE.Node<"float">, rate: number): THREE.Node<"float"> {
  const a = noise4(p.add(vec2(0.71, 0.29).mul(t.mul(rate)))).x;
  const b = noise4(p.add(vec2(13.7, 5.3)).sub(vec2(0.31, 0.83).mul(t.mul(rate)))).y;
  return a.add(b).mul(Math.SQRT1_2);
}
