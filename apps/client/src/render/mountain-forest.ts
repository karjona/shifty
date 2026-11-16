// The mountain's forest: firs, pines, young trees and snags along the run
// (the models of art/env/trees.py), cheaper trees of the same make behind
// them, all carrying the snow that lies at their height and moving in the
// wind; and the shade they throw across the run, worked out once for the
// race's sun.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  dot,
  float,
  frontFacing,
  mix,
  positionLocal,
  positionWorld,
  sin,
  uv,
  vec3,
  vertexStage,
} from "three/tsl";
import { LOOK, cut0 } from "./cel/look.ts";
import { CelMaterial, inkId } from "./cel/material.ts";
import type { Models } from "./env/models.ts";
import { fadingInk, gustAt, scenerySnow, shadeKept, snowLoad, windNow } from "./mountain-look.ts";
import type { RunData } from "./mountain.ts";
import type { RunScenery } from "./runs.ts";
import type { Steps } from "./slices.ts";

/** A kind of tree: its model, and its shape as the forest is planted and its shade is thrown. */
interface Kind {
  model: string;
  /** The same tree from far off (itself, if left out). */
  lod?: string;
  /** Height and the reach of its longest boughs (m). */
  height: number;
  reach: number;
  /** The crown starts this far up (0-1), and is widest there (firs) or keeps its width to the top (pines). */
  crownFrom: number;
  round: boolean;
  /** How close another trunk may stand (m). */
  spacing: number;
  /** How often it comes up. */
  weight: number;
}

const NEAR: Kind[] = [
  {
    model: "fir_tall",
    lod: "fir_tall_lod",
    height: 16,
    reach: 3.3,
    crownFrom: 0.18,
    round: false,
    spacing: 3.4,
    weight: 3,
  },
  {
    model: "fir_broad",
    lod: "fir_broad_lod",
    height: 12.5,
    reach: 3.7,
    crownFrom: 0.18,
    round: false,
    spacing: 3.6,
    weight: 3,
  },
  {
    model: "fir_old",
    lod: "fir_old_lod",
    height: 18,
    reach: 3.2,
    crownFrom: 0.23,
    round: false,
    spacing: 3.4,
    weight: 1.1,
  },
  {
    model: "pine_scots",
    lod: "pine_scots_lod",
    height: 13.5,
    reach: 3.6,
    crownFrom: 0.55,
    round: true,
    spacing: 3.6,
    weight: 0.4,
  },
  {
    model: "fir_young",
    lod: "fir_young_lod",
    height: 4.2,
    reach: 1.45,
    crownFrom: 0.08,
    round: false,
    spacing: 1.9,
    weight: 1.5,
  },
  {
    model: "fir_small",
    lod: "fir_small_lod",
    height: 2.6,
    reach: 0.95,
    crownFrom: 0.1,
    round: false,
    spacing: 1.4,
    weight: 1.1,
  },
  { model: "snag", height: 9.4, reach: 0.3, crownFrom: 1, round: false, spacing: 2, weight: 0.22 },
];
const FAR: Kind[] = [
  { model: "far_fir_a", height: 14, reach: 3, crownFrom: 0.14, round: false, spacing: 3.2, weight: 3 },
  { model: "far_fir_b", height: 11, reach: 3.4, crownFrom: 0.14, round: false, spacing: 3.4, weight: 2.4 },
  { model: "far_fir_c", height: 17, reach: 2.8, crownFrom: 0.14, round: false, spacing: 3.2, weight: 1 },
];
const KINDS = [...NEAR, ...FAR];
/** The trees that stand where the sim has a pine: firs with bare trunks a rider can read. */
const SOLID = [0, 2, 0, 1];
/** Mountain pines (`NEAR[PINE]`) grow only this far down the run (0-1 of its length), where the forest is lowest. */
const PINE = 3;
const PINES_FROM = 0.62;

/** Trees within this of the riding limit (m) are the detailed ones. */
const NEAR_RANGE = 30;
/** How far beyond the riding limit the run's own forest reaches (m). */
const FOREST_REACH = 86;
/** The near forest is batched by stretches of the run this long (path points), the far one in squares this wide (m). */
const CHUNK_POINTS = 28;
const FAR_CELL = 320;
/** A stretch of the near forest further than this from the camera (m) is drawn as its trees from far off. */
const DETAIL_FAR = 170;
/** Where trees bound the run, their trunks stand this far past the riding limit (m), with a gap in the row at this share of the run's points. */
const EDGE_TRUNK = 0.35;
const EDGE_GAPS = 0.25;
/** A tree's longest boughs end at least this far beyond the riding limit (m). */
const EDGE_ROOM = 1.2;
/** A tree's shade is thrown no further than this (m). */
const SHADE_REACH = 70;

export interface Tree {
  x: number;
  y: number;
  z: number;
  /** Which of `KINDS`. */
  kind: number;
  scale: number;
  /** How much taller than wide it has grown. */
  tall: number;
  turn: number;
  /** The batch it is drawn in. */
  chunk: string;
}

/** Where the forest may grow. */
export interface ForestSite {
  run: RunData;
  scenery: RunScenery;
  heights(points: Float32Array): Float32Array;
  /** The mountain around the run: the corner and size of its square (m). */
  around: { x0: number; z0: number; width: number; depth: number };
  /** Open ground the forest keeps out of (the lodge's yard, the lake, the finish). */
  open(x: number, z: number): boolean;
}

/** Deterministic noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Picks one of `kinds` by weight. */
function pick(kinds: Kind[], r: number): number {
  let total = 0;
  for (const k of kinds) total += k.weight;
  let at = r * total;
  for (let i = 0; i < kinds.length; i++) {
    at -= kinds[i]!.weight;
    if (at <= 0) return i;
  }
  return kinds.length - 1;
}

/** The closest point of the run's centre line (its points every few metres), and the riding limit on that side. */
function nearest(run: RunData, x: number, z: number): { dist: number; limit: number; index: number } {
  let best = Infinity;
  let index = 0;
  for (let i = 0; i < run.path.length; i++) {
    const p = run.path[i]!;
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) {
      best = d;
      index = i;
    }
  }
  const p = run.path[index]!;
  const right = (x - p.x) * -Math.cos(p.yaw) + (z - p.z) * Math.sin(p.yaw) > 0;
  return { dist: Math.sqrt(best), limit: right ? p.limitR : p.limitL, index };
}

/**
 * Plants the forest: crowding the run's edges (as thick as the run's
 * scenery says), in clumps over the mountain around, and a tree wherever
 * the sim has one. Trees keep their distance from each other, out of the
 * riding width and off open ground, and thin out toward the tree line.
 */
export function plantForest(site: ForestSite): Tree[] {
  const { run, scenery } = site;
  const rand = rng(1234);
  interface Spot {
    x: number;
    z: number;
    kind: number;
    scale: number;
    solid: boolean;
  }
  const spots: Spot[] = [];
  // The sim's own pines first: they keep their place.
  let solid = 0;
  for (const o of run.obstacles) {
    if (o.kind !== "pine") continue;
    spots.push({ x: o.x, z: o.z, kind: SOLID[solid++ % SOLID.length]!, scale: 0.92, solid: true });
  }
  for (const p of run.path) {
    const section = scenery.forest(p.s);
    const rx = -Math.cos(p.yaw);
    const rz = Math.sin(p.yaw);
    // Where trees bound the run, a row of trunks stands right at the edge
    // riders are stopped at.
    for (const side of [-1, 1]) {
      if ((side > 0 ? p.edgeR : p.edgeL) !== "trees" || rand() < EDGE_GAPS) continue;
      const out = (side > 0 ? p.limitR : p.limitL) + EDGE_TRUNK + rand() * 0.6;
      const along = (rand() - 0.5) * 2;
      spots.push({
        x: p.x + rx * side * out + Math.sin(p.yaw) * along,
        z: p.z + rz * side * out + Math.cos(p.yaw) * along,
        kind: SOLID[solid++ % SOLID.length]!,
        scale: 0.8 + rand() * 0.25,
        solid: true,
      });
    }
    for (const side of [-1, 1]) {
      const tries = Math.round(2.2 * section + rand());
      for (let k = 0; k < tries; k++) {
        const out = 2.2 + rand() * rand() * (FOREST_REACH - p.limit);
        const along = (rand() - 0.5) * 4;
        const far = out > NEAR_RANGE;
        let kind = far ? NEAR.length + pick(FAR, rand()) : pick(NEAR, rand());
        // Up high it is all firs.
        if (kind === PINE && (p.s < run.length * PINES_FROM || out < 7)) kind = 1;
        spots.push({
          x: p.x + rx * side * (p.limit + out) + Math.sin(p.yaw) * along,
          z: p.z + rz * side * (p.limit + out) + Math.cos(p.yaw) * along,
          kind,
          scale: 0.78 + rand() * 0.5,
          solid: false,
        });
      }
    }
  }
  // The mountain around: clumps.
  const { x0, z0, width, depth } = site.around;
  for (let k = 0; k < 3000; k++) {
    const x = x0 + rand() * width;
    const z = z0 + rand() * depth;
    const kind = NEAR.length + pick(FAR, rand());
    const scale = 0.8 + rand() * 0.55;
    const clump = Math.sin(x * 0.013) * Math.cos(z * 0.011) + Math.sin(x * 0.031 + z * 0.017) * 0.5;
    if (clump >= 0.2) spots.push({ x, z, kind, scale, solid: false });
  }
  // Each keeps its distance from the ones already standing.
  const CELL = 4;
  const taken = new Map<string, Spot[]>();
  const kept: (Spot & { index: number; out: number })[] = [];
  for (const s of spots) {
    const near = nearest(run, s.x, s.z);
    const out = near.dist - near.limit;
    // Its boughs stay off the riding width.
    const clear = EDGE_ROOM + (s.kind < NEAR.length ? KINDS[s.kind]!.reach * s.scale : 2);
    if (!s.solid && (out < clear || site.open(s.x, s.z))) continue;
    const gx = Math.floor(s.x / CELL);
    const gz = Math.floor(s.z / CELL);
    const room = KINDS[s.kind]!.spacing * s.scale;
    let crowded = false;
    for (let i = gx - 1; i <= gx + 1 && !crowded; i++) {
      for (let j = gz - 1; j <= gz + 1 && !crowded; j++) {
        for (const o of taken.get(`${i},${j}`) ?? []) {
          const need = (room + KINDS[o.kind]!.spacing * o.scale) / 2;
          if ((o.x - s.x) ** 2 + (o.z - s.z) ** 2 < need * need) {
            crowded = true;
            break;
          }
        }
      }
    }
    if (crowded && !s.solid) continue;
    const key = `${gx},${gz}`;
    let cell = taken.get(key);
    if (!cell) taken.set(key, (cell = []));
    cell.push(s);
    kept.push({ ...s, index: near.index, out });
  }
  const points = new Float32Array(kept.length * 2);
  kept.forEach((s, i) => points.set([s.x, s.z], i * 2));
  const ys = site.heights(points);
  const trees: Tree[] = [];
  kept.forEach((s, i) => {
    const y = ys[i]!;
    // Nothing grows above the tree line, and what grows just below it is stunted.
    const below = scenery.treeLine - y;
    if (below < 0) return;
    const stunt = Math.min(1, 0.55 + below / 70);
    const far = s.kind >= NEAR.length;
    trees.push({
      x: s.x,
      y: y - 0.25,
      z: s.z,
      kind: s.kind,
      scale: s.scale * stunt,
      tall: 0.92 + rand() * 0.3,
      turn: rand() * Math.PI * 2,
      chunk: far
        ? `far ${Math.floor(s.x / FAR_CELL)},${Math.floor(s.z / FAR_CELL)}`
        : `near ${Math.floor(s.index / CHUNK_POINTS)}`,
    });
  });
  return trees;
}

/** How green a colour is (0-1). */
const greenness = (c: THREE.Node<"vec3">) => c.g.sub(c.r.max(c.b)).mul(9).clamp(0, 1);

let shared: CelMaterial | null = null;

/**
 * The trees' material (one for every kind). A vertex's colour is its
 * needles' or bark's; its masks (`uv`) say how far along a bough it is and
 * how readily snow lies there.
 */
function treeMaterial(): CelMaterial {
  if (shared) return shared;
  const masks = uv();
  const colour = Fn(() => {
    const root = attribute<"vec4">("color", "vec4").rgb;
    const base = root.mul(root);
    // The season's needles (a little darker in the cold), worked out per vertex.
    const light = dot(base, vec3(0.3, 0.59, 0.11))
      .div(0.15)
      .clamp(0.4, 2.2);
    const needles = vertexStage(mix(base, LOOK.evergreen.mul(light), LOOK.greens.z.mul(greenness(base)).mul(0.6)));
    const load = vertexStage(snowLoad(positionWorld));
    const snowy = cut0(masks.y.mul(load).sub(0.5));
    const top = mix(needles, scenerySnow(), snowy);
    // Under the boughs: the dark of the crown.
    const under = needles.mul(vec3(0.42, 0.5, 0.56));
    return frontFacing.select(top, under);
  })();
  const m = new CelMaterial({
    colorNode: colour,
    side: THREE.DoubleSide,
    // The underside of a bough never takes the sun.
    bias: frontFacing.select(float(0), float(-3)),
    shade: new THREE.Color(0.56, 0.6, 0.86),
    richness: 1.2,
    rim: 0.35,
    silhouette: 0.7,
    crease: 0,
    darkness: 0.75,
    id: inkId("forest"),
  });
  fadingInk(m, 0.7, 0, inkId("forest"), 0.75);
  m.shadeNode = vec3(0.56, 0.6, 0.86).mul(shadeKept());
  // The wind: the whole tree leans with the gusts, and its boughs bob.
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const { speed, dir } = windNow();
    const gust = gustAt(p.xz);
    const h = attribute<"vec4">("color", "vec4").a.mul(HEIGHT_UNIT);
    const lean = h.mul(0.06).pow(2).mul(speed.mul(0.028).add(0.02)).mul(gust.mul(0.8).add(0.2));
    const along = masks.x;
    const beat = sin(LOOK.time.mul(2.6).add(p.x.mul(1.7)).add(p.z.mul(1.3)).add(h.mul(0.9)));
    const bob = along
      .mul(along)
      .mul(speed.mul(0.011).add(0.012))
      .mul(beat.add(gust.mul(1.4)));
    return p.add(vec3(dir.x.mul(lean), bob.negate(), dir.y.mul(lean)));
  })();
  shared = m;
  return m;
}

/** A vertex's height up its tree rides in its colour's alpha, in these units (m). */
const HEIGHT_UNIT = 24;

/** The trees of one batch as one mesh, each a copy of its kind's model (or of its far-off one). */
function merged(trees: Tree[], models: Models, far: boolean): THREE.BufferGeometry | null {
  let vertices = 0;
  let indices = 0;
  const parts: { tree: Tree; g: THREE.BufferGeometry }[] = [];
  for (const tree of trees) {
    const kind = KINDS[tree.kind]!;
    const g = models.get(far ? (kind.lod ?? kind.model) : kind.model);
    if (!g?.index) continue;
    parts.push({ tree, g });
    vertices += g.attributes.position!.count;
    indices += g.index.count;
  }
  if (vertices === 0) return null;
  const pos = new Float32Array(vertices * 3);
  const nor = new Float32Array(vertices * 3);
  const col = new Uint8Array(vertices * 4);
  const masks = new Float32Array(vertices * 2);
  const index = new Uint32Array(indices);
  let v = 0;
  let k = 0;
  for (const { tree, g } of parts) {
    const p = g.attributes.position!;
    const n = g.attributes.normal!;
    const c = g.attributes.color!;
    const m = g.attributes.uv!;
    const cs = Math.cos(tree.turn);
    const sn = Math.sin(tree.turn);
    const s = tree.scale;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const o = (v + i) * 3;
      pos[o] = tree.x + (x * cs + z * sn) * s;
      pos[o + 1] = tree.y + y * s * tree.tall;
      pos[o + 2] = tree.z + (z * cs - x * sn) * s;
      nor[o] = n.getX(i) * cs + n.getZ(i) * sn;
      nor[o + 1] = n.getY(i);
      nor[o + 2] = n.getZ(i) * cs - n.getX(i) * sn;
      const q = (v + i) * 4;
      // (Square roots: the shader squares them, so dark greens keep their steps.)
      col[q] = Math.round(Math.sqrt(c.getX(i)) * 255);
      col[q + 1] = Math.round(Math.sqrt(c.getY(i)) * 255);
      col[q + 2] = Math.round(Math.sqrt(c.getZ(i)) * 255);
      col[q + 3] = Math.round(Math.min(1, Math.max(0, (y * s * tree.tall) / HEIGHT_UNIT)) * 255);
      masks[(v + i) * 2] = m.getX(i);
      masks[(v + i) * 2 + 1] = m.getY(i);
    }
    const src = g.index!;
    for (let i = 0; i < src.count; i++) index[k + i] = v + src.getX(i);
    v += p.count;
    k += src.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 4, true));
  out.setAttribute("uv", new THREE.BufferAttribute(masks, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/** The forest as it is drawn: a mesh per stretch of the run (in detail close by, simpler from far off) and per square of the mountain. */
/** A sight line is checked against the trees of the cells it crosses (m), and passes this far clear of a tree (m). */
const SIGHT_CELL = 12;
const SIGHT_CLEAR = 0.7;
/** A picture is kept clear of trees this far of the way to what it shows (0-1): a tree by the lens fills it, one by the rider is scenery. */
const SIGHT_NEAR = 0.4;
/** A picture is this many times wider than tall. */
const SIGHT_ASPECT = 16 / 9;
/** A bare trunk's radius (m), below its crown. */
const TRUNK = 0.4;

/**
 * Which lines of sight the forest leaves open. A tree stands in the way as
 * its trunk up to its crown, and its crown as a cone narrowing to its top
 * (a round crown keeps its width).
 */
export class ForestSight {
  private cells = new Map<number, Tree[]>();

  constructor(trees: Tree[]) {
    for (const t of trees) {
      const r = KINDS[t.kind]!.reach * t.scale + SIGHT_CLEAR + SIGHT_CELL;
      const i0 = Math.floor((t.x - r) / SIGHT_CELL);
      const i1 = Math.floor((t.x + r) / SIGHT_CELL);
      const j0 = Math.floor((t.z - r) / SIGHT_CELL);
      const j1 = Math.floor((t.z + r) / SIGHT_CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          let cell = this.cells.get(shadeCell(i, j));
          if (!cell) this.cells.set(shadeCell(i, j), (cell = []));
          cell.push(t);
        }
      }
    }
  }

  /**
   * Whether no tree stands between `eye` and `at` (not counting the last
   * `skip` m before `at`). With `frame`, the height (m) of a picture taken
   * from `eye` of what is at `at`, no tree stands in the picture either
   * over the near part of the way.
   */
  clear(eye: THREE.Vector3, at: THREE.Vector3, frame = 0, skip = 1.5): boolean {
    const dx = at.x - eye.x;
    const dz = at.z - eye.z;
    const flat = Math.hypot(dx, dz);
    if (flat < 1e-3) return true;
    const reach = Math.max(0, 1 - skip / flat);
    const steps = Math.max(1, Math.ceil(flat / (SIGHT_CELL / 2)));
    let last = -1;
    for (let n = 0; n <= steps; n++) {
      const k = n / steps;
      const key = shadeCell(Math.floor((eye.x + dx * k) / SIGHT_CELL), Math.floor((eye.z + dz * k) / SIGHT_CELL));
      if (key === last) continue;
      last = key;
      const cell = this.cells.get(key);
      if (!cell) continue;
      for (const t of cell) {
        // Where the line passes nearest the trunk, seen from above.
        const along = Math.max(0, Math.min(reach, ((t.x - eye.x) * dx + (t.z - eye.z) * dz) / (flat * flat)));
        const off = Math.hypot(eye.x + dx * along - t.x, eye.z + dz * along - t.z);
        const kind = KINDS[t.kind]!;
        const width = kind.reach * t.scale;
        // Half the picture's height there, and the room the line needs.
        const half = along < SIGHT_NEAR ? (frame / 2) * along : 0;
        const room = SIGHT_CLEAR + half * SIGHT_ASPECT;
        if (off > width + room) continue;
        const tall = kind.height * t.scale * t.tall;
        const up = eye.y + (at.y - eye.y) * along - t.y;
        if (up - half > tall) continue;
        const crown = kind.crownFrom * tall;
        const lowest = Math.max(crown, up - half);
        const crownWidth = kind.round ? width : width * (1 - (lowest - crown) / Math.max(1e-3, tall - crown));
        if (off < (up + half < crown ? TRUNK : crownWidth) + room) return false;
      }
    }
    return true;
  }
}

export class Forest {
  readonly group = new THREE.Group();
  private batches: { centre: THREE.Vector3; radius: number; detail: THREE.Mesh | null; far: THREE.Mesh }[] = [];

  private trees: Tree[];

  /** It is built by `build` (see slices.ts). */
  constructor(trees: Tree[]) {
    this.trees = trees;
    this.group.userData.noMerge = true;
  }

  /** Builds its batches from the models, a batch at a time. */
  *build(models: Models): Steps {
    const chunks = new Map<string, Tree[]>();
    for (const t of this.trees) {
      let chunk = chunks.get(t.chunk);
      if (!chunk) chunks.set(t.chunk, (chunk = []));
      chunk.push(t);
    }
    const material = treeMaterial();
    for (const [name, chunk] of chunks) {
      const near = name.startsWith("near");
      const lod = merged(chunk, models, true);
      yield;
      if (!lod) continue;
      const far = new THREE.Mesh(lod, material);
      const fine = near ? merged(chunk, models, false) : null;
      const detail = fine ? new THREE.Mesh(fine, material) : null;
      if (detail) detail.castShadow = true;
      const sphere = (fine ?? lod).boundingSphere!;
      this.batches.push({ centre: sphere.center, radius: sphere.radius, detail, far });
      this.group.add(far);
      if (detail) this.group.add(detail);
      yield;
    }
  }

  /** Shows each batch as the camera at `eye` needs it: nothing past `reach` m, detail close by. */
  update(eye: THREE.Vector3, reach: number): void {
    for (const b of this.batches) {
      const d = b.centre.distanceTo(eye) - b.radius;
      const close = b.detail !== null && d < DETAIL_FAR;
      if (b.detail) b.detail.visible = close;
      b.far.visible = !close && d < reach;
    }
  }
}

/** Trees are looked up by the squares (this wide, m) their shade can reach. */
const SHADE_CELL = 24;
const shadeCell = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);

/** A tree's half width (m) at `t` of its height (0-1). */
function profile(k: Kind, t: number): number {
  if (t < k.crownFrom) return 0.3;
  const u = (t - k.crownFrom) / Math.max(1e-3, 1 - k.crownFrom);
  if (k.round) return k.reach * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)) * 0.9 + 0.2;
  return k.reach * (1 - u) ** 0.85 + 0.1;
}

/**
 * The shade the forest throws on the snow, for points `xyz` (`[x, y, z]`
 * each) under a sun standing toward `sun`: 0 in the open, 1 well inside a
 * tree's shadow, 0.5 on its edge (worked out a slice at a time, see slices.ts).
 */
export function* forestShade(trees: Tree[], sun: THREE.Vector3, xyz: Float32Array): Steps<Float32Array> {
  const n = xyz.length / 3;
  const shade = new Float32Array(n);
  const flat = Math.hypot(sun.x, sun.z);
  if (flat < 1e-6) return shade;
  // Away from the sun, along the ground; and how fast a shadow drops with distance.
  const sx = -sun.x / flat;
  const sz = -sun.z / flat;
  const drop = sun.y / flat;
  const CELL = SHADE_CELL;
  const cells = new Map<number, Tree[]>();
  const key = shadeCell;
  for (const t of trees) {
    const k = KINDS[t.kind]!;
    const reach = Math.min(SHADE_REACH, (k.height * t.scale * t.tall) / drop);
    const r = k.reach * t.scale + 1;
    const ax = t.x + sx * reach;
    const az = t.z + sz * reach;
    const i0 = Math.floor((Math.min(t.x, ax) - r) / CELL);
    const i1 = Math.floor((Math.max(t.x, ax) + r) / CELL);
    const j0 = Math.floor((Math.min(t.z, az) - r) / CELL);
    const j1 = Math.floor((Math.max(t.z, az) + r) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        let cell = cells.get(key(i, j));
        if (!cell) cells.set(key(i, j), (cell = []));
        cell.push(t);
      }
    }
  }
  yield;
  for (let v = 0; v < n; v++) {
    if (v % 4096 === 4095) yield;
    const x = xyz[v * 3]!;
    const y = xyz[v * 3 + 1]!;
    const z = xyz[v * 3 + 2]!;
    const cell = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!cell) continue;
    let most = 0;
    for (const t of cell) {
      const dx = x - t.x;
      const dz = z - t.z;
      const along = dx * sx + dz * sz;
      if (along < -4 || along > SHADE_REACH) continue;
      const k = KINDS[t.kind]!;
      const height = k.height * t.scale * t.tall;
      // The height on the tree whose shadow lands here.
      const h = along * drop + (y - t.y);
      if (h < 0 || h > height) continue;
      const across = Math.abs(dx * sz - dz * sx);
      const half = profile(k, h / height) * t.scale;
      // Thrown far, a shadow goes soft and thin.
      const thin = 1 - 0.35 * Math.max(0, along / SHADE_REACH);
      const inside = 0.5 + (half * thin - across) / 1.5;
      if (inside > most) most = inside;
    }
    shade[v] = Math.min(1, most);
  }
  return shade;
}
