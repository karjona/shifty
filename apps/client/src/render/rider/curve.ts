// Smooth curves through keyed values, and the cross-sections the rider's
// body is lofted from.
import * as THREE from "three/webgpu";

/** Rows of `[t, v1, v2, ...]`, sorted by t; returns the values at any t (Catmull-Rom, clamped ends). */
export function keyed(rows: readonly (readonly number[])[]): (t: number) => number[] {
  const n = rows.length;
  const width = rows[0]!.length - 1;
  return (t: number) => {
    const out = new Array<number>(width);
    if (t <= rows[0]![0]!) {
      for (let k = 0; k < width; k++) out[k] = rows[0]![k + 1]!;
      return out;
    }
    if (t >= rows[n - 1]![0]!) {
      for (let k = 0; k < width; k++) out[k] = rows[n - 1]![k + 1]!;
      return out;
    }
    let i = 0;
    while (i < n - 2 && t > rows[i + 1]![0]!) i++;
    const a = rows[i]!;
    const b = rows[i + 1]!;
    const before = rows[Math.max(0, i - 1)]!;
    const after = rows[Math.min(n - 1, i + 2)]!;
    const span = b[0]! - a[0]!;
    const u = (t - a[0]!) / span;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let k = 1; k <= width; k++) {
      // Tangents from the neighbours, scaled to this segment; flat at the ends.
      const m0 = i === 0 ? 0 : ((b[k]! - before[k]!) / (b[0]! - before[0]!)) * span;
      const m1 = i + 1 === n - 1 ? 0 : ((after[k]! - a[k]!) / (after[0]! - a[0]!)) * span;
      out[k - 1] = h00 * a[k]! + h10 * m0 + h01 * b[k]! + h11 * m1;
    }
    return out;
  };
}

/** A gaussian bump: 1 at 0, falling off with `x / sigma`. */
export const bell = (x: number, sigma: number) => Math.exp(-(x * x) / (sigma * sigma));

/** The shortest signed angle from `b` to `a`. */
export const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

const sgnpow = (s: number, p: number) => Math.sign(s) * Math.abs(s) ** p;

/**
 * A cross-section of the body: a superellipse around `c` in the plane of
 * `side` and `front`, wider or deeper in front than behind, with bumps
 * (muscle, bone, fat) added outward. φ = 0 points along `front`, φ = π/2
 * along `side`.
 */
export interface Section {
  c: THREE.Vector3;
  side: THREE.Vector3;
  front: THREE.Vector3;
  /** Half width along `side`, depth in front and behind. */
  w: number;
  df: number;
  db: number;
  /** Superellipse exponents in front and behind (2 = ellipse, higher = boxier). */
  nf: number;
  nb: number;
  /** Outward offset at φ (m). */
  bump?: (phi: number) => number;
}

/** A point on a section at angle φ, pushed out by `offset` (clothes). */
export function sectionPoint(s: Section, phi: number, offset: number, out: THREE.Vector3): THREE.Vector3 {
  const sn = Math.sin(phi);
  const cs = Math.cos(phi);
  const x = (s.w + offset) * sgnpow(sn, 2 / s.nf);
  const z = cs >= 0 ? (s.df + offset) * sgnpow(cs, 2 / s.nf) : (s.db + offset) * sgnpow(cs, 2 / s.nb);
  const b = s.bump ? s.bump(phi) : 0;
  const len = Math.hypot(x, z) || 1;
  const rx = x + (x / len) * b;
  const rz = z + (z / len) * b;
  return out.copy(s.c).addScaledVector(s.side, rx).addScaledVector(s.front, rz);
}

/**
 * A ring's column angles: `sides + 1` of them from the back (-π) round
 * through the front (0) to the back again (π, the texture seam), closer
 * together in front when `frontBias` > 0 (0-0.8).
 */
export function ringAngles(sides: number, frontBias: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= sides; i++) {
    const s = -Math.PI + (i / sides) * Math.PI * 2;
    out.push(s - frontBias * Math.sin(s));
  }
  return out;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
