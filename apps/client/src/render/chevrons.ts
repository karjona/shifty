// Chevron boards: yellow floating signs with black chevrons, lined up along
// the outside of every turn, angled toward the riders coming in and
// pointing the way the course turns, so a bend reads from far down the
// straight. They float just past the course's outer limit, which riders
// can't cross: they show where it is, and nobody rides into them.
import * as THREE from "three/webgpu";
import { BobbingBatch, placed } from "./bobbing.ts";
import { geometryOf } from "./buoys.ts";
import type { CourseData } from "./course.ts";
import { landDistance } from "./land.ts";
import { Parts } from "./parts.ts";

const YELLOW = 0xffd23c;
const INK = 0x1c2230;
const BACK = 0x3a404c;
const FLOAT = 0xf2f0ea;
const POST = 0x8b919b;

/** A board: width and height (m), and how high its bottom edge stands above the water. */
const BOARD = { width: 4.2, height: 1.7, above: 0.6, depth: 0.06 };
/** How far each board turns from facing the turn's centre toward the riders coming in (radians). */
const FACING = 0.65;
/** Distance between boards along the turn (m). */
const SPACING = 7.5;

/** Where a board floats, which way its face looks (yaw), and which way its chevrons point (1 = to the right, seen from the front). */
export interface ChevronSpot {
  x: number;
  z: number;
  yaw: number;
  dir: 1 | -1;
}

/**
 * The boards along the outside of both turns of the oval: on an arc just
 * past the outer limit (each board's near end clear of it), off any land.
 */
export function chevronSpots(d: CourseData): ChevronSpot[] {
  const spots: ChevronSpot[] = [];
  const r = d.outerLimit + (BOARD.width / 2) * Math.sin(FACING) + 0.5;
  const turns: [number, number][] = [
    [d.straightHalf, -Math.PI / 2],
    [-d.straightHalf, Math.PI / 2],
  ];
  const n = Math.round((Math.PI * r) / SPACING);
  for (const [cx, from] of turns) {
    for (let i = 0; i <= n; i++) {
      const th = from + (i / n) * Math.PI;
      const x = cx + r * Math.cos(th);
      const z = r * Math.sin(th);
      if (d.land.some((l) => landDistance(l, x, z) < BOARD.width)) continue;
      // Toward the turn's centre, and along the way riders go round it.
      const inX = -Math.cos(th);
      const inZ = -Math.sin(th);
      const goX = -Math.sin(th);
      const goZ = Math.cos(th);
      const nx = inX * Math.cos(FACING) - goX * Math.sin(FACING);
      const nz = inZ * Math.cos(FACING) - goZ * Math.sin(FACING);
      const yaw = Math.atan2(nx, nz);
      // Seen from the front, the board's right is its +X.
      const dir = goX * Math.cos(yaw) - goZ * Math.sin(yaw) >= 0 ? 1 : -1;
      spots.push({ x, z, yaw, dir });
    }
  }
  return spots;
}

/** One chevron pointing to `dir` (+X = 1), centred at `cx`, between ±`half` high. */
function chevron(cx: number, half: number, dir: 1 | -1): THREE.Shape {
  const point = half * 0.95;
  const thick = half * 0.62;
  const s = new THREE.Shape();
  const x = (u: number) => cx + u * dir;
  s.moveTo(x(-point / 2 - thick / 2), half);
  s.lineTo(x(-point / 2 + thick / 2), half);
  s.lineTo(x(point / 2 + thick / 2), 0);
  s.lineTo(x(-point / 2 + thick / 2), -half);
  s.lineTo(x(-point / 2 - thick / 2), -half);
  s.lineTo(x(point / 2 - thick / 2), 0);
  s.closePath();
  return s;
}

/** A board on its floats, its face (+Z) yellow with three black chevrons pointing to `dir`. */
function boardGeometry(dir: 1 | -1): THREE.BufferGeometry {
  const { width: w, height: h, above, depth } = BOARD;
  const half = h * 0.34;
  const gap = half * 1.85;
  const chevrons = [-gap, 0, gap].map((cx) => chevron(cx, half, dir));
  const face = new THREE.Shape();
  face.moveTo(-w / 2, -h / 2);
  face.lineTo(w / 2, -h / 2);
  face.lineTo(w / 2, h / 2);
  face.lineTo(-w / 2, h / 2);
  face.closePath();
  face.holes.push(...chevrons);
  const slab = { depth, bevelEnabled: false };
  const y = above + h / 2;
  const parts = new Parts();
  parts.add(new THREE.ExtrudeGeometry(face, slab), YELLOW, 0, y, 0);
  parts.add(new THREE.ExtrudeGeometry(chevrons, slab), INK, 0, y, 0);
  parts.add(new THREE.BoxGeometry(w, h, 0.08), BACK, 0, y, -0.04);
  for (const side of [-1, 1]) {
    const px = side * w * 0.36;
    parts.add(new THREE.BoxGeometry(0.1, above + 0.2, 0.1), POST, px, (above + 0.2) / 2 - 0.1, -0.12);
    parts.add(new THREE.CylinderGeometry(0.28, 0.28, 1.6, 10), FLOAT, px, 0.02, -0.35, Math.PI / 2);
  }
  return geometryOf(parts);
}

/** The course's chevron boards, riding the swell: one batch per way they point. */
export class ChevronBoards {
  readonly group = new THREE.Group();
  private batches: BobbingBatch[] = [];

  constructor(data: CourseData) {
    const spots = chevronSpots(data);
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5 });
    for (const dir of [1, -1] as const) {
      const mine = spots.filter((s) => s.dir === dir);
      if (mine.length === 0) continue;
      const batch = new BobbingBatch(
        boardGeometry(dir),
        material,
        mine.map((s) => ({ x: s.x, z: s.z, base: placed(s.x, s.z, s.yaw) })),
      );
      batch.mesh.castShadow = true;
      this.batches.push(batch);
      this.group.add(batch.mesh);
    }
  }

  update(waves: Float32Array, t: number): void {
    for (const b of this.batches) b.update(waves, t);
  }
}
