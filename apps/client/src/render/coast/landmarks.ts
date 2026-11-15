// Landmarks of the coast, in the town's material (facades.ts): the old
// watchtower on the cape's point, and the hermitage on the bay's islet.
import * as THREE from "three/webgpu";
import { TILE, house } from "./facades.ts";
import { Local, type Shape, box, place, post } from "./shape.ts";

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
  shape.take(post(0.06, 0.04, 4.6, 5), IRON, place(x, y + 12.2, z), { uv: TILE.white });
}

/** Where the watchtower's flag flies from: the top of its staff, over its foot. */
export const WATCHTOWER_STAFF = 16.6;

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
