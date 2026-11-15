// Cel rock: stone drawn in big planes. One material for every rock, cliff
// and stretch of bare ground on the coast (each vertex carries its colour):
// beds of strata a couple of metres thick in two tones with a dark seam,
// a wet band along the water line, and, out in the weather, grass in the
// season's colour and snow on what faces up. The shapes: quarried blocks
// and boulders (convex, a dozen planes each), crags built in tiers, and
// cliffs swept along a shore with a notch at the water, ledges and a rim.
import * as THREE from "three/webgpu";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { Fn, float, fract, fwidth, mix, normalWorld, positionWorld, sin, smoothstep, vec3 } from "three/tsl";
import { FOLIAGE } from "../cel/look.ts";
import { CelMaterial, inkId } from "../cel/material.ts";
import { noise4 } from "../cel/noise.ts";
import { type Paint, Shape, random } from "./shape.ts";

/** Limestone of the coast, lit: three close tones a cliff's planes take, and its top planes. */
export const LIMESTONE = [0xd9c4a0, 0xcfb893, 0xc4ab86].map((h) => new THREE.Color(h));
export const LIMESTONE_TOP = new THREE.Color(0xe6d6b4);
/** Quarried armour stone: grey, a little warm. */
export const ARMOUR = [0xb4aca0, 0xa69e92, 0xc0b8ac, 0x9c958a].map((h) => new THREE.Color(h));
/** Dry grass and scrub on top of rock (the season turns it). */
export const SCRUB = new THREE.Color(0x7f9a4e);
export const DRY_GRASS = new THREE.Color(0x9aa85a);

let rock: CelMaterial | null = null;

/** The rock material (shared). */
export function rockMaterial(): CelMaterial {
  if (rock) return rock;
  const tone = Fn(() => {
    const p = positionWorld;
    const n = noise4(p.xz.mul(0.045));
    // Beds dipping gently across the coast, thick and thin, their edges wandering.
    const s = p.y
      .mul(0.2)
      .add(sin(p.y.mul(0.19).add(1.3)).mul(0.55))
      .add(p.x.mul(0.011))
      .add(p.z.mul(0.006))
      .add(n.x.mul(0.3));
    const bed = fract(s);
    const w = fwidth(s).max(1e-4);
    const band = smoothstep(float(0.5).sub(w), float(0.5).add(w), bed).mul(
      smoothstep(float(0.9).add(w), float(0.9).sub(w), bed),
    );
    const seam = smoothstep(float(0.9).sub(w), float(0.9).add(w), bed).mul(smoothstep(float(1), float(1).sub(w), bed));
    // Every third bed is stained with iron.
    const third = fract(s.floor().mul(1 / 3));
    const rust = smoothstep(0.5, 0.6, third).mul(float(1).sub(band)).mul(float(1).sub(seam));
    // Faces show their beds; what faces up is bleached plain.
    const face = smoothstep(0.8, 0.55, normalWorld.y);
    const beds = mix(vec3(1), vec3(1.0, 0.9, 0.78), rust.mul(0.6)).mul(
      float(1).sub(band.mul(0.15).add(seam.mul(0.34))),
    );
    const k = mix(vec3(1), beds, face);
    // Wet and dark where the swell reaches, under a pale line of salt.
    const line = float(0.75).add(n.y.mul(0.45));
    const lw = fwidth(p.y).max(1e-4);
    const wet = smoothstep(line.add(lw), line.sub(lw), p.y);
    const salt = smoothstep(line.add(0.28).add(lw), line.add(0.28).sub(lw), p.y).mul(float(1).sub(wet)).mul(face);
    return mix(mix(k, vec3(1.08, 1.07, 1.04), salt.mul(0.55)), vec3(0.52, 0.56, 0.63).mul(k), wet);
  });
  rock = new CelMaterial({
    vertexColors: true,
    flatShading: true,
    colorNode: tone(),
    outdoor: FOLIAGE.grass,
    shade: new THREE.Color(0.6, 0.58, 0.8),
    richness: 1.25,
    crease: 0.75,
    darkness: 0.8,
    id: inkId("rock"),
  });
  rock.name = "rock";
  return rock;
}

/** Paints a stone: one of `tones` for its faces, lighter on what faces up. */
export function stonePaint(tones: readonly THREE.Color[], top: THREE.Color, r: () => number): Paint {
  const face = tones[Math.floor(r() * tones.length)] ?? tones[0]!;
  const c = new THREE.Color();
  return (_p, n) => c.copy(n.y > 0.72 ? top : face);
}

/** A quarried block about 1 across, standing on y = 0: a box with some corners split off. */
export function blockGeometry(seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const size = new THREE.Vector3(0.5, 0.36 + r() * 0.1, 0.4 + r() * 0.12);
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const corner = new THREE.Vector3(
          sx * size.x * (0.86 + r() * 0.2),
          sy * size.y * (0.86 + r() * 0.2),
          sz * size.z * (0.86 + r() * 0.2),
        );
        if (r() < 0.45) {
          // Split off: three points a way along the edges that met there.
          const cut = 0.25 + r() * 0.3;
          pts.push(
            corner.clone().setX(corner.x - sx * size.x * cut),
            corner.clone().setY(corner.y - sy * size.y * cut),
            corner.clone().setZ(corner.z - sz * size.z * cut * 0.8),
          );
        } else pts.push(corner);
      }
  const g = new ConvexGeometry(pts);
  g.translate(0, size.y, 0);
  return g;
}

/** A boulder about 1 across, its middle at y = 0: rounder than a block, a couple of dozen planes. */
export function boulderGeometry(seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const pts: THREE.Vector3[] = [];
  const n = 11 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    // Evenly round the sphere, then jittered.
    const y = 1 - (2 * (i + 0.5)) / n;
    const a = i * 2.39996 + r() * 0.6;
    const ring = Math.sqrt(1 - y * y);
    const k = 0.4 + r() * 0.16;
    pts.push(new THREE.Vector3(Math.cos(a) * ring * k, y * k * 0.72, Math.sin(a) * ring * k));
  }
  return new ConvexGeometry(pts);
}

/**
 * A crag standing in the sea: tiers of rock round `(0, 0)` that cover the
 * circle of `radius` at the water line, up to `height`, its peak off to
 * one side. For rocks a few metres across.
 */
export function cragGeometry(radius: number, height: number, seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const pts: THREE.Vector3[] = [];
  const ring = (count: number, rad: number, y: number, spread: number, cx = 0, cz = 0) => {
    const turn = r() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = turn + ((i + (r() - 0.5) * 0.5) / count) * Math.PI * 2;
      const k = rad * (1 + r() * spread);
      pts.push(new THREE.Vector3(cx + Math.cos(a) * k, y + (r() - 0.5) * 0.3, cz + Math.sin(a) * k));
    }
  };
  // (A ring of n points covers a circle 1 / cos(π / n) smaller than itself.)
  ring(7, radius * 1.16, -2.6, 0.1);
  ring(7, radius * 1.13, 0.5, 0.08);
  ring(5, radius * 0.92, height * 0.38, 0.12);
  // Two summits: the higher off to one side, a shoulder across from it.
  const lean = r() * Math.PI * 2;
  const ox = Math.cos(lean) * radius * 0.35;
  const oz = Math.sin(lean) * radius * 0.35;
  ring(3, radius * 0.32, height * 0.94, 0.3, ox, oz);
  ring(2, radius * 0.3, height * 0.6, 0.3, -ox * 1.3, -oz * 1.3);
  return new ConvexGeometry(pts);
}

/** A point on a shore the cliff stands on: where, which way is out to sea, how high the cliff is. */
export interface ShorePoint {
  x: number;
  z: number;
  /** Unit normal, out to sea. */
  nx: number;
  nz: number;
  /** The cliff's rim over the water (m). */
  height: number;
  /** The ground just inland of the rim (m), or null to close the top level. */
  inland: number | null;
  /** Grass on its ledges and top (0-1). */
  lush: number;
}

export interface CliffStyle {
  tones: readonly THREE.Color[];
  top: THREE.Color;
  grass: THREE.Color;
  /** A plane's length along the shore (m): least and most. */
  face: [number, number];
  /** How far the planes stand out past the shore (m): least and most. */
  out: [number, number];
  /** How far inland of the rim the top reaches (m). */
  flange: number;
  /** A ledge's depth (m): least and most; and the least height a cliff has one at. */
  ledge: [number, number];
  tiers: number;
  /** The ground's height where the top's inland edge lies (the cliff's own rim height if left out). */
  ground?: (x: number, z: number) => number;
}

export const CLIFF: CliffStyle = {
  tones: LIMESTONE,
  top: LIMESTONE_TOP,
  grass: DRY_GRASS,
  face: [5, 11],
  out: [0.5, 2.1],
  flange: 5,
  ledge: [1, 2.6],
  tiers: 6,
};

/** One vertex of the cliff's plan: a shore point, and how far its lower and upper tiers stand out. */
interface Station extends ShorePoint {
  low: number;
  high: number;
  ledge: number;
  /** How far up the first tier ends (0-1 of the height). */
  split: number;
  lean: number;
  /** The rim here above or below the shore's height (m): blocks of rock stand a little proud of their neighbours. */
  rise: number;
  /** How far along the shore the upper tier is shifted (m), so its fissures don't line up with the ones below. */
  shear: number;
}

/**
 * Lays the cliff's plan along a shore: long planes between vertices that
 * stand a little in and out, and fissures (two vertices close together, a
 * step between them) where a line should fall.
 */
function stations(shore: readonly ShorePoint[], closed: boolean, style: CliffStyle, seed: number): Station[] {
  const r = random(seed);
  // Arc length along the shore.
  const s: number[] = [0];
  for (let i = 1; i < shore.length; i++)
    s.push(s[i - 1]! + Math.hypot(shore[i]!.x - shore[i - 1]!.x, shore[i]!.z - shore[i - 1]!.z));
  const first = shore[0]!;
  const last = shore[shore.length - 1]!;
  const total = s[s.length - 1]! + (closed ? Math.hypot(first.x - last.x, first.z - last.z) : 0);
  const at = (d: number): ShorePoint => {
    const u = closed ? ((d % total) + total) % total : Math.min(Math.max(d, 0), total);
    let i = 0;
    while (i < shore.length - 1 && s[i + 1]! < u) i++;
    const a = shore[i]!;
    const b = shore[(i + 1) % shore.length]!;
    const span = (i + 1 < shore.length ? s[i + 1]! : total) - s[i]!;
    const t = span > 1e-6 ? Math.min(1, (u - s[i]!) / span) : 0;
    const nx = a.nx + (b.nx - a.nx) * t;
    const nz = a.nz + (b.nz - a.nz) * t;
    const len = Math.hypot(nx, nz) || 1;
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      nx: nx / len,
      nz: nz / len,
      height: a.height + (b.height - a.height) * t,
      inland: a.inland === null || b.inland === null ? null : a.inland + (b.inland - a.inland) * t,
      lush: a.lush + (b.lush - a.lush) * t,
    };
  };
  const [lo, hi] = style.out;
  const out: Station[] = [];
  let low = lo + r() * (hi - lo);
  let high = r() * 0.8;
  const [ledgeLo, ledgeHi] = style.ledge;
  let ledge = ledgeLo + r() * (ledgeHi - ledgeLo);
  let split = 0.4 + r() * 0.2;
  let lean = r() * 0.7;
  let rise = 0;
  const push = (d: number) => out.push({ ...at(d), low, high, ledge, split, lean, rise, shear: (r() - 0.5) * 3 });
  let d = 0;
  push(0);
  while (d < total - style.face[0] * 0.6) {
    const length = Math.min(style.face[0] + r() * (style.face[1] - style.face[0]), total - d);
    d += length;
    // The plane ends about where it began: turned a little, never bowed.
    low = Math.min(hi, Math.max(lo, low + (r() - 0.5) * 0.5));
    if (closed && d > total - 0.5) break;
    push(d);
    if (d > total - 2.5) break;
    // A fissure: the next plane starts further in or out, and its tiers shift.
    if (r() < 0.6) {
      d += 0.8 + r() * 0.7;
      low = low > (lo + hi) / 2 ? lo + r() * (hi - lo) * 0.35 : hi - r() * (hi - lo) * 0.35;
      high = r() * 0.9;
      ledge = Math.min(ledgeHi, Math.max(ledgeLo, (ledge || ledgeLo) + (r() - 0.5) * (ledgeHi - ledgeLo) * 0.8));
      split = Math.min(0.7, Math.max(0.3, split + (r() - 0.5) * 0.3));
      lean = r() * 0.8;
      rise = (r() - 0.5) * 0.16;
      // A plane without a ledge now and then: one face from the water to the rim.
      if (r() < 0.18) ledge = 0;
      push(Math.min(d, total));
    }
  }
  return out;
}

/** The cliff's profile at a station: rings from under the water to the top, as (out to sea, height). */
function profile(st: Station, style: CliffStyle): [number, number][] {
  const h = Math.max(1.2, st.height * (1 + st.rise));
  const o = st.low;
  // Low rock has no ledge: one face from the notch to the rim.
  const tiers = h > style.tiers;
  const ledge = tiers ? st.ledge : 0;
  const split = tiers ? st.split : 0.6;
  const back = o - ledge - st.high;
  const rings: [number, number][] = [
    [o + 1.6, -4],
    [o - 0.25, 0.1],
    [o + 0.3, Math.min(1.7, h * 0.4)],
    [o + 0.1, h * split],
  ];
  if (tiers) rings.push([back, h * split + (ledge > 0 ? 0.35 : 0.05)], [back - 0.15 + st.lean, h * 0.86]);
  rings.push([back - 0.9, h]);
  const inland = st.inland ?? h + 0.4;
  rings.push([back - 0.9 - style.flange, inland]);
  return rings;
}

/**
 * Sweeps a cliff along `shore` (points a metre or two apart, the sea on
 * the side their normals point to) into `shape`. Returns the inland edge
 * of its top, station by station.
 */
export function sweepCliff(
  shape: Shape,
  shore: readonly ShorePoint[],
  closed: boolean,
  seed: number,
  style: CliffStyle = CLIFF,
): THREE.Vector3[] {
  if (shore.length < 2) return [];
  const plan = stations(shore, closed, style, seed);
  const r = random(seed + 17);
  const rows = plan.map((st) => {
    const rings = profile(st, style);
    const row = rings.map(([out, y], j) => {
      // The upper tier (above the ledge), slid along the shore.
      const slide = rings.length > 6 && j >= 4 && j < rings.length - 1 ? st.shear : 0;
      return new THREE.Vector3(st.x + st.nx * out - st.nz * slide, y, st.z + st.nz * out + st.nx * slide);
    });
    const inner = row[row.length - 1]!;
    if (style.ground) inner.y = style.ground(inner.x, inner.z);
    return row;
  });
  const c = new THREE.Color();
  const count = closed ? plan.length : plan.length - 1;
  for (let i = 0; i < count; i++) {
    const a = rows[i]!;
    const b = rows[(i + 1) % plan.length]!;
    const lush = (plan[i]!.lush + plan[(i + 1) % plan.length]!.lush) / 2;
    const tone = style.tones[Math.floor(r() * style.tones.length)] ?? style.tones[0]!;
    const grassy = r() < lush * 0.55;
    const paint: Paint = (_p, n) =>
      c.copy(n.y > 0.72 ? (grassy || n.y > 0.97 ? (lush > 0.5 ? style.grass : style.top) : style.top) : tone);
    // Tiers can differ between neighbours (a ledge that ends): join ring to ring from the bottom and the top.
    const rings = Math.max(a.length, b.length);
    // The sea is on the right of the way along the shore, or the planes are wound the other way.
    const here = plan[i]!;
    const next = plan[(i + 1) % plan.length]!;
    const seaward = -(next.z - here.z) * here.nx + (next.x - here.x) * here.nz >= 0;
    const ring = (row: THREE.Vector3[], j: number) => {
      if (row.length === rings) return row[j]!;
      // A shorter profile has no ledge: its face stands in for the missing rings.
      const map = [0, 1, 2, 3, 3, 4, 4, 5];
      return row[Math.min(row.length - 1, map[j] ?? j)]!;
    };
    for (let j = 0; j < rings - 1; j++) {
      const a0 = ring(a, j);
      const a1 = ring(a, j + 1);
      const b0 = ring(b, j);
      const b1 = ring(b, j + 1);
      if (a0.distanceToSquared(a1) > 1e-6) {
        if (seaward) shape.tri(a0, b0, a1, paint);
        else shape.tri(a0, a1, b0, paint);
      }
      if (b0.distanceToSquared(b1) > 1e-6) {
        if (seaward) shape.tri(b0, b1, a1, paint);
        else shape.tri(b0, a1, b1, paint);
      }
    }
  }
  return rows.map((row) => row[row.length - 1]!);
}

/** Points round a circle, as a shore (for an island or a rock swept as a cliff). */
export function roundShore(
  cx: number,
  cz: number,
  radius: number,
  height: (angle: number) => number,
  lush = 0,
  inland: number | null = null,
): ShorePoint[] {
  const n = Math.max(24, Math.round((Math.PI * 2 * radius) / 1.2));
  const out: ShorePoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = -(i / n) * Math.PI * 2;
    out.push({
      x: cx + Math.cos(a) * radius,
      z: cz + Math.sin(a) * radius,
      nx: Math.cos(a),
      nz: Math.sin(a),
      height: height(a),
      inland,
      lush,
    });
  }
  return out;
}

/**
 * A sea stack: a pillar of rock on the circle of `radius` round `(x, z)`,
 * `height` tall, in tiers with ledges, a waist the sea has cut and a cap
 * that leans.
 */
export function addStack(shape: Shape, x: number, z: number, radius: number, height: number, seed: number): void {
  const r = random(seed);
  const sides = 7 + Math.floor(r() * 2);
  const turn = r() * Math.PI * 2;
  const lean = r() * Math.PI * 2;
  const angles = Array.from({ length: sides }, (_, i) => turn + ((i + (r() - 0.5) * 0.45) / sides) * Math.PI * 2);
  // Tiers from the sea bed up: (radius as a multiple, height, how far it has leant).
  const cover = 1 / Math.cos(Math.PI / sides);
  const tiers: [number, number][] = [
    [cover * 1.12, -4],
    [cover * 1.0, 0.1],
    [cover * 1.06, 2.2],
  ];
  let k = 1.0;
  let y = 2.2;
  while (y < height - 4) {
    const rise = 3.2 + r() * 3.4;
    y = Math.min(height - 2.2, y + rise);
    // A face up to a ledge, then the next tier set back (or, once, standing out over the one below).
    tiers.push([cover * k * (0.97 + r() * 0.08), y]);
    k *= r() < 0.22 ? 1.07 : 0.8 + r() * 0.12;
    tiers.push([cover * k, y + 0.3]);
  }
  tiers.push([cover * k * 0.92, height - 0.6], [cover * k * 0.45, height + r() * 0.8]);
  const jitter = angles.map(() => 0.9 + r() * 0.2);
  const rings = tiers.map(([m, ty], t) => {
    const off = Math.max(0, ty) / height;
    return angles.map((a, i) => {
      const wob = t < 3 ? 1 : jitter[i]! * (0.94 + r() * 0.12);
      const rad = radius * m * wob;
      return new THREE.Vector3(
        x + Math.cos(a) * rad + Math.cos(lean) * off * off * radius * 0.5,
        ty + (t > 2 && t < tiers.length - 1 ? (r() - 0.5) * 0.5 + Math.cos(a - lean) * radius * 0.16 : 0),
        z + Math.sin(a) * rad + Math.sin(lean) * off * off * radius * 0.5,
      );
    });
  });
  const c = new THREE.Color();
  for (let i = 0; i < sides; i++) {
    const tone = LIMESTONE[Math.floor(r() * LIMESTONE.length)] ?? LIMESTONE[0]!;
    const paint: Paint = (_p, n) => c.copy(n.y > 0.72 ? LIMESTONE_TOP : tone);
    const j = (i + 1) % sides;
    for (let t = 0; t < rings.length - 1; t++) {
      // (Angles run counter-clockwise seen from above: outward faces go up the near side first.)
      shape.tri(rings[t]![i]!, rings[t + 1]![i]!, rings[t]![j]!, paint);
      shape.tri(rings[t]![j]!, rings[t + 1]![i]!, rings[t + 1]![j]!, paint);
    }
  }
  // The cap: scrub on top.
  const top = rings[rings.length - 1]!;
  const mid = top.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / sides);
  mid.y += 0.5;
  for (let i = 0; i < sides; i++) shape.tri(top[i]!, mid, top[(i + 1) % sides]!, SCRUB);
}
