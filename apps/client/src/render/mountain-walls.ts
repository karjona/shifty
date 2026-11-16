// Rock built along a run from its ground: the walls of a couloir or a
// gully as one face of buttresses standing shoulder to shoulder (each its
// own height and set forward or back, so joints run down the face between
// them; two tiers with a ledge between, some overhanging; its top running
// back into the slope behind). Snow lies on their ledges and tops where
// snow lies, and icicles hang from their overhangs in the cold. They take the rock's material (mountain-rocks.ts), so the
// same beds run through them as through the mountain.
import * as THREE from "three/webgpu";
import { Fn, float, modelWorldMatrix, positionLocal, uv, vec3, vec4 } from "three/tsl";
import { CelMaterial, inkId } from "./cel/material.ts";
import { fadingInk, snowLoad } from "./mountain-look.ts";
import { runAt, runPoint } from "./mountain-props.ts";
import { rockMaterial } from "./mountain-rocks.ts";
import type { CliffData, RunData } from "./mountain.ts";
import type { RockWalls } from "./runs.ts";

/** Rock's tones as its faces are painted (linear): tops, then faces from light to deep. */
const TOP = [0.54, 0.49, 0.41] as const;
const FACES = [
  [0.36, 0.31, 0.26],
  [0.27, 0.23, 0.2],
  [0.2, 0.17, 0.16],
] as const;
const SIDE = [0.16, 0.14, 0.14] as const;
const SNOW = [0.9, 0.93, 1] as const;

type P = [number, number, number];
/** The rock material's two masks at a corner. */
type Mask = [number, number];
const isMask = (m: Mask[] | Mask): m is Mask => typeof m[0] === "number";

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

/** Triangles being gathered: positions, colours (rgba) and the rock material's masks. */
class Shape {
  pos: number[] = [];
  col: number[] = [];
  masks: number[] = [];

  /** A quad a-b-c-d (wound to face `toward`), in `colour`; `mask` per corner or for all. */
  quad(a: P, b: P, c: P, d: P, toward: P, colour: readonly number[], mask: Mask[] | Mask = [0, 0]): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const facing = (uy * vz - uz * vy) * toward[0] + (uz * vx - ux * vz) * toward[1] + (ux * vy - uy * vx) * toward[2];
    const order = facing >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    const corners = [a, b, c, d];
    for (const i of order) {
      this.pos.push(...corners[i]!);
      this.col.push(colour[0]!, colour[1]!, colour[2]!, 1);
      const m = isMask(mask) ? mask : mask[i]!;
      this.masks.push(m[0], m[1]);
    }
  }

  /** A triangle (wound to face `toward`). */
  tri(a: P, b: P, c: P, toward: P, colour: readonly number[], mask: Mask[]): void {
    this.quad(a, b, c, c, toward, colour, [mask[0]!, mask[1]!, mask[2]!, mask[2]!]);
  }

  mesh(material: THREE.Material): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 4));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.masks, 2));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.noMerge = true;
    return mesh;
  }
}

let ice: CelMaterial | null = null;

/** Icicles: pale ice, each drawn up into its root where no snow lies (`uv.x`: how far below its root a vertex hangs, m). */
function icicleMaterial(): CelMaterial {
  if (ice) return ice;
  const m = new CelMaterial({
    color: 0xcfe6f6,
    shade: new THREE.Color(0.6, 0.74, 1),
    side: THREE.DoubleSide,
    spec: 0.5,
    specSize: 0.2,
  });
  fadingInk(m, 0.5, 0, inkId("ice"), 0.45);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const cold = snowLoad(modelWorldMatrix.mul(vec4(p, 1)).xyz)
      .sub(0.55)
      .mul(4)
      .clamp(0, 1);
    return p.add(vec3(0, uv().x.mul(float(1).sub(cold)), 0));
  })();
  ice = m;
  return m;
}

/** A row of icicles hanging from the edge `a`-`b`, the longest `longest` m. */
function icicles(out: Shape, a: P, b: P, longest: number, rand: () => number): void {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const count = Math.floor(length / 0.45);
  for (let k = 0; k < count; k++) {
    if (rand() < 0.35) continue;
    const t = (k + rand()) / count;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    const hang = longest * (0.25 + 0.75 * rand() * rand());
    const w = 0.035 + hang * 0.05;
    const dx = ((b[0] - a[0]) / length) * w;
    const dz = ((b[2] - a[2]) / length) * w;
    // Two crossed blades, tapering to a point.
    out.tri([x - dx, y, z - dz], [x + dx, y, z + dz], [x, y - hang, z], [0, 0, 1], SNOW, [
      [0, 0],
      [0, 0],
      [hang, 0],
    ]);
    out.tri([x - dz, y, z + dx], [x + dz, y, z - dx], [x, y - hang, z], [1, 0, 0], SNOW, [
      [0, 0],
      [0, 0],
      [hang, 0],
    ]);
  }
}

/** A blanket of snow on the level quad a-b-c-d (a-b its front edge), `thick` m deep, rounded off toward the front. */
function blanket(out: Shape, a: P, b: P, c: P, d: P, thick: number): void {
  const up = (p: P, h: number): P => [p[0], p[1] + h, p[2]];
  const toBack = (p: P, q: P, k: number): P => [
    p[0] + (q[0] - p[0]) * k,
    p[1] + (q[1] - p[1]) * k,
    p[2] + (q[2] - p[2]) * k,
  ];
  const a1 = up(toBack(a, d, 0.12), thick);
  const b1 = up(toBack(b, c, 0.12), thick);
  const front: P = [a[0] - d[0], 0.4, a[2] - d[2]];
  // The rounded front, then the top.
  out.quad(a, b, b1, a1, front, SNOW, [
    [0, 1],
    [0, 1],
    [thick, 1],
    [thick, 1],
  ]);
  out.quad(a1, b1, up(c, thick), up(d, thick), [0, 1, 0], SNOW, [thick, 1]);
  // Its ends.
  out.quad(a, a1, up(d, thick), d, [a[0] - b[0], 0, a[2] - b[2]], SNOW, [
    [0, 1],
    [thick, 1],
    [thick, 1],
    [0, 1],
  ]);
  out.quad(b, b1, up(c, thick), c, [b[0] - a[0], 0, b[2] - a[2]], SNOW, [
    [0, 1],
    [thick, 1],
    [thick, 1],
    [0, 1],
  ]);
}

/**
 * The walls of a run's scenery: for each stretch and side, buttresses from
 * its start to its end. Returns the rock and its icicles.
 */
export function rockWalls(
  run: RunData,
  walls: RockWalls[],
  heights: (points: Float32Array) => Float32Array,
): THREE.Mesh[] {
  const rock = new Shape();
  const hanging = new Shape();
  const rand = rng(8128);
  for (const wall of walls) {
    for (const side of wall.side ? [wall.side] : [-1, 1]) {
      // The buttresses: each a few metres of the wall.
      const parts: {
        s0: number;
        s1: number;
        jog: number;
        tall: number;
        split: number;
        lean0: number;
        lean1: number;
        ledge: number;
      }[] = [];
      for (let s = wall.from; s < wall.to;) {
        const length = 3 + rand() * 5;
        const mid = s + length / 2;
        // Lower where the wall begins and ends, and in waves along it.
        const ends = Math.min(1, (mid - wall.from + 3) / 16, (wall.to - mid + 3) / 16);
        const wave = 0.75 + 0.5 * (0.5 + 0.5 * Math.sin(mid * 0.11 + side * 1.7)) + (rand() - 0.5) * 0.35;
        parts.push({
          s0: s,
          s1: Math.min(wall.to, s + length),
          jog: 0.5 + 0.45 * Math.sin(mid * 0.19 + side * 2.3) + rand() * 0.35,
          tall: wall.height * wave * (0.35 + 0.65 * ends),
          split: 0.3 + rand() * 0.3,
          // (Negative: the tier's top overhangs its foot.)
          lean0: rand() < 0.4 ? -(0.15 + rand() * 0.35) : rand() * 0.35,
          lean1: rand() < 0.3 ? -(0.1 + rand() * 0.3) : rand() * 0.5,
          ledge: 0.35 + rand() * 0.9,
        });
        s += length;
      }
      // The ground under each buttress's four foot corners (front and back).
      const DEEP = 6;
      const pts = new Float32Array(parts.length * 8);
      const feet = parts.map((b, i) => {
        const at = (s: number, extra: number) => {
          const p = runPoint(run, s);
          const limit = side > 0 ? p.limitR : p.limitL;
          const q = runAt(run, s, side * (limit + wall.out + b.jog + extra));
          return [q.x, q.z] as const;
        };
        const f = [at(b.s0, 0), at(b.s1, 0), at(b.s1, DEEP), at(b.s0, DEEP)];
        f.forEach((p, k) => pts.set(p, i * 8 + k * 2));
        return f;
      });
      const ys = heights(pts);
      parts.forEach((b, i) => {
        const f = feet[i]!;
        const y = [0, 1, 2, 3].map((k) => ys[i * 4 + k]!);
        const low = Math.min(y[0]!, y[1]!) - 1.2;
        const high = Math.max(y[0]!, y[1]!);
        // As tall as the slope behind it stands over the run (a little proud of it), and no taller than the wall is.
        const behind = Math.max(y[2]!, y[3]!);
        const top = Math.min(high + b.tall, Math.max(high + 1.6, behind + 0.3 + rand() * 1.3));
        const mid = high + (top - high) * b.split;
        // Out from the run (level), and along the wall.
        const ox = f[3]![0] - f[0]![0];
        const oz = f[3]![1] - f[0]![1];
        const ol = Math.hypot(ox, oz) || 1;
        const out: P = [ox / ol, 0, oz / ol];
        const toRun: P = [-out[0], 0.15, -out[2]];
        const at = (k: 0 | 1, back: number, h: number): P => [f[k]![0] + out[0] * back, h, f[k]![1] + out[2] * back];
        const tone = () => FACES[Math.floor(rand() * FACES.length)]!;
        // The lower tier's face, the ledge, the upper tier's face, the top.
        const a0 = at(0, 0, low);
        const a1 = at(1, 0, low);
        const b0 = at(0, b.lean0, mid);
        const b1 = at(1, b.lean0, mid);
        const c0 = at(0, b.lean0 + b.ledge, mid);
        const c1 = at(1, b.lean0 + b.ledge, mid);
        const d0 = at(0, b.lean0 + b.ledge + b.lean1, top);
        const d1 = at(1, b.lean0 + b.ledge + b.lean1, top);
        // (Its top runs back into the slope.)
        const e0 = at(0, DEEP, Math.min(top, y[3]! - 0.4));
        const e1 = at(1, DEEP, Math.min(top, y[2]! - 0.4));
        rock.quad(a0, a1, b1, b0, toRun, tone());
        rock.quad(b0, b1, c1, c0, [0, 1, 0], TOP);
        rock.quad(c0, c1, d1, d0, toRun, tone());
        rock.quad(d0, d1, e1, e0, [0, 1, 0], TOP);
        // Its two ends, where its neighbours stand back from it or lower.
        for (const k of [0, 1] as const) {
          const end: P = k === 0 ? [a0[0] - a1[0], 0, a0[2] - a1[2]] : [a1[0] - a0[0], 0, a1[2] - a0[2]];
          const [a, bb, c, d, e] = k === 0 ? [a0, b0, c0, d0, e0] : [a1, b1, c1, d1, e1];
          const base: P = [e[0], low, e[2]];
          rock.quad(a, bb, [c[0], mid, c[2]], [c[0], low, c[2]], end, SIDE);
          rock.quad([c[0], low, c[2]], c, d, [d[0], low, d[2]], end, SIDE);
          rock.quad([d[0], low, d[2]], d, e, base, end, SIDE);
        }
        blanket(rock, b0, b1, c1, c0, 0.3);
        blanket(rock, d0, d1, e1, e0, 0.42);
        // Icicles under what overhangs.
        if (b.lean0 < -0.12 && mid - high > 1.2) icicles(hanging, b0, b1, Math.min(1.4, (mid - high) * 0.4), rand);
        if (b.lean1 < -0.1) icicles(hanging, d0, d1, Math.min(1.2, (top - mid) * 0.4), rand);
      });
    }
  }
  return [rock.mesh(rockMaterial()), hanging.mesh(icicleMaterial())].filter((m) => m !== null);
}

/**
 * A cliff's face across the run and out into the slope either side, as far
 * as the ground drops: columns of rock a few metres wide standing proud of
 * the snow's steep face, each in two tiers with a ledge between (one face
 * where the drop is small), its brow out over the tier below; snow lies on
 * the brow and the ledges, and icicles hang from the brows that overhang.
 */
export function cliffFaces(
  run: RunData,
  cliffs: readonly CliffData[],
  heights: (points: Float32Array) => Float32Array,
): THREE.Mesh[] {
  const rock = new Shape();
  const hanging = new Shape();
  const rand = rng(4242);
  /** How far behind the lip the rock begins, and how far past the face's foot the ground is read (m). */
  const BACK = 0.3;
  const PAST = 0.6;
  for (const c of cliffs) {
    const f = runPoint(run, c.s);
    const fx = Math.sin(f.yaw);
    const fz = Math.cos(f.yaw);
    const reach = f.limit + 34;
    const edges: number[] = [];
    for (let o = -reach; o < reach; o += 2.2 + rand() * 3) edges.push(o);
    edges.push(reach);
    // The ground along the lip and along the foot, under each column's edges.
    const wide = c.face + BACK + PAST;
    const lip = edges.map((o) => runAt(run, c.s - BACK, o));
    const pts = new Float32Array(edges.length * 4);
    lip.forEach((q, i) => pts.set([q.x, q.z, q.x + fx * wide, q.z + fz * wide], i * 4));
    const ys = heights(pts);
    const toward: P = [fx, 0.25, fz];
    const tone = () => FACES[Math.floor(rand() * FACES.length)]!;
    for (let i = 0; i + 1 < edges.length; i++) {
      const top = [ys[i * 2]!, ys[(i + 1) * 2]!] as const;
      const foot = [ys[i * 2 + 1]!, ys[(i + 1) * 2 + 1]!] as const;
      const tall = Math.min(top[0] - foot[0], top[1] - foot[1]);
      if (tall < 1.8) continue;
      // Out from the lip line (m): the brow, the upper tier's foot, the ledge's rim, the foot.
      const brow = 0.5 + rand() * 0.8;
      const split = 0.35 + rand() * 0.3;
      const lean = rand() < 0.4 ? -(0.1 + rand() * 0.3) : rand() * 0.4;
      const mid = Math.max(brow + lean, wide * (1 - split) + 0.3);
      const ledge = 0.5 + rand() * 0.9;
      const out = Math.max(mid + ledge + rand() * 0.5 - 0.15, wide + 0.3 + rand() * 0.5);
      const at = (k: 0 | 1, d: number, y: number): P => [lip[i + k]!.x + fx * d, y, lip[i + k]!.z + fz * d];
      const yTop = (k: 0 | 1) => top[k] - 0.3;
      const yMid = (k: 0 | 1) => foot[k] + (top[k] - foot[k]) * split;
      const yFoot = (k: 0 | 1) => foot[k] - 0.8;
      const t = [at(0, brow, yTop(0)), at(1, brow, yTop(1))] as const;
      const back = [at(0, -0.2, yTop(0)), at(1, -0.2, yTop(1))] as const;
      const base = [at(0, out, yFoot(0)), at(1, out, yFoot(1))] as const;
      rock.quad(back[0], back[1], t[1], t[0], [0, 1, 0], TOP);
      blanket(rock, t[0], t[1], back[1], back[0], 0.5);
      const tiers = tall > 3.5;
      if (tiers) {
        const m = [at(0, mid, yMid(0)), at(1, mid, yMid(1))] as const;
        const rim = [at(0, mid + ledge, yMid(0)), at(1, mid + ledge, yMid(1))] as const;
        rock.quad(m[0], m[1], t[1], t[0], toward, tone());
        rock.quad(m[0], m[1], rim[1], rim[0], [0, 1, 0], TOP);
        rock.quad(base[0], base[1], rim[1], rim[0], toward, tone());
        blanket(rock, rim[0], rim[1], m[1], m[0], 0.4);
        if (lean < -0.08) icicles(hanging, t[0], t[1], Math.min(1.5, (top[0] - foot[0]) * (1 - split) * 0.35), rand);
      } else rock.quad(base[0], base[1], t[1], t[0], toward, tone());
      // Its two ends, where its neighbours stand back from it.
      for (const k of [0, 1] as const) {
        const other = k === 0 ? 1 : 0;
        const end: P = [lip[i + k]!.x - lip[i + other]!.x, 0, lip[i + k]!.z - lip[i + other]!.z];
        const inTop = at(k, -0.2, yTop(k));
        const inFoot = at(k, -0.2, yFoot(k));
        if (tiers) {
          const inMid = at(k, -0.2, yMid(k));
          rock.quad(t[k], at(k, mid, yMid(k)), inMid, inTop, end, SIDE);
          rock.quad(at(k, mid + ledge, yMid(k)), base[k], inFoot, inMid, end, SIDE);
        } else rock.quad(t[k], base[k], inFoot, inTop, end, SIDE);
      }
    }
  }
  return [rock.mesh(rockMaterial()), hanging.mesh(icicleMaterial())].filter((m) => m !== null);
}
