// Rider art, loaded once and shared: each model is a .glb of skinned
// pieces (no materials) plus a detail and a mask texture per piece, made by
// art/rider/build.py into public/riders/<body>/.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Body as BodyKind } from "@shifty/rider";
import type { Finish } from "./material.ts";
import { BONE, BONES, boneOf } from "./skeleton.ts";

/** What a piece's tints come from: the item's colourway, or the rider's skin, eyes and hair. */
export type TintSource = "kit" | "look" | "hair";

/** One mesh of a model, skinned to the BONES order. */
export interface Piece {
  name: string;
  geometry: THREE.BufferGeometry;
  detail: THREE.Texture;
  mask: THREE.Texture;
  finish: Finish;
  tints: TintSource;
  /** Body regions this piece covers (bits of REGIONS), hidden while it is worn. */
  hides: number;
}

export interface ModelAsset {
  pieces: Piece[];
  /** The skeleton's rest positions (BONES order). */
  rest: THREE.Vector3[];
}

const BASE = `${import.meta.env.BASE_URL}riders`;
const gltf = new GLTFLoader();
const images = new THREE.TextureLoader();
const cache = new Map<string, Promise<ModelAsset>>();
let manifest: Promise<Record<string, string[]>> | null = null;

/** The models the art has built for a body. */
export async function builtModels(body: BodyKind): Promise<ReadonlySet<string>> {
  manifest ??= fetch(`${BASE}/manifest.json`)
    .then((r) => r.json())
    .then((v: unknown) => {
      const out: Record<string, string[]> = {};
      if (typeof v === "object" && v !== null) {
        for (const [k, list] of Object.entries(v)) {
          if (Array.isArray(list)) out[k] = list.filter((x): x is string => typeof x === "string");
        }
      }
      return out;
    });
  return new Set((await manifest)[body] ?? []);
}

function finishOf(v: unknown): Finish {
  const f: Finish = { roughness: 0.7 };
  if (typeof v === "object" && v !== null) {
    const r: unknown = Reflect.get(v, "roughness");
    const m: unknown = Reflect.get(v, "metalness");
    const rim: unknown = Reflect.get(v, "rim");
    const flat: unknown = Reflect.get(v, "flat");
    if (typeof r === "number") f.roughness = r;
    if (typeof m === "number") f.metalness = m;
    if (typeof rim === "number") f.rim = rim;
    if (typeof flat === "number") f.flat = flat;
  }
  return f;
}

function hidesOf(v: unknown): number {
  return Array.isArray(v) ? v.reduce((m: number, r: unknown) => (typeof r === "number" ? m | (1 << r) : m), 0) : 0;
}

function tintsOf(v: unknown): TintSource {
  return v === "look" || v === "hair" ? v : "kit";
}
const textures = new Map<string, Promise<THREE.Texture>>();

function loadTexture(url: string): Promise<THREE.Texture> {
  let t = textures.get(url);
  if (!t) {
    t = images.loadAsync(url).then((tex) => {
      // The art's UVs follow glTF (origin top left); the maps hold raw factors, not colours.
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    });
    textures.set(url, t);
  }
  return t;
}

/** Rewrites a skinned mesh's joint indices from its glTF skin's order to BONES order. */
function remapJoints(mesh: THREE.SkinnedMesh): THREE.BufferGeometry {
  const map = mesh.skeleton.bones.map((b) => {
    const name = boneOf(b.name);
    if (!name) throw new Error(`unknown bone ${b.name}`);
    return BONE[name];
  });
  const geo = mesh.geometry;
  const idx = geo.getAttribute("skinIndex");
  const out = new Uint16Array(idx.count * 4);
  for (let i = 0; i < idx.count; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = map[idx.getComponent(i, k)] ?? 0;
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(out, 4));
  return geo;
}

/** A model of the art (e.g. `body`, `summer.vest.foam`) for a body, loaded once. */
export function loadModel(body: BodyKind, model: string): Promise<ModelAsset> {
  const key = `${body}/${model}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const file = await gltf.loadAsync(`${BASE}/${key}.glb`);
      file.scene.updateMatrixWorld(true);
      const meshes: THREE.SkinnedMesh[] = [];
      file.scene.traverse((o) => {
        if (o instanceof THREE.SkinnedMesh) meshes.push(o);
      });
      const rest = BONES.map(() => new THREE.Vector3());
      const skeleton = meshes[0]?.skeleton;
      for (const b of skeleton?.bones ?? []) {
        const name = boneOf(b.name);
        if (name) b.getWorldPosition(rest[BONE[name]]!);
      }
      const pieces = await Promise.all(
        meshes.map(async (m) => {
          // A mesh split into primitives comes back as a group of meshes named after the node.
          const name = m.name.replace(/_\d+$/, "");
          const [detail, mask] = await Promise.all([
            loadTexture(`${BASE}/${key}.${name}.detail.png`),
            loadTexture(`${BASE}/${key}.${name}.mask.png`),
          ]);
          const finish: unknown = Reflect.get(m.userData, "finish");
          const tints: unknown = Reflect.get(m.userData, "tints");
          const hides: unknown = Reflect.get(m.userData, "hides");
          return {
            name,
            geometry: remapJoints(m),
            detail,
            mask,
            finish: finishOf(finish),
            tints: tintsOf(tints),
            hides: hidesOf(hides),
          };
        }),
      );
      return { pieces, rest };
    })();
    cache.set(key, p);
  }
  return p;
}
