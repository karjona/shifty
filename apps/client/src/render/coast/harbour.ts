// Harbour works: breakwaters of armour stone with a paved deck and a
// parapet, the lighthouse, harbour lights and beacons, lamp posts,
// bollards and benches. Built into shapes (see shape.ts) in the rock and
// the prop materials; lamps that flash are meshes of their own (`Glow`).
import * as THREE from "three/webgpu";
import type { LandData } from "../course.ts";
import { capsuleOutline, prism } from "./outline.ts";
import { Glow, propMaterial } from "./materials.ts";
import {
  ARMOUR,
  LIMESTONE,
  LIMESTONE_TOP,
  blockGeometry,
  boulderGeometry,
  cragGeometry,
  rockMaterial,
  stonePaint,
} from "./rock.ts";
import { Shape, box, place, post, random, turned } from "./shape.ts";

const CONCRETE = 0xd6cdb9;
const CONCRETE_SIDE = 0xb9af9c;
const WALL = 0xcfc5b0;
const IRON = 0x3a3f46;
const WHITE = 0xf4f1ea;
const RED = 0xd6402e;
const GREEN = 0x2f9a4a;
const GLASS = 0xbfe2ee;

const PAVING = new THREE.Color(CONCRETE);
const PAVING_SIDE = new THREE.Color(CONCRETE_SIDE);
/** Paving on top, a darker face below. */
const paved = (_p: THREE.Vector3, n: THREE.Vector3) => (n.y > 0.5 ? PAVING : PAVING_SIDE);

/** A segment with a radius round it (a land capsule, or part of one). */
export interface Capsule {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** A point on a capsule's edge and the way out from it. */
export interface EdgePoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** Where round the capsule it is: along a side (0), or round an end (1). */
  end: boolean;
}

/**
 * Points every `step` m round a capsule at `radius`, the outside on the
 * right of the way round. `ends` fixes how many go round each end (so
 * rings at different radii match point for point).
 */
export function capsuleEdge(l: Capsule, radius: number, step: number, ends?: number): EdgePoint[] {
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len = Math.hypot(dx, dz);
  const ux = len > 1e-3 ? dx / len : 1;
  const uz = len > 1e-3 ? dz / len : 0;
  const nx = -uz;
  const nz = ux;
  const out: EdgePoint[] = [];
  const side = (fx: number, fz: number, sign: number) => {
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * len * sign;
      out.push({
        x: fx + ux * a + nx * sign * radius,
        z: fz + uz * a + nz * sign * radius,
        nx: nx * sign,
        nz: nz * sign,
        end: false,
      });
    }
  };
  const end = (cx: number, cz: number, sign: number) => {
    const n = ends ?? Math.max(2, Math.round((Math.PI * radius) / step));
    for (let i = 0; i < n; i++) {
      const phi = (i / n) * Math.PI;
      const ex = (Math.cos(phi) * nx + Math.sin(phi) * ux) * sign;
      const ez = (Math.cos(phi) * nz + Math.sin(phi) * uz) * sign;
      out.push({ x: cx + ex * radius, z: cz + ez * radius, nx: ex, nz: ez, end: true });
    }
  };
  if (len > 1e-3) side(l.ax, l.az, 1);
  end(l.bx, l.bz, 1);
  if (len > 1e-3) side(l.bx, l.bz, -1);
  end(l.ax, l.az, -1);
  return out;
}

/** The stones armour is laid from: a few blocks and boulders, shared. */
function stoneKit(): THREE.BufferGeometry[] {
  return [
    blockGeometry(3),
    blockGeometry(8),
    blockGeometry(21),
    blockGeometry(34),
    boulderGeometry(5).translate(0, 0.3, 0),
  ];
}

/**
 * Armour stone laid in rows down a slope round a capsule: from `inner`
 * (m from the axis, at height `top`) out to `outer` at the water, biggest
 * at the bottom. `keep` leaves stones out (a quay face).
 */
export function addArmour(
  shape: Shape,
  l: Capsule,
  inner: number,
  outer: number,
  top: number,
  seed: number,
  keep: (p: EdgePoint) => boolean = () => true,
): void {
  const r = random(seed);
  const kit = stoneKit();
  const rows = Math.max(2, Math.round((outer - inner) / 2.7));
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const radius = inner + 0.9 + (outer - inner - 1.9) * t;
    const size = 2.4 + t * 1.5;
    // (A stone stands about 0.8 of its size tall: its top comes under the deck's edge.)
    const y = top - 0.9 - (top + 0.4) * t;
    for (const p of capsuleEdge(l, radius, size * 0.8)) {
      if (!keep(p)) continue;
      const s = size * (0.85 + r() * 0.35);
      const geo = kit[Math.floor(r() * kit.length)]!;
      const m = turned(
        p.x + (r() - 0.5) * 0.9,
        y + (r() - 0.5) * 0.4 - s * 0.55,
        p.z + (r() - 0.5) * 0.9,
        (r() - 0.5) * 0.7,
        r() * Math.PI * 2,
        (r() - 0.5) * 0.7,
        s,
      );
      shape.add(geo, stonePaint(ARMOUR, ARMOUR[2]!, r), m, { flat: true });
    }
  }
  for (const g of kit) g.dispose();
}

/** A dark core under armour stone, so the gaps between stones show rock, not sea. */
function addCore(shape: Shape, l: Capsule, inner: number, outer: number, top: number): void {
  const rings: [number, number][] = [
    [outer + 0.3, -3.5],
    [outer - 1.2, -0.5],
    [inner + 0.4, top - 1.0],
  ];
  const edges = rings.map(([radius]) => capsuleEdge(l, radius, 6, 8));
  const n = edges[0]!.length;
  const v = (ring: number, i: number) => {
    const p = edges[ring]![i % n]!;
    return new THREE.Vector3(p.x, rings[ring]![1], p.z);
  };
  for (let i = 0; i < n; i++)
    for (let j = 0; j < rings.length - 1; j++) shape.quad(v(j, i), v(j, i + 1), v(j + 1, i + 1), v(j + 1, i), 0x6e675c);
}

/** A lamp post of the promenade: an iron post with a lantern. */
export function addLampPost(shape: Shape, x: number, y: number, z: number, yaw = 0): void {
  const m = place(x, y, z, yaw);
  shape.take(post(0.14, 0.1, 0.5, 6), IRON, m);
  shape.take(post(0.07, 0.05, 4.2, 5), IRON, place(x, y + 0.5, z, yaw));
  shape.take(box(0.42, 0.5, 0.42), 0xfff0c0, place(x, y + 4.7, z, yaw));
  shape.take(new THREE.ConeGeometry(0.4, 0.3, 4).rotateY(Math.PI / 4), IRON, place(x, y + 5.35, z, yaw));
}

/** A mooring bollard. */
export function addBollard(shape: Shape, x: number, y: number, z: number): void {
  shape.take(post(0.22, 0.16, 0.5, 6), IRON, place(x, y, z));
  shape.take(post(0.26, 0.26, 0.14, 6), IRON, place(x, y + 0.5, z));
}

/** A bench: slats on iron legs, facing `yaw`. */
export function addBench(shape: Shape, x: number, y: number, z: number, yaw: number): void {
  const wood = 0x8a6a46;
  shape.take(box(1.8, 0.08, 0.5), wood, place(x, y + 0.42, z, yaw));
  const back = turned(x - Math.sin(yaw) * 0.26, y + 0.5, z - Math.cos(yaw) * 0.26, -0.2, yaw, 0);
  shape.take(box(1.8, 0.5, 0.07), wood, back);
  for (const side of [-0.75, 0.75])
    shape.take(box(0.07, 0.42, 0.45), IRON, place(x + Math.cos(yaw) * side, y, z - Math.sin(yaw) * side, yaw));
}

/** A lamp's lantern: where it is and its light. */
export interface Lantern {
  mesh: THREE.Mesh;
  glow: Glow;
  /** Seconds between flashes, how long one lasts, and when in the cycle it comes. */
  period: number;
  flash: number;
  offset: number;
}

/**
 * The lighthouse: a white tower with red bands on a stone plinth, a
 * gallery with its rail, the lantern room and a red cupola. About 15 m
 * to the cupola from its foot at `(x, y, z)`; its door faces `yaw`.
 */
export function addLighthouse(shape: Shape, x: number, y: number, z: number, yaw: number): Lantern {
  const at = (dy: number) => place(x, y + dy, z, yaw);
  shape.take(post(3.3, 3.1, 1.2, 8), 0xc9bea8, at(0), { flat: true });
  // The tower, in bands.
  const foot = 1.75;
  const head = 1.2;
  const tall = 9.4;
  const bands: [number, number, number][] = [
    [0, 2.4, WHITE],
    [2.4, 4.2, RED],
    [4.2, 6.6, WHITE],
    [6.6, 8.0, RED],
    [8.0, tall, WHITE],
  ];
  const radius = (h: number) => foot + (head - foot) * (h / tall);
  for (const [from, to, colour] of bands)
    shape.take(
      new THREE.CylinderGeometry(radius(to), radius(from), to - from, 12, 1, true).translate(0, (from + to) / 2, 0),
      colour,
      at(1.2),
    );
  // The door and two windows up the stair.
  const face = (h: number, w: number, tallness: number, turn: number) => {
    const a = yaw + turn;
    const rad = radius(h) - 0.08;
    shape.take(box(w, tallness, 0.3), 0x3f4a5a, place(x + Math.sin(a) * rad, y + 1.2 + h, z + Math.cos(a) * rad, a));
  };
  face(0, 0.9, 1.9, 0);
  face(4.8, 0.5, 0.8, 0.5);
  face(7.2, 0.5, 0.8, -0.9);
  // The gallery on its corbel, and the rail.
  const deck = 1.2 + tall;
  shape.take(new THREE.CylinderGeometry(2.25, 1.2, 0.7, 12).translate(0, -0.35, 0), WHITE, at(deck));
  shape.take(post(2.35, 2.35, 0.16, 12), 0xd8d2c4, at(deck));
  shape.take(new THREE.TorusGeometry(2.25, 0.05, 4, 12).rotateX(Math.PI / 2), IRON, at(deck + 1.05));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    shape.take(box(0.07, 1.0, 0.07), IRON, place(x + Math.cos(a) * 2.25, y + deck + 0.1, z + Math.sin(a) * 2.25));
  }
  // The lantern room: glass between mullions, under the cupola.
  shape.take(post(1.25, 1.25, 0.5, 10), WHITE, at(deck + 0.16));
  shape.take(new THREE.CylinderGeometry(1.12, 1.12, 1.5, 10, 1, true).translate(0, 0.75, 0), GLASS, at(deck + 0.66), {
    flat: true,
  });
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    shape.take(box(0.09, 1.5, 0.09), IRON, place(x + Math.cos(a) * 1.14, y + deck + 0.66, z + Math.sin(a) * 1.14, -a));
  }
  shape.take(post(1.4, 1.4, 0.14, 10), RED, at(deck + 2.16));
  shape.take(
    new THREE.SphereGeometry(1.3, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1),
    RED,
    at(deck + 2.3),
  );
  shape.take(new THREE.SphereGeometry(0.2, 6, 4), IRON, at(deck + 3.4));
  shape.take(post(0.04, 0.02, 1.1, 4), IRON, at(deck + 3.5));
  const glow = new Glow(0xfff2b0, 0.3);
  const mesh = glow.mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 8).translate(0, 0.6, 0));
  mesh.position.set(x, y + deck + 0.8, z);
  return { mesh, glow, period: 5, flash: 1.1, offset: 0 };
}

/**
 * A harbour light: a small tower with a coloured band and cupola, its
 * lantern flashing. About 7 m tall, its foot at `(x, y, z)`.
 */
export function addHarbourLight(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  colour: "green" | "red",
  offset: number,
): Lantern {
  const tint = colour === "green" ? GREEN : RED;
  const at = (dy: number) => place(x, y + dy, z);
  shape.take(post(1.5, 1.4, 0.7, 8), 0xc9bea8, at(0), { flat: true });
  shape.take(new THREE.CylinderGeometry(0.82, 1.0, 2.2, 10, 1, true).translate(0, 1.1, 0), WHITE, at(0.7));
  shape.take(new THREE.CylinderGeometry(0.74, 0.82, 1.0, 10, 1, true).translate(0, 0.5, 0), tint, at(2.9));
  shape.take(new THREE.CylinderGeometry(0.68, 0.74, 0.8, 10, 1, true).translate(0, 0.4, 0), WHITE, at(3.9));
  shape.take(box(0.6, 1.3, 0.25), 0x3f4a5a, place(x, y + 0.7, z + 0.95));
  shape.take(post(1.25, 1.25, 0.12, 10), 0xd8d2c4, at(4.7));
  shape.take(new THREE.TorusGeometry(1.18, 0.04, 4, 10).rotateX(Math.PI / 2), IRON, at(5.5));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    shape.take(box(0.06, 0.75, 0.06), IRON, place(x + Math.cos(a) * 1.18, y + 4.8, z + Math.sin(a) * 1.18));
  }
  shape.take(post(0.5, 0.5, 0.25, 8), WHITE, at(4.82));
  shape.take(new THREE.ConeGeometry(0.62, 0.6, 8).translate(0, 0.3, 0), tint, at(5.97));
  shape.take(post(0.03, 0.02, 0.7, 4), IRON, at(6.5));
  const glow = new Glow(colour === "green" ? 0x9dffb4 : 0xffa08a, 0.4);
  const mesh = glow.mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.9, 8).translate(0, 0.45, 0));
  mesh.position.set(x, y + 5.07, z);
  return { mesh, glow, period: 3, flash: 0.9, offset };
}

/** Sets each lantern's light for time `t` (s): a flash, then dark. */
export function flashLanterns(lanterns: readonly Lantern[], t: number): void {
  for (const l of lanterns) {
    const phase = (((t + l.offset) % l.period) + l.period) % l.period;
    // Held on twos, like the rest of the motion.
    const on = phase < l.flash ? 1 : phase < l.flash + 0.25 ? 0.4 : 0;
    l.glow.level.value = on;
  }
}

/** What the bay's breakwater is made of. */
export interface Breakwater {
  group: THREE.Group;
  lanterns: Lantern[];
  /** The deck's height and half width (m). */
  top: number;
  half: number;
}

/**
 * The bay's breakwater: armour stone sloping up both sides to a paved
 * deck with a parapet on the seaward side, lamp posts, bollards and
 * benches, the lighthouse on its east head and a green light on the west.
 */
export function buildBreakwater(straightHalf: number, radius: number, lighthouseX: number): Breakwater {
  const group = new THREE.Group();
  const l: Capsule = { ax: -straightHalf, az: 0, bx: straightHalf, bz: 0 };
  const top = 2.6;
  const half = 4.4;
  const stone = new Shape();
  addCore(stone, l, half, radius, top);
  addArmour(stone, l, half, radius, top, 7);
  group.add(stone.mesh(rockMaterial()));

  const works = new Shape();
  const deck: LandData = { ...l, radius: half, kind: "mole" };
  works.take(prism(capsuleOutline(deck, 8), 0.4, top), paved, undefined, { flat: true });
  // The lighthouse's round platform on the east head.
  works.take(post(5.2, 5.0, top + 0.3, 12), paved, place(lighthouseX, 0, 0), { flat: true });
  // The parapet, on the side of the open sea (-z).
  const wallZ = -(half - 0.35);
  works.take(box(straightHalf * 2 - 4, 1.3, 0.6), WALL, place(0, top, wallZ));
  works.take(box(straightHalf * 2 - 3.6, 0.14, 0.8), 0xe0d8c6, place(0, top + 1.3, wallZ));
  for (let x = -straightHalf + 12; x < straightHalf - 8; x += 37.5) addLampPost(works, x, top, wallZ + 0.9);
  for (let x = -straightHalf + 4; x < straightHalf; x += 14) addBollard(works, x, top, half - 0.5);
  for (let x = -straightHalf + 30; x < straightHalf - 20; x += 55) addBench(works, x, top, wallZ + 1.1, 0);
  const lanterns = [
    addLighthouse(works, lighthouseX, top + 0.3, 0, 0),
    addHarbourLight(works, -straightHalf - 1.5, top, 0, "green", 1.2),
  ];
  group.add(works.mesh(propMaterial()));
  for (const lantern of lanterns) group.add(lantern.mesh);
  return { group, lanterns, top, half };
}

/** What the cape's mole is made of. */
export interface Mole {
  group: THREE.Group;
  lanterns: Lantern[];
}

/**
 * A harbour mole along the capsule `l`: a quay with a vertical face on
 * the harbour side, a parapet and armour stone on the sea side (`sea`:
 * 1 or -1, which side of a to b the open sea is), and a green light on
 * its head (b).
 */
export function buildMole(l: LandData, top: number, sea: 1 | -1): Mole {
  const group = new THREE.Group();
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  // Out to sea: the edge's normal on that side.
  const sx = -uz * sea;
  const sz = ux * sea;
  const yaw = Math.atan2(ux, uz) - Math.PI / 2;
  const stone = new Shape();
  addArmour(stone, l, 1.6, l.radius + 0.6, top + 0.6, 77, (p) => !p.end && p.nx * sx + p.nz * sz > 0.5);
  group.add(stone.mesh(rockMaterial()));

  const works = new Shape();
  works.take(prism(capsuleOutline(l, 6), -5, top), paved, undefined, { flat: true });
  const mx = (l.ax + l.bx) / 2;
  const mz = (l.az + l.bz) / 2;
  works.take(box(len + 2, 1.3, 0.7), WALL, place(mx + sx * 2.1, top, mz + sz * 2.1, yaw));
  works.take(box(len + 2.3, 0.14, 0.9), 0xe0d8c6, place(mx + sx * 2.1, top + 1.3, mz + sz * 2.1, yaw));
  for (let a = 4; a < len; a += 7)
    addBollard(works, l.ax + ux * a - sx * (l.radius - 0.7), top, l.az + uz * a - sz * (l.radius - 0.7));
  for (let a = 8; a < len - 4; a += 16) addLampPost(works, l.ax + ux * a + sx * 1.3, top, l.az + uz * a + sz * 1.3);
  const lanterns = [
    addHarbourLight(works, l.bx + ux * (l.radius - 2.2), top, l.bz + uz * (l.radius - 2.2), "green", 0),
  ];
  group.add(works.mesh(propMaterial()));
  for (const lantern of lanterns) group.add(lantern.mesh);
  return { group, lanterns };
}

/** A rock in the sea with a red beacon on it (a harbour mouth's other side). */
export function buildBeaconRock(l: LandData): Mole {
  const group = new THREE.Group();
  const stone = new Shape();
  const r = random(51);
  stone.take(cragGeometry(l.radius, 3.4, 51), stonePaint(LIMESTONE, LIMESTONE_TOP, r), place(l.ax, 0, l.az), {
    flat: true,
  });
  const kit = [boulderGeometry(9), boulderGeometry(12)];
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2;
    const s = 1.6 + r() * 1.4;
    stone.add(
      kit[i % 2]!,
      stonePaint(LIMESTONE, LIMESTONE_TOP, r),
      turned(l.ax + Math.cos(a) * l.radius * 0.8, 0.1, l.az + Math.sin(a) * l.radius * 0.8, r(), r() * 6, r(), s),
      { flat: true },
    );
  }
  for (const g of kit) g.dispose();
  group.add(stone.mesh(rockMaterial()));
  const works = new Shape();
  const lanterns = [addHarbourLight(works, l.ax, 2.2, l.az, "red", 1.5)];
  group.add(works.mesh(propMaterial()));
  for (const lantern of lanterns) group.add(lantern.mesh);
  return { group, lanterns };
}
