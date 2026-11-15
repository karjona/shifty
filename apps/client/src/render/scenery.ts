// Costa Nevada's distance, behind every circuit. On the coast: the plain
// behind the shore (a patchwork of fields, pines and cypresses), foothills
// rising in terraces with white villages on them, the sierra in three
// ranges (wooded below, rock, snow down to the season's line), and far
// headlands and islands out to sea. On the mountain: the sierra's peaks
// all round the run. Far and cheap: each layer is one mesh, laid in as an
// illustrator would, fading into the distance's colour by hand (the
// scene's fog would hide it), and more on a hazy day. Everything here is
// out in the weather: in the season's colours, snowed on above the snow
// line (see cel/look.ts).
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { FOLIAGE, LOOK, cut0 } from "./cel/look.ts";
import { CelMaterial, HAZE, UNREFLECTED, inkId } from "./cel/material.ts";
import { noise4 } from "./cel/noise.ts";
import { type PeakStyle, noise3, peakGeometry, peakMaterial } from "./cel/terrain.ts";
import { GRASSY } from "./coast/rock.ts";
import { Shape, box, place, random } from "./coast/shape.ts";
import { Planting } from "./coast/trees.ts";
import {
  Fn,
  attribute,
  cameraPosition,
  clamp,
  color,
  float,
  fract,
  fwidth,
  min,
  mix,
  mx_cell_noise_float,
  mx_noise_float,
  positionWorld,
  smoothstep,
  step,
  vec2,
  vec3,
} from "three/tsl";

/** Deterministic noise in [0, 1) for placing scenery. */
export function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** How far scenery fades into the distance by how far it is from the camera: by hand, and more on a hazy day. */
function distanceHaze(near: number, far: number, most: number): THREE.Node<"float"> {
  const k = clamp(
    cameraPosition
      .distance(positionWorld)
      .sub(near)
      .div(far - near),
    0,
    1,
  ).mul(most);
  return k.add(LOOK.haze.mul(float(1).sub(k)).mul(0.7));
}

/** A range of the sierra: peaks of these heights standing shoulder to shoulder along a line. */
interface Range {
  /** How far behind the coast it stands (m), and how far it wanders from that. */
  back: number;
  wander: number;
  /** Its peaks' heights (m): least and most. */
  heights: [number, number];
  haze: number;
  snowline: number;
}

const COAST_ROCK = 0x66728c;
const COAST_FOREST = 0x4d6a66;

/**
 * The sierra behind a coast, as one mesh: ranges one behind another, the
 * nearer lower and wooded, the far ones taller, paler and snowier. `side`
 * is which way inland lies along z (1 or -1); it spans `width` m across.
 */
export function sierra(side: 1 | -1, ranges: readonly Range[], width: number, seed: number): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const r = random(seed);
  ranges.forEach((range, k) => {
    const style: PeakStyle = {
      rock: COAST_ROCK,
      snow: 0xf7f9fd,
      snowline: range.snowline,
      haze: range.haze,
      footHaze: 0.4,
      forest: COAST_FOREST,
    };
    let x = -width / 2;
    let n = 0;
    while (x < width / 2) {
      // A high peak now and then among lower shoulders.
      const high = n % 3 === 1 || r() < 0.25;
      const [lo, hi] = range.heights;
      const h = high ? lo + (hi - lo) * (0.55 + r() * 0.45) : lo * (0.6 + r() * 0.45);
      const radius = h * (1.25 + r() * 0.7);
      const geo = peakGeometry(radius, h, seed * 31 + k * 97 + n, style);
      geo.translate(x + radius * 0.45, -24, side * (range.back + (r() - 0.5) * range.wander));
      parts.push(geo);
      x += radius * (0.62 + r() * 0.4);
      n++;
    }
  });
  const mesh = new THREE.Mesh(
    mergeGeometries(parts),
    peakMaterial({ rock: COAST_ROCK, snow: 0xf7f9fd, snowline: 0.5, haze: 0, footHaze: 0, forest: COAST_FOREST }),
  );
  for (const g of parts) g.dispose();
  mesh.name = "sierra";
  mesh.userData.noMerge = true;
  // (Too far off to show in the water.)
  mesh.layers.set(UNREFLECTED);
  return mesh;
}

/** The coast's sierra: three ranges. */
export const COAST_SIERRA: Range[] = [
  { back: 1500, wander: 160, heights: [150, 250], haze: 0.16, snowline: 0.74 },
  { back: 2050, wander: 220, heights: [270, 430], haze: 0.3, snowline: 0.52 },
  { back: 2750, wander: 260, heights: [380, 560], haze: 0.46, snowline: 0.4 },
];

let hillCel: CelMaterial | null = null;

/** The foothills' material: each vertex's colour, terraces drawn round the slopes and groves dotted over them, fading with distance. */
function hillMaterial(): CelMaterial {
  if (hillCel) return hillCel;
  const colour = Fn(() => {
    const c = attribute<"vec3">("color", "vec3");
    const p = positionWorld;
    const wide = noise4(p.xz.mul(0.004));
    const fine = noise4(p.xz.mul(0.023));
    // Terraces: a darker line every few metres up the slope, where it is neither flat nor wooded.
    const level = p.y.mul(0.11).add(wide.x.mul(0.7));
    const w = fwidth(level).max(1e-4);
    const terrace = smoothstep(float(0.14).add(w), float(0.14).sub(w), fract(level)).mul(smoothstep(8, 22, p.y));
    const groves = cut0(fine.y.mul(0.6).add(wide.z.mul(0.55)).sub(0.12));
    const woods = vec3(0.26, 0.4, 0.27);
    return mix(mix(c, c.mul(0.84), terrace.mul(float(1).sub(groves))), woods, groves.mul(0.85));
  });
  hillCel = new CelMaterial({
    colorNode: colour(),
    fog: false,
    outdoor: GRASSY,
    haze: distanceHaze(350, 2300, 0.62),
    threshold: 0.08,
    shade: new THREE.Color(0.6, 0.66, 0.88),
    richness: 1.15,
    silhouette: 0.8,
    crease: 0,
    darkness: 0.45,
    id: inkId("hills"),
  });
  hillCel.name = "hills";
  return hillCel;
}

let farCel: CelMaterial | null = null;

/** Painted things far off (villages, a ferry): each vertex its colour, fading with distance. */
export function farMaterial(): CelMaterial {
  farCel ??= new CelMaterial({
    vertexColors: true,
    fog: false,
    haze: distanceHaze(350, 2300, 0.62),
    crease: 0.3,
    darkness: 0.5,
    id: inkId("far"),
  });
  farCel.name = "far";
  return farCel;
}

const FIELD = [0x9fb35e, 0xb9c06a, 0xcdb878, 0x8aa554, 0xa8b866];
const OLIVE = new THREE.Color(0x7f9a5a);
const WOODS = new THREE.Color(0x4f7a4a);
const SCREE = new THREE.Color(0xa59c88);

/**
 * The foothills behind a coast: rolling ground rising from `from` m
 * inland for `depth` m toward the sierra, in fields low down, olive
 * terraces, then woods; white villages stand on its spurs.
 */
export function foothills(
  side: 1 | -1,
  from: number,
  depth: number,
  width: number,
  top: number,
  seed: number,
): THREE.Group {
  const g = new THREE.Group();
  const cell = 55;
  const nx = Math.round(width / cell) + 1;
  const nz = Math.round(depth / cell) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const height = (x: number, d: number): number => {
    const t = d / depth;
    const rise = Math.pow(Math.min(1, Math.max(0, t)), 1.25);
    // Spurs running down toward the shore, valleys between them.
    const spur = 1 - Math.abs(noise3(x * 0.0021, 0.3, d * 0.0009, seed));
    const roll = noise3(x * 0.006, 1.7, d * 0.006, seed + 3);
    return Math.max(0, rise * top * (0.45 + 0.75 * spur * spur) + roll * 14 * Math.min(1, t * 4)) + 1;
  };
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = -width / 2 + i * cell;
      const d = j * cell;
      const y = height(x, d);
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = side * (from + d);
      const patch = hash(Math.floor(x / 160) * 7.3 + Math.floor(d / 120) * 3.1 + seed);
      const slope = Math.abs(height(x + 30, d) - height(x - 30, d)) / 60 + Math.abs(height(x, d + 30) - y) / 30;
      if (y > top * 0.72 && slope > 0.32) c.copy(SCREE);
      else if (y > top * 0.38) c.copy(WOODS);
      else if (y > 26) c.copy(OLIVE);
      else c.setHex(FIELD[Math.floor(patch * FIELD.length)] ?? FIELD[0]!);
      c.toArray(col, k * 3);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      // (Wound so the hills face up whichever way inland lies.)
      if (side > 0) index.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
      else index.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const hills = new THREE.Mesh(geo, hillMaterial());
  hills.name = "hills";
  hills.userData.noMerge = true;
  g.add(hills);

  // Villages: white houses under tiled roofs round a church tower, on spurs partway up.
  const r = random(seed + 5);
  const shape = new Shape();
  const wall = new THREE.Color(0xf4efe4);
  const roof = new THREE.Color(0xc8704a);
  for (let v = 0; v < 5; v++) {
    const x = -width * 0.42 + (v / 4) * width * 0.84 + (r() - 0.5) * 120;
    const d = depth * (0.16 + r() * 0.3);
    const houses = 12 + Math.floor(r() * 10);
    for (let h = 0; h < houses; h++) {
      const hx = x + (r() - 0.5) * 110;
      const hd = d + (r() - 0.5) * 70;
      const w = 9 + r() * 8;
      const tall = 6 + r() * 6;
      const y = height(hx, hd) - 2;
      const turn = r() * 0.6;
      shape.take(box(w, tall + 2, 8 + r() * 5), wall, place(hx, y, side * (from + hd), turn));
      shape.take(box(w + 1.2, 1.8, 10 + r() * 4), roof, place(hx, y + tall + 2, side * (from + hd), turn));
    }
    const y = height(x, d);
    shape.take(box(6, 26, 6), wall, place(x, y - 2, side * (from + d)));
    shape.take(
      new THREE.ConeGeometry(5, 7, 4).rotateY(Math.PI / 4).translate(0, 3.5, 0),
      roof,
      place(x, y + 24, side * (from + d)),
      {
        flat: true,
      },
    );
  }
  const villages = shape.mesh(farMaterial(), "none");
  villages.layers.set(UNREFLECTED);
  g.add(villages);
  return g;
}

/** Far headlands and islands out to sea: low capes running out from the coast at either hand, islets on the horizon. */
export function seaHorizon(side: 1 | -1, seed: number): THREE.Mesh {
  const style: PeakStyle = { rock: 0x7a8296, snow: 0xf7f9fd, snowline: 2, haze: 0.5, footHaze: 0.25, forest: 0x5f7a70 };
  const parts: THREE.BufferGeometry[] = [];
  const r = random(seed);
  const add = (x: number, z: number, radius: number, h: number) => {
    const geo = peakGeometry(radius, h, Math.floor(r() * 900), style);
    geo.scale(1.6, 1, 0.8);
    geo.translate(x, -8, z);
    parts.push(geo);
  };
  // The capes: each a string of hills stepping down into the sea.
  for (const hand of [-1, 1]) {
    for (let k = 0; k < 4; k++)
      add(
        hand * (2500 - k * 230),
        -side * (150 + k * 420 + r() * 120),
        320 - k * 40,
        (150 - k * 28) * (0.8 + r() * 0.4),
      );
  }
  // Islets out on the horizon.
  add(-900 + r() * 400, -side * 3000, 180, 70);
  add(1300 + r() * 300, -side * 3200, 260, 95);
  add(1650, -side * 3250, 120, 40);
  const mesh = new THREE.Mesh(mergeGeometries(parts), peakMaterial(style));
  for (const g of parts) g.dispose();
  mesh.name = "headlands";
  mesh.userData.noMerge = true;
  mesh.layers.set(UNREFLECTED);
  return mesh;
}

/** A colour as a shader constant. */
function tone(hex: number): THREE.Node<"vec3"> {
  const k = new THREE.Color(hex);
  return vec3(k.r, k.g, k.b);
}

/** The coastal plain: a beach along the water, then a patchwork of fields and hedges. */
function fields(): THREE.Node<"vec3"> {
  return Fn(() => {
    const p = positionWorld.xz;
    // Plots: a grid, warped so no two are square, each one flat colour.
    const q0 = vec2(p.x.mul(0.022), p.y.mul(0.034));
    const warp = vec2(mx_noise_float(vec3(q0.mul(0.45), 2.1)), mx_noise_float(vec3(q0.mul(0.45), 8.7))).mul(0.45);
    const q = q0.add(warp);
    const cell = q.floor();
    const f = q.fract();
    const id = mx_cell_noise_float(vec3(cell, 1.0));
    const palette = [0x8fb35a, 0xb7c46a, 0xd9c27a, 0x7fa04e, 0x9fb0d8, 0xc9d27e, 0xa8c070];
    let c: THREE.Node<"vec3"> = tone(palette[0]!);
    for (let i = 1; i < palette.length; i++) c = mix(c, tone(palette[i]!), step(i / palette.length, id));
    // Rows in some plots (vines, wheat), and hedges between them.
    const rows = fract(q.x.mul(9).add(q.y.mul(2)));
    const rw = fwidth(q.x.mul(9).add(q.y.mul(2))).max(1e-4);
    const ploughed = step(0.55, mx_cell_noise_float(vec3(cell, 5.0)));
    c = mix(c, c.mul(0.86), smoothstep(rw.mul(1.2), float(0), rows).mul(ploughed));
    const edge = min(min(f.x, f.y), min(f.x.oneMinus(), f.y.oneMinus()));
    const w = fwidth(edge).max(1e-4);
    c = mix(color(0x5d7a3c), c, smoothstep(w.mul(0.8), w.mul(2), edge));
    // Sand along the water, then a track behind the beach.
    const beach = smoothstep(152, 150, p.y.add(mx_noise_float(vec3(p.x.mul(0.02), 0, 0)).mul(6)));
    c = mix(c, color(0xe8d6a8), beach);
    const track = smoothstep(1.6, 1.0, p.y.sub(158).abs());
    return mix(c, color(0xd8c9a6), track);
  })();
}

/** Stone pines and cypresses in clumps on the coastal plain behind the town. */
function plainTrees(): THREE.Group {
  const plants = new Planting();
  for (let k = 0; k < 34; k++) {
    // Clumps along the plain, thinning toward the hills.
    const cx = -1100 + hash(k * 3.1) * 2200;
    const cz = 178 + hash(k * 7.7) * 150;
    // (The town stands on its quay there.)
    if (Math.abs(cx) < 196 && cz < 200) continue;
    const n = 3 + Math.floor(hash(k + 0.5) * 6);
    for (let i = 0; i < n; i++) {
      const x = cx + (hash(k * 31 + i) - 0.5) * 44;
      const z = cz + (hash(k * 17 + i * 3) - 0.5) * 32;
      if (hash(k * 5 + i) < 0.6) plants.add("pineFar", x, 0.6, z, 9 + hash(k * 2 + i) * 5, 0.85 + hash(k + i) * 0.25);
      else plants.add("cypress", x, 0.6, z, 10 + hash(k * 9 + i) * 6, 0.9);
    }
  }
  return plants.build(true);
}

/** The bay's backdrop: the plain the town stands on, the foothills and the sierra behind it, headlands out to sea. */
export function buildScenery(): THREE.Group {
  const g = new THREE.Group();
  g.userData.noMerge = true;
  // North shore: the coastal plain (its beach runs off past the turns).
  const sand = new THREE.MeshStandardNodeMaterial({ color: 0xe8d6a8, roughness: 1, flatShading: true });
  sand.userData.outdoor = FOLIAGE.grass;
  sand.userData.colorNode = fields();
  HAZE.set(sand, distanceHaze(300, 1400, 0.4));
  const plain = new THREE.Mesh(new THREE.BoxGeometry(2600, 4, 260), sand);
  plain.position.set(0, -1.2, 250);
  plain.receiveShadow = true;
  g.add(plain);
  g.add(plainTrees());
  g.add(foothills(1, 360, 1150, 3400, 210, 11));
  g.add(sierra(1, COAST_SIERRA, 5200, 3));
  g.add(seaHorizon(1, 21));
  return g;
}

const WINTER_ROCK = 0x56607e;

/**
 * Winter: high peaks all around the run, beyond the fog, as one mesh.
 * `top` and `bottom` are the run's heights at its ends; `path` is its
 * centre line.
 */
export function peakRange(top: number, bottom: number, path: { x: number; z: number }[]): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  let minZ = Infinity;
  let maxZ = -Infinity;
  let cx = 0;
  for (const p of path) {
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
    cx += p.x / path.length;
  }
  const along = maxZ - minZ;
  const add = (
    radius: number,
    h: number,
    seed: number,
    snowline: number,
    haze: number,
    x: number,
    y: number,
    z: number,
  ) => {
    const geo = peakGeometry(radius, h, seed, {
      rock: WINTER_ROCK,
      snow: 0xf7f9fd,
      snowline,
      haze: haze * 0.75,
      footHaze: 0.9,
    });
    geo.translate(x, y, z);
    parts.push(geo);
  };
  for (let i = 0; i < 26; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const t = Math.floor(i / 2) / 12;
    const z = minZ - 300 + t * (along + 600);
    // The mountain rises behind the start: peaks there stand higher.
    const base = top + (bottom - top) * Math.min(1, Math.max(0, (z - minZ) / along));
    const h = 220 + hash(i + 200) * 180 + (1 - t) * 140;
    add(
      h * (1.0 + hash(i + 70) * 0.5),
      h,
      i + 40,
      0.55,
      0.55 + t * 0.15,
      cx + side * (1300 + hash(i + 90) * 700),
      base + h / 2 - 60,
      z,
    );
  }
  // Across the valley below the finish: the range you see riding down.
  for (let i = 0; i < 12; i++) {
    const h = 380 + hash(i + 400) * 300;
    add(
      h * (1.1 + hash(i + 410) * 0.5),
      h,
      i + 120,
      0.55,
      0.6 + hash(i + 420) * 0.15,
      cx + (i - 5.5) * 420 + hash(i + 430) * 200,
      bottom - 160 + h / 2,
      maxZ + 2200 + hash(i + 440) * 1200,
    );
  }
  // The summit ridge behind the start.
  for (let i = 0; i < 6; i++) {
    const h = 420 + hash(i + 300) * 200;
    add(h * 1.3, h, i + 80, 0.4, 0.5, cx + (i - 2.5) * 520, top + h / 2 - 80, minZ - 1300 - hash(i + 5) * 500);
  }
  const mesh = new THREE.Mesh(
    mergeGeometries(parts),
    peakMaterial({ rock: WINTER_ROCK, snow: 0xf7f9fd, snowline: 0.5, haze: 0, footHaze: 0 }),
  );
  for (const g of parts) g.dispose();
  mesh.name = "peaks";
  return mesh;
}
