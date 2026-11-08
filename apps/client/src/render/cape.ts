// The cape: a rocky headland in a bay of the Costa Nevada coast, joined to
// the mainland by a natural arch. The land is one terrain drawn from the
// sim's capsules (`courseJson`), so the shore you see is the shore you hit:
// cliffs round the headland and the mainland, a sandy beach in the east
// cove, and the harbour town on the west. On it: the arch, the sea stacks,
// the harbour mole and its light, the beacon rock in the harbour mouth,
// moored boats, the old watchtower on the point, the beach bar, umbrellas
// and the lifeguard tower, pines on the clifftops, and the snowy sierra
// behind.
//
// The look follows the race's season through uniforms (`COAST_LOOK`): the
// grass and the pines' colour, and snow settling on upward faces above the
// conditions' snow line (cel/look.ts). Rock, sand and grass share one material, so a season's change
// is a few numbers, never a new shader.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  color,
  float,
  fract,
  fwidth,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  uniform,
} from "three/tsl";
import type { Season } from "../game/conditions.ts";
import { Bay, type BayOptions, type WaterScenery } from "./bay.ts";
import { LOOK } from "./cel/look.ts";
import type { CircuitLook } from "./look.ts";
import type { BobbingBatch } from "./bobbing.ts";
import { noise3 } from "./cel/terrain.ts";
import { type CourseData, type LandData, type Mooring, mooredBoats } from "./course.ts";
import { Boxes, buildLand, capsuleOutline, landDistance, prism, rng, unitBox } from "./land.ts";
import { hash, peak } from "./scenery.ts";

/**
 * The coast's look by season, as shader values: the grass on the land and
 * the pines' needles, and where snow lies (on faces turned up, above the
 * snow line, as much as `snowCover`).
 */
export const COAST_LOOK = {
  grass: uniform(new THREE.Color(0xa6a457)),
  pines: uniform(new THREE.Color(0x3d6a35)),
  /** Height (m) above which snow settles (the conditions', see look.ts). */
  snowLine: LOOK.snowLine,
  /** 0 (none) to 1 (every upward face above the line). */
  snowCover: LOOK.snowCover,
};

/** Season looks: summer dry and golden, fall browning, winter green under the snow, spring fresh. */
const SEASON_LOOK: Record<Season, { grass: number; pines: number }> = {
  summer: { grass: 0xb0a65a, pines: 0x3d6a35 },
  fall: { grass: 0x9c8a4c, pines: 0x3a6034 },
  winter: { grass: 0x7d8a5a, pines: 0x2f5530 },
  spring: { grass: 0x7fae4a, pines: 0x40703a },
};

/** The cape under the sky: the bay's sun, snow down to the beach in winter and only on the sierra otherwise. */
const CAPE_LOOK: CircuitLook = {
  south: [30, 15],
  swing: 1,
  fogNear: 140,
  fogFar: 700,
  snowLine: { summer: 290, fall: 175, winter: 2.5, spring: 200 },
};

/** Sets the coast's look for a season. */
export function setCoastSeason(season: Season): void {
  const s = SEASON_LOOK[season];
  COAST_LOOK.grass.value.setHex(s.grass);
  COAST_LOOK.pines.value.setHex(s.pines);
}

const SNOW = 0xf4f7fb;
const ROCK = new THREE.Color(0xbba88c);
const DARK_ROCK = new THREE.Color(0x8f7f6c);
const SAND = new THREE.Color(0xecdbaf);
const PROMENADE = new THREE.Color(0xd9cbb0);
/** The town's quay top (see land.ts) and the mole's. */
const QUAY_TOP = 2.2;
export const MOLE_TOP = 2.6;
/** Cliff tops: the headland rises toward its point; the mainland's cliffs. */
const HEADLAND_TOP = 22;
const POINT_TOP = 32;
const COAST_CLIFF = 18;

/** Distance to the nearest of `caps` (negative inside). */
function nearest(caps: LandData[], x: number, z: number): number {
  let d = 1e6;
  for (const l of caps) d = Math.min(d, landDistance(l, x, z));
  return d;
}

/** One sample of the land: its height, its colour and how much grass it can hold. */
interface Ground {
  h: number;
  color: THREE.Color;
  lush: number;
  /** Which land it is (for what grows or stands on it). */
  kind: "sea" | "headland" | "coast" | "beach" | "town";
  /** How far inland (m). */
  inland: number;
}

/**
 * The land round the cape as a height field, from the course's capsules:
 * cliffs where the headland and the mainland meet the sea, a beach that
 * rises gently from the water, the town's quay flat. Pure: the broadcast
 * uses it to know what hides a rider.
 */
export class CoastGround {
  private head: LandData[];
  private coast: LandData[];
  private beach: LandData[];
  private town: LandData[];
  private out: Ground = { h: 0, color: new THREE.Color(), lush: 0, kind: "sea", inland: 0 };

  constructor(land: LandData[]) {
    this.head = land.filter((l) => l.kind === "headland");
    this.coast = land.filter((l) => l.kind === "coast");
    this.beach = land.filter((l) => l.kind === "beach");
    this.town = land.filter((l) => l.kind === "town");
  }

  /** The ground's height at `(x, z)` (the sea bed under water). */
  height(x: number, z: number): number {
    return this.sample(x, z).h;
  }

  /** The ground at `(x, z)` (the returned object is reused). */
  sample(x: number, z: number): Ground {
    const g = this.out;
    const n = noise3(x * 0.031, 0.5, z * 0.031, 7);
    const n2 = noise3(x * 0.11, 2.5, z * 0.11, 9);
    const dHead = nearest(this.head, x, z);
    const dCoast = nearest(this.coast, x, z);
    const dBeach = nearest(this.beach, x, z);
    const dTown = nearest(this.town, x, z);
    const d = Math.min(dHead, dCoast, dBeach, dTown);
    // Under water: the sea bed shelving away.
    let h = -2 - Math.min(4, Math.max(0, d) * 0.4);
    let kind: Ground["kind"] = "sea";
    let lush = 0;
    g.color.copy(DARK_ROCK);
    if (dHead < 0) {
      const inland = -dHead;
      // A cliff (its height wandering along the shore), then the top rising
      // in a rounded hump toward the point.
      const top = HEADLAND_TOP + (POINT_TOP - HEADLAND_TOP) * smooth((z + 20) / 130);
      const edge = top * (0.45 + 0.25 * (n * 0.5 + 0.5));
      const cliff = Math.pow(smooth(inland / 6), 0.7);
      const crown = smooth((inland - 4) / 34);
      const hh = -2 + (edge + 2) * cliff + (top - edge) * crown + n2 * 1.4 * cliff;
      if (hh > h) {
        h = hh;
        kind = "headland";
        lush = 1;
        g.color.copy(ROCK);
      }
    }
    if (dCoast < 0) {
      const inland = -dCoast;
      const cliff = Math.pow(smooth(inland / 7), 0.7);
      const hills = Math.max(0, inland - 18) * 0.3 * (0.75 + 0.35 * n) + n2 * 1.5;
      const hh = -2 + (COAST_CLIFF * (0.6 + 0.4 * (n * 0.5 + 0.5)) + 2) * cliff + Math.min(hills, 170);
      if (hh > h) {
        h = hh;
        kind = "coast";
        lush = 1;
        g.color.copy(ROCK);
      }
    }
    if (dBeach < 0) {
      const inland = -dBeach;
      // Sand up from the water, the promenade, then the hills behind.
      let hh = inland * 0.07;
      if (inland > 36) hh = 2.5 + Math.min(inland - 36, 2) * 0.35;
      if (inland > 46) hh = 3.2 + (inland - 46) * 0.22 * (0.8 + 0.3 * n);
      if (hh > h) {
        h = hh;
        kind = "beach";
        lush = smooth((inland - 46) / 6);
        g.color.copy(inland < 36 ? SAND : inland < 46 ? PROMENADE : ROCK);
      }
    }
    if (dTown < 10) {
      // The town's quay is drawn on its own: keep the ground under it.
      const k = smooth((10 - dTown) / 12);
      const capped = Math.min(h, QUAY_TOP - 0.3);
      h = h + (capped - h) * k;
      if (dTown < 0) {
        kind = "town";
        lush = 0;
      }
    }
    g.h = h;
    g.kind = kind;
    g.lush = lush;
    g.inland = -d;
    return g;
  }
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Paints a geometry for the coast's material: one colour, and how much grass it can hold. */
function paint(geo: THREE.BufferGeometry, rgb: THREE.Color, lush: number): THREE.BufferGeometry {
  const n = geo.attributes.position!.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.toArray(colors, i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("lush", new THREE.BufferAttribute(new Float32Array(n).fill(lush), 1));
  geo.deleteAttribute("uv");
  return geo;
}

/**
 * The coast's one material: the colour it is painted, grass where it is
 * level enough and can hold it, layers in the rock, and snow on faces
 * turned up above the snow line.
 */
function coastMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  m.userData.colorNode = Fn(() => {
    const base = attribute("color", "vec3");
    const lush = attribute("lush", "float");
    const up = normalWorld.y;
    const w = fwidth(up).max(1e-3);
    // Limestone in layers, darker every few metres on the faces.
    const band = fract(positionWorld.y.mul(0.32).add(positionWorld.x.mul(0.013)));
    const bw = fwidth(band).max(1e-3);
    const layered = mix(base, base.mul(0.84), smoothstep(bw, float(0), band.sub(0.12).abs()).mul(up.oneMinus()));
    const grassy = smoothstep(float(0.8).sub(w), float(0.8).add(w), up).mul(lush);
    const c = mix(layered, COAST_LOOK.grass, grassy);
    const above = smoothstep(COAST_LOOK.snowLine, COAST_LOOK.snowLine.add(4), positionWorld.y);
    const snowy = smoothstep(float(0.72).sub(w), float(0.72).add(w), up).mul(above).mul(COAST_LOOK.snowCover);
    return mix(c, color(SNOW), smoothstep(0.45, 0.55, snowy));
  })();
  return m;
}

/** The ground near the course in detail, and far round the bay in coarse steps. */
const NEAR = { x0: -330, x1: 350, z0: -300, z1: 290, step: 2.5 };
const FAR = { x0: -1100, x1: 1100, z0: -1100, z1: 650, step: 16 };

/**
 * A height field mesh over a rectangle, sampled every `step`, leaving out
 * cells deep under water and those `skip` says another mesh draws.
 * `lower` sinks it (m) where another mesh lies over it.
 */
function groundMesh(
  ground: CoastGround,
  r: { x0: number; x1: number; z0: number; z1: number; step: number },
  skip: (x: number, z: number) => boolean,
  lower: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const nx = Math.round((r.x1 - r.x0) / r.step) + 1;
  const nz = Math.round((r.z1 - r.z0) / r.step) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const lush = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = r.x0 + i * r.step;
      const z = r.z0 + j * r.step;
      const g = ground.sample(x, z);
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = g.h - lower(x, z);
      pos[k * 3 + 2] = z;
      g.color.toArray(col, k * 3);
      lush[k] = g.lush;
    }
  }
  const index: number[] = [];
  const y = (i: number, j: number) => pos[(j * nx + i) * 3 + 1]!;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (Math.max(y(i, j), y(i + 1, j), y(i, j + 1), y(i + 1, j + 1)) < -1.6) continue;
      if (skip(r.x0 + (i + 0.5) * r.step, r.z0 + (j + 0.5) * r.step)) continue;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("lush", new THREE.BufferAttribute(lush, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Nudges every vertex by smooth noise, so a shape reads as weathered rock. */
function weather(geo: THREE.BufferGeometry, amount: number, scale: number, seed: number): THREE.BufferGeometry {
  const p = geo.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    p.setXYZ(
      i,
      x + noise3(x * scale, y * scale, z * scale, seed) * amount,
      y + noise3(x * scale, y * scale, z * scale, seed + 1) * amount * 0.5,
      z + noise3(x * scale, y * scale, z * scale, seed + 2) * amount,
    );
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * The arch: a bridge of rock over the passage through the headland's
 * neck, standing on its two legs (the sim's arch capsules).
 */
function arch(legs: LandData[]): THREE.BufferGeometry | null {
  const sorted = legs.toSorted((p, q) => p.az - q.az);
  const a = sorted[0];
  const b = sorted[sorted.length - 1];
  if (!a || !b || a === b) return null;
  const cx = (a.ax + a.bx + b.ax + b.bx) / 4;
  // The opening: between the legs' inner faces, up to its crown.
  const open0 = a.az + a.radius;
  const open1 = b.az - b.radius;
  const outer0 = a.az - a.radius - 10;
  const outer1 = b.az + b.radius + 10;
  const crown = 16;
  const spring = 9;
  const top = 26;
  // In the shape's plane: u = -z (it is turned to stand along x), v = y.
  const shape = new THREE.Shape();
  shape.moveTo(-outer0, -6);
  shape.lineTo(-outer0, top - 6);
  shape.quadraticCurveTo(-outer0, top, -outer0 - 10, top);
  shape.lineTo(-outer1 + 10, top + 1);
  shape.quadraticCurveTo(-outer1, top, -outer1, top - 6);
  shape.lineTo(-outer1, -6);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-open0, -5);
  hole.lineTo(-open0, spring);
  hole.absellipse((-open0 - open1) / 2, spring, (open1 - open0) / 2, crown - spring, 0, Math.PI, false);
  hole.lineTo(-open1, -5);
  hole.closePath();
  shape.holes.push(hole);
  const depth = Math.max(Math.abs(a.bx - a.ax), Math.abs(b.bx - b.ax)) + a.radius * 2 + 2;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 14, steps: 6 });
  geo.rotateY(Math.PI / 2);
  geo.translate(cx - depth / 2, 0, 0);
  weather(geo, 1.6, 0.09, 31);
  return paint(geo, ROCK, 0.8);
}

/** A sea stack: a pillar of layered rock, narrowing a little to a scrubby top. */
function stack(l: LandData, seed: number): THREE.BufferGeometry {
  const h = 14 + hash(seed) * 13;
  const rows = 12;
  const geo = new THREE.CylinderGeometry(l.radius * 0.78, l.radius * 1.08, h + 6, 12, rows);
  geo.translate(0, h / 2 - 3, 0);
  const p = geo.attributes.position!;
  const lean = (hash(seed + 3) - 0.5) * 0.14;
  const ledge = 2.6 + hash(seed + 5) * 1.6;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    // Lumps, ledges where harder layers stand out, and a waist the sea has cut.
    const lumps = noise3(p.getX(i) * 0.35, y * 0.18, p.getZ(i) * 0.35, seed) * 0.26;
    const layer = (y / ledge) % 1 < 0.35 ? 0.07 : 0;
    const waist = -0.14 * Math.exp(-(((y - 1.5) / 2.5) ** 2));
    const k = 1 + lumps + layer + waist;
    p.setXYZ(
      i,
      p.getX(i) * k + y * lean,
      y + (y > h - 0.5 ? noise3(p.getX(i) * 0.6, 0, p.getZ(i) * 0.6, seed) * 1.6 : 0),
      p.getZ(i) * k,
    );
  }
  geo.translate(l.ax, 0, l.az);
  const flat = geo.toNonIndexed();
  geo.dispose();
  flat.computeVertexNormals();
  return paint(flat, ROCK, 0.9);
}

const std = (hex: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.85, ...opts });

/** A mesh of `geo` at `(x, y, z)`, casting and taking shadows. */
function put(geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, yaw = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The old watchtower (torre de guaita): a round sandstone tower with a crenellated top and its door high up. */
function watchtower(x: number, y: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  const stone = std(0xcdb48a);
  g.add(put(new THREE.CylinderGeometry(3.1, 3.7, 12, 14, 3), stone, 0, 5, 0));
  g.add(put(new THREE.CylinderGeometry(3.45, 3.3, 1.2, 14), stone, 0, 11.6, 0));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.add(put(new THREE.BoxGeometry(1.1, 1, 0.7), stone, Math.cos(a) * 3.1, 12.7, Math.sin(a) * 3.1, -a));
  }
  // The door, 6 m up, and the corbels of its long-gone gallery.
  g.add(put(new THREE.BoxGeometry(0.4, 1.9, 1.1), std(0x4a3a2c), 3.25, 6.6, 0));
  for (const dz of [-0.7, 0.7]) g.add(put(new THREE.BoxGeometry(0.8, 0.35, 0.3), stone, 3.5, 5.4, dz));
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  return g;
}

/** The mole: a paved breakwater with its stones on the sea side and a green light on its head. */
function mole(l: LandData, ground: CoastGround): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(prism(capsuleOutline(l, 12), -5, MOLE_TOP), [std(0xd9cbb0), std(0xb4a58c)]);
  body.receiveShadow = true;
  body.castShadow = true;
  g.add(body);
  // Armour stones along the side facing the open sea (away from the harbour's town).
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const r = rng(77);
  const stones = new Boxes();
  for (let a = -2; a < len + 4; a += 2.2) {
    for (const side of [1, -1]) {
      const reach = side === 1 ? l.radius + 0.8 : l.radius + 0.2;
      const s = side === 1 ? 2.2 + r() * 1.2 : 1.2 + r() * 0.6;
      // South (+z) is the sea side.
      const x = l.ax + ux * a - uz * reach * side;
      const z = l.az + uz * a + ux * reach * side;
      if (ground.height(x, z) > 0) continue;
      stones.add(
        x,
        -0.6 + r() * 0.8 * (side === 1 ? 1 : 0.3),
        z,
        s,
        s * 0.8,
        s,
        [0xa49c8e, 0x958d80, 0xb3ab9c][Math.floor(r() * 3)]!,
        r() * 3,
      );
    }
  }
  g.add(stones.build(new THREE.BoxGeometry(1, 1, 1), std(0xffffff, { flatShading: true })));
  // Bollards along the harbour side.
  const bollards = new Boxes();
  for (let a = 4; a < len; a += 7)
    bollards.add(
      l.ax + ux * a + uz * (l.radius - 0.6),
      MOLE_TOP,
      l.az + uz * a - ux * (l.radius - 0.6),
      0.35,
      0.6,
      0.35,
      0x3a3f46,
    );
  g.add(bollards.build(unitBox(), std(0xffffff)));
  // The harbour light on the head: green, as the course's marks on your left.
  const hx = l.bx + ux * (l.radius - 2);
  const hz = l.bz + uz * (l.radius - 2);
  g.add(put(new THREE.CylinderGeometry(0.9, 1.1, 5.5, 10), std(0xf4f1ea), hx, MOLE_TOP + 2.75, hz));
  g.add(put(new THREE.CylinderGeometry(0.95, 0.95, 1.2, 10), std(0x2f9a4a), hx, MOLE_TOP + 4.2, hz));
  g.add(
    put(
      new THREE.CylinderGeometry(0.55, 0.55, 0.9, 10),
      std(0xd8ffe0, { emissive: 0x6cff8a, emissiveIntensity: 0.6 }),
      hx,
      MOLE_TOP + 6,
      hz,
    ),
  );
  g.add(put(new THREE.ConeGeometry(0.8, 0.8, 10), std(0x2f9a4a), hx, MOLE_TOP + 6.85, hz));
  return g;
}

/** The beacon on the rock across the harbour mouth: red, as the course's marks on your right. */
function beacon(l: LandData, coast: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const rock = weather(new THREE.IcosahedronGeometry(l.radius * 1.05, 2), 0.9, 0.35, 5);
  rock.scale(1, 0.7, 1);
  g.add(put(paint(rock, ROCK, 0.3), coast, l.ax, 0.2, l.az));
  g.add(put(new THREE.CylinderGeometry(0.25, 0.3, 7, 8), std(0xd6402e), l.ax, 6, l.az));
  g.add(put(new THREE.CylinderGeometry(0.75, 0.75, 1.6, 10), std(0xd6402e), l.ax, 8.2, l.az));
  g.add(
    put(
      new THREE.CylinderGeometry(0.4, 0.4, 0.6, 8),
      std(0xffe0d8, { emissive: 0xff6a4a, emissiveIntensity: 0.6 }),
      l.ax,
      9.4,
      l.az,
    ),
  );
  return g;
}

/** The beach bar: a timber hut on a deck, a reed roof, its counter and stools; shut up out of season. */
function chiringuito(x: number, y: number, z: number, yaw: number, open: boolean): THREE.Group {
  const g = new THREE.Group();
  const wood = std(0xa77a4f);
  const pale = std(0xf2ead8);
  g.add(put(new THREE.BoxGeometry(13, 0.4, 9), std(0xb88a5c), 0, 0.2, 0));
  g.add(put(new THREE.BoxGeometry(7, 3, 4.5), pale, 0, 1.9, -1.6));
  // The front: a counter when open, shutters down when not.
  g.add(put(new THREE.BoxGeometry(7.2, 1.1, 0.8), wood, 0, 0.95, 1));
  if (!open) g.add(put(new THREE.BoxGeometry(6.8, 1.7, 0.15), std(0x4f86a8), 0, 2.4, 0.6));
  for (const px of [-3.4, 3.4]) g.add(put(new THREE.BoxGeometry(0.3, 3.2, 0.3), wood, px, 1.9, 1.3));
  const roof = new THREE.ConeGeometry(6.4, 2.2, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.scale(1.25, 1, 0.95);
  g.add(put(roof, std(0xcfae6d, { flatShading: true }), 0, 4.4, -0.6));
  // A painted board over the counter: the sea, a sun.
  g.add(put(new THREE.BoxGeometry(4.2, 0.9, 0.12), std(0x2a8fb0), 0, 3.6, 1.45));
  g.add(put(new THREE.CircleGeometry(0.32, 12), std(0xf2c14e), 1.3, 3.65, 1.52));
  if (open) {
    const stools = new Boxes();
    for (let i = -2; i <= 2; i++) stools.add(i * 1.4, 0.4, 2.1, 0.45, 0.8, 0.45, 0x7a5a3c);
    g.add(stools.build(unitBox(), std(0xffffff)));
    // Tables with parasols on the deck.
    for (const [tx, tz] of [
      [-5, 2.8],
      [5, 2.8],
    ] as const) {
      g.add(put(new THREE.CylinderGeometry(0.6, 0.6, 0.08, 10), pale, tx, 1.15, tz));
      g.add(put(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), wood, tx, 1.7, tz));
      g.add(put(new THREE.ConeGeometry(1.6, 0.6, 8), std(0xf6f2ea), tx, 3.1, tz));
    }
  }
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  return g;
}

/** The lifeguard tower: a white hut on stilts with a red band, a ramp, and its flag. */
function lifeguardTower(x: number, y: number, z: number, yaw: number, flag: number): THREE.Group {
  const g = new THREE.Group();
  const wood = std(0xe9e4d8);
  for (const [lx, lz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const)
    g.add(put(new THREE.BoxGeometry(0.22, 3.2, 0.22), wood, lx * 1.1, 1.6, lz * 1.1));
  g.add(put(new THREE.BoxGeometry(2.9, 0.2, 2.9), wood, 0, 3.2, 0));
  g.add(put(new THREE.BoxGeometry(2.4, 2, 2.4), wood, 0, 4.3, -0.1));
  g.add(put(new THREE.BoxGeometry(2.45, 0.4, 2.45), std(0xd6402e), 0, 4.6, -0.1));
  const roof = new THREE.ConeGeometry(2.1, 0.9, 4);
  roof.rotateY(Math.PI / 4);
  g.add(put(roof, std(0x8a9aa8), 0, 5.75, -0.1));
  const ramp = new THREE.BoxGeometry(1, 0.12, 5);
  ramp.rotateX(-0.62);
  g.add(put(ramp, wood, 0, 1.6, 3.4));
  g.add(put(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), wood, 1.3, 7, 1.3));
  g.add(put(new THREE.BoxGeometry(0.05, 0.8, 1.2), std(flag, { side: THREE.DoubleSide }), 1.3, 8.5, 0.7));
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  return g;
}

/** Sun umbrellas and loungers in rows down the beach, between `from` and `to` along it. */
function umbrellas(ground: CoastGround, beach: LandData, count: number): THREE.Group {
  const g = new THREE.Group();
  const r = rng(91);
  const poles = new Boxes();
  const canopies = new Boxes();
  const loungers = new Boxes();
  const colours = [0x2a8fb0, 0xf2c14e, 0xd94a3a, 0xf6f2ea, 0x3f8a4a, 0xf08a3c];
  let placedCount = 0;
  for (let i = 0; i < 400 && placedCount < count; i++) {
    const z = beach.az - 70 + r() * (beach.bz - beach.az + 120);
    // Along the shore, 10 to 30 m up the sand.
    const inlandWanted = 10 + r() * 20;
    let x = beach.ax - beach.radius;
    for (let k = 0; k < 40; k++) {
      const s = ground.sample(x, z);
      if (s.kind === "beach" && s.inland >= inlandWanted) break;
      x += 1.5;
    }
    const s = ground.sample(x, z);
    if (s.kind !== "beach" || s.inland > 34) continue;
    const c = colours[Math.floor(r() * colours.length)]!;
    poles.add(x, s.h, z, 0.08, 2.4, 0.08, 0xf2f0ea);
    canopies.add(x, s.h + 2.1, z, 2.6, 0.55, 2.6, c, r() * Math.PI);
    for (const side of [-1, 1]) loungers.add(x + 0.6, s.h, z + side * 1.1, 1.9, 0.35, 0.65, r() < 0.5 ? 0xf6f2ea : c);
    placedCount++;
  }
  const cone = new THREE.ConeGeometry(0.5, 1, 8, 1);
  cone.translate(0, 0.5, 0);
  g.add(
    poles.build(unitBox(), std(0xffffff)),
    canopies.build(cone, std(0xffffff, { side: THREE.DoubleSide })),
    loungers.build(unitBox(), std(0xffffff)),
  );
  return g;
}

/** Points every `step` m round a capsule's edge (world x, z as x, y). */
function perimeter(l: LandData, step: number): THREE.Vector2[] {
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len = Math.hypot(dx, dz);
  const ux = len > 1e-3 ? dx / len : 1;
  const uz = len > 1e-3 ? dz / len : 0;
  const out: THREE.Vector2[] = [];
  for (const side of [-1, 1])
    for (let a = 0; a <= len; a += step)
      out.push(new THREE.Vector2(l.ax + ux * a - uz * side * l.radius, l.az + uz * a + ux * side * l.radius));
  const arc = Math.max(1, Math.round((Math.PI * l.radius) / step));
  for (const [cx, cz, from] of [
    [l.bx, l.bz, Math.atan2(uz, ux) - Math.PI / 2],
    [l.ax, l.az, Math.atan2(uz, ux) + Math.PI / 2],
  ] as const)
    for (let i = 0; i <= arc; i++) {
      const a = from + (i / arc) * Math.PI;
      out.push(new THREE.Vector2(cx + Math.cos(a) * l.radius, cz + Math.sin(a) * l.radius));
    }
  return out;
}

/**
 * Boulders fallen from the cliffs, heaped along the water line round the
 * headland and the rocky mainland near the course (not on the beach or by
 * the town): one instanced batch in the coast's material.
 */
function shoreBoulders(ground: CoastGround, land: LandData[], coast: THREE.Material): THREE.InstancedMesh {
  const geo = paint(weather(new THREE.IcosahedronGeometry(1, 1), 0.25, 1.3, 13), DARK_ROCK, 0.25);
  const items: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  let k = 0;
  for (const l of land) {
    if (l.kind !== "headland" && l.kind !== "coast") continue;
    for (const p of perimeter(l, 2.6)) {
      k++;
      if (p.x < NEAR.x0 || p.x > NEAR.x1 || p.y < NEAR.z0 || p.y > NEAR.z1) continue;
      const g = ground.sample(p.x, p.y);
      if (g.kind !== "headland" && g.kind !== "coast") continue;
      if (Math.abs(g.inland) > 1.5 || hash(k * 1.7) < 0.25) continue;
      for (let n = 0; n < 2; n++) {
        const size = 1.2 + hash(k * 3.1 + n) * 2.6;
        const x = p.x + (hash(k * 5.3 + n) - 0.5) * 4;
        const z = p.y + (hash(k * 7.9 + n) - 0.5) * 4;
        q.setFromEuler(e.set(hash(k + n) * 3, hash(k * 2 + n) * 6, hash(k * 3 + n) * 3));
        items.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, -0.4 + size * 0.2, z),
            q,
            new THREE.Vector3(size, size * 0.7, size),
          ),
        );
      }
    }
  }
  const mesh = new THREE.InstancedMesh(geo, coast, items.length);
  items.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Pines on the clifftops and the hills, cypresses by the town: instanced, coloured by the season (`COAST_LOOK`). */
function pines(ground: CoastGround): THREE.Group {
  const g = new THREE.Group();
  const crown = new THREE.IcosahedronGeometry(1, 1);
  crown.scale(1, 0.42, 1);
  const needles = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  needles.userData.colorNode = Fn(() => {
    const up = normalWorld.y;
    const snowy = smoothstep(0.35, 0.6, up)
      .mul(COAST_LOOK.snowCover)
      .mul(smoothstep(COAST_LOOK.snowLine, COAST_LOOK.snowLine.add(4), positionWorld.y));
    return mix(COAST_LOOK.pines, color(SNOW), smoothstep(0.4, 0.5, snowy));
  })();
  const items: { x: number; y: number; z: number; s: number; h: number; tint: number }[] = [];
  const tryAt = (x: number, z: number, chance: number, seed: number) => {
    // In groves, with clearings between them.
    const grove = smooth((noise3(x * 0.012, 4.5, z * 0.012, 3) + 0.15) * 2.2);
    if (hash(seed) > chance * grove) return;
    const { lush, kind, inland, h: y } = ground.sample(x, z);
    if (lush < 0.9 || kind === "town" || inland < 6 || y < 4) return;
    // Not on a steep face.
    const slope =
      Math.abs(ground.height(x + 2, z) - ground.height(x - 2, z)) +
      Math.abs(ground.height(x, z + 2) - ground.height(x, z - 2));
    if (slope > 3.2) return;
    const size = 3.2 + hash(seed + 1) * 2.6;
    items.push({ x, y, z, s: size, h: 4 + hash(seed + 2) * 5, tint: 0.82 + hash(seed + 3) * 0.3 });
  };
  let k = 0;
  for (let z = NEAR.z0; z < NEAR.z1; z += 7) {
    for (let x = NEAR.x0; x < NEAR.x1; x += 7) {
      k++;
      tryAt(x + (hash(k * 1.3) - 0.5) * 6, z + (hash(k * 2.7) - 0.5) * 6, 0.5, k * 3.1);
    }
  }
  for (let z = FAR.z0 + 300; z < 320; z += 20) {
    for (let x = -800; x < 800; x += 20) {
      k++;
      if (x > NEAR.x0 && x < NEAR.x1 && z > NEAR.z0 && z < NEAR.z1) continue;
      tryAt(x + (hash(k * 1.3) - 0.5) * 16, z + (hash(k * 2.7) - 0.5) * 16, 0.2, k * 3.1);
    }
  }
  const crowns = new THREE.InstancedMesh(crown, needles, items.length);
  const trunks = new THREE.InstancedMesh(unitBox(), std(0x6b4a30), items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  items.forEach((it, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.tint * 10);
    m.compose(new THREE.Vector3(it.x, it.y + it.h, it.z), q, new THREE.Vector3(it.s, it.s, it.s * 0.9));
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, c.setScalar(it.tint));
    m.compose(new THREE.Vector3(it.x, it.y - 0.5, it.z), q, new THREE.Vector3(0.45, it.h + 0.4, 0.45));
    trunks.setMatrixAt(i, m);
  });
  for (const mesh of [crowns, trunks]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    g.add(mesh);
  }
  return g;
}

/** The sierra behind the coast: two ranges, snow-capped, the far one taller and hazier. */
function sierra(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 16; i++) {
    const far = i % 2 === 1;
    const h = (far ? 340 : 200) + hash(i + 140) * (far ? 180 : 110);
    const p = peak(h * (1.1 + hash(i + 17) * 0.5), h, i + 61, far ? 0.45 : 0.58, far ? 0.45 : 0.28);
    p.position.x = -2100 + i * 280 + hash(i + 41) * 140;
    p.position.z = -(far ? 2500 : 1700) - hash(i + 53) * 260;
    g.add(p);
  }
  return g;
}

/** Fishing boats moored in the harbour, along the town's quay and in the lee of the mole. */
function harbourMoorings(town: LandData, breakwater: LandData): Mooring[] {
  const r = rng(23);
  const spots: Mooring[] = [];
  // The quay's face toward the harbour (+x), from the harbour's head to the mole.
  const face = town.ax + town.radius + 3.2;
  for (let z = -112; z < breakwater.az - breakwater.radius - 6; z += 7 + r() * 4) {
    if (r() < 0.2) continue;
    spots.push({ x: face + r() * 0.8, z, yaw: -Math.PI / 2 + (r() - 0.5) * 0.15 });
  }
  // Inside the mole.
  for (let x = breakwater.ax + 6; x < breakwater.bx - 6; x += 8 + r() * 3)
    spots.push({ x, z: breakwater.az - breakwater.radius - 3, yaw: (r() - 0.5) * 0.15 });
  return spots;
}

/** Where the beach bar and the lifeguard tower stand: along the beach (z) and how far up the sand (m). */
const BAR = { z: -30, inland: 38 };
export const LIFEGUARD = { z: 25, inland: 16, top: 5.5 };

/** The point on the beach `inland` metres up the sand at `z`. */
export function onBeach(ground: CoastGround, beach: LandData, z: number, inland: number): THREE.Vector3 {
  let x = beach.ax - beach.radius;
  for (let k = 0; k < 80; k++) {
    const s = ground.sample(x, z);
    if (s.kind === "beach" && s.inland >= inland) break;
    x += 1;
  }
  return new THREE.Vector3(x, ground.height(x, z), z);
}

/** The watchtower's foot: the highest ground near the headland's southern end. Its top is 13 m up. */
export function watchtowerSpot(ground: CoastGround, land: LandData[]): THREE.Vector3 | null {
  const point = land.filter((l) => l.kind === "headland").toSorted((a, b) => b.bz - a.bz)[0];
  if (!point) return null;
  const best = new THREE.Vector3(point.bx, -1, point.bz);
  for (let dz = -20; dz <= 10; dz += 2)
    for (let dx = -12; dx <= 12; dx += 2) {
      const h = ground.height(point.bx + dx, point.bz + dz);
      if (h > best.y) best.set(point.bx + dx, h, point.bz + dz);
    }
  return best;
}

/** Everything round the cape's course that isn't the course itself. */
export class CapeScenery implements WaterScenery {
  readonly group = new THREE.Group();
  readonly gulls = new THREE.Vector3(-20, 0, 40);
  readonly inland = 2.5;
  readonly ground: CoastGround;
  private boats: BobbingBatch[] = [];

  constructor(course: CourseData, season: Season) {
    setCoastSeason(season);
    const land = course.land;
    const ground = (this.ground = new CoastGround(land));
    const coast = coastMaterial();
    const inNear = (x: number, z: number, margin: number) =>
      x > NEAR.x0 + margin && x < NEAR.x1 - margin && z > NEAR.z0 + margin && z < NEAR.z1 - margin;
    const near = new THREE.Mesh(
      groundMesh(
        ground,
        NEAR,
        () => false,
        () => 0,
      ),
      coast,
    );
    const far = new THREE.Mesh(
      groundMesh(
        ground,
        FAR,
        (x, z) => inNear(x, z, FAR.step),
        (x, z) => {
          const out = Math.max(NEAR.x0 - x, x - NEAR.x1, NEAR.z0 - z, z - NEAR.z1);
          return 1.2 * smooth(1 - out / 40);
        },
      ),
      coast,
    );
    for (const m of [near, far]) {
      m.receiveShadow = true;
      m.castShadow = true;
      m.userData.noMerge = true;
      this.group.add(m);
    }

    // Rock that stands on its own: the arch, the stacks, the beacon rock.
    const rocks: THREE.BufferGeometry[] = [];
    const span = arch(land.filter((l) => l.kind === "arch"));
    if (span) rocks.push(span);
    land.filter((l) => l.kind === "stack").forEach((l, i) => rocks.push(stack(l, 300 + i * 17)));
    for (const geo of rocks) {
      const m = new THREE.Mesh(geo, coast);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    for (const rock of land.filter((l) => l.kind === "rock")) this.group.add(beacon(rock, coast));

    // The harbour: the town on its quay (as the bay's), the mole, the boats.
    const town = land.find((l) => l.kind === "town");
    const harbourMole = land.find((l) => l.kind === "mole");
    if (town) this.group.add(buildLand([town]));
    if (harbourMole) this.group.add(mole(harbourMole, ground));
    if (town && harbourMole) {
      for (const b of mooredBoats(harbourMoorings(town, harbourMole), 29)) {
        this.boats.push(b);
        this.group.add(b.mesh);
      }
    }

    const tower = watchtowerSpot(ground, land);
    if (tower) this.group.add(watchtower(tower.x, tower.y - 0.5, tower.z, 0.4));

    // The beach: the bar, the lifeguard tower, umbrellas in season.
    const beach = land.find((l) => l.kind === "beach");
    if (beach) {
      const bar = onBeach(ground, beach, BAR.z, BAR.inland);
      // Facing the sea (west, -x).
      this.group.add(chiringuito(bar.x, bar.y, bar.z, -Math.PI / 2, season === "summer" || season === "spring"));
      const lifeguard = onBeach(ground, beach, LIFEGUARD.z, LIFEGUARD.inland);
      this.group.add(
        lifeguardTower(lifeguard.x, lifeguard.y, lifeguard.z, -Math.PI / 2, season === "summer" ? 0x2fb34a : 0xf2c14e),
      );
      const count = season === "summer" ? 70 : season === "winter" ? 0 : 18;
      if (count > 0) this.group.add(umbrellas(ground, beach, count));
    }

    this.group.add(pines(ground), shoreBoulders(ground, land, coast));
    const sierraGroup = sierra();
    sierraGroup.userData.noMerge = true;
    this.group.add(sierraGroup);
  }

  update(waves: Float32Array, t: number): void {
    for (const b of this.boats) b.update(waves, t);
  }
}

/** The cape: the water courses' environment (see bay.ts) with the cape's land round it. */
export class Cape extends Bay {
  /** The land's height (what hides a rider from a camera). */
  readonly land: CoastGround;

  constructor(opts: BayOptions) {
    const scenery = new CapeScenery(opts.course, opts.conditions?.season ?? "summer");
    super({ ...opts, scenery, look: CAPE_LOOK });
    this.land = scenery.ground;
  }
}
