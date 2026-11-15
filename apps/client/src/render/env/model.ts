// Scenery art (the club's terrace, the podium), loaded once and shared: a
// .glb made by art/env/build.py into public/env/. Its meshes carry a colour
// per vertex and no normals, quantized, each one material class (`solid`,
// `foliage`, `cloth`...), smooth or faceted, and props are stored once and
// placed many times. Here everything of a class becomes one geometry
// (positions, normals, colours and how far the wind sways each vertex), so
// a scene draws in a handful of batches. Groups the scene moves (a fan, a
// gull) stay apart, and named places come along as anchors.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** The geometry of each material class. */
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

/** Triangles as they come out of the file, per class, before they are joined. */
interface Soup {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  sway: Float32Array;
}

/** A mesh of the file as loose triangles in `m`'s space, with normals: per face, or smooth across shared vertices. */
function soup(g: THREE.BufferGeometry, m: THREE.Matrix4, smooth: boolean): Soup {
  const pos = g.getAttribute("position");
  const col = g.getAttribute("color");
  const index = g.index;
  const n = pos.count;
  const count = index ? index.count : n;
  const at = (i: number) => (index ? index.getX(i) : i);
  const p = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    p[i * 3] = v.x;
    p[i * 3 + 1] = v.y;
    p[i * 3 + 2] = v.z;
  }
  const out: Soup = {
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    color: new Float32Array(count * 3),
    sway: new Float32Array(count),
  };
  const shared = smooth ? new Float32Array(n * 3) : null;
  for (let f = 0; f < count; f += 3) {
    const a = at(f) * 3;
    const b = at(f + 1) * 3;
    const c = at(f + 2) * 3;
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
    if (shared) {
      for (const k of [a, b, c]) {
        shared[k] = shared[k]! + nx;
        shared[k + 1] = shared[k + 1]! + ny;
        shared[k + 2] = shared[k + 2]! + nz;
      }
    } else {
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
    }
    [a, b, c].forEach((k, corner) => {
      const o = (f + corner) * 3;
      out.position[o] = p[k]!;
      out.position[o + 1] = p[k + 1]!;
      out.position[o + 2] = p[k + 2]!;
      if (!shared) {
        out.normal[o] = nx;
        out.normal[o + 1] = ny;
        out.normal[o + 2] = nz;
      }
      const vertex = k / 3;
      out.color[o] = col.getX(vertex);
      out.color[o + 1] = col.getY(vertex);
      out.color[o + 2] = col.getZ(vertex);
      out.sway[f + corner] = col.getW(vertex);
    });
  }
  if (shared) {
    for (let f = 0; f < count; f++) {
      const k = at(f) * 3;
      const len = Math.hypot(shared[k]!, shared[k + 1]!, shared[k + 2]!) || 1;
      out.normal[f * 3] = shared[k]! / len;
      out.normal[f * 3 + 1] = shared[k + 1]! / len;
      out.normal[f * 3 + 2] = shared[k + 2]! / len;
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

/** Collects the meshes under `root` by class, in the space `to` maps their world into. */
function collect(root: THREE.Object3D, to: THREE.Matrix4, skip: (o: THREE.Object3D) => boolean): EnvParts {
  const soups = new Map<string, Soup[]>();
  const m = new THREE.Matrix4();
  const visit = (o: THREE.Object3D) => {
    if (skip(o)) return;
    if (o instanceof THREE.Mesh) {
      const cls: unknown = o.userData.c;
      const key = typeof cls === "string" ? cls : "solid";
      let list = soups.get(key);
      if (!list) soups.set(key, (list = []));
      const g: THREE.BufferGeometry = o.geometry;
      list.push(soup(g, m.multiplyMatrices(to, o.matrixWorld), o.userData.s === 1));
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  const parts: EnvParts = new Map();
  for (const [cls, list] of soups) parts.set(cls, joined(list));
  return parts;
}

/** A scene of the art (e.g. `club`), loaded once. */
export function loadEnv(name: string): Promise<EnvModel> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const file = await gltf.loadAsync(`${BASE}/${name}.glb`);
      const scene = file.scene;
      scene.updateMatrixWorld(true);
      const anims: EnvAnim[] = [];
      const anchors = new Map<string, EnvAnchor[]>();
      const special = (o: THREE.Object3D) =>
        o !== scene && (typeof o.userData.anim === "string" || "anchor" in o.userData);
      scene.traverse((o) => {
        const anim: unknown = o.userData.anim;
        const anchor: unknown = o.userData.anchor;
        if (typeof anim === "string") {
          const inverse = o.matrixWorld.clone().invert();
          anims.push({
            name: anim,
            matrix: o.matrixWorld.clone(),
            parts: collect(o, inverse, (c) => c !== o && special(c)),
          });
        } else if (typeof anchor === "string") {
          let list = anchors.get(anchor);
          if (!list) anchors.set(anchor, (list = []));
          const data: Record<string, unknown> = { ...o.userData };
          list.push({ matrix: o.matrixWorld.clone(), data });
        }
      });
      const parts = collect(scene, new THREE.Matrix4(), special);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const g: THREE.BufferGeometry = o.geometry;
          g.dispose();
        }
      });
      return { parts, anims, anchors };
    })();
    cache.set(name, p);
  }
  return p;
}
