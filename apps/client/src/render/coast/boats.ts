// The coast's boats: llaüts (the double-ended fishing boats of these
// waters, a stem post at the bow and a lateen yard on a short mast),
// trawlers with their wheelhouse and gear, sailing yachts at anchor or
// under sail, and inflatables. Hulls are lofted through stations (keel,
// bilge, wale, gunwale), painted in their colours.
//
// A `Fleet` is every boat lying somewhere as one mesh: each rides the
// swell (heaving and leaning with the water under it) in the vertex
// shader, from three numbers a boat worked out on the CPU. A `Roamer` is
// a boat under way: a mesh of its own, sailing a loop.
import * as THREE from "three/webgpu";
import { attribute, positionLocal, uniformArray, uv, vec3 } from "three/tsl";
import { CelMaterial, inkId } from "../cel/material.ts";
import { waveHeight } from "../waves.ts";
import { Shape, box, place, post, random, turned } from "./shape.ts";

const WHITE = 0xf4f1ea;
const WOOD = 0xcfae7c;
const WOOD_DARK = 0x8a6a46;
const IRON = 0x3a3f46;
const GLASS = 0x3f546c;
const SAIL = 0xf2ecdc;
const ANTIFOUL = 0x8a3a2c;
const ORANGE = 0xf08a3c;

type V3 = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface HullSpec {
  length: number;
  beam: number;
  stations: number;
  /** Half the beam at `t` (0 stern, 1 bow), as a fraction of the full half beam. */
  half: (t: number) => number;
  /** The gunwale's height over the water at `t`, and the keel's depth. */
  sheer: (t: number) => number;
  keel: (t: number) => number;
  /** How deep the top strake is (m), and the deck below the lowest gunwale. */
  strake: number;
  well: number;
  rim: number;
  bottom: number;
  side: number;
  band: number;
  deck: number;
  /** A flat stern (a yacht, an inflatable) instead of a pointed one. */
  transom?: boolean;
}

/** Lofts a hull into `s` (bow toward +z, the water line at y = 0); returns its deck's height. */
function loft(s: Shape, h: HullSpec): number {
  const deckY = Math.min(...Array.from({ length: h.stations + 1 }, (_, i) => h.sheer(i / h.stations))) - h.well;
  // One side's section at a station: keel, bilge, wale, gunwale, inner rim, deck edge.
  const section = (i: number, side: number): V3[] => {
    const t = i / h.stations;
    const z = (t - 0.5) * h.length;
    const hb = (h.beam / 2) * h.half(t) * side;
    const top = h.sheer(t);
    const k = h.keel(t);
    const inner = hb - Math.sign(hb) * Math.min(h.rim, Math.abs(hb) * 0.6);
    return [
      v(0, k, z),
      v(hb * 0.8, k * 0.3, z),
      v(hb, top - h.strake, z),
      v(hb * 0.99, top, z),
      v(inner, top, z),
      v(inner, deckY, z),
    ];
  };
  const colours = [h.bottom, h.side, h.band, h.band, h.side];
  for (let i = 0; i < h.stations; i++) {
    for (const side of [1, -1]) {
      const a = section(i, side);
      const b = section(i + 1, side);
      for (let k = 0; k < 5; k++) {
        // (Seen from outside, the bow is to the left on the starboard side.)
        if (side > 0) s.quad(b[k]!, a[k]!, a[k + 1]!, b[k + 1]!, colours[k]!);
        else s.quad(a[k]!, b[k]!, b[k + 1]!, a[k + 1]!, colours[k]!);
      }
    }
    const a = section(i, 1)[5]!;
    const b = section(i + 1, 1)[5]!;
    s.quad(a, v(-a.x, a.y, a.z), v(-b.x, b.y, b.z), b, h.deck);
  }
  if (h.transom) {
    const r = section(0, 1);
    const l = section(0, -1);
    for (let k = 0; k < 3; k++) s.quad(r[k]!, l[k]!, l[k + 1]!, r[k + 1]!, k === 0 ? h.bottom : h.side);
    s.quad(r[4]!, l[4]!, l[5]!, r[5]!, h.side);
  }
  return deckY;
}

/** A dark pane on a cabin's wall: a box barely proud of it. */
function pane(s: Shape, x: number, y: number, z: number, w: number, h: number, d: number): void {
  s.take(box(w, h, d), GLASS, place(x, y, z));
}

/** Each hull's gunwale over the water from stern (0) to bow (1): a llaüt's rises at both ends, a trawler's high at the bow. */
const llautSheer = (t: number) => 0.6 + 0.4 * Math.pow(Math.abs(2 * t - 1), 2) + 0.16 * t;
const trawlerSheer = (t: number) =>
  1.25 + 1.1 * Math.pow(Math.max(0, 2 * t - 1), 2) + 0.25 * Math.pow(Math.max(0, 1 - 2 * t), 2);
const yachtSheer = (t: number) => 0.95 + 0.25 * t;

const LLAUT_COLOURS: [number, number][] = [
  [WHITE, 0x2f6fb0],
  [WHITE, 0x2d8a7a],
  [WHITE, 0xc8483a],
  [0x2f6fb0, WHITE],
  [WHITE, 0xf2c14e],
  [0x3f8a6a, WHITE],
];

/** A llaüt, about 6 m: `seed` picks its colours and what it carries (a cuddy, a mast and yard, an awning). */
export function llaut(seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const [side, band] = LLAUT_COLOURS[Math.floor(r() * LLAUT_COLOURS.length)]!;
  const length = 5.4 + r() * 1.4;
  const sheer = llautSheer;
  const deck = loft(s, {
    length,
    beam: 2.2,
    stations: 8,
    half: (t) => Math.max(0.05, Math.pow(Math.sin(Math.PI * (0.04 + 0.92 * t)), 0.7)),
    sheer,
    keel: (t) => -0.35 * (1 - Math.pow(Math.abs(2 * t - 1), 3)),
    strake: 0.2,
    well: 0.28,
    rim: 0.14,
    bottom: ANTIFOUL,
    side,
    band,
    deck: WOOD,
  });
  const bow = length / 2;
  // The stem post standing over the bow, and the rudder's head.
  s.take(box(0.12, 0.75, 0.16), band, turned(0, sheer(1) - 0.2, bow - 0.07, 0.25, 0, 0));
  s.take(box(0.1, 0.5, 0.14), band, place(0, sheer(0) - 0.15, -bow + 0.06));
  s.take(box(0.06, 0.06, 0.9), WOOD_DARK, turned(0, sheer(0) + 0.3, -bow + 0.5, -0.15, 0, 0));
  // Thwarts across the well.
  for (const z of [-0.9, 0.6]) s.take(box(1.7, 0.07, 0.3), WOOD_DARK, place(0, deck + 0.34, z));
  const fit = r();
  if (fit < 0.45) {
    // A cuddy forward, with its hatch and a window each side.
    s.take(box(1.35, 0.62, 1.5), WHITE, place(0, deck + 0.05, bow * 0.42));
    s.take(box(1.5, 0.07, 1.65), band, place(0, deck + 0.67, bow * 0.42));
    for (const sx of [-0.69, 0.69]) pane(s, sx, deck + 0.3, bow * 0.42, 0.04, 0.24, 0.8);
    pane(s, 0, deck + 0.3, bow * 0.42 - 0.76, 0.7, 0.26, 0.04);
  } else {
    // The engine's box amidships.
    s.take(box(0.75, 0.42, 0.95), WHITE, place(0, deck + 0.05, -0.2));
    s.take(box(0.82, 0.05, 1.02), band, place(0, deck + 0.47, -0.2));
  }
  if (r() < 0.6) {
    // The mast, and the lateen yard lowered along it with its sail furled.
    s.take(post(0.055, 0.04, 3.1, 5), WOOD_DARK, place(0, deck, bow * 0.3));
    s.take(box(0.07, 0.07, 5.2), WOOD_DARK, turned(0, deck + 2.3, -0.2, -0.32, 0, 0));
    s.take(
      new THREE.CylinderGeometry(0.11, 0.11, 4.4, 5).rotateX(Math.PI / 2),
      SAIL,
      turned(0.1, deck + 2.22, -0.25, -0.32, 0, 0),
    );
  } else if (r() < 0.5) {
    // An awning on four stanchions over the well.
    for (const [x, z] of [
      [-0.8, -1.4],
      [0.8, -1.4],
      [-0.8, 0.5],
      [0.8, 0.5],
    ] as const)
      s.take(box(0.05, 1.5, 0.05), IRON, place(x, deck, z));
    s.take(box(1.9, 0.06, 2.3), SAIL, place(0, deck + 1.5, -0.45));
  }
  // Fenders over the side, a coil of rope, a fish box.
  for (const z of [-1.1, 0.9]) s.take(new THREE.SphereGeometry(0.17, 6, 4), ORANGE, place(1.12, 0.32, z, 0, 1, 1.5, 1));
  s.take(box(0.6, 0.26, 0.42), pickBox(r), place(0.35, deck + 0.02, -1.7));
  return s.build();
}

const pickBox = (r: () => number) => [0x3a6ea5, 0xf2c14e, 0xd94a3a][Math.floor(r() * 3)]!;

/** A trawler, about 13 m: a high bow, the wheelhouse forward, the gallows, net drum and derrick aft. */
export function trawler(seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const side = [0x2f5f9a, 0x2f7a5e, 0xb8432f, 0x245a7a][Math.floor(r() * 4)]!;
  const length = 13;
  const sheer = trawlerSheer;
  const deck = loft(s, {
    length,
    beam: 4.2,
    stations: 9,
    half: (t) =>
      Math.max(
        0.06,
        t < 0.5 ? 0.72 + 0.28 * Math.sin(Math.PI * t) : Math.pow(Math.sin(Math.PI * (0.02 + 0.96 * t)), 0.6),
      ),
    sheer,
    keel: (t) => -0.9 * (1 - Math.pow(Math.abs(2 * t - 1), 4)),
    strake: 0.3,
    well: 0.5,
    rim: 0.16,
    bottom: ANTIFOUL,
    side,
    band: WHITE,
    deck: 0xb9a888,
    transom: true,
  });
  // The wheelhouse: windows all round under an overhanging roof, the funnel and the mast behind.
  const wz = 1.8;
  s.take(box(2.7, 2.3, 3.1), WHITE, place(0, deck, wz));
  s.take(box(3.0, 0.12, 3.5), side, place(0, deck + 2.3, wz));
  pane(s, 0, deck + 1.35, wz + 1.56, 2.3, 0.6, 0.04);
  for (const sx of [-1.36, 1.36]) pane(s, sx, deck + 1.35, wz + 0.3, 0.04, 0.6, 2.2);
  s.take(box(0.7, 1.7, 0.05), 0x7a5236, place(0, deck, wz - 1.57));
  s.take(post(0.28, 0.24, 1.3, 7), side, place(0.7, deck + 2.4, wz - 0.9));
  s.take(post(0.07, 0.05, 3.6, 5), WHITE, place(0, deck + 2.4, wz + 0.2));
  s.take(box(1.5, 0.07, 0.07), WHITE, place(0, deck + 4.8, wz + 0.2));
  s.take(box(0.9, 0.12, 0.2), IRON, place(0, deck + 2.75, wz + 1.1));
  // Aft: the gallows over the stern, the net drum, a derrick, nets and boxes.
  for (const sx of [-1.5, 1.5]) s.take(box(0.14, 2.6, 0.14), WHITE, place(sx, deck, -length / 2 + 0.9));
  s.take(box(3.14, 0.14, 0.14), WHITE, place(0, deck + 2.6, -length / 2 + 0.9));
  s.take(
    new THREE.CylinderGeometry(0.55, 0.55, 2.0, 8).rotateZ(Math.PI / 2),
    0x3f9a8c,
    place(0, deck + 0.75, -length / 2 + 2.6),
  );
  s.take(box(0.1, 0.1, 5), WHITE, turned(0, deck + 3.2, -1.4, 0.5, 0, 0));
  s.take(
    new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    0xf08a3c,
    place(-1.0, deck, -3.6, 0.4, 1.0, 0.45, 0.8),
  );
  for (let k = 0; k < 3; k++)
    s.take(box(0.9, 0.34, 0.6), pickBox(r), place(1.1, deck + k * 0.34, -3.3 + (k % 2) * 0.1));
  // Tyres over the side.
  for (const z of [-3, 0, 3])
    s.take(
      new THREE.TorusGeometry(0.34, 0.13, 5, 8).rotateY(Math.PI / 2),
      0x2a2c32,
      place(2.12 * (z > 2 ? 0.86 : 1), 0.75, z),
    );
  return s.build();
}

/** A sailing yacht, about 9 m, at anchor (sails stowed) or, with `sailing`, under main and jib. */
export function yacht(seed: number, sailing = false): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const stripe = [0x2f6fb0, 0xc8483a, 0x2a4a6a, 0x2d8a7a][Math.floor(r() * 4)]!;
  const length = 9;
  const sheer = yachtSheer;
  const deck = loft(s, {
    length,
    beam: 2.9,
    stations: 8,
    half: (t) =>
      Math.max(
        0.04,
        t < 0.35 ? 0.78 + 0.22 * (t / 0.35) : Math.pow(Math.cos(((t - 0.35) / 0.65) * (Math.PI / 2)), 0.75),
      ),
    sheer,
    keel: (t) => -0.55 * (1 - Math.pow(Math.abs(2 * t - 1), 2)),
    strake: 0.18,
    well: 0.12,
    rim: 0.1,
    bottom: stripe,
    side: WHITE,
    band: stripe,
    deck: 0xd8c098,
    transom: true,
  });
  // The coach roof with its windows, the cockpit's wheel.
  s.take(box(1.8, 0.48, 3.4), WHITE, place(0, deck, 0.4));
  for (const sx of [-0.91, 0.91]) pane(s, sx, deck + 0.18, 0.5, 0.04, 0.2, 2.4);
  s.take(new THREE.TorusGeometry(0.3, 0.035, 4, 8), IRON, place(0, deck + 0.75, -2.6));
  // The mast, and the boom over the cockpit.
  const mastZ = 1.1;
  const mast = 11;
  s.take(post(0.075, 0.05, mast, 5), 0xd8dade, place(0, deck + 0.48, mastZ));
  s.take(box(0.9, 0.04, 0.04), 0xd8dade, place(0, deck + 0.48 + mast * 0.55, mastZ));
  const boomY = deck + 1.55;
  s.take(box(0.09, 0.09, 3.9), 0xd8dade, place(0, boomY, mastZ - 1.95));
  if (sailing) {
    const head = v(0, deck + 0.4 + mast, mastZ);
    const tack = v(0, boomY + 0.1, mastZ);
    const clew = v(0.5, boomY + 0.1, mastZ - 3.8);
    const stem = v(0, deck + 0.1, length / 2 - 0.2);
    const jibHead = v(0, deck + mast * 0.86, mastZ + 0.05);
    const jibClew = v(0.7, deck + 0.9, mastZ - 0.6);
    // Sails seen from both sides.
    for (const [a, b, c] of [
      [head, tack, clew],
      [jibHead, stem, jibClew],
    ] as const) {
      s.tri(a, b, c, SAIL);
      s.tri(a, c, b, 0xe2dccc);
    }
  } else {
    // The mainsail stowed along the boom under its cover.
    s.take(
      new THREE.CylinderGeometry(0.17, 0.13, 3.5, 5).rotateX(Math.PI / 2),
      stripe,
      place(0, boomY + 0.2, mastZ - 1.9),
    );
  }
  return s.build();
}

/** An inflatable, about 5 m: grey tubes round a white floor, a console and an outboard. */
export function inflatable(): THREE.BufferGeometry {
  const s = new Shape();
  const deck = loft(s, {
    length: 5,
    beam: 2.1,
    stations: 6,
    half: (t) => Math.max(0.1, t < 0.55 ? 1 : Math.pow(Math.cos(((t - 0.55) / 0.45) * (Math.PI / 2)), 0.6)),
    sheer: (t) => 0.55 + 0.2 * t * t,
    keel: () => -0.2,
    strake: 0.35,
    well: 0.3,
    rim: 0.42,
    bottom: 0x3a3f46,
    side: 0x8a9098,
    band: 0x9aa0a8,
    deck: 0xdcdcd8,
    transom: true,
  });
  s.take(box(0.6, 0.85, 0.5), WHITE, place(0, deck, 0.2));
  pane(s, 0, deck + 0.85, 0.3, 0.6, 0.3, 0.04);
  s.take(box(0.36, 0.7, 0.4), 0x2a2c32, place(0, deck + 0.1, -2.55));
  s.take(box(1.1, 0.1, 0.14), ORANGE, place(0, deck + 0.3, 1.4));
  return s.build();
}

/** The television's camera boat: an inflatable with a tower amidships and the camera on a jib over it. */
export function cameraBoat(): THREE.BufferGeometry {
  const s = new Shape();
  s.take(inflatable(), null, place(0, 0, 0, 0, 1.4));
  const deck = 0.35;
  for (const [x, z] of [
    [-0.55, -0.6],
    [0.55, -0.6],
    [-0.55, 0.6],
    [0.55, 0.6],
  ] as const)
    s.take(box(0.07, 3.3, 0.07), IRON, place(x, deck, z));
  s.take(box(1.4, 0.08, 1.5), 0x8a9098, place(0, deck + 3.3, 0));
  s.take(box(1.4, 0.05, 0.05), IRON, place(0, deck + 4.2, 0.72));
  s.take(box(0.08, 1.2, 0.08), IRON, place(0, deck + 3.38, 0));
  s.take(box(0.34, 0.26, 0.5), 0x2a2c32, place(0, deck + 4.55, 0));
  return s.build();
}

/** The ferry, about 110 m: a dark hull under white decks, a funnel in the line's colours. Seen from far off. */
export function ferry(): THREE.BufferGeometry {
  const s = new Shape();
  const hull = 0x2a3f5a;
  const deck = loft(s, {
    length: 110,
    beam: 19,
    stations: 8,
    half: (t) =>
      Math.max(
        0.05,
        t < 0.6
          ? 0.85 + 0.15 * Math.sin((Math.PI * t) / 0.6)
          : Math.pow(Math.cos(((t - 0.6) / 0.4) * (Math.PI / 2)), 0.7),
      ),
    sheer: (t) => 9 + 2.5 * t * t,
    keel: () => -3,
    strake: 2,
    well: 0.5,
    rim: 0.5,
    bottom: ANTIFOUL,
    side: hull,
    band: WHITE,
    deck: 0xb9b4a8,
    transom: true,
  });
  // Decks stepping in toward the top, rows of windows, the bridge forward, the funnel aft.
  s.take(box(17, 5, 78), WHITE, place(0, deck, -6));
  s.take(box(15, 3.6, 62), WHITE, place(0, deck + 5, -8));
  s.take(box(13, 3.2, 12), WHITE, place(0, deck + 8.6, 18));
  for (const sx of [-8.55, 8.55]) {
    pane(s, sx, deck + 1.2, -6, 0.1, 1.1, 70);
    pane(s, sx * 0.885, deck + 6, -8, 0.1, 1.2, 54);
  }
  pane(s, 0, deck + 9.6, 24.05, 12, 1.3, 0.1);
  s.take(post(3.2, 2.6, 7.5, 8), 0xd6402e, place(0, deck + 8.6, -22));
  s.take(post(2.7, 2.7, 1.2, 8), 0x2a2c32, place(0, deck + 16.1, -22));
  s.take(post(0.25, 0.15, 9, 5), WHITE, place(0, deck + 11.8, 20));
  return s.build();
}

export type BoatKind = "llaut" | "trawler" | "yacht" | "inflatable" | "camera";

/** Where a boat lies: the middle of its hull at the water line, its heading, and what it is. */
export interface Berth {
  x: number;
  z: number;
  yaw: number;
  kind: BoatKind;
  seed: number;
}

/** The boat a berth holds. */
function boatOf(b: Berth): THREE.BufferGeometry {
  if (b.kind === "trawler") return trawler(b.seed);
  if (b.kind === "yacht") return yacht(b.seed);
  if (b.kind === "inflatable") return inflatable();
  if (b.kind === "camera") return cameraBoat();
  return llaut(b.seed);
}

/** How many boats one fleet can hold. */
const FLEET = 48;
/** How readily each kind leans with the water (big hulls ride steadier). */
const LIVELY: Record<BoatKind, number> = { llaut: 1, trawler: 0.45, yacht: 0.7, inflatable: 1, camera: 0.6 };

/** Boats lying at their berths, riding the swell, all one mesh. */
export class Fleet {
  readonly mesh: THREE.Mesh;
  private berths: Berth[];
  /** Per boat: how far the swell has lifted it, and the water's slope under it along x and z. */
  private bobs: THREE.Vector3[];

  constructor(berths: readonly Berth[]) {
    this.berths = berths.slice(0, FLEET);
    this.bobs = Array.from({ length: FLEET }, () => new THREE.Vector3());
    const shape = new Shape();
    this.berths.forEach((b, i) => {
      shape.take(boatOf(b), null, place(b.x, 0, b.z, b.yaw), { weight: i, at: (p) => [p.x - b.x, p.z - b.z] });
    });
    const material = new CelMaterial({
      vertexColors: true,
      crease: 0.8,
      darkness: 0.85,
      spec: 0.2,
      specSize: 0.05,
      id: inkId("boat"),
    });
    const bobs = uniformArray<"vec3">(this.bobs, "vec3");
    const bob = bobs.element(attribute<"float">("sway", "float").toInt());
    const off = uv();
    const p = positionLocal;
    // Lifted with the water, leaning with its slope: what stands tall swings furthest.
    material.positionNode = p.add(
      vec3(bob.y.mul(p.y).negate(), bob.x.add(bob.y.mul(off.x)).add(bob.z.mul(off.y)), bob.z.mul(p.y).negate()),
    );
    material.name = "fleet";
    this.mesh = shape.mesh(material, "cast");
    this.mesh.frustumCulled = false;
  }

  /** Floats every boat on the swell at time `t`. */
  update(waves: Float32Array, t: number): void {
    this.berths.forEach((b, i) => {
      const reach = 1.5;
      const h = waveHeight(waves, b.x, b.z, t);
      const lively = LIVELY[b.kind];
      const sx =
        ((waveHeight(waves, b.x + reach, b.z, t) - waveHeight(waves, b.x - reach, b.z, t)) / (2 * reach)) * lively;
      const sz =
        ((waveHeight(waves, b.x, b.z + reach, t) - waveHeight(waves, b.x, b.z - reach, t)) / (2 * reach)) * lively;
      // A slow roll of its own, so boats in flat water still stir.
      const roll = Math.sin(t * 0.9 + i * 1.7) * 0.012;
      this.bobs[i]!.set(h, sx + roll * Math.cos(b.yaw), sz - roll * Math.sin(b.yaw));
    });
  }
}

/** A boat under way round a loop of waypoints (x, z), `speed` m/s, riding the swell. */
export class Roamer {
  readonly mesh: THREE.Mesh;
  private path: THREE.CatmullRomCurve3;
  private length: number;
  private speed: number;
  private offset: number;
  private at = new THREE.Vector3();
  private ahead = new THREE.Vector3();

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    points: [number, number][],
    speed: number,
    offset = 0,
  ) {
    this.path = new THREE.CatmullRomCurve3(
      points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      "centripetal",
    );
    this.length = this.path.getLength();
    this.speed = speed;
    this.offset = offset;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "boat";
    this.mesh.userData.noMerge = true;
    this.mesh.rotation.order = "YXZ";
  }

  update(waves: Float32Array, t: number): void {
    const u = ((((t * this.speed) / this.length + this.offset) % 1) + 1) % 1;
    this.path.getPointAt(u, this.at);
    this.path.getPointAt((u + 4 / this.length) % 1, this.ahead);
    const yaw = Math.atan2(this.ahead.x - this.at.x, this.ahead.z - this.at.z);
    const { x, z } = this.at;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const h = waveHeight(waves, x, z, t);
    const pitch = (waveHeight(waves, x + fx * 2, z + fz * 2, t) - waveHeight(waves, x - fx * 2, z - fz * 2, t)) / 4;
    const roll =
      (waveHeight(waves, x + fz * 1.2, z - fx * 1.2, t) - waveHeight(waves, x - fz * 1.2, z + fx * 1.2, t)) / 2.4;
    this.mesh.position.set(x, h, z);
    this.mesh.rotation.set(-Math.atan(pitch) * 0.7, yaw, -Math.atan(roll) * 0.6);
  }
}
