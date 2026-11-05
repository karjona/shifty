// Winter: the mountain. The snow is drawn from the sim's own heights (a
// ribbon of vertices along the run, fine where the riding is, and a coarse
// grid for the mountain around it), so the slope you see is the slope you
// ride. The snow shows its shape: a low sun, shade baked into hollows, blue
// dye lines on lips and knuckles, and old board tracks streaking down the
// run. Around it: pines crowding the run's edges, red netting fences,
// checkpoint flags, the start and finish arches, the chairlift, rocks, a
// lodge by the cliff drop, peaks in the haze, falling snow, powder thrown up
// by the boards, and the tracks they carve.
import * as THREE from "three/webgpu";
import type { Appearance } from "@shifty/rider";
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { CarveTrails } from "./trails.ts";
import { BoarderModel } from "./boarder.ts";
import { peakRange } from "./scenery.ts";
import { CEL } from "./cel/look.ts";
import { celify } from "./cel/material.ts";
import { skyDome } from "./cel/sky.ts";
import { ParticlePool } from "./spray.ts";
import type { CameraTuning, Environment, Frame, RiderModel, RiderView } from "./world.ts";

export interface RunPoint {
  s: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Half width of the groomed run, its walls, and how far riders can go. */
  half: number;
  wall: number;
  limit: number;
}

export interface GateData {
  s: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  half: number;
  limit: number;
}

export interface ObstacleData {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  kind: "pine" | "rock" | "tower";
}

export interface TableData {
  s: number;
  lip: number;
  offset: number;
  /** -1 = the whole run. */
  halfWidth: number;
}

/** The run, from `courseJson` (see `sim::mountain`). */
export interface RunData {
  length: number;
  startS: number;
  finishS: number;
  startGate: GateData;
  finish: GateData;
  checkpoints: GateData[];
  /** The centre line every 4 m. */
  path: RunPoint[];
  obstacles: ObstacleData[];
  tables: TableData[];
}

/** The sim's snow, asked for in bulk (see `sim-wasm`). */
export interface Terrain {
  /** `[x, y, z]` per (row arc length, offset). */
  ribbon(rows: Float32Array, offsets: Float32Array): Float32Array;
  /** `[height, distance from the run]` per grid point, row by row. */
  grid(x0: number, z0: number, step: number, nx: number, nz: number): Float32Array;
  /** Heights at `[x0, z0, x1, z1, ...]`. */
  heights(points: Float32Array): Float32Array;
}

/**
 * Close and low behind the rider, 1080-style: the rider fills about half
 * the screen's height, and the view tips down the slope, so the snow
 * rushing past fills the screen to about a third from the top.
 */
const CAMERA: CameraTuning = {
  fov: 52,
  fovSpeed: 6,
  fovAir: 4,
  back: 2.75,
  backPerSpeed: 0.006,
  up: 1.4,
  lookAhead: 6,
  lookUp: -0.55,
  lookFrom: "ground",
  turn: 4.5,
  reverseLooksAhead: false,
  heightOnGround: 14,
  // In the air the camera rises with the rider, but its height lags on
  // the way down: the rider drops in the frame.
  heightRising: 10,
  heightInAir: 5,
  clearance: 0.8,
  floorFollow: 6,
  airFrom: 1.2,
  airSpan: 5,
  airBack: 0.5,
  airUp: 0.3,
  tilt: 0.55,
};

/** The ribbon reaches this far either side of the centre line (less than the tightest turn's radius). */
const RIBBON_HALF = 56;
/** The coarse mountain: grid step, margin around the run, and how far below the true snow it sits. */
const GRID_STEP = 8;
const GRID_MARGIN = 420;
const GRID_SINK = 0.3;
/** Coarse vertices this close to the run hide under the ribbon. */
const GRID_HIDE = RIBBON_HALF - GRID_STEP;
const ROWS_PER_CHUNK = 96;
const SKY = 0xc9d4e4;
/** Curvature along the run (1/m) sharper than this, at a crest, gets a dye line (lips, knuckles, the cliff). */
const DYE_BREAK = 0.16;
/** How far back up the approach from the crest the dye reaches (m). */
const DYE_WIDTH = 0.6;
/** How far either side (m) the curvature and the local pitch are measured over, and the pitch around it. */
const CURVE_SPAN = 1.5;
const PITCH_SPAN = 9;

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

const flat = (color: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, flatShading: true, ...opts });

/** Offsets across the ribbon: fine on the run, coarser up the walls and beyond. */
function ribbonOffsets(): Float32Array {
  const side: number[] = [];
  for (let o = 0.8; o <= 20; o += 0.8) side.push(o);
  for (let o = 21.25; o <= 34; o += 1.25) side.push(o);
  for (let o = 36.5; o < RIBBON_HALF; o += 2.5) side.push(o);
  side.push(RIBBON_HALF);
  return Float32Array.from([...side.toReversed().map((o) => -o), 0, ...side]);
}

/** Rows along the run: every metre, every half metre across the tables and wherever the pitch breaks sharply (lips, the cliff). */
function ribbonRows(run: RunData): Float32Array {
  const breaks: number[] = [];
  const p = run.path;
  for (let i = 1; i < p.length - 1; i++) {
    const before = (p[i]!.y - p[i - 1]!.y) / (p[i]!.s - p[i - 1]!.s);
    const after = (p[i + 1]!.y - p[i]!.y) / (p[i + 1]!.s - p[i]!.s);
    if (Math.abs(after - before) > 0.3) breaks.push(p[i]!.s);
  }
  const fine = (s: number) =>
    run.tables.some((t) => s > t.s - 2 && s < t.lip + 12) || breaks.some((b) => Math.abs(s - b) < 8);
  const rows: number[] = [];
  for (let s = -80; s <= run.length + 60; s += fine(s) ? 0.5 : 1) rows.push(s);
  return Float32Array.from(rows);
}

/**
 * The snow: white in the open, blue-grey in drifts, with grain close up and
 * rock where it's steep. On the run (`ribbon`, with `uv` = arc length and
 * offset): old board tracks streaking down it, corduroy between them, shade
 * baked into faces that rise toward the rider and into hollows (`shade`), so
 * rollers and kickers read even in flat light, and blue dye on lips and
 * knuckles (`dye`).
 * Fine detail fades out where it would be smaller than a pixel.
 */
function snowMaterial(ribbon: boolean): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const near = smoothstep(90, 20, p.distance(cameraPosition));
    const drift = mx_noise_float(p.xz.mul(0.045)).mul(0.5).add(0.5);
    const blotch = mx_noise_float(p.xz.mul(0.17)).mul(0.5).add(0.5);
    let c = mix(vec3(0.74, 0.8, 0.92), vec3(0.9, 0.93, 0.98), drift).mul(blotch.mul(0.1).add(0.9));
    c = c.mul(mx_noise_float(p.xz.mul(3.1)).mul(0.05).mul(near).add(1));
    if (ribbon) {
      const s = uv().x;
      const o = uv().y;
      // Metres per pixel across the run: lines thinner than that fade out.
      const px = max(fwidth(o), 0.001);
      // Old tracks: wandering lines down the run, in patches.
      const layers = [
        [2.3, 0.9, 0.11, 0.07],
        [3.7, 1.6, 0.07, 0.1],
        [5.3, 2.4, 0.045, 0.13],
      ] as const;
      const lines = layers.map(([spacing, amp, freq, width], k) => {
        const wander = sin(s.mul(freq).add(k * 2.1))
          .mul(amp)
          .add(mx_noise_float(vec2(s.mul(0.02), o.mul(0.08).add(k * 7.3))).mul(amp * 1.5));
        const u = o.add(wander).div(spacing);
        const d = abs(fract(u).sub(0.5)).mul(spacing);
        // Each track its own depth: some fresh, some nearly filled in.
        const depth = hash(floor(u).add(k * 31))
          .mul(0.7)
          .add(0.3);
        const line = smoothstep(px.add(width), max(float(width).sub(px), 0), d)
          .mul(clamp(float(width).div(px), 0, 1))
          .mul(depth);
        const patch = smoothstep(-0.15, 0.3, mx_noise_float(vec2(s.mul(0.012), o.mul(0.04).add(k * 3.7))));
        return line.mul(patch);
      });
      const tracked = max(lines[0]!, lines[1]!, lines[2]!);
      c = mix(c, c.mul(vec3(0.74, 0.8, 0.93)), tracked.mul(0.75));
      // Corduroy: fine ridges along the run, on the groomed part only.
      const ridge = sin(o.mul((Math.PI * 2) / 0.32))
        .mul(0.5)
        .add(0.5);
      const groomed = smoothstep(17, 13, abs(o)).mul(clamp(float(1).sub(px.div(0.12)), 0, 1));
      c = c.mul(float(1).sub(ridge.mul(0.07).mul(groomed).mul(float(1).sub(tracked))));
      // Faces rising toward the rider and hollows in shade, the rest a touch brighter.
      const shade = attribute("shade", "float");
      c = c.mul(float(1).sub(max(shade, 0).mul(0.38)).add(max(shade.negate(), 0).mul(0.08)));
    }
    // Steep walls and cliffs show rock.
    const rock = smoothstep(0.62, 0.45, normalWorld.y);
    const rockColor = mix(vec3(0.33, 0.33, 0.36), vec3(0.45, 0.44, 0.45), drift);
    c = mix(c, rockColor, rock.mul(0.85));
    if (ribbon) {
      // Dye lines, painted on top of everything.
      const dye = smoothstep(0.35, 0.65, attribute("dye", "float"));
      c = mix(c, vec3(0.03, 0.17, 0.75), dye.mul(0.85));
    }
    return c;
  })();
  // Glitter: a few cells of snow catch the light close up.
  mat.emissiveNode = Fn(() => {
    const cell = floor(positionWorld.mul(16));
    const g = hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(131)));
    const near = smoothstep(12, 3, positionWorld.distance(cameraPosition));
    return vec3(1, 1, 1).mul(smoothstep(0.997, 1.0, g).mul(near).mul(0.35));
  })();
  return mat;
}

/** Second difference of heights `a`, `b`, `c`, spaced `h0` then `h1` apart: curvature (1/m), + = a hollow. */
function bend(a: number, b: number, c: number, h0: number, h1: number): number {
  return h0 > 0 && h1 > 0 ? (2 * ((c - b) / h1 - (b - a) / h0)) / (h0 + h1) : 0;
}

/** Colours a geometry per vertex (from its height and normal) and unindexes it. */
function colorize(g: THREE.BufferGeometry, fn: (y: number, ny: number) => THREE.Color): THREE.BufferGeometry {
  const pos = g.attributes.position!;
  g.computeVertexNormals();
  const nrm = g.attributes.normal!;
  const cols: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const c = fn(pos.getY(i), nrm.getY(i));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  return g.toNonIndexed();
}

/** A pine: stacked cones with snow on their tops, and a trunk. Vertex colours. */
function pineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const green = new THREE.Color(0x17382a);
  const snow = new THREE.Color(0xdde6f2);
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1.6, 5);
  trunk.translate(0, 0.8, 0);
  parts.push(colorize(trunk, () => new THREE.Color(0x4a3526)));
  const tiers = [
    [1.6, 0.95, 3.2],
    [1.25, 2.4, 2.8],
    [0.9, 3.7, 2.4],
    [0.55, 4.9, 2.0],
  ] as const;
  for (const [r, y, h] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 7);
    cone.translate(0, y + h / 2, 0);
    parts.push(
      colorize(cone, (vy) => {
        // Snow sits on each tier's shoulders; the skirt below stays green.
        const t = (vy - y) / h;
        return t > 0.52 && t < 0.9 ? snow : green;
      }),
    );
  }
  return mergeGeometries(parts);
}

/** Concatenates non-indexed geometries with position, normal and colour. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  for (const g of parts) {
    pos.push(...g.attributes.position!.array);
    nrm.push(...g.attributes.normal!.array);
    col.push(...g.attributes.color!.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/** Red safety netting: a canvas texture with see-through holes. */
function nettingTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = "#e23d2b";
  g.lineWidth = 5;
  for (let i = -64; i < 128; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 64, 64);
    g.stroke();
    g.beginPath();
    g.moveTo(i + 64, 0);
    g.lineTo(i, 64);
    g.stroke();
  }
  // A solid band along the top.
  g.fillStyle = "#e23d2b";
  g.fillRect(0, 0, 64, 7);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A banner texture: text on a colour. */
function bannerTexture(text: string, bg: string, fg: string, checker = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 1024, 128);
  if (checker) {
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 === 0 ? "#111" : "#f4f4f0";
        g.fillRect(x * 16, y * 16, 16, 16);
        g.fillRect(x * 16, 96 + y * 16, 16, 16);
      }
  }
  g.fillStyle = fg;
  g.font = "bold 72px ui-rounded, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 512, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Emitter {
  carve: number;
  mist: number;
  grounded: boolean;
  vy: number;
  bailing: boolean;
}

export class Mountain implements Environment {
  readonly group = new THREE.Group();
  readonly camera = CAMERA;
  readonly topSpeed = 32;

  private run: RunData;
  private terrain: Terrain;
  private sky = new THREE.Color(SKY);
  /** True snow heights on the coarse grid (for cheap lookups: particles). */
  private gridHeights = new Float32Array(0);
  private grid = { x0: 0, z0: 0, nx: 0, nz: 0 };
  private probe = new Float32Array(2);
  private flakes = new ParticlePool({
    max: 2400,
    color: [0.96, 0.97, 1.0],
    gravity: 0,
    drag: 1.5,
    rim: 0.3,
    lensFrom: 0.15,
    lensTo: 0.6,
    peak: 0.9,
    fadeIn: 8,
  });
  private powder = new ParticlePool({
    max: 3072,
    color: [0.93, 0.95, 1.0],
    gravity: 6,
    drag: 2.2,
    rim: 0.15,
    lensFrom: 0.5,
    lensTo: 1.8,
    peak: 0.9,
    fadeIn: 14,
  });
  private mist = new ParticlePool({
    max: 640,
    color: [0.92, 0.94, 0.99],
    gravity: 0.6,
    drag: 1.2,
    rim: 0,
    lensFrom: 0.2,
    lensTo: 1.0,
    peak: 0.32,
    fadeIn: 5,
  });
  private trails = new CarveTrails();
  private flakeCarry = 0;
  private emitters = new Map<number, Emitter>();
  private wind = { x: 0.6, z: -0.3 };
  private random = rng(77);

  constructor(run: RunData, terrain: Terrain) {
    this.run = run;
    this.terrain = terrain;
    this.buildSnow();
    this.buildMountainAround();
    this.buildForest();
    this.buildFences();
    this.buildGates();
    this.buildLift();
    this.buildRocks();
    this.buildLodge();
    this.group.add(peakRange(this.sky, run.path[0]!.y, run.path.at(-1)!.y, run.path));
    this.group.add(this.trails.group, this.flakes.sprite, this.powder.sprite, this.mist.sprite);
    if (CEL) {
      // Snow shades to a cool lavender, as drawn; the rest takes the usual cel tones.
      celify(
        this.group,
        (m) => (m.colorNode ? { shade: new THREE.Color(0.7, 0.76, 0.98), richness: 1.05, crease: 0.4 } : {}),
        true,
      );
      this.group.add(skyDome());
    }
  }

  light(scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    scene.background = this.sky;
    scene.fog = new THREE.Fog(this.sky, 45, 330);
    hemi.color.set(0xdfe9fb);
    hemi.groundColor.set(0x6f84b0);
    hemi.intensity = 1.9;
    sun.color.set(0xfff1dd);
    sun.intensity = 3.1;
  }

  ground(x: number, z: number): number {
    this.probe[0] = x;
    this.probe[1] = z;
    return this.terrain.heights(this.probe)[0] ?? 0;
  }

  /** Snow height from the coarse grid: rough, but cheap enough for every particle. */
  private roughGround(x: number, z: number): number {
    const { x0, z0, nx, nz } = this.grid;
    const fx = (x - x0) / GRID_STEP;
    const fz = (z - z0) / GRID_STEP;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i));
    const tz = Math.max(0, Math.min(1, fz - j));
    const h = this.gridHeights;
    const a = h[j * nx + i]!;
    const b = h[j * nx + i + 1]!;
    const c = h[(j + 1) * nx + i]!;
    const d = h[(j + 1) * nx + i + 1]!;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  makeRider(slot: number, _appearance: Appearance | null): RiderModel {
    const model = new BoarderModel(slot);
    if (CEL) celify(model.mesh);
    return model;
  }

  /** The run's snow: a ribbon of the sim's own heights, in chunks (so off-screen ones are culled). */
  private buildSnow(): void {
    const rows = ribbonRows(this.run);
    const offsets = ribbonOffsets();
    const cols = offsets.length;
    const xyz = this.terrain.ribbon(rows, offsets);
    const n = rows.length;
    // Normals from neighbours across the whole ribbon, so chunk seams don't show.
    const normals = new Float32Array(n * cols * 3);
    const at = (r: number, c: number, k: number) => xyz[(r * cols + c) * 3 + k]!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let r = 0; r < n; r++) {
      const r0 = Math.max(0, r - 1);
      const r1 = Math.min(n - 1, r + 1);
      for (let c = 0; c < cols; c++) {
        const c0 = Math.max(0, c - 1);
        const c1 = Math.min(cols - 1, c + 1);
        a.set(at(r1, c, 0) - at(r0, c, 0), at(r1, c, 1) - at(r0, c, 1), at(r1, c, 2) - at(r0, c, 2));
        b.set(at(r, c1, 0) - at(r, c0, 0), at(r, c1, 1) - at(r, c0, 1), at(r, c1, 2) - at(r, c0, 2));
        // Along the run x toward its right: up.
        const nrm = a.cross(b).normalize();
        if (nrm.y < 0) nrm.negate();
        normals.set([nrm.x, nrm.y, nrm.z], (r * cols + c) * 3);
      }
    }
    const { shade, dye } = this.shapeOf(xyz, rows, offsets);
    const mat = snowMaterial(true);
    for (let start = 0; start < n - 1; start += ROWS_PER_CHUNK) {
      const end = Math.min(n - 1, start + ROWS_PER_CHUNK);
      const count = (end - start + 1) * cols;
      const pos = new Float32Array(count * 3);
      const nor = new Float32Array(count * 3);
      const uvs = new Float32Array(count * 2);
      const shaded = shade.slice(start * cols, (end + 1) * cols);
      const dyed = dye.slice(start * cols, (end + 1) * cols);
      for (let r = start; r <= end; r++) {
        for (let c = 0; c < cols; c++) {
          const src = (r * cols + c) * 3;
          const dst = ((r - start) * cols + c) * 3;
          pos[dst] = xyz[src]!;
          pos[dst + 1] = xyz[src + 1]!;
          pos[dst + 2] = xyz[src + 2]!;
          // Beyond the walls the ribbon eases down to meet the coarse mountain.
          const edge = Math.abs(offsets[c]!) > RIBBON_HALF - 10 ? (Math.abs(offsets[c]!) - (RIBBON_HALF - 10)) / 10 : 0;
          pos[dst + 1]! -= GRID_SINK * edge;
          nor.set(normals.subarray(src, src + 3), dst);
          uvs[((r - start) * cols + c) * 2] = rows[r]!;
          uvs[((r - start) * cols + c) * 2 + 1] = offsets[c]!;
        }
      }
      const idx: number[] = [];
      for (let r = 0; r < end - start; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const i0 = r * cols + c;
          const i1 = i0 + 1;
          const i2 = i0 + cols;
          const i3 = i2 + 1;
          // Columns run to the right of travel (mirrored against world X),
          // so this winding faces up.
          idx.push(i0, i1, i2, i1, i3, i2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute("shade", new THREE.BufferAttribute(shaded, 1));
      geo.setAttribute("dye", new THREE.BufferAttribute(dyed, 1));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  /**
   * The snow's shape, per ribbon vertex: `shade` (+1 a face rising steeply
   * toward a rider coming down, or a deep hollow; -1 a face falling away or
   * a sharp crest), from the local pitch against the pitch around it and
   * the curvature, and `dye` (1 on the sharpest crest of a lip, a knuckle or
   * the cliff edge, inside the riding width).
   */
  private shapeOf(
    xyz: Float32Array,
    rows: Float32Array,
    offsets: Float32Array,
  ): { shade: Float32Array; dye: Float32Array } {
    const n = rows.length;
    const cols = offsets.length;
    const y = (r: number, c: number) => xyz[(r * cols + c) * 3 + 1]!;
    // Rows `span` metres either side of each row.
    const around = (span: number) => {
      const back = new Int32Array(n);
      const ahead = new Int32Array(n);
      for (let r = 0, b = 0, a = 0; r < n; r++) {
        while (b + 1 < r && rows[b + 1]! <= rows[r]! - span) b++;
        a = Math.max(a, r);
        while (a < n - 1 && rows[a]! < rows[r]! + span) a++;
        back[r] = Math.min(b, r);
        ahead[r] = a;
      }
      return { back, ahead };
    };
    const near = around(CURVE_SPAN);
    const wide = around(PITCH_SPAN);
    const pitch = (r0: number, r1: number, c: number) =>
      r1 > r0 ? (y(r1, c) - y(r0, c)) / (rows[r1]! - rows[r0]!) : 0;
    const along = new Float32Array(n * cols);
    const shade = new Float32Array(n * cols);
    for (let r = 0; r < n; r++) {
      const r0 = near.back[r]!;
      const r1 = near.ahead[r]!;
      for (let c = 0; c < cols; c++) {
        const k = bend(y(r0, c), y(r, c), y(r1, c), rows[r]! - rows[r0]!, rows[r1]! - rows[r]!);
        const c0 = Math.max(0, c - 2);
        const c1 = Math.min(cols - 1, c + 2);
        const across = bend(y(r, c0), y(r, c), y(r, c1), offsets[c]! - offsets[c0]!, offsets[c1]! - offsets[c]!);
        const facing = pitch(r0, r1, c) - pitch(wide.back[r]!, wide.ahead[r]!, c);
        along[r * cols + c] = k;
        shade[r * cols + c] = Math.max(-1, Math.min(1, 3.5 * facing + 6 * k + 3 * across));
      }
    }
    const dye = new Float32Array(n * cols);
    for (let r = 2; r < n - 2; r++) {
      const limit = this.limitAt(rows[r]!);
      for (let c = 0; c < cols; c++) {
        if (Math.abs(offsets[c]!) > limit) continue;
        const k = along[r * cols + c]!;
        if (k > -DYE_BREAK) continue;
        let sharpest = true;
        for (const d of [-2, -1, 1, 2]) if (along[(r + d) * cols + c]! < k) sharpest = false;
        if (!sharpest) continue;
        // The line runs from the crest back up the approach, where riders see it.
        for (let b = r; b >= 0 && rows[r]! - rows[b]! <= DYE_WIDTH; b--) dye[b * cols + c] = 1;
      }
    }
    return { shade, dye };
  }

  /** How far from the centre line riders can go, at arc length `s`. */
  private limitAt(s: number): number {
    const path = this.run.path;
    const i = Math.round((s - path[0]!.s) / (path[1]!.s - path[0]!.s));
    return path[Math.max(0, Math.min(path.length - 1, i))]!.limit;
  }

  /** The mountain beyond the ribbon: a coarse grid of the sim's heights, sunk a little (and well under the ribbon). */
  private buildMountainAround(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.run.path) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const x0 = Math.floor((minX - GRID_MARGIN) / GRID_STEP) * GRID_STEP;
    const z0 = Math.floor((minZ - GRID_MARGIN) / GRID_STEP) * GRID_STEP;
    const nx = Math.ceil((maxX + GRID_MARGIN - x0) / GRID_STEP) + 1;
    const nz = Math.ceil((maxZ + GRID_MARGIN - z0) / GRID_STEP) + 1;
    const data = this.terrain.grid(x0, z0, GRID_STEP, nx, nz);
    this.grid = { x0, z0, nx, nz };
    this.gridHeights = new Float32Array(nx * nz);
    for (let i = 0; i < nx * nz; i++) this.gridHeights[i] = data[i * 2]!;
    const mat = snowMaterial(false);
    const TILE = 32;
    for (let tz = 0; tz < nz - 1; tz += TILE) {
      for (let tx = 0; tx < nx - 1; tx += TILE) {
        const ex = Math.min(nx - 1, tx + TILE);
        const ez = Math.min(nz - 1, tz + TILE);
        const w = ex - tx + 1;
        const pos: number[] = [];
        const idx: number[] = [];
        let any = false;
        for (let j = tz; j <= ez; j++) {
          for (let i = tx; i <= ex; i++) {
            const k = j * nx + i;
            const dist = data[k * 2 + 1]!;
            const sink = dist < GRID_HIDE ? 6 : GRID_SINK;
            pos.push(x0 + i * GRID_STEP, data[k * 2]! - sink, z0 + j * GRID_STEP);
            if (dist >= GRID_HIDE) any = true;
          }
        }
        if (!any) continue;
        for (let j = 0; j < ez - tz; j++) {
          for (let i = 0; i < ex - tx; i++) {
            const a = j * w + i;
            idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
  }

  /** Pines: crowding the run's edges (thickest through the tree section), and scattered over the mountain. */
  private buildForest(): void {
    const rand = rng(1234);
    const spots: { x: number; z: number; scale: number }[] = [];
    const path = this.run.path;
    for (const p of path) {
      const section = p.s > 700 && p.s < 1000 ? 2.2 : p.s > 1100 && p.s < 1380 ? 1.4 : 1;
      const rx = -Math.cos(p.yaw);
      const rz = Math.sin(p.yaw);
      for (const side of [-1, 1]) {
        const tries = Math.round(2 * section + rand());
        for (let k = 0; k < tries; k++) {
          const near = p.limit + 2.5 + rand() * rand() * (RIBBON_HALF + 30 - p.limit);
          const along = (rand() - 0.5) * 4;
          spots.push({
            x: p.x + rx * side * near + Math.sin(p.yaw) * along,
            z: p.z + rz * side * near + Math.cos(p.yaw) * along,
            scale: 0.75 + rand() * 0.9,
          });
        }
      }
    }
    // The mountain around: clumps.
    const { x0, z0, nx, nz } = this.grid;
    for (let k = 0; k < 2600; k++) {
      const x = x0 + rand() * (nx - 1) * GRID_STEP;
      const z = z0 + rand() * (nz - 1) * GRID_STEP;
      const clump = Math.sin(x * 0.013) * Math.cos(z * 0.011) + Math.sin(x * 0.031 + z * 0.017) * 0.5;
      if (clump < 0.2) continue;
      spots.push({ x, z, scale: 0.8 + rand() * 1.0 });
    }
    // Lone pines on the run (they are solid in the sim).
    for (const o of this.run.obstacles) if (o.kind === "pine") spots.push({ x: o.x, z: o.z, scale: 1.4 });
    // Keep the riding width clear (but for the run's own pines).
    const keep = spots.filter((p) => {
      const nearest = this.nearestPath(p.x, p.z);
      return nearest.dist > nearest.limit + 1.5 || p.scale === 1.4;
    });
    const pts = new Float32Array(keep.length * 2);
    keep.forEach((p, i) => pts.set([p.x, p.z], i * 2));
    const ys = this.terrain.heights(pts);
    const mesh = new THREE.InstancedMesh(
      pineGeometry(),
      new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
      keep.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    keep.forEach((p, i) => {
      q.setFromEuler(e.set(0, rand() * Math.PI * 2, 0));
      m.compose(
        new THREE.Vector3(p.x, ys[i]! - 0.4, p.z),
        q,
        new THREE.Vector3(p.scale, p.scale * (0.9 + rand() * 0.5), p.scale),
      );
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /** The closest point of the run's path (coarse: 4 m samples). */
  private nearestPath(x: number, z: number): { dist: number; limit: number } {
    let best = Infinity;
    let limit = 0;
    for (const p of this.run.path) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < best) {
        best = d;
        limit = p.limit;
      }
    }
    return { dist: Math.sqrt(best), limit };
  }

  /** Red netting along both edges of the run (not in the gully, whose walls hold you in). */
  private buildFences(): void {
    const tex = nettingTexture();
    const mat = new THREE.MeshBasicNodeMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      fog: true,
    });
    const posts: THREE.Matrix4[] = [];
    for (const side of [-1, 1]) {
      const pos: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      const pts = new Float32Array(this.run.path.length * 2);
      const tops: [number, number][] = [];
      this.run.path.forEach((p, i) => {
        const o = (p.limit + 0.5) * side;
        const x = p.x - Math.cos(p.yaw) * o;
        const z = p.z + Math.sin(p.yaw) * o;
        pts.set([x, z], i * 2);
        tops.push([x, z]);
      });
      const ys = this.terrain.heights(pts);
      let u = 0;
      let open = false;
      this.run.path.forEach((p, i) => {
        const fenced = p.half > 10 && p.s > 50 && p.s < this.run.finishS + 30;
        const [x, z] = tops[i]!;
        const y = ys[i]!;
        if (!fenced) {
          open = false;
          return;
        }
        const base = pos.length / 3;
        pos.push(x, y - 0.1, z, x, y + 1.15, z);
        uvs.push(u, 0, u, 1);
        if (open) idx.push(base - 2, base, base - 1, base - 1, base, base + 1);
        open = true;
        u += 4 / 1.2;
        posts.push(new THREE.Matrix4().makeTranslation(x, y + 0.55, z));
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      this.group.add(new THREE.Mesh(geo, mat));
    }
    const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 1.3, 0.06), flat(0x2a2a2a), posts.length);
    posts.forEach((m, i) => postMesh.setMatrixAt(i, m));
    this.group.add(postMesh);
  }

  /** Checkpoint flags, and the start and finish arches. */
  private buildGates(): void {
    const red = flat(0xd8342a, { roughness: 0.6, side: THREE.DoubleSide });
    const pole = flat(0x222222);
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6);
    poleGeo.translate(0, 1.1, 0);
    const flagGeo = new THREE.PlaneGeometry(0.75, 0.55);
    flagGeo.translate(0.375, 1.85, 0);
    for (const g of this.run.checkpoints) {
      for (const side of [-1, 1]) {
        const o = (g.limit + 1.2) * side;
        const x = g.x - Math.cos(g.yaw) * o;
        const z = g.z + Math.sin(g.yaw) * o;
        const y = this.ground(x, z);
        for (const dz of [-0.45, 0.45]) {
          const p = new THREE.Mesh(poleGeo, pole);
          p.position.set(x + Math.sin(g.yaw) * dz, y, z + Math.cos(g.yaw) * dz);
          this.group.add(p);
        }
        const flag = new THREE.Mesh(flagGeo, red);
        flag.position.set(x - Math.sin(g.yaw) * 0.45, y, z - Math.cos(g.yaw) * 0.45);
        flag.rotation.y = g.yaw + Math.PI / 2;
        flag.castShadow = true;
        this.group.add(flag);
      }
    }
    this.arch(this.run.startGate, bannerTexture("23.4° SHIFTY · COSTA NEVADA", "#1f3b6e", "#ffffff"));
    this.arch(this.run.finish, bannerTexture("FINISH", "#f4f4f0", "#111111", true));
    // The start hut behind the grid.
    const hut = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(14, 4, 6), flat(0x7a4a2c));
    walls.position.y = 2;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(9.5, 3, 4), flat(0xeef2f8));
    roof.position.y = 5.5;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 0.5);
    hut.add(walls, roof);
    const back = this.run.path[0]!;
    hut.position.set(
      back.x - Math.sin(back.yaw) * 10,
      this.ground(back.x, back.z - 10) - 0.2,
      back.z - Math.cos(back.yaw) * 10,
    );
    hut.rotation.y = back.yaw;
    hut.traverse((o) => (o.castShadow = true));
    this.group.add(hut);
  }

  private arch(g: GateData, banner: THREE.Texture): void {
    const span = (g.limit + 1.5) * 2;
    const left = { x: g.x + Math.cos(g.yaw) * (span / 2), z: g.z - Math.sin(g.yaw) * (span / 2) };
    const right = { x: g.x - Math.cos(g.yaw) * (span / 2), z: g.z + Math.sin(g.yaw) * (span / 2) };
    const yl = this.ground(left.x, left.z);
    const yr = this.ground(right.x, right.z);
    const top = Math.max(yl, yr, g.y) + 5.5;
    const postMat = flat(0x1f3b6e);
    for (const [p, y] of [
      [left, yl],
      [right, yr],
    ] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, top - y + 1, 0.6), postMat);
      post.position.set(p.x, (top + y) / 2, p.z);
      post.castShadow = true;
      this.group.add(post);
    }
    const sign = new THREE.Mesh(new THREE.BoxGeometry(span, 1.4, 0.2), [
      postMat,
      postMat,
      postMat,
      postMat,
      new THREE.MeshBasicNodeMaterial({ map: banner }),
      new THREE.MeshBasicNodeMaterial({ map: banner }),
    ]);
    sign.position.set(g.x, top, g.z);
    sign.rotation.y = g.yaw;
    sign.castShadow = true;
    this.group.add(sign);
  }

  /** Chairlift towers (solid in the sim), the cable between them, and chairs. */
  private buildLift(): void {
    const towers = this.run.obstacles.filter((o) => o.kind === "tower");
    if (towers.length === 0) return;
    const steel = flat(0x9aa3ad, { roughness: 0.5 });
    const tops: THREE.Vector3[] = [];
    for (const t of towers) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, t.height, 8), steel);
      pole.position.set(t.x, t.y + t.height / 2, t.z);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.35, 0.35), steel);
      arm.position.set(t.x, t.y + t.height, t.z);
      pole.castShadow = arm.castShadow = true;
      this.group.add(pole, arm);
      tops.push(new THREE.Vector3(t.x, t.y + t.height - 0.3, t.z));
    }
    // Extend the line up and down past the first and last tower.
    const first = tops[0]!;
    const last = tops.at(-1)!;
    const dir = last.clone().sub(first).normalize();
    tops.unshift(first.clone().addScaledVector(dir, -120));
    tops.push(last.clone().addScaledVector(dir, 120));
    const cable = new THREE.LineBasicNodeMaterial({ color: 0x30343a });
    const chairs: THREE.Matrix4[] = [];
    for (const side of [-2.6, 2.6]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < tops.length - 1; i++) {
        const a = tops[i]!;
        const b = tops[i + 1]!;
        const n = 16;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const p = a.clone().lerp(b, t);
          p.y -= Math.sin(t * Math.PI) * 1.6;
          const right = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
          p.addScaledVector(right, side);
          pts.push(p);
          if (k % 4 === 2) chairs.push(new THREE.Matrix4().makeTranslation(p.x, p.y - 1.8, p.z));
        }
      }
      this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cable));
    }
    const chairGeo = new THREE.BoxGeometry(1.6, 0.9, 0.7);
    const chairMesh = new THREE.InstancedMesh(chairGeo, flat(0x3b4a5a), chairs.length);
    chairs.forEach((m, i) => chairMesh.setMatrixAt(i, m));
    chairMesh.castShadow = true;
    this.group.add(chairMesh);
  }

  /** Rocks on the run (solid in the sim), with snow on top. */
  private buildRocks(): void {
    const rock = flat(0x6c6a6e);
    const snow = flat(0xeef2f8);
    for (const o of this.run.obstacles) {
      if (o.kind !== "rock") continue;
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(o.radius * 1.1, 0), rock);
      r.position.set(o.x, o.y + o.radius * 0.35, o.z);
      r.scale.y = 0.75;
      const cap = new THREE.Mesh(new THREE.DodecahedronGeometry(o.radius * 0.8, 0), snow);
      cap.position.set(o.x, o.y + o.radius * 0.75, o.z);
      cap.scale.y = 0.35;
      r.castShadow = true;
      this.group.add(r, cap);
    }
  }

  /** A lodge on the bench above the cliff drop. */
  private buildLodge(): void {
    const at = this.run.path.find((p) => p.s >= 1040) ?? this.run.path[0]!;
    const o = at.limit + 9;
    const x = at.x - Math.cos(at.yaw) * o;
    const z = at.z + Math.sin(at.yaw) * o;
    const lodge = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 16), flat(0x8a5a36));
    walls.position.y = 2.5;
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 7.5, 4, 4, 1), flat(0xeef2f8));
    roof.position.y = 7;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 1.55);
    const windows = new THREE.Mesh(new THREE.BoxGeometry(10.1, 1.2, 12), flat(0x2a3440, { roughness: 0.3 }));
    windows.position.y = 3;
    lodge.add(walls, roof, windows);
    lodge.position.set(x, this.ground(x, z) - 0.3, z);
    lodge.rotation.y = at.yaw;
    lodge.traverse((obj) => (obj.castShadow = true));
    this.group.add(lodge);
  }

  update(f: Frame): void {
    const ground = (x: number, z: number) => this.roughGround(x, z);
    // Falling snow around the camera, drifting with the wind.
    this.flakeCarry += f.dt * 420;
    while (this.flakeCarry >= 1) {
      this.flakeCarry -= 1;
      const r = this.random;
      const x = f.eye.x + (r() - 0.5) * 60;
      const z = f.eye.z + (r() - 0.5) * 60;
      const y = f.eye.y + r() * 22 - 4;
      this.flakes.spawn(x, y, z, this.wind.x, -1.4 - r() * 0.8, this.wind.z, 7, 0.05 + r() * 0.05, 0.06 + r() * 0.05);
    }
    for (const r of f.riders) this.emit(r, f.models.get(r.slot), f.dt);
    this.trails.update(f.riders, f.t);
    this.flakes.update(ground, f.dt, { x: this.wind.x, z: this.wind.z });
    this.powder.update(ground, f.dt);
    this.mist.update(() => -1e6, f.dt);
  }

  /** Powder off one rider's board: a spray off the tail when carving or braking, a burst on landing and falling. */
  private emit(r: RiderView, model: RiderModel | undefined, dt: number): void {
    let e = this.emitters.get(r.slot);
    if (!e) {
      e = { carve: 0, mist: 0, grounded: r.grounded, vy: r.vy, bailing: r.bailing };
      this.emitters.set(r.slot, e);
    }
    const landed = r.grounded && !e.grounded;
    const fell = r.bailing && !e.bailing;
    const impact = landed ? Math.min(1, Math.max(0, -e.vy / 12)) : 0;
    e.grounded = r.grounded;
    e.vy = r.vy;
    e.bailing = r.bailing;
    if (!model || !r.grounded) return;
    const fwd = { x: Math.sin(r.yaw), z: Math.cos(r.yaw) };
    const right = { x: -fwd.z, z: fwd.x };
    const speed = r.speed;
    const carve = Math.min(1, (Math.abs(r.steer) * speed) / 18);
    const brake = Math.max(0, -r.lean) * Math.min(1, speed / 6);
    const rate = (carve * 0.6 + brake + (speed > 6 ? 0.08 : 0)) * 260 + impact * 900 + (fell ? 700 : 0);
    e.carve += rate * dt;
    // The edge on the outside of the turn throws the spray.
    const out = r.steer >= 0 ? 1 : -1;
    const rand = this.random;
    while (e.carve >= 1) {
      e.carve -= 1;
      const back = -0.6 + rand() * 0.5;
      const x = r.x + fwd.x * back + right.x * out * 0.15;
      const z = r.z + fwd.z * back + right.z * out * 0.15;
      const throwSide = (1.2 + rand() * 2.5) * (carve + brake) * -out;
      this.powder.spawn(
        x,
        r.y + 0.05,
        z,
        r.vx * 0.55 + right.x * throwSide + (rand() - 0.5),
        1.2 + rand() * 2.4 + impact * 3,
        r.vz * 0.55 + right.z * throwSide + (rand() - 0.5),
        0.5 + rand() * 0.5,
        0.06 + rand() * 0.06,
        0.18 + rand() * 0.2,
      );
    }
    e.mist += (rate * 0.12 + speed * 0.4) * dt;
    while (e.mist >= 1) {
      e.mist -= 1;
      this.mist.spawn(
        r.x - fwd.x * 0.8 + (rand() - 0.5),
        r.y + 0.3,
        r.z - fwd.z * 0.8 + (rand() - 0.5),
        r.vx * 0.3,
        0.4 + rand() * 0.6,
        r.vz * 0.3,
        1.2 + rand() * 0.8,
        0.6,
        2.4 + rand() * 1.6,
      );
    }
  }
}
