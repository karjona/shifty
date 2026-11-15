// The game's art files (public/riders, rides and env): what there is, how
// big each file is, and loading them, counted in the wait that wants them
// (see loading.ts). A file is asked for by a hash of its content, so a
// browser keeps it until a release changes it (public/_headers).
import files from "virtual:art";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { type Wait, download, joinDownload } from "../loading.ts";

const BASE = import.meta.env.BASE_URL;
const gltf = new GLTFLoader();

/** Whether the art has a file (a path under public/, e.g. `riders/male/body.glb`). */
export function hasArt(path: string): boolean {
  return Object.hasOwn(files, path);
}

/** The art's files whose paths match `pattern`. */
export function artMatching(pattern: RegExp): string[] {
  return Object.keys(files).filter((p) => pattern.test(p));
}

/** Where to fetch a file of the art: by the hash of its content, in builds. */
export function artUrl(path: string): string {
  const hash = Object.hasOwn(files, path) ? files[path]?.[1] : "";
  return hash ? `${BASE}${path}?v=${hash}` : `${BASE}${path}`;
}

/** Downloads a file of the art, its bytes counted in `wait` (null: in the background). */
export function fetchArt(path: string, wait: Wait | null): Promise<ArrayBuffer> {
  return download(artUrl(path), wait, "art", Object.hasOwn(files, path) ? (files[path]?.[0] ?? 0) : 0);
}

/** Counts files of the art that are on their way (asked for by someone else) in `wait` too. */
export function followArt(paths: readonly string[], wait: Wait | null): void {
  for (const p of paths) joinDownload(artUrl(p), wait);
}

/** A glTF file of the art, parsed. */
export async function loadGltf(path: string, wait: Wait | null): Promise<GLTF> {
  return gltf.parseAsync(await fetchArt(path, wait), "");
}

/** An image of the art as it is (raw factors: no colour conversion, no premultiplied alpha), decoded off the main
 * thread. */
export async function loadBitmap(path: string, wait: Wait | null): Promise<ImageBitmap> {
  const blob = new Blob([await fetchArt(path, wait)], { type: "image/png" });
  return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
