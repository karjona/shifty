// The mountain's rock (the models of art/env/rocks.py): boulders where the
// sim has them, sharp rocks poking through a thin cover, crags on the walls
// and round the run, and the rock faces under rock lips. All of it, and the
// mountain's own steep faces, carries the same strata: beds dipping one way
// across the whole mountain, in flat tones with a line between them. Snow
// caps sit on the rocks where snow lies.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  max,
  mix,
  modelWorldMatrix,
  positionLocal,
  positionWorld,
  smoothstep,
  uv,
  vec3,
  vec4,
  vertexStage,
} from "three/tsl";
import { LOOK } from "./cel/look.ts";
import { CelMaterial, inkId } from "./cel/material.ts";
import { noise4 } from "./cel/noise.ts";
import type { Models } from "./env/models.ts";
import { fadingInk, scenerySnow, shadeKept, snowLoad, snowShade } from "./mountain-look.ts";
import { runAt, runPoint } from "./mountain-props.ts";
import type { RunData } from "./mountain.ts";
import type { RunScenery } from "./runs.ts";

/** Rock's shade tone (a multiple of its colour). */
export const ROCK_SHADE = [0.6, 0.58, 0.82] as const;
/** Beds are about this thick (m). */
const BED = 1.25;
/** A cap sinks this many times its height without snow (more than any rock is scaled by). */
const CAP_SINK = 2.4;

/**
 * The strata at world point `p`: `tone`, what a rock's colour is multiplied
 * by in this bed (some beds darker, some lighter and warmer), and `line`,
 * the dark line between two beds (0-1; thinner than a pixel, it fades).
 */
export function strata(p: THREE.Node<"vec3">): {
  tone: THREE.Node<"vec3">;
  line: THREE.Node<"float">;
  /** Which bed, and how far up it (0-1). */
  bed: THREE.Node<"float">;
  up: THREE.Node<"float">;
} {
  // The beds dip across the mountain, and wander a little.
  const level = p.y
    .add(p.x.mul(0.07))
    .sub(p.z.mul(0.04))
    .add(noise4(p.xz.mul(0.05)).x.mul(0.45))
    .div(BED);
  const bed = floor(level);
  const f = fract(level);
  const kind = hash(bed.add(17));
  // Most beds a shade apart; now and then a pale, warmer one.
  const grey = mix(float(0.84), float(1.1), hash(bed.mul(3.7).add(5)));
  const warm = smoothstep(0.78, 0.8, kind);
  const tone = mix(vec3(grey), vec3(1.2, 1.08, 0.86), warm);
  const px = max(fwidth(level), 1e-4);
  const half = float(0.035);
  const d = f.min(float(1).sub(f));
  const line = smoothstep(half.add(px), max(half.sub(px), 0), d).mul(clamp(half.mul(2).div(px), 0, 1));
  return { tone, line, bed, up: f };
}

/** A rock face's colour: `base` in its bed's tone, lined between the beds. */
export function bedded(base: THREE.Node<"vec3">, p: THREE.Node<"vec3">): THREE.Node<"vec3"> {
  const s = strata(p);
  const c = base.mul(s.tone);
  return mix(c, c.mul(vec3(0.5, 0.48, 0.55)), s.line.mul(0.8));
}

let shared: CelMaterial | null = null;

/**
 * The rocks' material. A vertex's colour is its face's tone; its masks
 * (`uv`) are a snow cap's height over its face (m) and whether it is a cap.
 */
export function rockMaterial(): CelMaterial {
  if (shared) return shared;
  const masks = uv();
  const m = new CelMaterial({
    colorNode: Fn(() => {
      const base = attribute<"vec4">("color", "vec4").rgb;
      return mix(bedded(base, positionWorld), scenerySnow(), masks.y);
    })(),
    shade: new THREE.Color(...ROCK_SHADE),
    richness: 1.12,
    id: inkId("rock"),
  });
  fadingInk(m, 1, 0.8, inkId("rock"), 0.9);
  // (A cap shades as the snow round it does.)
  m.shadeNode = mix(vec3(...ROCK_SHADE).mul(shadeKept()), snowShade(), masks.y);
  // Without snow a cap sinks into its rock.
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const load = snowLoad(modelWorldMatrix.mul(vec4(p, 1)).xyz);
    return p.sub(vec3(0, masks.x.mul(float(1).sub(load)).mul(CAP_SINK), 0));
  })();
  shared = m;
  return m;
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

interface Placed {
  model: string;
  x: number;
  y: number;
  z: number;
  turn: number;
  size: THREE.Vector3;
}

/** The models as they stand at 1:1: half their width and depth (m), and their height. */
const SHAPES: Record<string, { half: number; deep: number; height: number }> = {
  boulder_a: { half: 1.05, deep: 1, height: 1.5 },
  boulder_b: { half: 1.0, deep: 1, height: 1.7 },
  boulder_c: { half: 1.05, deep: 1, height: 1.3 },
  shard_a: { half: 0.5, deep: 0.5, height: 1.0 },
  shard_b: { half: 0.48, deep: 0.5, height: 1.2 },
  crag_a: { half: 2.5, deep: 2.1, height: 5 },
  crag_b: { half: 3, deep: 2.3, height: 3.6 },
  crag_c: { half: 2.2, deep: 2, height: 7.5 },
  wall_a: { half: 4.5, deep: 2.25, height: 5 },
  wall_b: { half: 4, deep: 2.25, height: 7 },
  wall_c: { half: 5, deep: 2, height: 3.2 },
};
const BOULDERS = ["boulder_a", "boulder_b", "boulder_c"];
const SHARDS = ["shard_a", "shard_b"];
const CRAGS = ["crag_a", "crag_b", "crag_c", "wall_a", "wall_c"];

/**
 * Every rock of a run: the sim's rocks (as big as
 * they are solid), the walls and crags of the run's scenery (clear of the
 * riding width, crags facing down the slope they stand on), and the faces
 * under rock lips.
 */
export function rockMeshes(
  run: RunData,
  scenery: RunScenery,
  models: Models,
  heights: (points: Float32Array) => Float32Array,
): THREE.Mesh[] {
  const placed: Placed[] = [];
  let n = 0;
  for (const o of run.obstacles) {
    if (o.kind !== "rock") continue;
    const model = (o.cover ? SHARDS : BOULDERS)[n++ % (o.cover ? 2 : 3)]!;
    const shape = SHAPES[model]!;
    const s = (o.radius / shape.half) * 1.05;
    placed.push({
      model,
      x: o.x,
      y: o.y - 0.05,
      z: o.z,
      turn: o.x * 1.7 + o.z,
      size: new THREE.Vector3(s, Math.max(0.7 * s, (o.height / shape.height) * 1.1), s),
    });
  }
  const rand = rng(4242);
  /** A rock to stand on the ground: `turn` null faces it down the slope. */
  interface Spot {
    x: number;
    z: number;
    model: string;
    s: number;
    turn: number | null;
    /** How far its foot sinks (m), and how much taller than wide it is drawn. */
    sink: number;
    tall: number;
    /** How deep it is drawn, against its width (1 if left out). */
    thin?: number;
    /** Where its height is read from the ground, if not where it stands. */
    level?: { x: number; z: number };
  }
  const spots: Spot[] = [];
  for (const b of scenery.outcrops) {
    for (let k = 0; k < b.count; k++) {
      const at = b.from + rand() * (b.to - b.from);
      const p = runPoint(run, at);
      const side = rand() < 0.5 ? -1 : 1;
      const size = b.size * (0.45 + rand() * 0.55);
      const big = size > 4.6;
      const model = big ? CRAGS[Math.floor(rand() * CRAGS.length)]! : BOULDERS[Math.floor(rand() * 3)]!;
      const s = big ? size / (SHAPES[model]!.half * 2) : Math.min(2, size / (SHAPES[model]!.half * 2));
      // Clear of the riding width by its own half width.
      const out = p.limit + b.near + size * 0.55 + rand() * rand() * (b.far - b.near);
      const where = runAt(run, at, side * out);
      spots.push({
        x: where.x,
        z: where.z,
        model,
        s,
        turn: big ? null : rand() * Math.PI * 2,
        sink: 0.25 * s,
        tall: 0.85 + rand() * 0.4,
      });
    }
  }
  for (const lip of run.lips) {
    if (lip.kind !== "rock") continue;
    // The crest is snow over the rock's top; its face shows below it, on the drop.
    const shape = SHAPES.wall_c!;
    const s = Math.max(lip.halfWidth * 2 + 2, 4) / (shape.half * 2);
    const thin = 0.3;
    const at = runAt(run, lip.lip + 0.35 - shape.deep * s * thin, lip.offset);
    const crest = runAt(run, lip.lip, lip.offset);
    spots.push({
      x: at.x,
      z: at.z,
      model: "wall_c",
      s,
      turn: at.yaw,
      sink: shape.height * s + 0.3,
      tall: 1,
      thin,
      level: crest,
    });
  }
  // The ground under each, and round it (for the way the slope falls).
  const D = 3;
  const pts = new Float32Array(spots.length * 10);
  spots.forEach((p, i) => {
    const at = p.level ?? p;
    pts.set([at.x, at.z, p.x + D, p.z, p.x - D, p.z, p.x, p.z + D, p.x, p.z - D], i * 10);
  });
  const ys = heights(pts);
  spots.forEach((p, i) => {
    const y = ys[i * 5]!;
    const downX = ys[i * 5 + 2]! - ys[i * 5 + 1]!;
    const downZ = ys[i * 5 + 4]! - ys[i * 5 + 3]!;
    placed.push({
      model: p.model,
      x: p.x,
      y: y - p.sink,
      z: p.z,
      turn: p.turn ?? Math.atan2(downX, downZ) + (rand() - 0.5) * 0.5,
      size: new THREE.Vector3(p.s, p.s * p.tall, p.s * (p.thin ?? 1)),
    });
  });
  // (Each a mesh of its own: the mountain merges them by where they stand.)
  const out: THREE.Mesh[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const p of placed) {
    const geometry = models.get(p.model);
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, rockMaterial());
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.setFromAxisAngle(up, p.turn);
    mesh.scale.copy(p.size);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

/**
 * Bare ground round the foot of each rock that pokes through a thin cover:
 * an uneven patch of earth, in the season's ground colours.
 */
export function coverPatches(run: RunData, ground: (x: number, z: number) => number): THREE.Mesh | null {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const o of run.obstacles) {
    if (o.kind !== "rock" || !o.cover) continue;
    const rand = rng(Math.floor(o.x * 31 + o.z * 17));
    const base = pos.length / 3;
    const around = 9;
    pos.push(o.x, ground(o.x, o.z) + 0.04, o.z);
    for (let k = 0; k < around; k++) {
      const a = (k / around) * Math.PI * 2;
      const r = o.radius * (1.25 + rand() * 0.9);
      const x = o.x + Math.cos(a) * r;
      const z = o.z + Math.sin(a) * r * 0.8;
      pos.push(x, ground(x, z) + 0.035, z);
    }
    for (let k = 0; k < around; k++) idx.push(base, base + 1 + ((k + 1) % around), base + 1 + k);
  }
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new CelMaterial({
    colorNode: vertexStage(mix(LOOK.ground2, LOOK.ground, noise4(positionWorld.xz.mul(0.9)).x.mul(0.5).add(0.5))),
    silhouette: 0,
    crease: 0,
    darkness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}
