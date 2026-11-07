// Ride art (jetskis and snowboards), loaded once and shared: each model is
// a .glb of one mesh skinned to the bones `ride` and, on a jetski, `bars`
// (no materials), plus a detail and a mask texture, made by
// art/ride/build.py into public/rides/.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadTexture } from "../rider/assets.ts";

/** The bones a ride's mesh is skinned to, in this order. */
export const RIDE_BONES = ["ride", "bars"] as const;

export interface RideAsset {
  geometry: THREE.BufferGeometry;
  /** Tint factors and marks (grey). */
  detail: THREE.Texture;
  /** How much of the main, second and accent colour (RGB), and how glossy (A). */
  mask: THREE.Texture;
  /** Where the bars turn (their bone's rest position), if the ride has bars. */
  bars: THREE.Vector3 | null;
}

const BASE = `${import.meta.env.BASE_URL}rides`;
const gltf = new GLTFLoader();
const cache = new Map<string, Promise<RideAsset>>();
let manifest: Promise<ReadonlySet<string>> | null = null;

/** The ride models the art has built. */
export function builtRides(): Promise<ReadonlySet<string>> {
  manifest ??= fetch(`${BASE}/manifest.json`)
    .then((r) => r.json())
    .then((v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []))
    .catch(() => new Set<string>());
  return manifest;
}

/** A bone's place in RIDE_BONES (the root's if it isn't one). */
function boneIndex(name: string): number {
  const i = RIDE_BONES.findIndex((n) => n === name);
  return i < 0 ? 0 : i;
}

/** Rewrites the mesh's joint indices from its glTF skin's order to RIDE_BONES order. */
function remapJoints(mesh: THREE.SkinnedMesh): THREE.BufferGeometry {
  const map = mesh.skeleton.bones.map((b) => boneIndex(b.name));
  const geo = mesh.geometry;
  const idx = geo.getAttribute("skinIndex");
  const out = new Uint16Array(idx.count * 4);
  for (let i = 0; i < idx.count; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = map[idx.getComponent(i, k)] ?? 0;
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(out, 4));
  return geo;
}

/** A ride model of the art (e.g. `summer.ride.runabout`), loaded once. */
export function loadRide(model: string): Promise<RideAsset> {
  let p = cache.get(model);
  if (!p) {
    p = (async () => {
      const [file, detail, mask] = await Promise.all([
        gltf.loadAsync(`${BASE}/${model}.glb`),
        loadTexture(`${BASE}/${model}.detail.png`),
        loadTexture(`${BASE}/${model}.mask.png`),
      ]);
      file.scene.updateMatrixWorld(true);
      let mesh: THREE.SkinnedMesh | null = null;
      file.scene.traverse((o) => {
        if (o instanceof THREE.SkinnedMesh) mesh ??= o;
      });
      if (!mesh) throw new Error(`${model}: no skinned mesh`);
      const found: THREE.SkinnedMesh = mesh;
      const bone = found.skeleton.bones.find((b) => b.name === "bars");
      return {
        geometry: remapJoints(found),
        detail,
        mask,
        bars: bone ? bone.getWorldPosition(new THREE.Vector3()) : null,
      };
    })();
    cache.set(model, p);
  }
  return p;
}
