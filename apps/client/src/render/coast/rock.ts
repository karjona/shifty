// Cel rock: stone drawn in big planes. One material for every rock, cliff
// and stretch of bare ground on the coast (each vertex carries its colour):
// beds of strata a couple of metres thick in two tones with a dark seam,
// cracks running down the faces, a wet band along the water line, and, out in the weather, grass in the
// season's colour and snow on what faces up. The shapes: quarried blocks
// and boulders (convex, a dozen planes each), crags built in tiers, and
// cliffs swept along a shore with a notch at the water, ledges and a rim.
import * as THREE from "three/webgpu";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { Fn, dot, float, fract, fwidth, mix, normalWorld, positionWorld, sin, smoothstep, vec2, vec3 } from "three/tsl";
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

/**
 * What the coast's ground is to the seasons (see `FOLIAGE`): grass, a little less than whole, so its light dry
 * greens turn with the season without going garish.
 */
export const GRASSY = FOLIAGE.grass * 0.8;

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
    // Cracks: fine dark lines down a face, breaking where they cross from bed to bed.
    const run = dot(p.xz, vec2(normalWorld.z.negate(), normalWorld.x));
    const strip = s.floor();
    const split = noise4(vec2(run.mul(0.46).add(strip.mul(3.7)), p.y.mul(0.055).add(strip.mul(1.3)))).x.sub(0.06);
    const cw = fwidth(split).max(1e-4);
    const crack = smoothstep(cw.mul(1.3), cw.mul(0.3), split.abs());
    const k = mix(vec3(1), beds.mul(float(1).sub(crack.mul(0.3))), face);
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
    outdoor: GRASSY,
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
  /** How many of its long planes the sea has hollowed at the water line (0-1): notches, and a cave now and then. */
  hollows?: number;
  /** How far inside the land a point is (m), so a cave is cut only where there is rock to hold it. */
  inside?: (x: number, z: number) => number;
}

/** Inside a hollow in the rock: its depths, and the water lying in it. */
const HOLLOW_DEEP = new THREE.Color(0x22232f);
const HOLLOW_WATER = new THREE.Color(0x14303c);

const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), n: new THREE.Vector3() };

/** A triangle through three points, wound to face `toward` (a direction). */
function facing(
  shape: Shape,
  p: THREE.Vector3,
  q: THREE.Vector3,
  w: THREE.Vector3,
  toward: THREE.Vector3,
  paint: Paint,
): void {
  scratch.a.subVectors(q, p);
  scratch.b.subVectors(w, p);
  scratch.n.crossVectors(scratch.a, scratch.b);
  if (scratch.n.dot(toward) >= 0) shape.tri(p, q, w, paint);
  else shape.tri(p, w, q, paint);
}

/** The mouth of a hollow in a plane of rock, as (along the plane, up it), each 0-1: a cave's, and a notch's. */
const CAVE_MOUTH: [number, number][] = [
  [0.1, 0],
  [0.07, 0.3],
  [0.2, 0.52],
  [0.42, 0.64],
  [0.68, 0.58],
  [0.88, 0.36],
  [0.92, 0],
];
const NOTCH_MOUTH: [number, number][] = [
  [0.05, 0],
  [0.08, 0.5],
  [0.24, 0.84],
  [0.5, 0.94],
  [0.72, 0.8],
  [0.93, 0.56],
  [0.96, 0],
];

/**
 * A hollow in a plane of rock whose corners are `a1`, `b1` at the water
 * and `a3`, `b3` above (`a2`, `b2`: where the rock stands proud between
 * them, if it does): the plane with an arched mouth cut in it (`mouth`,
 * turned the other way round if `flip`), and a tunnel `depth` m into the
 * rock, toward `-out`, darker the deeper it goes.
 */
function addHollow(
  shape: Shape,
  a: readonly [THREE.Vector3, THREE.Vector3 | null, THREE.Vector3],
  b: readonly [THREE.Vector3, THREE.Vector3 | null, THREE.Vector3],
  out: THREE.Vector3,
  depth: number,
  tone: THREE.Color,
  outline: readonly [number, number][],
  flip: boolean,
  r: () => number,
): void {
  const [a1, a2, a3] = a;
  const [b1, b2, b3] = b;
  const at = (u: number, v: number) => a1.clone().lerp(b1, u).lerp(a3.clone().lerp(b3, u), v);
  const last = outline.length - 1;
  const mouth = outline.map((_, k) => {
    const [u, v] = flip ? [1 - outline[last - k]![0], outline[last - k]![1]] : outline[k]!;
    return at(u + (r() - 0.5) * 0.05, k === 0 || k === last ? 0 : v + (r() - 0.5) * 0.07);
  });
  const [l0, l1, l2] = [at(0, 0), at(0, 0.5), at(0, 1)];
  const [r0, r1, r2] = [at(1, 0), at(1, 0.5), at(1, 1)];
  const top = at(0.5, 1);
  const m = (k: number) => mouth[k]!;
  // The plane round the mouth.
  for (const [p, q, w] of [
    [l0, m(0), m(1)],
    [l0, m(1), l1],
    [l1, m(1), m(2)],
    [l1, m(2), l2],
    [l2, m(2), m(3)],
    [l2, m(3), top],
    [top, m(3), r2],
    [r2, m(3), m(4)],
    [r2, m(4), r1],
    [r1, m(4), m(5)],
    [r1, m(5), r0],
    [r0, m(5), m(6)],
  ] as const)
    facing(shape, p, q, w, out, tone);
  // (Its neighbours stand proud at the water: the gap at either end is closed.)
  const along = new THREE.Vector3().subVectors(b1, a1);
  if (a2) facing(shape, a1, a2, a3, along, tone);
  if (b2) facing(shape, b1, b2, b3, along.clone().negate(), tone);
  // The tunnel: walls from the mouth in, darkening, to a back wall; dark water on its floor.
  const inner = mouth.map((p) => p.clone().addScaledVector(out, -depth));
  const axis = at(0.5, 0.3).addScaledVector(out, -depth / 2);
  const c = new THREE.Color();
  const mid = new THREE.Vector3();
  const far = out.clone().multiplyScalar(-1);
  const lit = tone.clone().multiplyScalar(0.5);
  const deep: Paint = (p) => c.copy(far.dot(mid.subVectors(p, m(3))) > depth * 0.5 ? HOLLOW_DEEP : lit);
  const inward = new THREE.Vector3();
  for (let k = 0; k < last; k++) {
    inward.subVectors(axis, mid.addVectors(m(k), m(k + 1)).multiplyScalar(0.5));
    facing(shape, m(k), m(k + 1), inner[k + 1]!, inward.clone(), deep);
    facing(shape, m(k), inner[k + 1]!, inner[k]!, inward.clone(), deep);
  }
  for (let k = 1; k < last; k++) facing(shape, inner[0]!, inner[k]!, inner[k + 1]!, out, HOLLOW_DEEP);
  const up = new THREE.Vector3(0, 1, 0);
  const floor = [m(0), m(last), inner[last]!, inner[0]!].map((p) => p.clone().setY(-0.35));
  facing(shape, floor[0]!, floor[1]!, floor[2]!, up, HOLLOW_WATER);
  facing(shape, floor[0]!, floor[2]!, floor[3]!, up, HOLLOW_WATER);
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
  const hollowed = random(seed + 29);
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
    // A long plane the sea has got into: a notch along its foot, or a cave.
    let hollow: "none" | "notch" | "cave" = "none";
    const out = new THREE.Vector3(here.nx + next.nx, 0, here.nz + next.nz).normalize();
    const depth = 1.5 + hollowed() * 0.9;
    const reach = 4.5 + hollowed() * 3.5;
    const roll = hollowed();
    if (
      style.hollows &&
      a.length === b.length &&
      a[1]!.distanceTo(b[1]!) > 3.6 &&
      Math.min(here.height, next.height) > 6
    ) {
      const mx = (a[1]!.x + b[1]!.x) / 2;
      const mz = (a[1]!.z + b[1]!.z) / 2;
      const inside = (d: number) => style.inside?.(mx - out.x * d, mz - out.z * d) ?? d;
      const tiered = a.length > 6 && a[3]!.y > 5 && b[3]!.y > 5;
      if (roll < style.hollows * 0.16 && tiered && inside(reach + 2) > reach * 0.8) hollow = "cave";
      else if (roll < style.hollows && inside(depth + 1) > depth * 0.6) hollow = "notch";
    }
    const flip = hollowed() < 0.5;
    if (hollow === "notch")
      addHollow(shape, [a[1]!, null, a[2]!], [b[1]!, null, b[2]!], out, depth, tone, NOTCH_MOUTH, flip, hollowed);
    if (hollow === "cave")
      addHollow(shape, [a[1]!, a[2]!, a[3]!], [b[1]!, b[2]!, b[3]!], out, reach, tone, CAVE_MOUTH, flip, hollowed);
    for (let j = 0; j < rings - 1; j++) {
      if ((hollow === "notch" && j === 1) || (hollow === "cave" && (j === 1 || j === 2))) continue;
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

/** Guano on the rocks the gulls keep to. */
const GUANO = new THREE.Color(0xf3efe2);

/**
 * A sea stack: a pillar of rock on the circle of `radius` round `(x, z)`,
 * `height` tall. Buttresses and chimneys run up it from a waist the sea
 * has cut, a ledge or two break its faces, it leans, and its summit is
 * white with guano under a tuft of scrub.
 */
export function addStack(shape: Shape, x: number, z: number, radius: number, height: number, seed: number): void {
  const r = random(seed);
  const sides = 10 + Math.floor(r() * 3);
  const turn = r() * Math.PI * 2;
  const lean = r() * Math.PI * 2;
  const angles = Array.from({ length: sides }, (_, i) => turn + ((i + (r() - 0.5) * 0.5) / sides) * Math.PI * 2);
  // Round the plan: buttresses standing out, chimneys cut in between some of them.
  const rib: number[] = [];
  for (let i = 0; i < sides; i++) {
    const chimney = i % 3 === 1 || (i % 3 === 2 && r() < 0.3);
    rib.push(chimney ? 0.7 + r() * 0.12 : 1.0 + r() * 0.14);
  }
  // (A polygon of n sides covers a circle 1 / cos(π / n) smaller than its corners' circle.)
  const cover = 1 / Math.cos(Math.PI / sides);
  // Up the stack: (height, radius as a multiple, how far the chimneys are cut in).
  const rows: [number, number, number][] = [
    [-4, 1.14, 0],
    [0.1, 1.0, 0],
    [0.95, 0.94, 0],
    [2.3, 1.07, 0.25],
  ];
  let k = 1.02;
  let y = 2.3;
  const shaft = height - 3.2;
  while (y < shaft - 2.5) {
    y = Math.min(shaft, y + 3.4 + r() * 3.2);
    const t = y / height;
    // A face up to a ledge, then the rock set back above it; the stack narrows toward its top.
    rows.push([y, k * (0.98 + r() * 0.06), 1]);
    if (r() < 0.3) {
      k *= 0.88 + r() * 0.06;
      rows.push([y + 0.35, k, 1]);
    } else k *= 1 - 0.1 * t;
  }
  rows.push([height - 1.6, k * 0.88, 0.8], [height - 0.2, k * 0.6, 0.5]);
  const rings = rows.map(([ry, m, cut], t) => {
    const off = Math.max(0, ry) / height;
    // (The whole stack leans, and each tier sits a little off the one below.)
    const sx = Math.cos(lean) * off * off * radius * 0.55 + (t > 3 ? (r() - 0.5) * radius * 0.08 : 0);
    const sz = Math.sin(lean) * off * off * radius * 0.55 + (t > 3 ? (r() - 0.5) * radius * 0.08 : 0);
    return angles.map((a, i) => {
      const rad = radius * cover * m * (1 + cut * (rib[i]! - 1)) * (t > 2 ? 0.96 + r() * 0.08 : 1);
      const dip = t > 3 && t < rows.length - 1 ? (r() - 0.5) * 0.5 + Math.cos(a - lean) * radius * 0.14 : 0;
      return new THREE.Vector3(x + Math.cos(a) * rad + sx, ry + dip, z + Math.sin(a) * rad + sz);
    });
  });
  // Guano runs down from the summit, further on some faces than others.
  const white = angles.map(() => rows.length - 3 - (r() < 0.45 ? 1 : 0) - (r() < 0.15 ? 1 : 0));
  const c = new THREE.Color();
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const deep = rib[i]! < 0.9 || rib[j]! < 0.9;
    const tone = LIMESTONE[deep ? 2 : Math.floor(r() * 2)] ?? LIMESTONE[0]!;
    for (let t = 0; t < rings.length - 1; t++) {
      const streaked = t >= Math.min(white[i]!, white[j]!) && t > 3;
      const ledge = r() < 0.3 ? SCRUB : LIMESTONE_TOP;
      const paint: Paint = (_p, n) =>
        c.copy(streaked ? (n.y > 0.3 ? GUANO : tone).clone().lerp(GUANO, 0.55) : n.y > 0.72 ? ledge : tone);
      // (Angles run counter-clockwise seen from above: outward faces go up the near side first.)
      shape.tri(rings[t]![i]!, rings[t + 1]![i]!, rings[t]![j]!, paint);
      shape.tri(rings[t]![j]!, rings[t + 1]![i]!, rings[t + 1]![j]!, paint);
    }
  }
  // The summit: a white cap, scrub at its middle.
  const top = rings[rings.length - 1]!;
  const mid = top.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / sides);
  const crown = top.map((p) =>
    p
      .clone()
      .lerp(mid, 0.55)
      .setY(mid.y + 0.45),
  );
  mid.y += 0.7;
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    shape.quad(top[i]!, crown[i]!, crown[j]!, top[j]!, GUANO);
    shape.tri(crown[i]!, mid, crown[j]!, SCRUB);
  }
}
