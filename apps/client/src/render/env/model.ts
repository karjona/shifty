// Scenery art (the club's terrace, the podium), loaded once and shared: a
// .glb made by art/scene/build.py into public/env/. Its meshes carry a colour
// per vertex and no normals, quantized, each one material class (`solid`,
// `foliage`, `cloth`...), smooth or faceted, and props are stored once and
// placed many times. Here everything of a class becomes one geometry
// (positions, normals, colours and how far the wind sways each vertex), so
// a scene draws in a handful of batches. Groups the scene moves (a fan, a
// gull) stay apart, and named places come along as anchors. The work is
// done a few milliseconds at a time, so the page keeps drawing meanwhile.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** The geometry of each material class (`solid`), or of each class in each square of ground (`solid#1,-2`). */
export type EnvParts = Map<string, THREE.BufferGeometry>;

/** A group the scene moves: its pivot, and its geometry about it. */
export interface EnvAnim {
  name: string;
  matrix: THREE.Matrix4;
  parts: EnvParts;
}

/** A named place, with what the art says about it. */
export interface EnvAnchor {
  matrix: THREE.Matrix4;
  data: Record<string, unknown>;
}

export interface EnvModel {
  parts: EnvParts;
  anims: EnvAnim[];
  anchors: Map<string, EnvAnchor[]>;
}

const BASE = `${import.meta.env.BASE_URL}env`;
const gltf = new GLTFLoader();
const cache = new Map<string, Promise<EnvModel>>();

/** How long the loader works before it lets the page draw a frame (ms). */
const SLICE_MS = 5;

/** A mesh of the file, decoded once however many times it is placed: its vertices as plain numbers, its triangles. */
interface Source {
  position: Float32Array;
  color: Float32Array;
  sway: Float32Array;
  index: Uint32Array;
}

/** Triangles of one class, in the scene's space, before they are joined. */
interface Soup {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  sway: Float32Array;
}

function decode(g: THREE.BufferGeometry): Source {
  const pos = g.getAttribute("position");
  const col = g.getAttribute("color");
  const n = pos.count;
  const position = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const sway = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    position[i * 3] = pos.getX(i);
    position[i * 3 + 1] = pos.getY(i);
    position[i * 3 + 2] = pos.getZ(i);
    color[i * 3] = col.getX(i);
    color[i * 3 + 1] = col.getY(i);
    color[i * 3 + 2] = col.getZ(i);
    sway[i] = col.getW(i);
  }
  const index = new Uint32Array(g.index ? g.index.count : n);
  for (let i = 0; i < index.length; i++) index[i] = g.index ? g.index.getX(i) : i;
  return { position, color, sway, index };
}

/** A mesh as loose triangles in `m`'s space, with normals: per face, or smooth across shared vertices. */
function soup(src: Source, m: THREE.Matrix4, smooth: boolean): Soup {
  const e = m.elements;
  const n = src.sway.length;
  const count = src.index.length;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i += 3) {
    const x = src.position[i]!;
    const y = src.position[i + 1]!;
    const z = src.position[i + 2]!;
    p[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    p[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    p[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  // A mirrored placing turns its faces inside out: read them the other way round.
  const mirrored = m.determinant() < 0;
  const out: Soup = {
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    color: new Float32Array(count * 3),
    sway: new Float32Array(count),
  };
  const shared = smooth ? new Float32Array(n * 3) : null;
  const corners = [0, 0, 0];
  for (let f = 0; f < count; f += 3) {
    corners[0] = src.index[f]!;
    corners[1] = src.index[mirrored ? f + 2 : f + 1]!;
    corners[2] = src.index[mirrored ? f + 1 : f + 2]!;
    const a = corners[0] * 3;
    const b = corners[1] * 3;
    const c = corners[2] * 3;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const wx = p[c]! - p[a]!;
    const wy = p[c + 1]! - p[a + 1]!;
    const wz = p[c + 2]! - p[a + 2]!;
    // The face's normal, as long as the face is big: larger faces weigh more at a shared vertex.
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    if (!shared) {
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
    }
    for (let k = 0; k < 3; k++) {
      const vertex = corners[k]!;
      const v = vertex * 3;
      const o = (f + k) * 3;
      out.position[o] = p[v]!;
      out.position[o + 1] = p[v + 1]!;
      out.position[o + 2] = p[v + 2]!;
      out.color[o] = src.color[v]!;
      out.color[o + 1] = src.color[v + 1]!;
      out.color[o + 2] = src.color[v + 2]!;
      out.sway[f + k] = src.sway[vertex]!;
      if (shared) {
        shared[v] = shared[v]! + nx;
        shared[v + 1] = shared[v + 1]! + ny;
        shared[v + 2] = shared[v + 2]! + nz;
        // (The vertex whose summed normal goes here, read back below.)
        out.normal[o] = vertex;
      } else {
        out.normal[o] = nx;
        out.normal[o + 1] = ny;
        out.normal[o + 2] = nz;
      }
    }
  }
  if (shared) {
    for (let o = 0; o < count * 3; o += 3) {
      const v = out.normal[o]! * 3;
      const len = Math.hypot(shared[v]!, shared[v + 1]!, shared[v + 2]!) || 1;
      out.normal[o] = shared[v]! / len;
      out.normal[o + 1] = shared[v + 1]! / len;
      out.normal[o + 2] = shared[v + 2]! / len;
    }
  }
  return out;
}

/** Soups of one class as one geometry. */
function joined(soups: Soup[]): THREE.BufferGeometry {
  const total = soups.reduce((sum, s) => sum + s.sway.length, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const sway = new Float32Array(total);
  let o = 0;
  for (const s of soups) {
    position.set(s.position, o * 3);
    normal.set(s.normal, o * 3);
    color.set(s.color, o * 3);
    sway.set(s.sway, o);
    o += s.sway.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setAttribute("color", new THREE.BufferAttribute(color, 3));
  g.setAttribute("sway", new THREE.BufferAttribute(sway, 1));
  g.computeBoundingSphere();
  return g;
}

/** The middle of a soup's box, on the ground (x, z). */
function middle(s: Soup): [number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < s.position.length; i += 3) {
    const x = s.position[i]!;
    const z = s.position[i + 2]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [(x0 + x1) / 2, (z0 + z1) / 2];
}

/** How many placings of a prop are worked out between looks at the clock. */
const PLACINGS = 16;

/** Runs `work` on each item, one after another. */
function inTurn<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  return items.reduce((before, item) => before.then(() => work(item)), Promise.resolve());
}

/** Lets the page draw a frame once the loader has worked for a slice (see `SLICE_MS`). */
class Pace {
  private since = performance.now();

  async breathe(): Promise<void> {
    if (performance.now() - this.since < SLICE_MS) return;
    await new Promise<void>((resolve) => setTimeout(resolve));
    this.since = performance.now();
  }
}

/**
 * Collects the meshes under `root` by class, in the space `to` maps their
 * world into. With `cell`, each class is also split by the square of ground
 * that size a mesh's middle is over (`solid#1,-2`), so a big scene culls a
 * square at a time.
 */
async function collect(
  root: THREE.Object3D,
  to: THREE.Matrix4,
  skip: (o: THREE.Object3D) => boolean,
  sources: Map<THREE.BufferGeometry, Source>,
  pace: Pace,
  cell = 0,
): Promise<EnvParts> {
  const meshes: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (skip(o)) return;
    if (o instanceof THREE.Mesh) meshes.push(o);
    for (const c of o.children) visit(c);
  };
  visit(root);
  const soups = new Map<string, Soup[]>();
  const m = new THREE.Matrix4();
  const placing = new THREE.Matrix4();
  await inTurn(meshes, async (o) => {
    const c: unknown = o.userData.c;
    const cls = typeof c === "string" ? c : "solid";
    const add = (made: Soup) => {
      let key = cls;
      if (cell > 0) {
        const [x, z] = middle(made);
        key = `${cls}#${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      }
      let list = soups.get(key);
      if (!list) soups.set(key, (list = []));
      list.push(made);
    };
    const g: THREE.BufferGeometry = o.geometry;
    let src = sources.get(g);
    if (!src) sources.set(g, (src = decode(g)));
    const from = src;
    const smooth = o.userData.s === 1;
    if (!(o instanceof THREE.InstancedMesh)) {
      add(soup(from, m.multiplyMatrices(to, o.matrixWorld), smooth));
      await pace.breathe();
      return;
    }
    // A prop placed many times: once per placing, a few at a time.
    const starts = Array.from({ length: Math.ceil(o.count / PLACINGS) }, (_, k) => k * PLACINGS);
    await inTurn(starts, async (start) => {
      for (let i = start; i < Math.min(o.count, start + PLACINGS); i++) {
        o.getMatrixAt(i, placing);
        add(soup(from, m.multiplyMatrices(to, o.matrixWorld).multiply(placing), smooth));
      }
      await pace.breathe();
    });
  });
  const parts: EnvParts = new Map();
  await inTurn([...soups], async ([key, list]) => {
    parts.set(key, joined(list));
    await pace.breathe();
  });
  return parts;
}

/** A scene of the art (e.g. `club`), loaded once; `cell` splits its classes by squares of ground (see `collect`). */
export function loadEnv(name: string, cell = 0): Promise<EnvModel> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const file = await gltf.loadAsync(`${BASE}/${name}.glb`);
      const scene = file.scene;
      scene.updateMatrixWorld(true);
      const anims: EnvAnim[] = [];
      const anchors = new Map<string, EnvAnchor[]>();
      const sources = new Map<THREE.BufferGeometry, Source>();
      const pace = new Pace();
      const special = (o: THREE.Object3D) =>
        o !== scene && (typeof o.userData.anim === "string" || "anchor" in o.userData);
      const moved: THREE.Object3D[] = [];
      scene.traverse((o) => {
        const anchor: unknown = o.userData.anchor;
        if (typeof o.userData.anim === "string") moved.push(o);
        else if (typeof anchor === "string") {
          let list = anchors.get(anchor);
          if (!list) anchors.set(anchor, (list = []));
          const data: Record<string, unknown> = { ...o.userData };
          list.push({ matrix: o.matrixWorld.clone(), data });
        }
      });
      await inTurn(moved, async (o) => {
        const inverse = o.matrixWorld.clone().invert();
        const parts = await collect(o, inverse, (c) => c !== o && special(c), sources, pace);
        anims.push({ name: String(o.userData.anim), matrix: o.matrixWorld.clone(), parts });
      });
      const parts = await collect(scene, new THREE.Matrix4(), special, sources, pace, cell);
      for (const g of sources.keys()) g.dispose();
      return { parts, anims, anchors };
    })();
    cache.set(name, p);
  }
  return p;
}
