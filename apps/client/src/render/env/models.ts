// Scenery models, made by art/env/build.py into public/env/: one .glb per
// place, one mesh per model, each vertex with its colour (linear) and two
// masks in its UV that the place's shaders read (see art/env). Loaded once
// and shared.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** A place's models, by name. */
export type Models = ReadonlyMap<string, THREE.BufferGeometry>;

const BASE = `${import.meta.env.BASE_URL}env`;
const cache = new Map<string, Promise<Models>>();

/** The models of `place` (`snow`: the mountain's). Without them (the file missing), an empty set. */
export function loadModels(place: string): Promise<Models> {
  let p = cache.get(place);
  if (!p) {
    p = new GLTFLoader()
      .loadAsync(`${BASE}/${place}.glb`)
      .then((file) => {
        const models = new Map<string, THREE.BufferGeometry>();
        file.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            const g: THREE.BufferGeometry = o.geometry;
            g.computeBoundingBox();
            g.computeBoundingSphere();
            models.set(o.name, g);
          }
        });
        return models;
      })
      .catch((e: unknown) => {
        console.warn(`scenery models (${place}) did not load`, e);
        return new Map<string, THREE.BufferGeometry>();
      });
    cache.set(place, p);
  }
  return p;
}
