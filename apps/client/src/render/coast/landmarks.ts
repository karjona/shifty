// Landmarks of the coast, in the town's material (facades.ts): the old
// watchtower on the cape's point, the hermitage on the bay's islet, the
// market hall on the bay's waterfront and the fish market on the cape's
// harbour; and gulls standing on what they like to stand on.
import * as THREE from "three/webgpu";
import { llaut } from "./boats.ts";
import { TILE, house } from "./facades.ts";
import { COSTA_NEVADA, type Life } from "./life.ts";
import { Local, type Shape, box, pick, place, post, turned } from "./shape.ts";

const SANDSTONE = new THREE.Color(0xdcc496);
const SANDSTONE_DARK = new THREE.Color(0xc4aa7c);
const IRON = 0x3a3f46;

/**
 * The old watchtower (torre de guaita): a round tower of dressed
 * sandstone, battered at its foot, its door high up the wall, a ring of
 * corbels under the parapet and its merlons. The platform is 12.2 m up,
 * the merlons' tops 13.4 m.
 */
export function addWatchtower(shape: Shape, x: number, y: number, z: number, yaw: number): void {
  const sides = 12;
  const rows: [number, number][] = [
    [4.3, -1.5],
    [3.75, 2],
    [3.45, 4.5],
    [3.3, 7],
    [3.2, 9.4],
    [3.15, 11],
  ];
  const at = (k: number, i: number, out = 0) => {
    const a = yaw + (i / sides) * Math.PI * 2;
    const [r, h] = rows[k]!;
    return new THREE.Vector3(x + Math.sin(a) * (r + out), y + h, z + Math.cos(a) * (r + out));
  };
  for (let i = 0; i < sides; i++) {
    const tone = i % 3 === 0 ? SANDSTONE_DARK : SANDSTONE;
    for (let k = 0; k < rows.length - 1; k++)
      shape.quad(at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k + 1, i), tone, TILE.ashlar);
  }
  // The corbels and the parapet they carry, out over the wall.
  const around = (r: number, h: number, i: number) => {
    const a = yaw + (i / sides) * Math.PI * 2;
    return new THREE.Vector3(x + Math.sin(a) * r, y + h, z + Math.cos(a) * r);
  };
  const ring = (r0: number, r1: number, y0: number, y1: number, paint: THREE.Color, uv = TILE.white) => {
    for (let i = 0; i < sides; i++)
      shape.quad(around(r0, y0, i), around(r0, y0, i + 1), around(r1, y1, i + 1), around(r1, y1, i), paint, uv);
  };
  ring(3.15, 3.75, 11, 11.5, SANDSTONE_DARK);
  ring(3.75, 3.75, 11.5, 12.6, SANDSTONE, TILE.ashlar);
  ring(3.75, 3.3, 12.6, 12.6, SANDSTONE_DARK);
  ring(3.3, 3.3, 12.6, 12.2, SANDSTONE_DARK);
  ring(3.3, 0.01, 12.2, 12.2, SANDSTONE_DARK);
  for (let i = 0; i < sides; i += 2) {
    const a = yaw + ((i + 0.5) / sides) * Math.PI * 2;
    shape.take(box(1.3, 0.8, 0.5), SANDSTONE, place(x + Math.sin(a) * 3.5, y + 12.6, z + Math.cos(a) * 3.5, a), {
      uv: TILE.white,
    });
  }
  for (let i = 0; i < sides * 2; i++) {
    const a = yaw + (i / (sides * 2)) * Math.PI * 2;
    shape.take(box(0.32, 0.5, 0.5), SANDSTONE_DARK, place(x + Math.sin(a) * 3.4, y + 10.6, z + Math.cos(a) * 3.4, a), {
      uv: TILE.white,
    });
  }
  // The door, up a ladder's height, and slits to watch the sea from.
  const L = new Local(shape, x, y, z, yaw);
  L.front(-0.75, 0.75, 4.9, 7.4, 3.5, SANDSTONE, TILE.portal);
  L.box(0, 4.6, 3.75, 1.9, 0.3, 0.9, SANDSTONE_DARK);
  for (const turn of [1.6, 3.1, 4.6]) {
    const S = new Local(shape, x, y, z, yaw + turn);
    S.box(0, 7.6, 3.3, 0.22, 1.1, 0.2, new THREE.Color(0x3a3340));
  }
  // The flagstaff on the platform.
  shape.take(post(0.07, 0.04, 7, 5), IRON, place(x, y + 12.2, z), { uv: TILE.white });
}

/** Where the watchtower's flag flies from: the top of its staff, over its foot. */
export const WATCHTOWER_STAFF = 19;

/** The hermitage on the islet: a whitewashed chapel under a tiled gable, a bell gable over its door, facing `yaw`. */
export function addHermitage(shape: Shape, x: number, y: number, z: number, yaw: number): void {
  const L = new Local(shape, x, y, z, yaw);
  const white = new THREE.Color(0xf6f2ea);
  const side = new THREE.Color(0xeee8dc);
  const tiles = house(1);
  const w = 3.6;
  const d = 5;
  const h = 2.9;
  const peak = h + 1.3;
  const zf = d / 2;
  const zb = -d / 2;
  const foot = -1.5;
  // The front: the door, and the bell gable rising over the roof.
  L.front(-w / 2, w / 2, foot, 0, zf, side);
  L.front(-w / 2, -0.75, 0, h, zf, white);
  L.front(0.75, w / 2, 0, h, zf, white);
  L.front(-0.75, 0.75, 0, h, zf, white, tiles.door);
  L.quad([-w / 2, h, zf], [w / 2, h, zf], [0, peak, zf], [0, peak, zf], white);
  L.box(0, peak - 0.5, zf - 0.15, 1.5, 2.1, 0.5, white);
  L.front(-0.6, 0.6, peak - 0.3, peak + 1.4, zf + 0.11, white, TILE.belfry);
  L.take(
    new THREE.CylinderGeometry(0.01, 1.1, 0.55, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.4),
    new THREE.Color(0xc96a40),
    0,
    peak + 1.87,
    zf - 0.15,
    true,
  );
  L.box(0, peak + 2.1, zf - 0.15, 0.08, 0.8, 0.08, IRON);
  L.box(0, peak + 2.55, zf - 0.15, 0.45, 0.08, 0.08, IRON);
  // The sides, a window each, the back, and the roof.
  for (const sx of [-1, 1]) {
    const px = (sx * w) / 2;
    const [from, to] = sx > 0 ? [zf, zb] : [zb, zf];
    L.quad([px, foot, from], [px, foot, to], [px, h, to], [px, h, from], side);
    const mid = Math.sign(from - to) * 1.3;
    L.quad(
      [px + sx * 0.03, 0.2, mid],
      [px + sx * 0.03, 0.2, -mid],
      [px + sx * 0.03, 2.8, -mid],
      [px + sx * 0.03, 2.8, mid],
      side,
      tiles.small,
    );
    const e = 0.4;
    const [fa, fb] = sx > 0 ? [zf + e, zb - e] : [zb - e, zf + e];
    L.quad(
      [px + sx * e, h - 0.25, fa],
      [px + sx * e, h - 0.25, fb],
      [0, peak + 0.1, fb],
      [0, peak + 0.1, fa],
      new THREE.Color(0xffffff),
      TILE.roof,
    );
  }
  L.quad([w / 2, foot, zb], [-w / 2, foot, zb], [-w / 2, h, zb], [w / 2, h, zb], side);
  L.quad([w / 2, h, zb], [-w / 2, h, zb], [0, peak, zb], [0, peak, zb], side);
  // A stone bench by the door.
  L.box(1.2, 0, zf + 0.6, 1.2, 0.45, 0.5, new THREE.Color(0xd6cdb8));
}

const TRIM = new THREE.Color(0xf1eadb);
const WHITE = new THREE.Color(0xffffff);
const TILES_TINT = new THREE.Color(0xf4f0ea);

/** A waterfront landmark's lot: how wide it is along the quay and how deep (m). */
export const MARKET_HALL = { width: 23, depth: 12.5 };
export const FISH_MARKET = { width: 30, depth: 10.5 };

/**
 * The market hall: an arcaded hall of ochre stucco and white stone under a
 * hipped tile roof with a lantern along its ridge, a frontispiece with the
 * town clock and a flag over its doors, and striped awnings out over the
 * stalls on either side. Its middle at `(x, y, z)`, its front (toward
 * `yaw`) half its depth ahead.
 */
export function addMarketHall(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  life: Life,
  r: () => number,
): void {
  const L = new Local(shape, x, y, z, yaw);
  const tiles = house(0);
  const wall = new THREE.Color(0xf0cf96);
  const side = wall.clone().multiplyScalar(0.95);
  const w = MARKET_HALL.width;
  const d = MARKET_HALL.depth;
  const x0 = -w / 2;
  const zf = d / 2;
  const zb = -d / 2;
  const base = 0.5;
  const arcade = 5.2;
  const eaves = 8.4;
  // The steps it stands on.
  L.box(0, 0, 0, w + 1.6, 0.25, d + 1.6, SANDSTONE);
  L.box(0, 0.25, 0, w + 0.8, 0.25, d + 0.8, TRIM);
  // The front: three arches either side of the frontispiece, a row of windows over them.
  const bays = 7;
  const bay = w / bays;
  for (let b = 0; b < bays; b++) {
    if (b === 3) continue;
    const b0 = x0 + b * bay;
    L.front(b0, b0 + bay, base, arcade, zf, wall, tiles.arcade);
    L.front(b0, b0 + bay, arcade, eaves, zf, wall, tiles.window);
    L.box(b0 + (b < 3 ? 0 : bay), base, zf + 0.06, 0.42, eaves - base, 0.24, TRIM);
  }
  L.box(0, arcade - 0.1, zf + 0.1, w + 0.3, 0.28, 0.3, TRIM);
  L.box(0, eaves - 0.1, zf + 0.16, w + 0.6, 0.34, 0.5, TRIM);
  // The frontispiece: the doors, the clock in its gable, a staff for the flag.
  const fw = bay + 2.2;
  const fz = zf + 0.7;
  const gable = eaves + 3.4;
  L.front(-fw / 2, fw / 2, base, 6.4, fz, TRIM, TILE.portal);
  L.front(-fw / 2, fw / 2, 6.4, gable - 0.4, fz, wall);
  L.front(-1.55, 1.55, eaves - 1.3, eaves + 1.8, fz + 0.04, WHITE, TILE.clock);
  L.quad(
    [-fw / 2 - 0.3, gable - 0.4, fz],
    [fw / 2 + 0.3, gable - 0.4, fz],
    [0, gable + 1.7, fz],
    [0, gable + 1.7, fz],
    TRIM,
  );
  for (const sx of [-1, 1]) {
    const px = (sx * fw) / 2;
    const [from, to] = sx > 0 ? [fz, zf] : [zf, fz];
    L.quad([px, base, from], [px, base, to], [px, gable - 0.4, to], [px, gable - 0.4, from], side);
    L.box(px, base, fz + 0.05, 0.5, gable - 0.4 - base, 0.3, TRIM);
  }
  L.quad(
    [-fw / 2, gable - 0.4, fz],
    [fw / 2, gable - 0.4, fz],
    [fw / 2, gable - 0.4, zf - 2],
    [-fw / 2, gable - 0.4, zf - 2],
    TRIM,
  );
  L.box(0, gable + 1.6, fz - 0.2, 0.1, 3.4, 0.1, IRON);
  const staff = L.p(0, gable + 5, fz - 0.2);
  life.flag(staff.x, staff.y, staff.z, 2.6, 1.6, COSTA_NEVADA);
  // The sides and the back.
  for (const [sx, from, to] of [
    [w / 2, zf, zb],
    [-w / 2, zb, zf],
  ] as const) {
    L.quad([sx, -4, from], [sx, -4, to], [sx, base, to], [sx, base, from], side);
    const n = 3;
    for (let k = 0; k < n; k++) {
      const z0 = from + ((to - from) * k) / n;
      const z1 = from + ((to - from) * (k + 1)) / n;
      L.quad([sx, base, z0], [sx, base, z1], [sx, arcade, z1], [sx, arcade, z0], side, tiles.arcade);
      L.quad([sx, arcade, z0], [sx, arcade, z1], [sx, eaves, z1], [sx, eaves, z0], side, tiles.window);
    }
  }
  L.quad([w / 2, -4, zb], [-w / 2, -4, zb], [-w / 2, eaves, zb], [w / 2, eaves, zb], side, tiles.wall);
  // The roof: hipped, with a lantern along its ridge.
  const e = 0.6;
  const ridge = eaves + 3;
  const hip = 4.2;
  L.quad(
    [x0 - e, eaves, zf + e],
    [-x0 + e, eaves, zf + e],
    [-x0 - hip, ridge, 0],
    [x0 + hip, ridge, 0],
    TILES_TINT,
    TILE.roof,
  );
  L.quad(
    [-x0 + e, eaves, zb - e],
    [x0 - e, eaves, zb - e],
    [x0 + hip, ridge, 0],
    [-x0 - hip, ridge, 0],
    TILES_TINT,
    TILE.roof,
  );
  L.quad(
    [-x0 + e, eaves, zf + e],
    [-x0 + e, eaves, zb - e],
    [-x0 - hip, ridge, 0],
    [-x0 - hip, ridge, 0],
    TILES_TINT,
    TILE.roof,
  );
  L.quad(
    [x0 - e, eaves, zb - e],
    [x0 - e, eaves, zf + e],
    [x0 + hip, ridge, 0],
    [x0 + hip, ridge, 0],
    TILES_TINT,
    TILE.roof,
  );
  const lw = w - hip * 2 - 1.5;
  for (const sz of [-1, 1]) {
    const lz = sz * 1.3;
    const [a, b] = sz > 0 ? [-lw / 2, lw / 2] : [lw / 2, -lw / 2];
    L.quad([a, ridge - 0.9, lz], [b, ridge - 0.9, lz], [b, ridge + 0.7, lz], [a, ridge + 0.7, lz], TRIM, tiles.small);
    L.quad(
      [a, ridge + 0.6, sz * 1.7],
      [b, ridge + 0.6, sz * 1.7],
      [b, ridge + 1.3, 0],
      [a, ridge + 1.3, 0],
      TILES_TINT,
      TILE.roofOld,
    );
  }
  for (const sx of [-1, 1])
    L.quad(
      [(sx * lw) / 2, ridge - 0.9, sx * 1.3],
      [(sx * lw) / 2, ridge - 0.9, -sx * 1.3],
      [(sx * lw) / 2, ridge + 1.3, 0],
      [(sx * lw) / 2, ridge + 1.3, 0],
      TRIM,
    );
  // Awnings out over the stalls on either side, their skirts in the wind; crates of fruit under them.
  const fruit = [0xf08a3c, 0xd94a3a, 0x7fae4a, 0xf2c14e, 0x8a4a8a];
  for (const sx of [-1, 1]) {
    const a0 = sx > 0 ? fw / 2 + 0.4 : x0 + 0.3;
    const a1 = sx > 0 ? -x0 - 0.3 : -fw / 2 - 0.4;
    const out = zf + 3.2;
    L.quad([a0, 3.2, out], [a1, 3.2, out], [a1, 4.5, zf + 0.05], [a0, 4.5, zf + 0.05], WHITE, TILE.awnings[1]);
    L.quad(
      [a1, 3.2, out],
      [a0, 3.2, out],
      [a0, 4.5, zf + 0.05],
      [a1, 4.5, zf + 0.05],
      new THREE.Color(0xb9b4c4),
      TILE.awnings[1],
    );
    life.valance(L.p(a0, 3.2, out), L.p(a1, 3.2, out), 0.42, [0xf6f2ea, 0xd94a3a]);
    for (const px of [a0 + 0.1, a1 - 0.1]) L.box(px, 0.5, out - 0.1, 0.08, 2.7, 0.08, IRON);
    for (let px = a0 + 1; px < a1 - 0.8; px += 1.9) {
      L.box(px, 0.5, zf + 2.1, 1.5, 0.75, 1.0, new THREE.Color(0x9a7a52));
      for (const cx of [-0.38, 0.38]) L.box(px + cx, 1.25, zf + 2.1, 0.66, 0.2, 0.85, new THREE.Color(pick(fruit, r)));
    }
  }
}

/**
 * The fish market on the harbour: a long white shed with a blue dado,
 * wide doors and a tiled roof, the fish on a board over its middle; the
 * ice house at its end with a chute to the quay, a crane at the quay's
 * edge, crates in stacks, nets on their racks and a boat hauled out on
 * trestles. Its middle at `(x, y, z)`, its front (toward `yaw`) half its
 * depth ahead; the quay's edge is `edge` m in front of that.
 */
export function addFishMarket(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  edge: number,
  r: () => number,
): void {
  const L = new Local(shape, x, y, z, yaw);
  const wall = new THREE.Color(0xf4efe2);
  const dado = new THREE.Color(0x3f74aa);
  const w = FISH_MARKET.width - 7.5;
  const d = FISH_MARKET.depth;
  const cx = -3.2;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const zf = d / 2;
  const zb = -d / 2;
  const eaves = 4.3;
  const ridge = 6.5;
  // The shed: doors to the quay between piers, the last bay open on the dark inside.
  const bays = 5;
  const bay = w / bays;
  for (let b = 0; b < bays; b++) {
    const b0 = x0 + b * bay;
    if (b === 1 || b === 3) {
      L.front(b0 + 0.3, b0 + bay - 0.3, 0, 3.5, zf - 1.2, new THREE.Color(0x2a2c38));
      L.quad([b0 + 0.3, 0, zf], [b0 + 0.3, 0, zf - 1.2], [b0 + 0.3, 3.5, zf - 1.2], [b0 + 0.3, 3.5, zf], dado);
      L.quad(
        [b0 + bay - 0.3, 0, zf - 1.2],
        [b0 + bay - 0.3, 0, zf],
        [b0 + bay - 0.3, 3.5, zf],
        [b0 + bay - 0.3, 3.5, zf - 1.2],
        dado,
      );
      L.front(b0, b0 + 0.3, 0, 3.5, zf, wall);
      L.front(b0 + bay - 0.3, b0 + bay, 0, 3.5, zf, wall);
    } else L.front(b0, b0 + bay, 0, 3.5, zf, wall, TILE.boathouse);
    L.front(b0, b0 + bay, 3.5, eaves, zf, wall);
  }
  L.box(cx, 0, zf + 0.04, w + 0.1, 0.9, 0.1, dado);
  // The gable ends and the back.
  for (const [sx, from, to] of [
    [x1, zf, zb],
    [x0, zb, zf],
  ] as const) {
    L.quad([sx, -4, from], [sx, -4, to], [sx, eaves, to], [sx, eaves, from], wall, house(1).wall);
    L.quad([sx, eaves, from], [sx, eaves, to], [sx, ridge, 0], [sx, ridge, 0], wall);
  }
  L.quad([x1, -4, zb], [x0, -4, zb], [x0, eaves, zb], [x1, eaves, zb], wall);
  const e = 0.7;
  L.quad(
    [x0 - e, eaves - 0.2, zf + e],
    [x1 + e, eaves - 0.2, zf + e],
    [x1 + e, ridge + 0.1, 0],
    [x0 - e, ridge + 0.1, 0],
    TILES_TINT,
    TILE.roofOld,
  );
  L.quad(
    [x1 + e, eaves - 0.2, zb - e],
    [x0 - e, eaves - 0.2, zb - e],
    [x0 - e, ridge + 0.1, 0],
    [x1 + e, ridge + 0.1, 0],
    TILES_TINT,
    TILE.roofOld,
  );
  // The board over its middle: the fish.
  L.box(cx, eaves + 0.3, zf + 0.5, 3.6, 1.9, 0.14, TRIM);
  L.front(cx - 1.6, cx + 1.6, eaves + 0.45, eaves + 2.05, zf + 0.58, WHITE, TILE.fish);
  // The ice house: a tower with a chute down toward the quay.
  const ix = x1 + 2.6;
  const tall = 8.2;
  for (let f = 0; f < 4; f++) {
    const F = new Local(shape, L.p(ix, 0, 0).x, y, L.p(ix, 0, 0).z, yaw + (f * Math.PI) / 2);
    F.front(-2, 2, -4, 0, 2, wall);
    F.front(-2, 2, 0, tall, 2, wall, f === 0 ? undefined : house(1).wall);
    F.front(-2, 2, 0, 0.9, 2.03, dado);
  }
  L.front(ix - 0.7, ix + 0.7, 0, 2.4, 2.04, WHITE, house(1).door);
  L.front(ix - 0.8, ix + 0.8, 5.6, 7.2, 2.04, WHITE, TILE.hatch);
  L.take(
    new THREE.ConeGeometry(3.3, 2, 4, 1).rotateY(Math.PI / 4).translate(0, 1, 0),
    new THREE.Color(0xc96a40),
    ix,
    tall,
    0,
    true,
  );
  shape.take(
    box(0.9, 0.25, 6.4),
    new THREE.Color(0x8b919b),
    turned(L.p(ix, 3.6, 4.6).x, y + 3.6, L.p(ix, 3.6, 4.6).z, 0.62, yaw, 0),
    {
      uv: TILE.white,
    },
  );
  for (const pz of [3.4, 6.2]) L.box(ix, 0, pz, 0.12, pz < 4 ? 4.4 : 2.3, 0.12, IRON);
  // On the quay in front: crates in stacks, nets on racks, a boat on trestles, the crane at the edge.
  const crate = [0x3a6ea5, 0xf6f2ea, 0xd94a3a, 0x2d8a7a, 0xf2c14e];
  for (let px = x0 + 1; px < x1 - 6; px += 2.3 + r() * 1.6) {
    const stack = 1 + Math.floor(r() * 4);
    const pz = zf + 1.4 + r() * 2.4;
    for (let k = 0; k < stack; k++)
      L.box(px + (r() - 0.5) * 0.1, k * 0.36, pz, 0.9, 0.36, 0.6, new THREE.Color(pick(crate, r)));
  }
  for (const px of [x0 + 2.5, x0 + 7.5]) {
    for (const dx of [-1.6, 1.6]) L.box(px + dx, 0, zf + 6.2, 0.1, 1.7, 0.1, new THREE.Color(0x8a6a46));
    L.box(px, 1.62, zf + 6.2, 3.4, 0.08, 0.08, new THREE.Color(0x8a6a46));
    L.front(px - 1.6, px + 1.6, 0.35, 1.62, zf + 6.2, WHITE, TILE.net);
    L.quad(
      [px + 1.6, 0.35, zf + 6.2],
      [px - 1.6, 0.35, zf + 6.2],
      [px - 1.6, 1.62, zf + 6.2],
      [px + 1.6, 1.62, zf + 6.2],
      WHITE,
      TILE.net,
    );
  }
  const boat = L.p(x1 - 2.2, 0, zf + 4.6);
  shape.take(llaut(63), null, turned(boat.x, y + 1.05, boat.z, 0, yaw + Math.PI / 2 + 0.12, 0.05), { uv: TILE.white });
  for (const dx of [-1.6, 1.6]) {
    const t = L.p(x1 - 2.2 + dx, 0, zf + 4.6);
    shape.take(box(0.14, 0.75, 1.5), new THREE.Color(0x8a6a46), place(t.x, y, t.z, yaw), { uv: TILE.white });
  }
  const crane = L.p(cx + 4, 0, zf + edge - 1.3);
  shape.take(post(0.2, 0.16, 3.4, 6), IRON, place(crane.x, y, crane.z), { uv: TILE.white });
  shape.take(box(0.16, 0.16, 3.4).translate(0, 0, 1.2), IRON, turned(crane.x, y + 3.3, crane.z, -0.35, yaw, 0), {
    uv: TILE.white,
  });
  shape.take(box(0.5, 0.45, 0.5), new THREE.Color(0xd94a3a), place(crane.x, y + 0.9, crane.z, yaw), { uv: TILE.white });
}

const GULL_BODY = new THREE.SphereGeometry(0.17, 6, 4).scale(0.8, 0.82, 1.5).translate(0, 0.27, 0);
const GULL_BACK = new THREE.SphereGeometry(0.16, 6, 3, 0, Math.PI * 2, 0, Math.PI * 0.5)
  .scale(0.84, 0.75, 1.75)
  .translate(0, 0.3, -0.07);
const GULL_HEAD = new THREE.SphereGeometry(0.085, 5, 4).translate(0, 0.47, 0.2);
const GULL_BEAK = new THREE.ConeGeometry(0.03, 0.13, 4).rotateX(Math.PI / 2).translate(0, 0.46, 0.33);

/** A gull standing at `(x, y, z)`, looking toward `yaw`. */
export function addGull(shape: Shape, x: number, y: number, z: number, yaw: number): void {
  const m = place(x, y, z, yaw);
  const uv = { uv: TILE.white };
  shape.add(GULL_BODY, 0xfbfaf6, m, uv);
  shape.add(GULL_BACK, 0xaab0ba, m, uv);
  shape.add(GULL_HEAD, 0xfbfaf6, m, uv);
  shape.add(GULL_BEAK, 0xf2b630, m, uv);
  for (const side of [-0.05, 0.05])
    shape.take(box(0.02, 0.16, 0.02), 0xf2b630, m.clone().multiply(place(side, 0, 0.02)), uv);
}
