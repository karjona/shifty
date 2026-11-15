// The beach: the bar (a timber hut under thatch on a deck, tables in the
// shade of a reed pergola; shuttered out of season), the lifeguard's tower,
// umbrellas and loungers in rows, striped bathing huts along the
// promenade, boats drawn up on the sand, a volleyball net, boardwalks, and
// the people the season and the weather bring. Built into the town's
// material (facades.ts) from a site that says where the sand is.
import * as THREE from "three/webgpu";
import type { Season } from "../../game/conditions.ts";
import { llaut } from "./boats.ts";
import { TILE } from "./facades.ts";
import { addBench, addLampPost } from "./harbour.ts";
import type { Life } from "./life.ts";
import type { Grounding } from "./grounding.ts";
import { type Crowd, type Walkers, addPerson } from "./people.ts";
import { Local, type Shape, box, pick, place, post, turned } from "./shape.ts";

/** Where the beach is: the point `inland` metres up the sand at `z` along the shore, and how far it runs. */
export interface BeachSite {
  at(z: number, inland: number): THREE.Vector3;
  from: number;
  to: number;
  /** The heading that faces the sea. */
  seaward: number;
}

const WOOD = new THREE.Color(0xb88a5c);
const WOOD_DARK = new THREE.Color(0x8a6a46);
const WHITE = new THREE.Color(0xf6f2ea);
const RED = new THREE.Color(0xd6402e);
const PLAIN = new THREE.Color(0xffffff);
const CANOPIES = [0x2a8fb0, 0xf2c14e, 0xd94a3a, 0x3f8a6a, 0xf08a3c, 0x7a5aa8];
/** The sand's colour under a figure's feet (its shade is small: one colour does). */
const SAND_SHADE = 0xecdbaf;

/** The beach bar, facing `yaw`: open (its counter served, the terrace laid) or shut up. */
export function addBeachBar(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  open: boolean,
  r: () => number,
): Local {
  const L = new Local(shape, x, y, z, yaw);
  // The deck, on short posts over the sand.
  L.box(0, 0.25, 0.5, 14, 0.2, 10, WOOD);
  for (const px of [-6.5, 0, 6.5]) for (const pz of [-4, 5]) L.box(px, -1, pz, 0.3, 1.3, 0.3, WOOD_DARK);
  const floor = 0.45;
  // The hut: planks, a counter across its front under a hatch.
  const w = 7;
  const d = 4.4;
  const zc = -1.8;
  const zf = zc + d / 2;
  const top = floor + 2.7;
  L.front(-w / 2, w / 2, floor, floor + 1.1, zf, WHITE, TILE.planks);
  L.front(-w / 2, w / 2, floor + 2.2, top, zf, WHITE, TILE.planks);
  for (const sx of [-1, 1])
    L.front(
      sx > 0 ? w / 2 - 0.5 : -w / 2,
      sx > 0 ? w / 2 : -w / 2 + 0.5,
      floor + 1.1,
      floor + 2.2,
      zf,
      WHITE,
      TILE.planks,
    );
  if (open) {
    // Inside: the back wall's shelves of bottles.
    L.front(-w / 2 + 0.5, w / 2 - 0.5, floor + 1.1, floor + 2.2, zf - 1.6, new THREE.Color(0x4a3a30));
    const bottles = [0x3f8a4a, 0xd94a3a, 0xf2c14e, 0x2a8fb0, 0xf6f2ea];
    for (let bx = -2.6; bx < 2.7; bx += 0.42)
      L.box(bx, floor + 1.5, zf - 1.5, 0.14, 0.38, 0.14, new THREE.Color(pick(bottles, r)));
  } else
    L.front(-w / 2 + 0.5, w / 2 - 0.5, floor + 1.1, floor + 2.2, zf - 0.05, new THREE.Color(0x4f86a8), TILE.planks);
  L.box(0, floor + 1.05, zf + 0.35, w + 0.4, 0.1, 0.8, WOOD_DARK);
  for (const [sx, from, to] of [
    [w / 2, zf, zc - d / 2],
    [-w / 2, zc - d / 2, zf],
  ] as const)
    L.quad([sx, floor, from], [sx, floor, to], [sx, top, to], [sx, top, from], WHITE, TILE.planks);
  L.quad(
    [w / 2, floor, zc - d / 2],
    [-w / 2, floor, zc - d / 2],
    [-w / 2, top, zc - d / 2],
    [w / 2, top, zc - d / 2],
    WHITE,
    TILE.planks,
  );
  // The thatch: a hipped roof wide over the counter.
  const e = 1.3;
  const ridge = top + 1.9;
  const x0 = -w / 2 - e;
  const x1 = w / 2 + e;
  const f = zf + e + 0.6;
  const b = zc - d / 2 - e;
  const hip = 2.6;
  L.quad([x0, top - 0.2, f], [x1, top - 0.2, f], [x1 - hip, ridge, zc], [x0 + hip, ridge, zc], PLAIN, TILE.thatch);
  L.quad([x1, top - 0.2, b], [x0, top - 0.2, b], [x0 + hip, ridge, zc], [x1 - hip, ridge, zc], PLAIN, TILE.thatch);
  L.quad([x1, top - 0.2, f], [x1, top - 0.2, b], [x1 - hip, ridge, zc], [x1 - hip, ridge, zc], PLAIN, TILE.thatch);
  L.quad([x0, top - 0.2, b], [x0, top - 0.2, f], [x0 + hip, ridge, zc], [x0 + hip, ridge, zc], PLAIN, TILE.thatch);
  for (const px of [x0 + 0.3, x1 - 0.3]) L.box(px, floor, f - 0.3, 0.2, top - floor - 0.2, 0.2, WOOD_DARK);
  // Its board over the counter, and boards leaning by the wall.
  L.front(-1.3, 1.3, top + 0.1, top + 1.5, zf + e + 0.5, PLAIN, TILE.sun);
  const boards = [0xf2c14e, 0x2a8fb0, 0xd94a3a];
  boards.forEach((c, i) =>
    shape.take(
      box(0.5, 2.3, 0.08),
      new THREE.Color(c),
      turned(L.p(w / 2 + 0.7 + i * 0.6, floor, zc).x, y + floor, L.p(w / 2 + 0.7 + i * 0.6, floor, zc).z, 0.22, yaw, 0),
      { uv: TILE.white },
    ),
  );
  if (open) {
    // Stools at the counter, tables under a pergola shaded with reeds.
    for (let i = -2; i <= 2; i++) L.box(i * 1.4, floor, zf + 1.1, 0.4, 0.75, 0.4, WOOD_DARK);
    const px0 = -6.4;
    const px1 = 6.4;
    const pz0 = 2.3;
    const pz1 = 5.3;
    for (const px of [px0, 0, px1]) for (const pz of [pz0, pz1]) L.box(px, floor, pz, 0.14, 2.5, 0.14, WOOD_DARK);
    L.quad(
      [px0 - 0.3, floor + 2.5, pz1 + 0.3],
      [px1 + 0.3, floor + 2.5, pz1 + 0.3],
      [px1 + 0.3, floor + 2.62, pz0 - 0.3],
      [px0 - 0.3, floor + 2.62, pz0 - 0.3],
      PLAIN,
      TILE.thatch,
    );
    L.quad(
      [px1 + 0.3, floor + 2.5, pz1 + 0.3],
      [px0 - 0.3, floor + 2.5, pz1 + 0.3],
      [px0 - 0.3, floor + 2.62, pz0 - 0.3],
      [px1 + 0.3, floor + 2.62, pz0 - 0.3],
      new THREE.Color(0xb8a48a),
      TILE.thatch,
    );
    for (const tx of [-4.6, -1.6, 1.6, 4.6]) {
      L.take(post(0.5, 0.5, 0.06, 8), WHITE, tx, floor + 0.72, 3.9);
      L.box(tx, floor, 3.9, 0.08, 0.72, 0.08, WOOD_DARK);
      for (const s of [-0.75, 0.75]) L.box(tx + s, floor, 3.9, 0.38, 0.45, 0.38, WOOD);
    }
  }
  return L;
}

/** The lifeguard's tower, facing `yaw`: a white hut on braced stilts with a red band, a ramp up to its deck. About 6 m tall. */
export function addLifeguardTower(shape: Shape, x: number, y: number, z: number, yaw: number): Local {
  const L = new Local(shape, x, y, z, yaw);
  for (const lx of [-1.2, 1.2]) for (const lz of [-1.2, 1.2]) L.box(lx, -0.5, lz, 0.2, 3.6, 0.2, WHITE);
  // Braces across the stilts.
  for (const turn of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const B = new Local(shape, x, y, z, yaw + turn);
    B.quad([-1.2, 0.3, 1.25], [-1.0, 0.3, 1.25], [1.2, 2.8, 1.25], [1.0, 2.8, 1.25], WHITE);
    B.quad([-1.0, 0.3, 1.2], [-1.2, 0.3, 1.2], [1.0, 2.8, 1.2], [1.2, 2.8, 1.2], WHITE);
  }
  L.box(0, 3.1, 0.4, 3.4, 0.16, 4.2, WOOD);
  // The hut: a red band round it, a wide window to the sea, a roof pitched back.
  L.box(0, 3.26, -0.3, 2.6, 0.9, 2.4, WHITE);
  L.box(0, 4.16, -0.3, 2.66, 0.35, 2.46, RED);
  L.box(0, 4.51, -0.3, 2.6, 0.75, 2.4, WHITE);
  L.front(-1.0, 1.0, 4.2, 5.1, 0.92, PLAIN, TILE.hatch);
  L.quad([-1.6, 5.2, 1.3], [1.6, 5.2, 1.3], [1.6, 5.75, -1.8], [-1.6, 5.75, -1.8], new THREE.Color(0x8a9aa8));
  L.quad([1.6, 5.2, 1.3], [-1.6, 5.2, 1.3], [-1.6, 5.75, -1.8], [1.6, 5.75, -1.8], new THREE.Color(0x6a7a88));
  // The rail round the deck, the ramp down to the sand, a rescue board.
  for (const [rx, rz, rw, rd] of [
    [0, 2.4, 3.4, 0.07],
    [-1.66, 1.3, 0.07, 2.2],
    [1.66, 1.3, 0.07, 2.2],
  ] as const)
    L.box(rx, 4.1, rz, rw, 0.07, rd, WHITE);
  for (const px of [-1.66, 1.66]) for (const pz of [0.9, 2.4]) L.box(px, 3.26, pz, 0.07, 0.9, 0.07, WHITE);
  L.quad([-0.6, 0, 6.6], [0.6, 0, 6.6], [0.6, 3.2, 2.5], [-0.6, 3.2, 2.5], WOOD);
  L.quad([0.6, 0, 6.6], [-0.6, 0, 6.6], [-0.6, 3.2, 2.5], [0.6, 3.2, 2.5], WOOD_DARK);
  L.box(1.5, 3.3, 0.6, 0.12, 1.9, 0.45, new THREE.Color(0xf2c14e));
  L.take(post(0.05, 0.04, 2.6, 5), WHITE, -1.5, 5.2, -1.3);
  return L;
}

/** Where the lifeguard's flag flies from: over the tower's foot, and across it. */
export const LIFEGUARD_FLAG = { x: -1.5, y: 7.6, z: -1.3 };

/** A sun umbrella at `(x, y, z)`, its canopy in gores of `colour` and white, with two loungers under it. */
function addUmbrella(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  colour: number,
  r: () => number,
): void {
  const a = new THREE.Color(colour);
  const tilt = (r() - 0.5) * 0.2;
  shape.take(post(0.04, 0.04, 2.3, 4), WHITE, place(x, y, z), { uv: TILE.white });
  const canopy = new THREE.ConeGeometry(1.55, 0.6, 8, 1).translate(0, 0.3, 0);
  const c = new THREE.Color();
  // (Each gore's plane faces its own way round the pole: its colour goes by that.)
  const gore = (_p: THREE.Vector3, n: THREE.Vector3) =>
    c.copy(Math.floor(((Math.atan2(n.z, n.x) + Math.PI) / (Math.PI * 2)) * 8) % 2 === 0 ? a : WHITE);
  shape.take(canopy, gore, turned(x, y + 2.15, z, tilt, 0, tilt * 0.5), { uv: TILE.white, flat: true });
  const L = new Local(shape, x, y, z, yaw);
  for (const side of [-1.0, 1.0]) {
    const bed = r() < 0.5 ? WHITE : a;
    L.box(side, 0.1, 0.2, 0.62, 0.22, 1.3, bed);
    L.quad(
      [side - 0.31, 0.32, -0.45],
      [side + 0.31, 0.32, -0.45],
      [side + 0.31, 0.78, -1.05],
      [side - 0.31, 0.78, -1.05],
      bed,
    );
    L.quad(
      [side + 0.31, 0.32, -0.45],
      [side - 0.31, 0.32, -0.45],
      [side - 0.31, 0.78, -1.05],
      [side + 0.31, 0.78, -1.05],
      bed,
    );
  }
}

/** A bathing hut: a striped cabin under a little gable, its door to the sea. */
function addHut(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  stripes: (typeof TILE.awnings)[number],
): void {
  const L = new Local(shape, x, y, z, yaw);
  const w = 2.1;
  const h = 2.2;
  L.front(-w / 2, w / 2, 0, h, w / 2, PLAIN, stripes);
  L.quad([w / 2, 0, w / 2], [w / 2, 0, -w / 2], [w / 2, h, -w / 2], [w / 2, h, w / 2], PLAIN, stripes);
  L.quad([-w / 2, 0, -w / 2], [-w / 2, 0, w / 2], [-w / 2, h, w / 2], [-w / 2, h, -w / 2], PLAIN, stripes);
  L.quad([w / 2, 0, -w / 2], [-w / 2, 0, -w / 2], [-w / 2, h, -w / 2], [w / 2, h, -w / 2], WHITE);
  L.quad([-w / 2, h, w / 2], [w / 2, h, w / 2], [0, h + 0.8, w / 2], [0, h + 0.8, w / 2], WHITE);
  L.box(0, 0, w / 2 + 0.02, 0.8, 1.8, 0.05, WHITE);
  for (const sx of [-1, 1]) {
    const px = sx * (w / 2 + 0.2);
    const [fa, fb] = sx > 0 ? [w / 2 + 0.25, -w / 2 - 0.1] : [-w / 2 - 0.1, w / 2 + 0.25];
    L.quad([px, h - 0.1, fa], [px, h - 0.1, fb], [0, h + 0.85, fb], [0, h + 0.85, fa], new THREE.Color(0xe8e2d6));
  }
}

/**
 * Everything on the beach `site`, into `shape`: `bar` and `lifeguard`
 * say where the bar and the tower stand (z along the shore, metres up the
 * sand). `crowd` (0-1) is how many people are out.
 */
export function addBeach(
  shape: Shape,
  site: BeachSite,
  bar: { z: number; inland: number },
  lifeguard: { z: number; inland: number },
  season: Season,
  crowd: number,
  wavers: Crowd,
  life: Life,
  /** The lifeguard's flag: green, yellow or red by the sea's state. */
  flag: number,
  r: () => number,
  /** Where shade is laid on the sand: the ground's colour and height at a place. */
  shades: { on: Grounding; colour: (x: number, z: number) => THREE.Color; ground: (x: number, z: number) => number },
  /** Those who walk along the water. */
  walkers: Walkers,
): void {
  const sea = site.seaward;
  const shade = { on: shades.on, colour: SAND_SHADE };
  const open = season === "summer" || season === "spring";
  const barAt = site.at(bar.z, bar.inland);
  const B = addBeachBar(shape, barAt.x, barAt.y - 0.2, barAt.z, sea, open, r);
  const towerAt = site.at(lifeguard.z, lifeguard.inland);
  const T = addLifeguardTower(shape, towerAt.x, towerAt.y, towerAt.z, sea);
  const staff = T.p(LIFEGUARD_FLAG.x, LIFEGUARD_FLAG.y, LIFEGUARD_FLAG.z);
  life.flag(staff.x, staff.y, staff.z, 1.5, 1, [flag]);
  if (open && crowd > 0.3) {
    const seat = T.p(0, 3.26, 1.6);
    addPerson(shape, seat.x, seat.y + 0.45, seat.z, sea, r, { pose: "sit", beach: true });
    T.box(0, 3.26, 1.35, 0.5, 0.45, 0.45, WHITE);
  }
  // Boardwalks from the promenade down to the bar and the tower.
  for (const z of [bar.z + 9, lifeguard.z - 6]) {
    for (let inland = 12; inland < 36; inland += 2) {
      const p = site.at(z, inland + 1);
      shape.take(box(2.05, 0.08, 1.6), WOOD, place(p.x, p.y + 0.02, p.z, sea + Math.PI / 2), { uv: TILE.planks });
    }
  }
  // Umbrellas in rows, fewer out of season; people under them.
  // (Nobody puts an umbrella up in the rain.)
  const rows = crowd < 0.25 ? [] : season === "summer" ? [11, 17, 23, 29] : season === "winter" ? [] : [14, 24];
  const court = { from: 52, to: 70 };
  for (const inland of rows) {
    for (let z = site.from + 14; z < site.to - 8; z += 6.5 + r() * 2.5) {
      if (Math.abs(z - bar.z) < 9 && inland > 20) continue;
      if (Math.abs(z - lifeguard.z) < 6 && inland < 26) continue;
      if (z > court.from - 4 && z < court.to + 4 && inland > 14) continue;
      if (season !== "summer" && r() < 0.5) continue;
      const p = site.at(z + (r() - 0.5) * 1.5, inland + (r() - 0.5) * 1.5);
      addUmbrella(shape, p.x, p.y, p.z, sea, pick(CANOPIES, r), r);
      shades.on.add(p.x, p.y, p.z, 1.5, 2.2, shades.colour, shades.ground, 0.07);
      if (r() < crowd) {
        const L = new Local(shape, p.x, p.y, p.z, sea);
        const side = r() < 0.5 ? -1 : 1;
        const on = L.p(side, 0.34, 0.25);
        addPerson(shape, on.x, on.y, on.z, sea + Math.PI, r, { pose: "lie", beach: true });
        if (r() < crowd * 0.6) {
          const by = L.p(-side, 0.32, 0.1);
          addPerson(shape, by.x, by.y + 0.1, by.z, sea, r, { pose: "sit", beach: true });
        }
      }
    }
  }
  // Along the water: walkers, and people who wave at the riders.
  const strollers = Math.round(26 * crowd);
  for (let i = 0; i < strollers; i++) {
    const z = site.from + 10 + r() * (site.to - site.from - 16);
    const p = site.at(z, 1.5 + r() * 5);
    if (i % 3 === 0) wavers.add(shape, p.x, p.y, p.z, sea + (r() - 0.5) * 0.6, r, true, shade);
    else
      addPerson(shape, p.x, p.y, p.z, sea + (r() < 0.5 ? 1 : -1) * (Math.PI / 2) + (r() - 0.5) * 0.5, r, {
        pose: "walk",
        beach: true,
        shade,
      });
  }
  // A few walk the water's edge and back.
  const beats = Math.round(5 * Math.min(1, crowd * 1.3));
  for (let i = 0; i < beats; i++) {
    const beat = 22 + r() * 16;
    const z = site.from + 14 + r() * (site.to - site.from - 30 - beat);
    const inland = 3.2 + r() * 1.6;
    const a = site.at(z, inland);
    const b = site.at(z + beat, inland);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    walkers.add(
      a.x,
      (a.y + b.y) / 2,
      a.z,
      (b.x - a.x) / length,
      (b.z - a.z) / length,
      length,
      0.9 + r() * 0.4,
      400 + i * 17,
      SAND_SHADE,
      true,
    );
  }
  // Towels on the sand, with sunbathers.
  const towels = Math.round(18 * crowd);
  for (let i = 0; i < towels; i++) {
    const z = site.from + 12 + r() * (site.to - site.from - 20);
    const p = site.at(z, 6 + r() * 4);
    const turn = sea + (r() - 0.5) * 0.8;
    shape.take(box(0.9, 0.03, 1.9), new THREE.Color(pick(CANOPIES, r)), place(p.x, p.y + 0.02, p.z, turn), {
      uv: TILE.white,
    });
    addPerson(shape, p.x, p.y + 0.05, p.z, turn + Math.PI, r, { pose: "lie", beach: true });
  }
  // The bar's customers: on its stools and at its tables.
  if (open) {
    const customers = Math.round(7 * crowd);
    for (let i = 0; i < customers; i++) {
      const at =
        i < 3
          ? B.p((i - 1) * 2.8, 0.45 + 0.75, -1.8 + 2.2 + 1.1)
          : B.p([-5.35, -0.85, 2.35, 5.35][i - 3] ?? 0, 0.45 + 0.45, 3.9);
      addPerson(shape, at.x, at.y, at.z, i < 3 ? sea + Math.PI : sea + (i % 2 === 0 ? 1 : -1) * (Math.PI / 2), r, {
        pose: "sit",
        beach: true,
      });
    }
  }
  // The volleyball court: its net, and a game when there are people for it.
  const mid = site.at((court.from + court.to) / 2, 22);
  const N = new Local(shape, mid.x, mid.y, mid.z, sea + Math.PI / 2);
  for (const px of [-4.6, 4.6]) N.box(px, 0, 0, 0.1, 2.5, 0.1, WHITE);
  N.front(-4.6, 4.6, 1.5, 2.45, 0, PLAIN, TILE.railing);
  N.quad([4.6, 1.5, 0], [-4.6, 1.5, 0], [-4.6, 2.45, 0], [4.6, 2.45, 0], PLAIN, TILE.railing);
  if (crowd > 0.5)
    for (const [px, pz] of [
      [-2, 3],
      [2.2, 4.5],
      [-1.5, -3.4],
      [2.4, -4],
    ] as const) {
      const p = N.p(px, 0, pz);
      addPerson(shape, p.x, mid.y, p.z, sea + Math.PI / 2 + (pz > 0 ? Math.PI : 0), r, {
        pose: pz === 3 ? "cheer" : "stand",
        beach: true,
      });
    }
  // Boats drawn up on the sand at the beach's north end.
  for (let i = 0; i < 3; i++) {
    const p = site.at(site.from + 18 + i * 7.5, 6.5 + r() * 2);
    shape.take(
      llaut(40 + i * 7),
      null,
      turned(p.x, p.y + 0.3, p.z, 0, sea + 0.3 * (r() - 0.5), 0.22 * (i % 2 === 0 ? 1 : -1)),
      { uv: TILE.white },
    );
  }
  // The promenade behind the sand: bathing huts in a row, lamps and benches.
  let k = 0;
  for (let z = site.from + 20; z < site.to - 20; z += 2.6) {
    k++;
    if (Math.abs(z - bar.z) < 12 || k % 9 > 5) continue;
    const p = site.at(z, 44.5);
    addHut(shape, p.x, p.y - 0.1, p.z, sea, TILE.awnings[k % 3]!);
  }
  for (let z = site.from + 24; z < site.to - 12; z += 26) {
    const lamp = site.at(z, 37.2);
    addLampPost(shape, lamp.x, lamp.y, lamp.z, sea);
    const bench = site.at(z + 8, 38);
    addBench(shape, bench.x, bench.y, bench.z, sea);
  }
  const passers = Math.round(10 * crowd);
  for (let i = 0; i < passers; i++) {
    const p = site.at(site.from + 24 + r() * (site.to - site.from - 40), 39 + r() * 3);
    addPerson(shape, p.x, p.y, p.z, sea + (r() < 0.5 ? 1 : -1) * (Math.PI / 2), r, { pose: "walk" });
  }
}
