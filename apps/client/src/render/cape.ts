// The cape: a rocky headland in a bay of the Costa Nevada coast, joined to
// the mainland by a natural arch. The land is drawn from the sim's capsules
// (`courseJson`), so the shore you see is the shore you hit: limestone
// cliffs swept along the headland's and the mainland's shores (planes,
// fissures, ledges, a notch at the water; see coast/rock.ts) under a
// rolling top of dry grass, a sandy beach in the east cove, and the harbour
// town on the west. On it: the arch, the sea stacks, the harbour mole and
// its light, the beacon rock in the harbour mouth, moored boats, the old
// watchtower on the point, the beach bar, umbrellas and the lifeguard
// tower, stone pines on the clifftops, and the snowy sierra behind.
//
// Everything is out in the weather (cel/look.ts): the grass and the trees
// in the season's colours, snow on what faces up above the snow line.
import * as THREE from "three/webgpu";
import { Fn, attribute, clamp, float, max, mix, positionWorld, smoothstep, vec3 } from "three/tsl";
import { type Conditions, homeConditions } from "../game/conditions.ts";
import { Bay, type BayOptions, type WaterScenery } from "./bay.ts";
import { cut0 } from "./cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId } from "./cel/material.ts";
import { noise4 } from "./cel/noise.ts";
import { type CircuitLook, sunOver } from "./look.ts";
import { noise3 } from "./cel/terrain.ts";
import { type BeachSite, addBeach } from "./coast/beach.ts";
import { type Berth, Fleet, Roamer, ferry, yacht } from "./coast/boats.ts";
import { townMaterial } from "./coast/facades.ts";
import { Grounding, sunlight } from "./coast/grounding.ts";
import { type Lantern, buildBeaconRock, buildMole, flashLanterns } from "./coast/harbour.ts";
import { WATCHTOWER_STAFF, addWatchtower } from "./coast/landmarks.ts";
import { COSTA_NEVADA, Life } from "./coast/life.ts";
import { boatMaterial } from "./coast/materials.ts";
import { Crowd, Walkers, crowdOf } from "./coast/people.ts";
import {
  CLIFF,
  DRY_GRASS,
  GRASSY,
  LIMESTONE,
  LIMESTONE_TOP,
  SCRUB,
  type ShorePoint,
  addStack,
  boulderGeometry,
  rockMaterial,
  stonePaint,
  sweepCliff,
} from "./coast/rock.ts";
import { Shape, random, turned } from "./coast/shape.ts";
import { cutShore, traceShore } from "./coast/shoreline.ts";
import { buildTown } from "./coast/town.ts";
import { Planting } from "./coast/trees.ts";
import type { CourseData, LandData } from "./course.ts";
import { landDistance, rng } from "./land.ts";
import type { RiderView } from "./world.ts";
import { COAST_SIERRA, farMaterial, foothills, hash, seaHorizon, sierra } from "./scenery.ts";

/** The cape under the sky: the bay's sun, snow down to the beach in winter and only on the sierra otherwise. */
const CAPE_LOOK: CircuitLook = {
  south: [30, 15],
  swing: 1,
  fogNear: 140,
  fogFar: 700,
  snowLine: { summer: 290, fall: 175, winter: 2.5, spring: 200 },
};

const SAND = new THREE.Color(0xecdbaf);
const PROMENADE = new THREE.Color(0xd9cbb0);
const SEA_BED = new THREE.Color(0x8f7f6c);
/** The town's quay top (see land.ts) and the mole's. */
const QUAY_TOP = 2.2;
export const MOLE_TOP = 2.6;
/** Cliff tops: the headland rises toward its point; the mainland's cliffs; the rock the arch springs from. */
const HEADLAND_TOP = 22;
const POINT_TOP = 32;
const COAST_CLIFF = 18;
const ARCH_RIM = 29;
/** The arch's opening: where its underside springs from the legs, and its crown (m over the water). */
const ARCH_SPRING = 10;
const ARCH_CROWN = 22;
/** The top of the arch's span (m), for what it hides. */
export const ARCH_TOP = ARCH_RIM + 6;
/** A cliff's top is drawn by the cliff this far in from the shore (m); the ground's own mesh starts there. */
const CLIFF_TOP = 6;

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
  /** How far in from a cliffed shore (m; negative out at sea). */
  cliff: number;
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
  private arch: LandData[];
  private out: Ground = { h: 0, color: new THREE.Color(), lush: 0, kind: "sea", inland: 0, cliff: 0 };

  constructor(land: LandData[]) {
    this.arch = land.filter((l) => l.kind === "arch");
    // (The arch's legs are headland to the ground: rock up to where the span springs.)
    this.head = land.filter((l) => l.kind === "headland" || l.kind === "arch");
    this.coast = land.filter((l) => l.kind === "coast");
    this.beach = land.filter((l) => l.kind === "beach");
    this.town = land.filter((l) => l.kind === "town");
  }

  /** The ground's height at `(x, z)` (the sea bed under water). */
  height(x: number, z: number): number {
    return this.sample(x, z).h;
  }

  /** Distance to the nearest cliffed shore (negative inside the land). */
  cliffs(x: number, z: number): number {
    return Math.min(nearest(this.head, x, z), nearest(this.coast, x, z));
  }

  /** Distance to the town's quay and to the beach's sand (negative inside). */
  quay(x: number, z: number): number {
    return nearest(this.town, x, z);
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
    // The rock stands tall where the arch springs from it.
    const byArch = smooth(1 - Math.max(0, nearest(this.arch, x, z)) / 22);
    // Under water: the sea bed shelving away.
    let h = -2 - Math.min(4, Math.max(0, d) * 0.4);
    let kind: Ground["kind"] = "sea";
    let lush = 0;
    g.color.copy(SEA_BED);
    if (dHead < 0) {
      const inland = -dHead;
      // A cliff (its height wandering along the shore), then the top rising
      // in a rounded hump toward the point.
      const top = HEADLAND_TOP + (POINT_TOP - HEADLAND_TOP) * smooth((z + 20) / 130);
      const edge = Math.max(top * (0.45 + 0.25 * (n * 0.5 + 0.5)), ARCH_RIM * byArch);
      const cliff = Math.pow(smooth(inland / 4), 0.7);
      const crown = smooth((inland - 5) / 34);
      const hh = -2 + (edge + 2) * cliff + Math.max(0, top - edge) * crown + n2 * 1.4 * cliff * (1 - byArch);
      if (hh > h) {
        h = hh;
        kind = "headland";
        lush = 1;
        g.color.copy(DRY_GRASS);
      }
    }
    if (dCoast < 0) {
      const inland = -dCoast;
      const cliff = Math.pow(smooth(inland / 4), 0.7);
      const hills = Math.max(0, inland - 18) * 0.3 * (0.75 + 0.35 * n) + n2 * 1.5;
      const edge = Math.max(COAST_CLIFF * (0.6 + 0.4 * (n * 0.5 + 0.5)), ARCH_RIM * byArch);
      const hh = -2 + (edge + 2) * cliff + Math.min(hills, 170);
      if (hh > h) {
        h = hh;
        kind = "coast";
        lush = 1;
        g.color.copy(DRY_GRASS);
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
        g.color.copy(inland < 36 ? SAND : inland < 46 ? PROMENADE : DRY_GRASS);
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
    g.cliff = kind === "headland" || kind === "coast" ? -Math.min(dHead, dCoast) : -1e3;
    return g;
  }
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

const groundCels = new Map<boolean, CelMaterial>();

/**
 * The ground's material: each vertex's colour, the grass broken into
 * darker scrub and patches of bare earth, the sand wet and dark by the
 * water. Out in the weather as grass. `shade`: the same ground as the
 * shade lying on it (see coast/grounding.ts).
 */
function groundMaterial(shade = false): CelMaterial {
  const made = groundCels.get(shade);
  if (made) return made;
  const colour = Fn(() => {
    const c = attribute<"vec3">("color", "vec3");
    const p = positionWorld;
    const wide = noise4(p.xz.mul(0.027));
    const fine = noise4(p.xz.mul(0.12));
    const green = clamp(c.g.sub(max(c.r, c.b)).mul(9), 0, 1);
    const scrub = cut0(wide.x.mul(0.7).add(fine.y.mul(0.45)).sub(0.08));
    const bare = cut0(fine.z.mul(0.6).add(wide.w.mul(0.5)).sub(0.42));
    const grown = mix(c, c.mul(vec3(0.74, 0.88, 0.66)), scrub.mul(green));
    const ground = mix(grown, vec3(LIMESTONE_TOP.r, LIMESTONE_TOP.g, LIMESTONE_TOP.b), bare.mul(green).mul(0.85));
    const wet = smoothstep(0.75, 0.3, p.y.add(fine.x.mul(0.2)));
    return ground.mul(mix(vec3(1), vec3(0.74, 0.78, 0.8), wet));
  });
  const cel = new CelMaterial({
    colorNode: colour(),
    outdoor: GRASSY,
    shade: new THREE.Color(0.6, 0.62, 0.82),
    richness: 1.2,
    crease: shade ? 0 : 0.5,
    silhouette: shade ? 0 : 1,
    darkness: shade ? 0 : 0.7,
    cast: shade ? float(0) : undefined,
    id: inkId("ground"),
  });
  cel.name = shade ? "ground-shade" : "ground";
  groundCels.set(shade, cel);
  return cel;
}

/** The colour the ground's mesh carries at `(x, z)` (its shader works the rest out). */
function groundColour(ground: CoastGround, x: number, z: number, out: THREE.Color): THREE.Color {
  const g = ground.sample(x, z);
  out.copy(g.color);
  // Scrub darkens the grass in drifts.
  if (g.lush > 0.5 && noise3(x * 0.021, 1.5, z * 0.021, 4) > 0.25) out.lerp(SCRUB, 0.6);
  return out;
}

/** The ground near the course in detail, and far round the bay in coarse steps. */
const NEAR = { x0: -330, x1: 350, z0: -300, z1: 290, step: 2.5 };
const FAR = { x0: -1100, x1: 1100, z0: -1100, z1: 650, step: 16 };

/**
 * A height field mesh over a rectangle, sampled every `step`, leaving out
 * cells deep under water and those `skip` says another mesh draws.
 * `lower` sinks it (m) where another mesh lies over it; with `cliffs`,
 * the strip along a cliffed shore is left to the cliff's own mesh.
 */
function groundMesh(
  ground: CoastGround,
  r: { x0: number; x1: number; z0: number; z1: number; step: number },
  skip: (x: number, z: number) => boolean,
  lower: (x: number, z: number) => number,
  cliffs: boolean,
): THREE.BufferGeometry {
  const nx = Math.round((r.x1 - r.x0) / r.step) + 1;
  const nz = Math.round((r.z1 - r.z0) / r.step) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const edge = new Uint8Array(nx * nz);
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = r.x0 + i * r.step;
      const z = r.z0 + j * r.step;
      const g = ground.sample(x, z);
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = g.h - lower(x, z);
      pos[k * 3 + 2] = z;
      c.copy(g.color);
      // Scrub darkens the grass in drifts.
      if (g.lush > 0.5 && noise3(x * 0.021, 1.5, z * 0.021, 4) > 0.25) c.lerp(SCRUB, 0.6);
      c.toArray(col, k * 3);
      edge[k] = cliffs && g.cliff > -100 && g.cliff < CLIFF_TOP ? 1 : 0;
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
      const cc = a + nx;
      const d = cc + 1;
      if (edge[a]! + edge[b]! + edge[cc]! + edge[d]! > 0) continue;
      index.push(a, cc, b, b, cc, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** The longest plane a cliff can have at a shore point (m): short round a tight end, long on a straight shore. */
function planeAt(land: readonly LandData[], x: number, z: number): number {
  let best = 1e6;
  let radius = 60;
  for (const l of land) {
    const d = Math.abs(landDistance(l, x, z));
    if (d < best) {
      best = d;
      radius = l.radius;
    }
  }
  return Math.sqrt(8 * radius * 0.55);
}

/**
 * The cliffs: every cliffed shore near the course traced from the land
 * and swept into rock, with boulders fallen at their feet.
 */
function addCliffs(shape: Shape, ground: CoastGround, land: readonly LandData[]): void {
  const cliffed = land.filter((l) => l.kind === "headland" || l.kind === "coast" || l.kind === "arch");
  const chains = traceShore((x, z) => ground.cliffs(x, z), { ...NEAR, cell: 2 });
  const kit = [boulderGeometry(13), boulderGeometry(29), boulderGeometry(41)];
  const r = random(5);
  chains.forEach((chain, k) => {
    // The town stands in front of the cliffs behind it: none there.
    for (const run of cutShore(chain.points, chain.closed, (p) => ground.quay(p.x, p.z) > 4)) {
      const shore: ShorePoint[] = run.points.map((p) => {
        const top = ground.sample(p.x - p.nx * 5, p.z - p.nz * 5);
        return { x: p.x, z: p.z, nx: p.nx, nz: p.nz, height: top.h, inland: null, lush: top.lush };
      });
      const tight = Math.min(...run.points.filter((_, i) => i % 6 === 0).map((p) => planeAt(cliffed, p.x, p.z)));
      sweepCliff(shape, shore, run.closed, 100 + k * 13, {
        ...CLIFF,
        face: [Math.min(5, tight * 0.6), Math.min(11, tight)],
        out: [-0.6, 0.9],
        flange: CLIFF_TOP + 3,
        ground: (x, z) => ground.height(x, z) - 0.3,
        hollows: 0.24,
        inside: (x, z) => -ground.cliffs(x, z),
      });
      // Boulders at the foot, where the shore meets the water.
      for (let i = 0; i < run.points.length; i += 3) {
        const p = run.points[i]!;
        if (r() > 0.3 || ground.sample(p.x + p.nx * 3, p.z + p.nz * 3).kind !== "sea") continue;
        const count = 1 + Math.floor(r() * 2.5);
        for (let n = 0; n < count; n++) {
          const size = 1.3 + r() * 1.3;
          const out = -0.6 + r() * 0.8;
          const slide = (r() - 0.5) * 4;
          shape.add(
            kit[Math.floor(r() * kit.length)]!,
            stonePaint(LIMESTONE, LIMESTONE_TOP, r),
            turned(
              p.x + p.nx * out - p.nz * slide,
              0.1 + r() * 0.3,
              p.z + p.nz * out + p.nx * slide,
              r(),
              r() * 6,
              r(),
              size,
            ),
            { flat: true },
          );
        }
      }
    }
  });
  for (const g of kit) g.dispose();
}

/**
 * The arch's span: a bridge of rock from one leg to the other over the
 * passage, thinnest at its crown, drawn in planes from station to station
 * across it.
 */
function addArch(shape: Shape, legs: LandData[]): void {
  const sorted = legs.toSorted((p, q) => p.az - q.az);
  const a = sorted[0];
  const b = sorted[sorted.length - 1];
  if (!a || !b || a === b) return;
  const cx = (a.ax + a.bx + b.ax + b.bx) / 4;
  // The opening: between the legs' inner faces.
  const open0 = a.az + a.radius;
  const open1 = b.az - b.radius;
  const mid = (open0 + open1) / 2;
  const half = (open1 - open0) / 2;
  const reach = Math.max(Math.abs(a.bx - a.ax), Math.abs(b.bx - b.ax)) / 2 + a.radius;
  const r = random(31);
  const rings: THREE.Vector3[][] = [];
  const from = open0 - 7;
  const to = open1 + 7;
  const steps = 15;
  for (let i = 0; i <= steps; i++) {
    const z = from + ((to - from) * i) / steps;
    const t = Math.abs(z - mid) / half;
    // The vault: ribs of harder rock hang a little lower across it.
    const rib = i % 3 === 1 ? 0.9 : 0;
    const under =
      t < 1 ? ARCH_CROWN - (ARCH_CROWN - ARCH_SPRING) * Math.pow(t, 2.2) - rib * (1 - t) : ARCH_SPRING - (t - 1) * 16;
    const top = ARCH_RIM + 2.6 + 2.4 * Math.cos(Math.min(1.5, t) * 1.05) + (r() - 0.5) * 1.6;
    const wide = Math.min(reach - 0.6, reach * (0.7 + 0.22 * t * t));
    const left = wide * (0.92 + r() * 0.16);
    const right = wide * (0.92 + r() * 0.16);
    const lip = 0.4 + r() * 1.3;
    const belly = (r() - 0.5) * 1.1;
    const brow = 3.2 + r() * 1.6;
    // Round the span, seen from the south: the vault (higher along its middle), east flank, top, west flank.
    rings.push(
      [
        [-left * 0.55, under + belly],
        [(r() - 0.5) * left * 0.2, under + 1.1 + r() * 0.7],
        [right * 0.55, under - belly],
        [right, under + brow],
        [right + lip, top - 4.4 - r()],
        [right * 0.68, top],
        [-left * 0.68, top + (r() - 0.5)],
        [-left - lip, top - 4.4 - r()],
        [-left, under + brow],
      ].map(([x, y]) => new THREE.Vector3(cx + x!, y, z)),
    );
  }
  const c = new THREE.Color();
  const count = rings[0]!.length;
  for (let i = 0; i < steps; i++) {
    const p = rings[i]!;
    const q = rings[i + 1]!;
    for (let k = 0; k < count; k++) {
      const tone = LIMESTONE[Math.floor(r() * LIMESTONE.length)] ?? LIMESTONE[0]!;
      const k1 = (k + 1) % count;
      const paint = (_p: THREE.Vector3, n: THREE.Vector3) => c.copy(n.y > 0.72 ? DRY_GRASS : tone);
      shape.tri(p[k]!, p[k1]!, q[k]!, paint);
      shape.tri(q[k]!, p[k1]!, q[k1]!, paint);
    }
  }
}

/** Stone pines in groves on the clifftops and the hills, scrub and agaves along the cliffs' edges. */
function plants(ground: CoastGround, shades: GroundShade): THREE.Group {
  const g = new THREE.Group();
  const near = new Planting();
  const far = new Planting();
  const tryAt = (to: Planting, kind: "pine" | "pineFar", x: number, z: number, chance: number, seed: number) => {
    // In groves, with clearings between them.
    const grove = smooth((noise3(x * 0.012, 4.5, z * 0.012, 3) + 0.15) * 2.2);
    if (hash(seed) > chance * grove) return;
    const { lush, kind: land, inland, h: y } = ground.sample(x, z);
    if (lush < 0.9 || land === "town" || inland < 9 || y < 4) return;
    // Not on a steep face.
    const slope =
      Math.abs(ground.height(x + 2, z) - ground.height(x - 2, z)) +
      Math.abs(ground.height(x, z + 2) - ground.height(x, z - 2));
    if (slope > 3.2) return;
    const tall = 7 + hash(seed + 2) * 4.5;
    to.add(kind, x, y - 0.3, z, tall, 0.86 + hash(seed + 3) * 0.26);
    if (to === near) shades.on.add(x, y, z, tall * 0.42, tall * 0.8, shades.colour, shades.ground, 0.14);
  };
  let k = 0;
  for (let z = NEAR.z0; z < NEAR.z1; z += 10) {
    for (let x = NEAR.x0; x < NEAR.x1; x += 10) {
      k++;
      tryAt(near, "pine", x + (hash(k * 1.3) - 0.5) * 9, z + (hash(k * 2.7) - 0.5) * 9, 0.42, k * 3.1);
    }
  }
  for (let z = FAR.z0 + 300; z < 320; z += 22) {
    for (let x = -800; x < 800; x += 22) {
      k++;
      if (x > NEAR.x0 && x < NEAR.x1 && z > NEAR.z0 && z < NEAR.z1) continue;
      tryAt(far, "pineFar", x + (hash(k * 1.3) - 0.5) * 16, z + (hash(k * 2.7) - 0.5) * 16, 0.22, k * 3.1);
    }
  }
  // Low growth where the grass meets the rock.
  for (let z = NEAR.z0; z < NEAR.z1; z += 6) {
    for (let x = NEAR.x0; x < NEAR.x1; x += 6) {
      k++;
      if (hash(k * 0.77) > 0.3) continue;
      const px = x + (hash(k * 1.9) - 0.5) * 5;
      const pz = z + (hash(k * 3.3) - 0.5) * 5;
      const s = ground.sample(px, pz);
      if (s.lush < 0.9 || s.cliff < CLIFF_TOP + 1 || s.cliff > 30 || s.h < 3) continue;
      near.add(
        hash(k * 5.1) < 0.25 ? "agave" : "bush",
        px,
        s.h - 0.1,
        pz,
        1.1 + hash(k * 2.3) * 1.3,
        0.9 + hash(k) * 0.2,
      );
    }
  }
  g.add(near.build(), far.build());
  return g;
}

/** Shade laid on the cape's ground: where it goes, and the ground's colour and height at a place. */
interface GroundShade {
  on: Grounding;
  colour: (x: number, z: number) => THREE.Color;
  ground: (x: number, z: number) => number;
}

/** The centre line at `s`, `offset` m to its right. */
function along(course: CourseData, s: number, offset: number): { x: number; z: number; yaw: number } {
  const step = course.path.length > 1 ? course.path[1]!.s : 2;
  const p = course.path[Math.round(s / step) % course.path.length] ?? course.path[0]!;
  return { x: p.x - Math.cos(p.yaw) * offset, z: p.z + Math.sin(p.yaw) * offset, yaw: p.yaw };
}

/**
 * Where the television's camera boats lie: outside the limit, halfway
 * round the widest right-hander (the point) and round the bend off the
 * stacks.
 */
export function cameraBoats(course: CourseData): { name: string; x: number; z: number; yaw: number }[] {
  const out = course.outerLimit + 16;
  const spots: { name: string; x: number; z: number; yaw: number }[] = [];
  const boat = (name: string, s: number) => {
    const p = along(course, s, -out);
    if (course.land.some((l) => landDistance(l, p.x, p.z) < 6)) return;
    spots.push({ name, ...p });
  };
  const rights = course.path.filter((p) => p.curve > 1e-4);
  const widest = Math.min(...rights.map((p) => p.curve));
  const sweep = rights.filter((p) => Math.abs(p.curve - widest) < 1e-5);
  const middle = sweep[Math.floor(sweep.length / 2)];
  if (middle) boat("boat-point", middle.s);
  boat("boat-stacks", course.length * 0.73);
  return spots;
}

/** The cape's boats: moored in the harbour along the town's quay and in the lee of the mole, and the television's. */
function berths(course: CourseData, town: LandData | undefined, mole: LandData | undefined): Berth[] {
  const r = rng(23);
  const spots: Berth[] = [];
  const seed = () => Math.floor(r() * 1000);
  if (town && mole) {
    // Stern to the quay's face toward the harbour (+x), from the harbour's head to the mole.
    const face = town.ax + town.radius;
    for (let z = -112; z < mole.az - mole.radius - 6; z += 4.2 + r() * 3.4) {
      if (r() < 0.15) continue;
      const big = r() < 0.16;
      spots.push({
        x: face + (big ? 7.4 : 3.6) + r() * 0.5,
        z: z + (big ? 3 : 0),
        yaw: Math.PI / 2 + (r() - 0.5) * 0.12,
        kind: big ? "trawler" : r() < 0.2 ? "inflatable" : "llaut",
        seed: seed(),
      });
      if (big) z += 6;
    }
    // Alongside, inside the mole.
    for (let x = mole.ax + 6; x < mole.bx - 6; x += 8 + r() * 3)
      spots.push({
        x,
        z: mole.az - mole.radius - 1.9,
        yaw: Math.PI / 2 + (r() < 0.5 ? Math.PI : 0),
        kind: "llaut",
        seed: seed(),
      });
  }
  for (const b of cameraBoats(course))
    spots.push({ x: b.x - Math.cos(b.yaw) * 2.5, z: b.z + Math.sin(b.yaw) * 2.5, yaw: b.yaw, kind: "camera", seed: 1 });
  return spots;
}

/** The fish market on the harbour's quay: by the mole's root, where the boats come in. */
const FISH_MARKET_AT = { kind: "fish", along: 152 } as const;

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
  private fleet: Fleet;
  private roamers: Roamer[];
  private lanterns: Lantern[] = [];
  private crowd = new Crowd();

  constructor(course: CourseData, conditions: Conditions) {
    const season = conditions.season;
    const land = course.land;
    const ground = (this.ground = new CoastGround(land));
    const soil = groundMaterial();
    const inNear = (x: number, z: number, margin: number) =>
      x > NEAR.x0 + margin && x < NEAR.x1 - margin && z > NEAR.z0 + margin && z < NEAR.z1 - margin;
    const near = new THREE.Mesh(
      groundMesh(
        ground,
        NEAR,
        () => false,
        () => 0,
        true,
      ),
      soil,
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
        false,
      ),
      soil,
    );
    for (const m of [near, far]) {
      m.receiveShadow = true;
      m.userData.noMerge = true;
      this.group.add(m);
    }

    // The rock: cliffs, the arch over its legs, the stacks.
    const rock = new Shape();
    addCliffs(rock, ground, land);
    addArch(
      rock,
      land.filter((l) => l.kind === "arch"),
    );
    land
      .filter((l) => l.kind === "stack")
      .forEach((l, i) => addStack(rock, l.ax, l.az, l.radius, 14 + hash(300 + i * 17) * 13, 300 + i * 17));
    this.group.add(rock.mesh(rockMaterial()));
    for (const l of land.filter((k) => k.kind === "rock")) {
      const beacon = buildBeaconRock(l);
      this.lanterns.push(...beacon.lanterns);
      this.group.add(beacon.group);
    }

    // What people built, in the town's material: the watchtower and the beach's own; the town on its quay.
    const works = new Shape();
    const r = random(91);
    const crowd = crowdOf(conditions);
    const town = land.find((l) => l.kind === "town");
    const harbourMole = land.find((l) => l.kind === "mole");
    const life = new Life();
    const light = sunlight(sunOver(conditions, CAPE_LOOK));
    // Shade on the ground and the sand, in the ground's own colours, lying on its mesh.
    const tint = new THREE.Color();
    const step = NEAR.step;
    const node = (i: number, j: number) => ground.height(NEAR.x0 + i * step, NEAR.z0 + j * step);
    const shades: GroundShade = {
      on: new Grounding(light),
      colour: (x, z) => groundColour(ground, x, z, tint),
      ground: (x, z) => {
        const fx = (x - NEAR.x0) / step;
        const fz = (z - NEAR.z0) / step;
        const i = Math.floor(fx);
        const j = Math.floor(fz);
        const u = fx - i;
        const w = fz - j;
        // (As the mesh's two triangles lie in each cell.)
        if (u + w <= 1) {
          const a = node(i, j);
          return a + (node(i + 1, j) - a) * u + (node(i, j + 1) - a) * w;
        }
        const d = node(i + 1, j + 1);
        return d + (node(i, j + 1) - d) * (1 - u) + (node(i + 1, j) - d) * (1 - w);
      },
    };
    const walkers = new Walkers();
    if (town)
      this.group.add(buildTown(town, 1000, season, crowd, this.crowd, life, undefined, light, FISH_MARKET_AT).group);
    if (harbourMole) {
      // The open sea is to the south (+z) of the mole.
      const dx = harbourMole.bx - harbourMole.ax;
      const mole = buildMole(harbourMole, MOLE_TOP, dx >= 0 ? 1 : -1, crowd, this.crowd);
      this.lanterns.push(...mole.lanterns);
      this.group.add(mole.group);
    }
    this.fleet = new Fleet(berths(course, town, harbourMole));
    this.group.add(this.fleet.mesh);
    // Sails out past the point.
    const sails: [number, number][] = [
      [-700, 420],
      [-100, 560],
      [620, 470],
      [420, 700],
      [-380, 720],
    ];
    this.roamers = [0.08, 0.37, 0.7].map(
      (offset, i) => new Roamer(yacht(4 + i * 5, true), boatMaterial(), sails, 2.6, offset),
    );
    // The ferry, far out past the point.
    const liner = new Roamer(
      ferry(),
      farMaterial(),
      [
        [-2600, 1500],
        [0, 1800],
        [2600, 1500],
        [2900, 2300],
        [0, 2600],
        [-2900, 2300],
      ],
      6,
      0.55,
    );
    this.roamers.push(liner);
    // (Too far off to show in the water.)
    for (const boat of this.roamers) boat.mesh.layers.set(UNREFLECTED);
    for (const boat of this.roamers) this.group.add(boat.mesh);

    const tower = watchtowerSpot(ground, land);
    if (tower) {
      addWatchtower(works, tower.x, tower.y - 0.5, tower.z, 0.4);
      life.flag(tower.x, tower.y - 0.5 + WATCHTOWER_STAFF, tower.z, 3, 1.9, COSTA_NEVADA);
    }

    // The beach: the bar, the lifeguard's tower, umbrellas and people in season.
    const beach = land.find((l) => l.kind === "beach");
    if (beach) {
      const site: BeachSite = {
        at: (z, inland) => onBeach(ground, beach, z, inland),
        from: beach.az - 70,
        to: beach.bz + 50,
        // The sea is to the west (-x).
        seaward: -Math.PI / 2,
      };
      // The lifeguard's flag: red in a storm or a hard wind, yellow out of season, green on a summer's day.
      const rough = [conditions.weather, conditions.turns].some((w) => w === "storm" || w === "windy");
      const flag = rough ? 0xd6402e : season === "summer" ? 0x2fb34a : 0xf2c14e;
      addBeach(works, site, BAR, LIFEGUARD, season, crowd, this.crowd, life, flag, r, shades, walkers);
      const palms = new Planting({ shadows: true, reflected: true });
      for (let z = site.from + 30; z < site.to - 20; z += 15 + r() * 6) {
        const p = site.at(z, 41);
        const tall = 6 + r() * 2.5;
        palms.add("palm", p.x, p.y, p.z, tall, 0.9 + r() * 0.2);
        shades.on.add(p.x, p.y, p.z, 2.4, tall * 0.9, shades.colour, shades.ground, 0.1);
      }
      this.group.add(palms.build(true));
    }
    // (Up the beach and on the headland: too far from the water to throw shadows on it or show in it.)
    const built = works.mesh(townMaterial(), "receive");
    built.layers.set(UNREFLECTED);
    this.group.add(built);
    const arms = this.crowd.build();
    if (arms) this.group.add(arms);
    this.group.add(...life.build());

    this.group.add(plants(ground, shades));
    const shade = shades.on.build(groundMaterial(true));
    if (shade) this.group.add(shade);
    const strollers = walkers.build();
    if (strollers) this.group.add(strollers);
    // The distance: foothills and the sierra behind the coast (north, -z), headlands and islets out to sea.
    this.group.add(foothills(-1, 1000, 950, 3800, 300, 5), sierra(-1, COAST_SIERRA, 5400, 7), seaHorizon(-1, 9));
  }

  update(waves: Float32Array, t: number, riders: readonly RiderView[]): void {
    this.crowd.update(t, riders);
    this.fleet.update(waves, t);
    for (const boat of this.roamers) boat.update(waves, t);
    flashLanterns(this.lanterns, t);
  }
}

/** The cape: the water courses' environment (see bay.ts) with the cape's land round it. */
export class Cape extends Bay {
  /** The land's height (what hides a rider from a camera). */
  readonly land: CoastGround;

  constructor(opts: BayOptions) {
    const scenery = new CapeScenery(opts.course, opts.conditions ?? homeConditions("jetski"));
    super({ ...opts, scenery, look: CAPE_LOOK });
    this.land = scenery.ground;
  }
}
