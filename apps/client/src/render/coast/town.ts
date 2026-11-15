// A fishing town of the Costa Nevada on its quay: a promenade along the
// water under palms, a waterfront of narrow houses (arcades and shop
// fronts with awnings below, shuttered windows and balconies above, tiled
// roofs with chimneys or roof terraces), and more rows climbing terraces
// behind them to the church and its bell tower. Laid out on the sim's
// town capsule, so the quay you see is the quay you hit. One mesh in the
// town's material (facades.ts); the plants are a planting of their own.
import * as THREE from "three/webgpu";
import type { Season } from "../../game/conditions.ts";
import { UNREFLECTED } from "../cel/material.ts";
import type { LandData } from "../course.ts";
import { capsuleOutline, prism } from "./outline.ts";
import { SHUTTERS, TILE, type Tile, house, townMaterial } from "./facades.ts";
import { addBench, addBollard, addLampPost, capsuleEdge } from "./harbour.ts";
import { FISH_MARKET, MARKET_HALL, addFishMarket, addGull, addMarketHall } from "./landmarks.ts";
import { COSTA_NEVADA, type Life } from "./life.ts";
import { Grounding, OVERHEAD, type Sunlight } from "./grounding.ts";
import { type Crowd, Walkers, addPerson } from "./people.ts";
import { Local, Shape, box, pick, place, post, random } from "./shape.ts";
import { Planting } from "./trees.ts";

/** The quay's top (m over the water). */
export const QUAY_TOP = 2.2;
/** Terraces behind the waterfront: how far in from the water each starts (m), and its height. */
const TERRACES: [number, number][] = [
  [38, 5.2],
  [52, 8.2],
  [66, 11.2],
  [80, 14.2],
];
/** Rows of houses: how far in their middle stands (m), their depth, and their storeys (least, most). */
const ROWS: { inland: number; depth: number; storeys: [number, number] }[] = [
  { inland: 14.5, depth: 9, storeys: [2, 4] },
  { inland: 28.5, depth: 9, storeys: [3, 5] },
  { inland: 44.5, depth: 9, storeys: [2, 4] },
  { inland: 58.5, depth: 9, storeys: [2, 4] },
  { inland: 72.5, depth: 9, storeys: [2, 3] },
  { inland: 87, depth: 10, storeys: [2, 3] },
];
const STOREY = 3;
const GROUND = 3.3;

const WALLS = [0xf7f3ea, 0xf7f3ea, 0xf4efe2, 0xf3e6c8, 0xf2d9a8, 0xeec4a0, 0xe8b4a0, 0xdce6ea, 0xf0d2c8];
const PAVING = new THREE.Color(0xdccfb6);
const COBBLES = new THREE.Color(0xcfc3a8);
const STONE = new THREE.Color(0xc4b79c);
const STONE_WET = new THREE.Color(0x7c7f86);
const COPING = new THREE.Color(0xe6dcc6);
const WHITE = new THREE.Color(0xffffff);
const TRIM = new THREE.Color(0xe9e2d2);
const IRON = 0x3a3f46;
/** An awning's skirt, in two colours; and what hangs on the washing lines. */
const VALANCES = [
  [0xf6f2ea, 0xd94a3a],
  [0xf6f2ea, 0x2f6fb0],
  [0xf6f2ea, 0x3f8a6a],
  [0xf2c14e, 0xf6f2ea],
];
const WASHING = [0xf6f2ea, 0xd94a3a, 0x3a6ea5, 0xf2c14e, 0xf6f2ea, 0xe87a9a];

/** A landmark on the waterfront: which, and how far along the quay its middle stands (m). */
export interface Landmark {
  kind: "market" | "fish";
  along: number;
}

/** The town's frame: along the quay, and in from the water. */
interface Quay {
  l: LandData;
  ux: number;
  uz: number;
  /** Unit normal toward the water. */
  nx: number;
  nz: number;
  len: number;
  /** Which way houses face (local +z toward the water). */
  yaw: number;
}

function quayOf(l: LandData): Quay {
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  // The water is on the course's side (toward the origin).
  let nx = -uz;
  let nz = ux;
  if (nx * -l.ax + nz * -l.az < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { l, ux, uz, nx, nz, len, yaw: Math.atan2(nx, nz) };
}

/** The point `along` the quay (m from its start) and `inland` from the water's edge. */
function quayPoint(q: Quay, along: number, inland: number): { x: number; z: number } {
  const d = q.l.radius - inland;
  return { x: q.l.ax + q.ux * along + q.nx * d, z: q.l.az + q.uz * along + q.nz * d };
}

/** How far past the quay's ends a row `inland` can run (m): its rounded ends allow less near the water. */
function reach(q: Quay, inland: number): number {
  const from = Math.abs(q.l.radius - inland);
  return Math.sqrt(Math.max(0, q.l.radius * q.l.radius - from * from));
}

/** The ground's height `inland` from the water: the quay, then the terraces. */
function groundAt(inland: number): number {
  let y = QUAY_TOP;
  for (const [from, top] of TERRACES) if (inland >= from) y = top;
  return y;
}

/** A house on its lot: `w` wide and `d` deep, `storeys` high, facing the water. */
function addHouse(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  w: number,
  d: number,
  storeys: number,
  r: () => number,
  waterfront: boolean,
  season: Season,
  life: Life,
): void {
  const L = new Local(shape, x, y, z, yaw);
  const wall = new THREE.Color(pick(WALLS, r));
  const side = wall.clone().multiplyScalar(0.96);
  const tiles = house(Math.floor(r() * SHUTTERS));
  const x0 = -w / 2;
  const x1 = w / 2;
  const zf = d / 2;
  const zb = -d / 2;
  const top = GROUND + (storeys - 1) * STOREY;
  const bays = Math.max(2, Math.round(w / 2.7));
  const bay = w / bays;
  // The ground floor: an arcade, shops under awnings, or a door and windows.
  const style = waterfront ? pick(["arcade", "shops", "shops", "plain"] as const, r) : "plain";
  const door = Math.floor(r() * bays);
  for (let b = 0; b < bays; b++) {
    const t =
      style === "arcade" ? tiles.arcade : style === "shops" ? tiles.shop : b === door ? tiles.door : tiles.window;
    L.front(x0 + b * bay, x0 + (b + 1) * bay, 0, GROUND, zf, wall, t);
  }
  if (style === "shops") {
    const stripes = pick(TILE.awnings, r);
    const dark = new THREE.Color(0xb9b4c4);
    L.quad(
      [x0 + 0.3, 2.3, zf + 1.7],
      [x1 - 0.3, 2.3, zf + 1.7],
      [x1 - 0.3, 2.95, zf + 0.02],
      [x0 + 0.3, 2.95, zf + 0.02],
      WHITE,
      stripes,
    );
    L.quad(
      [x1 - 0.3, 2.3, zf + 1.7],
      [x0 + 0.3, 2.3, zf + 1.7],
      [x0 + 0.3, 2.95, zf + 0.02],
      [x1 - 0.3, 2.95, zf + 0.02],
      dark,
      stripes,
    );
    // Its skirt, in the wind.
    life.valance(L.p(x0 + 0.3, 2.3, zf + 1.7), L.p(x1 - 0.3, 2.3, zf + 1.7), 0.3, pick(VALANCES, r));
  }
  // The floors above: windows, some shut, with a balcony across the middle of one floor.
  const balconyFloor = storeys > 1 && r() < 0.75 ? 1 + Math.floor(r() * (storeys - 1)) : -1;
  const flowers = r() < 0.25;
  for (let s = 1; s < storeys; s++) {
    const y0 = GROUND + (s - 1) * STOREY;
    const onBalcony = s === balconyFloor;
    const from = onBalcony ? (bays > 2 ? 1 : 0) : 0;
    const to = onBalcony ? (bays > 2 ? bays - 1 : bays) : 0;
    for (let b = 0; b < bays; b++) {
      const open = onBalcony && b >= from && b < to;
      const t = open ? tiles.balcony : r() < 0.3 ? tiles.shut : flowers && r() < 0.5 ? TILE.flowers : tiles.window;
      L.front(x0 + b * bay, x0 + (b + 1) * bay, y0, y0 + STOREY, zf, wall, t);
    }
    if (onBalcony) {
      const bx0 = x0 + from * bay + 0.25;
      const bx1 = x0 + to * bay - 0.25;
      L.box((bx0 + bx1) / 2, y0 - 0.12, zf + 0.5, bx1 - bx0, 0.14, 1.0, TRIM);
      L.front(bx0, bx1, y0 + 0.02, y0 + 0.95, zf + 0.98, WHITE, TILE.railing);
      L.quad(
        [bx1, y0 + 0.02, zf + 0.98],
        [bx1, y0 + 0.02, zf],
        [bx1, y0 + 0.95, zf],
        [bx1, y0 + 0.95, zf + 0.98],
        WHITE,
        TILE.railing,
      );
      L.quad(
        [bx0, y0 + 0.02, zf],
        [bx0, y0 + 0.02, zf + 0.98],
        [bx0, y0 + 0.95, zf + 0.98],
        [bx0, y0 + 0.95, zf],
        WHITE,
        TILE.railing,
      );
    }
  }
  // The sides and the back: plain, a small window here and there. (They reach down to the terrace below.)
  const foot = -4;
  for (const [sx, from, to] of [
    [x1, zf, zb],
    [x0, zb, zf],
  ] as const) {
    L.quad([sx, foot, from], [sx, foot, to], [sx, top, to], [sx, top, from], side, tiles.wall);
    if (r() < 0.6) {
      const wy = GROUND + Math.floor(r() * Math.max(1, storeys - 1)) * STOREY;
      const mid = (from + to) / 2;
      const half = (Math.sign(to - from) * STOREY) / 2;
      const out = sx > 0 ? 0.03 : -0.03;
      L.quad(
        [sx + out, wy, mid - half],
        [sx + out, wy, mid + half],
        [sx + out, wy + STOREY, mid + half],
        [sx + out, wy + STOREY, mid - half],
        side,
        r() < 0.5 ? tiles.small : tiles.shut,
      );
    }
  }
  L.quad([x1, foot, zb], [x0, foot, zb], [x0, top, zb], [x1, top, zb], side, tiles.wall);
  // The cornice.
  L.box(0, top - 0.12, zf + 0.12, w + 0.3, 0.26, 0.3, TRIM);
  const roofTint = new THREE.Color().setScalar(0.9 + r() * 0.1);
  const kind = r();
  if (kind < 0.24) {
    // A roof terrace behind a parapet: a hut for the stair, washing on a line.
    for (const [px, pz, pw, pd] of [
      [0, zf - 0.15, w, 0.3],
      [0, zb + 0.15, w, 0.3],
      [x0 + 0.15, 0, 0.3, d],
      [x1 - 0.15, 0, 0.3, d],
    ] as const)
      L.box(px, top, pz, pw, 0.9, pd, wall);
    L.quad(
      [x0, top + 0.1, zf],
      [x1, top + 0.1, zf],
      [x1, top + 0.1, zb],
      [x0, top + 0.1, zb],
      new THREE.Color(0xc9a58a),
    );
    L.box(x0 + 1.6, top, zb + 1.6, 2.4, 2.3, 2.4, wall);
    L.quad(
      [x0 + 0.3, top + 2.3, zb + 3.0],
      [x0 + 3.0, top + 2.3, zb + 3.0],
      [x0 + 3.0, top + 2.5, zb + 0.3],
      [x0 + 0.3, top + 2.5, zb + 0.3],
      roofTint,
      TILE.roof,
    );
    if (season !== "winter" && r() < 0.7) {
      for (const px of [x0 + 3.6, x1 - 0.8]) L.box(px, top, zf - 1.2, 0.08, 2.1, 0.08, IRON);
      if (x1 - 0.8 - (x0 + 3.6) > 1.6)
        life.washing(L.p(x0 + 3.6, top + 2.0, zf - 1.2), L.p(x1 - 0.8, top + 2.0, zf - 1.2), WASHING, r);
    }
  } else {
    // Tiles: the ridge along the street, eaves over the front and the back; some hipped at the ends.
    const e = 0.45;
    const rise = 1.5 + r() * 0.6;
    const hip = kind > 0.8 ? Math.min(w * 0.3, 2.4) : 0;
    const yr = top + rise;
    const tileUv = r() < 0.3 ? TILE.roofOld : TILE.roof;
    L.quad(
      [x0 - e, top, zf + e],
      [x1 + e, top, zf + e],
      [x1 + e - hip, yr, 0],
      [x0 - e + hip, yr, 0],
      roofTint,
      tileUv,
    );
    L.quad(
      [x1 + e, top, zb - e],
      [x0 - e, top, zb - e],
      [x0 - e + hip, yr, 0],
      [x1 + e - hip, yr, 0],
      roofTint,
      tileUv,
    );
    if (hip > 0) {
      L.quad(
        [x1 + e, top, zf + e],
        [x1 + e, top, zb - e],
        [x1 + e - hip, yr, 0],
        [x1 + e - hip, yr, 0],
        roofTint,
        tileUv,
      );
      L.quad(
        [x0 - e, top, zb - e],
        [x0 - e, top, zf + e],
        [x0 - e + hip, yr, 0],
        [x0 - e + hip, yr, 0],
        roofTint,
        tileUv,
      );
    } else {
      // The gable walls up to the ridge.
      L.quad([x1, top, zf], [x1, top, zb], [x1, yr - 0.1, 0], [x1, yr - 0.1, 0], side, tiles.wall);
      L.quad([x0, top, zb], [x0, top, zf], [x0, yr - 0.1, 0], [x0, yr - 0.1, 0], side, tiles.wall);
    }
    if (r() < 0.6) {
      const cx = x0 + 1 + r() * (w - 2);
      L.box(cx, top + rise * 0.5, -d * 0.2, 0.7, rise * 0.5 + 0.9, 0.7, wall);
      L.box(cx, top + rise + 0.9, -d * 0.2, 0.95, 0.14, 0.95, new THREE.Color(0xb86a44));
    }
  }
}

/** The church: a nave under a tiled gable, its west front to the water, and the bell tower beside it. */
function addChurch(shape: Shape, x: number, y: number, z: number, yaw: number): void {
  const L = new Local(shape, x, y, z, yaw);
  const wall = new THREE.Color(0xf6f1e4);
  const stone = new THREE.Color(0xe8dcc0);
  const w = 11;
  const d = 22;
  const h = 11;
  const zf = d / 2;
  const zb = -d / 2;
  const foot = -4;
  // The front: the portal, the rose window over it, up to the gable.
  const peak = h + 3.6;
  L.front(-w / 2, w / 2, foot, 0, zf, stone);
  L.front(-w / 2, -2.6, 0, h, zf, wall);
  L.front(2.6, w / 2, 0, h, zf, wall);
  L.front(-2.6, 2.6, 0, 5.2, zf, wall, TILE.portal);
  L.front(-2.6, 2.6, 5.2, h, zf, wall, TILE.rose);
  L.quad([-w / 2, h, zf], [w / 2, h, zf], [0, peak, zf], [0, peak, zf], wall);
  L.box(0, peak - 0.2, zf, 0.5, 1.4, 0.5, stone);
  L.box(0, peak + 0.9, zf, 0.12, 1.3, 0.12, IRON);
  L.box(0, peak + 1.7, zf, 0.7, 0.12, 0.12, IRON);
  // The nave's sides, with lancets, and its roof.
  for (const sx of [-1, 1]) {
    const px = (sx * w) / 2;
    for (let k = 0; k < 4; k++) {
      const z0 = zf - (k * d) / 4;
      const z1 = zf - ((k + 1) * d) / 4;
      const [from, to] = sx > 0 ? [z0, z1] : [z1, z0];
      L.quad([px, foot, from], [px, foot, to], [px, 0, to], [px, 0, from], stone);
      L.quad([px, 0, from], [px, 0, to], [px, h, to], [px, h, from], wall);
      L.quad(
        [px + sx * 0.03, 3, from - Math.sign(from - to) * 1.2],
        [px + sx * 0.03, 3, to + Math.sign(from - to) * 1.2],
        [px + sx * 0.03, 8.5, to + Math.sign(from - to) * 1.2],
        [px + sx * 0.03, 8.5, from - Math.sign(from - to) * 1.2],
        wall,
        TILE.lancet,
      );
    }
    const e = 0.5;
    const [fa, fb] = sx > 0 ? [zf + e, zb - e] : [zb - e, zf + e];
    L.quad(
      [px + sx * e, h - 0.2, fa],
      [px + sx * e, h - 0.2, fb],
      [0, peak + 0.15, fb],
      [0, peak + 0.15, fa],
      WHITE,
      TILE.roof,
    );
  }
  L.quad([w / 2, foot, zb], [-w / 2, foot, zb], [-w / 2, h, zb], [w / 2, h, zb], wall);
  L.quad([w / 2, h, zb], [-w / 2, h, zb], [0, peak, zb], [0, peak, zb], wall);
  // The bell tower: stages marked by string courses, the clock, the belfry, a tiled spire and its cross.
  const tw = 5.4;
  const tx = w / 2 + tw / 2 - 0.4;
  const tz = zf - tw / 2 - 0.5;
  const stages: [number, Tile | null][] = [
    [7, null],
    [6, null],
    [4.5, TILE.clock],
    [5.5, TILE.belfry],
  ];
  let ty = 0;
  L.box(tx, foot, tz, tw + 0.3, -foot, tw + 0.3, stone);
  for (const [tall, face] of stages) {
    const T = new Local(shape, L.p(tx, ty, tz).x, y + ty, L.p(tx, ty, tz).z, yaw);
    const half = tw / 2;
    for (let f = 0; f < 4; f++) {
      const F = new Local(shape, L.p(tx, ty, tz).x, y + ty, L.p(tx, ty, tz).z, yaw + (f * Math.PI) / 2);
      F.front(-half, half, 0, tall, half, wall);
      if (face) F.front(-half * 0.62, half * 0.62, tall * 0.1, tall * 0.9, half + 0.03, wall, face);
    }
    T.box(0, tall - 0.2, 0, tw + 0.5, 0.3, tw + 0.5, stone);
    ty += tall;
  }
  const spire = new THREE.ConeGeometry((tw + 0.7) * Math.SQRT1_2, 4.6, 4, 1).rotateY(Math.PI / 4).translate(0, 2.3, 0);
  L.take(spire, new THREE.Color(0xc96a40), tx, ty, tz, true);
  L.box(tx, ty + 4.5, tz, 0.14, 1.8, 0.14, IRON);
  L.box(tx, ty + 5.6, tz, 0.9, 0.14, 0.14, IRON);
}

/** What stands on the promenade: lamps, bollards, benches, cafe tables under parasols, crates and nets by the boats. */
function addPromenade(
  target: Shape,
  q: Quay,
  r: () => number,
  season: Season,
  crowd: number,
  wavers: Crowd,
  clear: (x: number, z: number) => boolean,
  shades: Grounding,
): void {
  // What would stand on ground kept clear goes to a shape that is never drawn.
  const spare = new Shape();
  let shape = target;
  const shade = { on: shades, colour: PAVING };
  const spot = (quay: Quay, along: number, inland: number) => {
    const p = quayPoint(quay, along, inland);
    shape = clear(p.x, p.z) ? spare : target;
    return p;
  };
  const span = reach(q, 3) - 6;
  // People: strolling the promenade, standing in talk, fishing off the edge, waving at the riders.
  const strollers = Math.round(((q.len + span * 2) / 6.5) * crowd);
  for (let i = 0; i < strollers; i++) {
    const a = -span + r() * (q.len + span * 2);
    const kind = r();
    if (kind < 0.16) {
      const p = spot(q, a, 1.3);
      if (shape === target) wavers.add(shape, p.x, QUAY_TOP, p.z, q.yaw + (r() - 0.5) * 0.5, r, false, shade);
    } else if (kind < 0.26) {
      const p = spot(q, a, 0.2);
      addPerson(shape, p.x, QUAY_TOP + 0.02, p.z, q.yaw, r, { pose: "fish" });
    } else if (kind < 0.5) {
      // Two in talk.
      const p = spot(q, a, 4.6 + r() * 3.6);
      const turn = r() * 6;
      const on = shape === target ? shade : undefined;
      addPerson(shape, p.x, QUAY_TOP, p.z, turn, r, { shade: on });
      addPerson(shape, p.x + Math.sin(turn) * 0.8, QUAY_TOP, p.z + Math.cos(turn) * 0.8, turn + Math.PI, r, {
        shade: on,
      });
    } else {
      const p = spot(q, a, 4.6 + r() * 4);
      const way = q.yaw + (r() < 0.5 ? 1 : -1) * (Math.PI / 2) + (r() - 0.5) * 0.3;
      addPerson(shape, p.x, QUAY_TOP, p.z, way, r, { pose: "walk", shade: shape === target ? shade : undefined });
    }
  }
  for (let a = -span; a < q.len + span; a += 8) {
    const p = spot(q, a, 0.8);
    addBollard(shape, p.x, QUAY_TOP, p.z);
  }
  for (let a = -span + 5; a < q.len + span; a += 26) {
    const p = spot(q, a, 2.2);
    addLampPost(shape, p.x, QUAY_TOP, p.z, q.yaw);
  }
  for (let a = -span + 14; a < q.len + span; a += 26) {
    const p = spot(q, a, 6.4);
    addBench(shape, p.x, QUAY_TOP, p.z, q.yaw);
    if (r() < crowd * 0.6)
      addPerson(shape, p.x + q.ux * 0.3, QUAY_TOP + 0.48, p.z + q.uz * 0.3, q.yaw, r, { pose: "sit" });
  }
  // Fish boxes and nets on the quay's edge.
  const crate = [0x3a6ea5, 0xf6f2ea, 0xd94a3a, 0x2d8a7a, 0xf2c14e];
  for (let a = -span + 10; a < q.len + span; a += 17 + r() * 16) {
    const p = spot(q, a + r() * 4, 1.8 + r() * 1.2);
    const turn = q.yaw + (r() - 0.5);
    const stack = 1 + Math.floor(r() * 3);
    for (let k = 0; k < stack; k++)
      shape.take(
        box(0.9, 0.36, 0.6),
        new THREE.Color(pick(crate, r)),
        place(p.x, QUAY_TOP + k * 0.36, p.z, turn + (r() - 0.5) * 0.3),
        { uv: TILE.white },
      );
    const n = spot(q, a + 2.2, 2.2);
    shape.take(
      new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      WHITE,
      place(n.x, QUAY_TOP, n.z, turn, 1.1, 0.5, 0.8),
      { uv: TILE.net, flat: true },
    );
  }
  if (season === "winter" || season === "fall") return;
  // Cafe terraces: tables under parasols in front of the shops.
  const parasol = [0xf6f2ea, 0xf2c14e, 0xd94a3a, 0x2a8fb0];
  for (let a = -span + 20; a < q.len + span - 10; a += 30 + r() * 30) {
    const colour = new THREE.Color(pick(parasol, r));
    for (let k = 0; k < 3; k++) {
      const p = spot(q, a + k * 3.4, 7.6);
      shape.take(post(0.5, 0.5, 0.06, 8), new THREE.Color(0xf4efe2), place(p.x, QUAY_TOP + 0.74, p.z), {
        uv: TILE.white,
      });
      shape.take(post(0.04, 0.04, 2.5, 4), new THREE.Color(0xf4efe2), place(p.x, QUAY_TOP, p.z), { uv: TILE.white });
      shape.take(new THREE.ConeGeometry(1.5, 0.55, 8).translate(0, 0.28, 0), colour, place(p.x, QUAY_TOP + 2.3, p.z), {
        uv: TILE.white,
        flat: true,
      });
      if (shape === target) shades.add(p.x, QUAY_TOP, p.z, 1.5, 2.3, PAVING);
      for (const side of [-0.8, 0.8]) {
        const cx = p.x + q.ux * side;
        const cz = p.z + q.uz * side;
        shape.take(box(0.42, 0.45, 0.42), new THREE.Color(0x8a6a46), place(cx, QUAY_TOP, cz), { uv: TILE.white });
        // Facing each other across the table.
        if (r() < crowd * 0.7)
          addPerson(shape, cx, QUAY_TOP + 0.46, cz, Math.atan2(-q.ux * side, -q.uz * side), r, { pose: "sit" });
      }
    }
  }
}

/** The part of `outline` at least `inland` from the water (a terrace's footprint). */
function behind(q: Quay, outline: THREE.Vector2[], inland: number): THREE.Vector2[] {
  const depth = (p: THREE.Vector2) => q.l.radius - ((p.x - q.l.ax) * q.nx + (p.y - q.l.az) * q.nz) - inland;
  const out: THREE.Vector2[] = [];
  outline.forEach((p, i) => {
    const next = outline[(i + 1) % outline.length]!;
    const a = depth(p);
    const b = depth(next);
    if (a >= 0) out.push(p);
    if (a >= 0 !== b >= 0) out.push(p.clone().lerp(next, a / (a - b)));
  });
  return out;
}

export interface Town {
  group: THREE.Group;
}

/** The town on the quay `l`, as it is in `season`, with as many people out as `crowd` (0-1) says. */
export function buildTown(
  l: LandData,
  seed: number,
  season: Season,
  crowd: number,
  wavers: Crowd,
  life: Life,
  /** Ground to leave bare of houses, street furniture and people (something else stands there). */
  clear: (x: number, z: number) => boolean = () => false,
  /** Which way shade falls. */
  light: Sunlight = OVERHEAD,
  /** The landmark on its waterfront, if it has one. */
  landmark: Landmark | null = null,
): Town {
  const group = new THREE.Group();
  const q = quayOf(l);
  const r = random(seed);
  // The waterfront (what casts shadows on the promenade and shows in the water), and the town up the hill.
  const shape = new Shape();
  const uphill = new Shape();

  // The quay: its top, its face of dressed stone (wet below), and the coping along its edge.
  const outline = capsuleOutline(l, 24);
  const top = prism(outline, QUAY_TOP - 0.5, QUAY_TOP);
  shape.take(top, PAVING, undefined, { uv: TILE.white, flat: true });
  const edge = capsuleEdge(l, l.radius, 4);
  const corner = (i: number, y: number, out = 0) => {
    const p = edge[i % edge.length]!;
    return new THREE.Vector3(p.x + p.nx * out, y, p.z + p.nz * out);
  };
  for (let i = 0; i < edge.length; i++) {
    shape.quad(corner(i, -6), corner(i + 1, -6), corner(i + 1, 0.55), corner(i, 0.55), STONE_WET);
    shape.quad(
      corner(i, 0.55),
      corner(i + 1, 0.55),
      corner(i + 1, QUAY_TOP - 0.2),
      corner(i, QUAY_TOP - 0.2),
      STONE,
      TILE.stone,
    );
    shape.quad(
      corner(i, QUAY_TOP - 0.2, 0.15),
      corner(i + 1, QUAY_TOP - 0.2, 0.15),
      corner(i + 1, QUAY_TOP + 0.04, 0.15),
      corner(i, QUAY_TOP + 0.04, 0.15),
      COPING,
    );
    shape.quad(
      corner(i, QUAY_TOP + 0.04, 0.15),
      corner(i + 1, QUAY_TOP + 0.04, 0.15),
      corner(i + 1, QUAY_TOP + 0.04, -0.6),
      corner(i, QUAY_TOP + 0.04, -0.6),
      COPING,
    );
  }
  // The terraces the upper town stands on: retaining walls of stone, cobbled on top.
  for (const [inland, y] of TERRACES) {
    const foot = behind(q, capsuleOutline({ ...l, radius: l.radius - 1.5 }, 12), inland);
    if (foot.length < 3) continue;
    uphill.take(prism(foot, QUAY_TOP - 0.3, y), (_p, n) => (n.y > 0.5 ? COBBLES : STONE), undefined, {
      uv: TILE.white,
      flat: true,
    });
  }

  // The church stands on the upper terraces, its tower over the roofs.
  const churchAlong = q.len * 0.42;
  const churchInland = 79;
  const church = quayPoint(q, churchAlong, churchInland);
  addChurch(uphill, church.x, groundAt(churchInland - 10), church.z, q.yaw);

  // The landmark's lot on the waterfront, kept free of houses, trees and street furniture.
  const plot = landmark ? (landmark.kind === "market" ? MARKET_HALL : FISH_MARKET) : null;
  const lot =
    landmark && plot
      ? { from: landmark.along - plot.width / 2 - 0.8, to: landmark.along + plot.width / 2 + 0.8 }
      : null;
  const front = ROWS[0]!.inland - ROWS[0]!.depth / 2;
  const free = (x: number, z: number) => {
    if (clear(x, z)) return true;
    if (!lot) return false;
    const along = (x - l.ax) * q.ux + (z - l.az) * q.uz;
    const inland = l.radius - ((x - l.ax) * q.nx + (z - l.az) * q.nz);
    return along > lot.from && along < lot.to && inland > 4.2 && inland < front + 1;
  };
  if (landmark && plot) {
    const p = quayPoint(q, landmark.along, front + plot.depth / 2 - (landmark.kind === "market" ? 1.2 : 0));
    if (landmark.kind === "market") addMarketHall(shape, p.x, QUAY_TOP, p.z, q.yaw, life, r);
    else {
      addFishMarket(shape, p.x, QUAY_TOP, p.z, q.yaw, front, r);
      // Gulls on its ridge, waiting for the boats.
      for (const dx of [-9.5, -6, 1.5, 4]) {
        const g = quayPoint(q, landmark.along + dx, front + plot.depth / 2);
        addGull(shape, g.x, QUAY_TOP + 6.55, g.z, q.yaw + dx * 1.7);
      }
    }
  }
  // The houses, row by row, with streets between them.
  ROWS.forEach((row, k) => {
    if (row.inland + row.depth / 2 > l.radius * 2 - 6) return;
    const y = groundAt(row.inland - row.depth / 2);
    const span = reach(q, row.inland + (row.inland < l.radius ? -row.depth / 2 : row.depth / 2)) - 5;
    let a = -span;
    let untilStreet = 28 + r() * 20;
    while (a < q.len + span - 5) {
      let w = Math.min(5.6 + r() * 4.2, q.len + span - a);
      if (k === 0 && lot && a < lot.to && a + w > lot.from) {
        // Up to the landmark's lot, then on past it.
        if (lot.from - a < 4.4) {
          a = lot.to;
          continue;
        }
        w = lot.from - a;
      }
      // Leave the church its place, and the square in front of it.
      const mid = a + w / 2;
      const byChurch = Math.abs(mid - churchAlong - 2.5) < 13 && row.inland > churchInland - 26;
      const p = quayPoint(q, mid, row.inland);
      if (!byChurch && !clear(p.x, p.z)) {
        const [lo, hi] = row.storeys;
        addHouse(
          k < 2 ? shape : uphill,
          p.x,
          y,
          p.z,
          q.yaw,
          w,
          row.depth,
          lo + Math.floor(r() * (hi - lo + 1)),
          r,
          k === 0,
          season,
          life,
        );
      }
      a += w + (r() < 0.3 ? 0.4 : 0);
      untilStreet -= w;
      if (untilStreet < 0) {
        a += 3.6 + r() * 1.4;
        untilStreet = 30 + r() * 26;
      }
    }
  });
  const shades = new Grounding(light);
  addPromenade(shape, q, r, season, crowd, wavers, free, shades);
  // A few walk the promenade up and down, between the lamps and the palms.
  const walkers = new Walkers();
  const lane = 3.7;
  const room = reach(q, lane) - 8;
  const strolling = Math.round(((q.len + room * 2) / 34) * Math.min(1, crowd * 1.4));
  for (let i = 0; i < strolling; i++) {
    const beat = 26 + r() * 30;
    const from = -room + r() * Math.max(1, q.len + room * 2 - beat);
    const way = r() < 0.5 ? 1 : -1;
    const pace = 1.05 + r() * 0.5;
    const dressed = Math.floor(r() * 9000);
    let open = true;
    for (let a = 0; a <= beat; a += 3) {
      const p = quayPoint(q, from + a, lane);
      if (clear(p.x, p.z)) open = false;
    }
    if (!open) continue;
    const start = quayPoint(q, way > 0 ? from : from + beat, lane + (r() - 0.5) * 0.5);
    walkers.add(start.x, QUAY_TOP, start.z, q.ux * way, q.uz * way, beat, pace, dressed, PAVING);
  }
  // Flags on the promenade in front of the town's middle, and a bakery's chimney up the hill.
  const flags = [[0x2d8a9a, 0xf6f2ea, 0xf08a3c], COSTA_NEVADA, [0x7a5aa8, 0xf2c14e]];
  flags.forEach((colours, i) => {
    const p = quayPoint(q, q.len * 0.5 + (i - 1) * 3.2, 3.4);
    shape.take(post(0.07, 0.05, 8, 5), IRON, place(p.x, QUAY_TOP, p.z), { uv: TILE.white });
    life.flag(p.x, QUAY_TOP + 7.9, p.z, 2.4, 1.5, colours);
  });
  const stack = quayPoint(q, q.len * 0.72, 61);
  uphill.take(post(0.75, 0.5, 13, 6), new THREE.Color(0xb86a4a), place(stack.x, groundAt(61), stack.z), {
    uv: TILE.white,
  });
  group.add(shape.mesh(townMaterial()));
  const upper = uphill.mesh(townMaterial(), "receive");
  upper.layers.set(UNREFLECTED);
  group.add(upper);

  // Palms along the promenade, cypresses by the church, pines behind the last roofs.
  const palms = new Planting({ shadows: true, reflected: true });
  const plants = new Planting();
  const span = reach(q, 5) - 6;
  for (let a = -span + 3; a < q.len + span; a += 12.5 + r() * 3) {
    const p = quayPoint(q, a, 4.6);
    if (free(p.x, p.z)) continue;
    const tall = 6.2 + r() * 2.6;
    palms.add("palm", p.x, QUAY_TOP, p.z, tall, 0.9 + r() * 0.2);
    shades.add(p.x, QUAY_TOP, p.z, 2.1, tall * 0.9, PAVING);
  }
  for (const [da, di] of [
    [-9, -8],
    [-11, 2],
    [15, -6],
    [17, 4],
    [13, 12],
  ] as const) {
    const p = quayPoint(q, churchAlong + da, churchInland + di);
    plants.add("cypress", p.x, groundAt(churchInland + di), p.z, 9 + r() * 5, 0.9 + r() * 0.2);
  }
  const back = l.radius * 2 - 9;
  const backSpan = reach(q, back) - 4;
  for (let a = -backSpan; a < q.len + backSpan; a += 9 + r() * 8) {
    const p = quayPoint(q, a, back + r() * 4);
    plants.add(r() < 0.3 ? "cypress" : "pine", p.x, groundAt(back) - 0.5, p.z, 8 + r() * 4, 0.88 + r() * 0.2);
  }
  group.add(palms.build(true), plants.build(true));
  const shade = shades.build();
  if (shade) group.add(shade);
  const strollers = walkers.build();
  if (strollers) group.add(strollers);
  return { group };
}
