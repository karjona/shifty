// Rider art, loaded once and shared: each model is a .glb of skinned
// pieces (no materials) plus a detail and a mask texture per piece (for the
// body's skin, its drawn anatomy instead), made by art/rider/build.py into
// public/riders/<body>/. A model's textures come down with it, not after it.
import * as THREE from "three/webgpu";
import type { Body as BodyKind } from "@shifty/rider";
import type { Wait } from "../../loading.ts";
import { artMatching, followArt, hasArt, loadBitmap, loadGltf } from "../art.ts";
import { BONE, BONES, boneOf } from "./skeleton.ts";

/** How a piece's surface takes the light. */
export interface Finish {
  /** Below about 0.45 the piece is glossy: it gets a highlight. */
  roughness: number;
}

/** What a piece's tints come from: the item's colourway, or the rider's skin, eyes and hair. */
export type TintSource = "kit" | "look" | "hair";

/** One mesh of a model, skinned to the BONES order. */
export interface Piece {
  name: string;
  geometry: THREE.BufferGeometry;
  detail: THREE.Texture;
  mask: THREE.Texture;
  /** The paint without its baked light, where the art has one (the face). */
  flat: THREE.Texture | null;
  /** The face: how its texture runs across the eyes, as (du/dx, dv/dx, du/dz, dv/dz) per metre to the rider's
   * left (x) and up (z). */
  gaze: readonly [number, number, number, number] | null;
  /** The body's skin: its drawn anatomy (ink lines, shapes of shade). Its `detail` and `mask` are blank. */
  lines: THREE.Texture | null;
  finish: Finish;
  tints: TintSource;
  /** Body regions this piece covers (bits of REGIONS), hidden while it is worn. */
  hides: number;
  /** Its morph targets by name (the face's presets, e.g. `nose.2`). */
  morphs: Readonly<Record<string, number>>;
}

export interface ModelAsset {
  pieces: Piece[];
  /** The skeleton's rest positions (BONES order). */
  rest: THREE.Vector3[];
}

const BASE = "riders";
const cache = new Map<string, Promise<ModelAsset>>();
const built = new Map<BodyKind, ReadonlySet<string>>();

/** The models the art has built for a body. */
export function builtModels(body: BodyKind): ReadonlySet<string> {
  let set = built.get(body);
  if (!set) {
    const prefix = `${BASE}/${body}/`;
    set = new Set(artMatching(/\.glb$/u).flatMap((p) => (p.startsWith(prefix) ? [p.slice(prefix.length, -4)] : [])));
    built.set(body, set);
  }
  return set;
}

function finishOf(v: unknown): Finish {
  const f: Finish = { roughness: 0.7 };
  if (typeof v === "object" && v !== null) {
    const r: unknown = Reflect.get(v, "roughness");
    if (typeof r === "number") f.roughness = r;
  }
  return f;
}

function hidesOf(v: unknown): number {
  return Array.isArray(v) ? v.reduce((m: number, r: unknown) => (typeof r === "number" ? m | (1 << r) : m), 0) : 0;
}

function gazeOf(v: unknown): Piece["gaze"] {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [a, b, c, d]: unknown[] = v;
  return typeof a === "number" && typeof b === "number" && typeof c === "number" && typeof d === "number"
    ? [a, b, c, d]
    : null;
}

function tintsOf(v: unknown): TintSource {
  return v === "look" || v === "hair" ? v : "kit";
}
const textures = new Map<string, Promise<THREE.Texture>>();

/** A texture of nothing, for pieces that have no paint of a kind. */
const BLANK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLANK.needsUpdate = true;

/** A face overlay of the art (e.g. `brows.2`, `beard.1`): how much of each texel of the face it covers. */
export function loadOverlay(body: BodyKind, name: string, wait: Wait | null): Promise<THREE.Texture | null> {
  const path = `${BASE}/${body}/body.face.${name}.png`;
  return hasArt(path) ? loadTexture(path, wait).catch(() => null) : Promise.resolve(null);
}

/** A texture of the art (a path under public/; a map of raw factors, not colours), loaded once. */
export function loadTexture(path: string, wait: Wait | null): Promise<THREE.Texture> {
  let t = textures.get(path);
  // (Still on its way: counted in this wait too.)
  if (t) followArt([path], wait);
  else {
    t = loadBitmap(path, wait).then((bitmap) => {
      const tex = new THREE.Texture(bitmap);
      // The art's UVs follow glTF (origin top left).
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    });
    // A texture that failed can be asked for again.
    t.catch(() => textures.delete(path));
    textures.set(path, t);
  }
  return t;
}

/** A texture of the art if it has it (null if not). */
function maybeTexture(path: string, wait: Wait | null): Promise<THREE.Texture | null> {
  return hasArt(path) ? loadTexture(path, wait).catch(() => null) : Promise.resolve(null);
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

/** The textures of a model's pieces (`<model>.<piece>.<map>.png`): the model's file names its pieces, but they
 * need not wait for it. */
function pieceTextures(key: string): string[] {
  const prefix = `${BASE}/${key}.`;
  return artMatching(/\.(?:detail|mask|flat|lines)\.png$/u).filter(
    (p) => p.startsWith(prefix) && /^[^.]+\.[a-z]+\.png$/u.test(p.slice(prefix.length)),
  );
}

/** A model of the art (e.g. `body`, `summer.vest.foam`) for a body, loaded once; `wait` counts its download. */
export function loadModel(body: BodyKind, model: string, wait: Wait | null): Promise<ModelAsset> {
  const key = `${body}/${model}`;
  let p = cache.get(key);
  // (Still on its way: counted in this wait too.)
  if (p) followArt([`${BASE}/${key}.glb`, ...pieceTextures(key)], wait);
  else {
    for (const path of pieceTextures(key)) void loadTexture(path, wait).catch(() => null);
    p = (async () => {
      const file = await loadGltf(`${BASE}/${key}.glb`, wait);
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
          const skin = model === "body" && name === "skin";
          const [detail, mask, flat, lines] = await Promise.all([
            skin ? BLANK : loadTexture(`${BASE}/${key}.${name}.detail.png`, wait),
            skin ? BLANK : loadTexture(`${BASE}/${key}.${name}.mask.png`, wait),
            name === "face" ? maybeTexture(`${BASE}/${key}.${name}.flat.png`, wait) : Promise.resolve(null),
            skin ? loadTexture(`${BASE}/${key}.${name}.lines.png`, wait) : Promise.resolve(null),
          ]);
          const finish: unknown = Reflect.get(m.userData, "finish");
          const tints: unknown = Reflect.get(m.userData, "tints");
          const hides: unknown = Reflect.get(m.userData, "hides");
          return {
            morphs: { ...m.morphTargetDictionary },
            name,
            geometry: remapJoints(m),
            detail,
            mask,
            flat,
            lines,
            gaze: gazeOf(Reflect.get(m.userData, "gaze")),
            finish: finishOf(finish),
            tints: tintsOf(tints),
            hides: hidesOf(hides),
          };
        }),
      );
      return { pieces, rest };
    })();
    // A model that failed can be asked for again.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
