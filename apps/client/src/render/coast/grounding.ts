// Shade lying under things the sun's shadow box doesn't reach: a flat
// shape on the ground under each tree, parasol and person, drawn in the
// ground's own colour and always in its shade tone. Where a cast shadow
// falls too, the two are one tone; under a closed sky both are gone.
import * as THREE from "three/webgpu";
import { float } from "three/tsl";
import { FOLIAGE } from "../cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId } from "../cel/material.ts";
import { Shape } from "./shape.ts";

/** How far a shade lies over the ground it is drawn on (m). */
const LIFT = 0.05;
const SIDES = 14;

let plain: CelMaterial | null = null;

/** Shade on painted ground (paving, decks, sand laid in one colour): each vertex its ground's colour. */
export function shadeMaterial(): CelMaterial {
  plain ??= new CelMaterial({
    vertexColors: true,
    outdoor: FOLIAGE.none,
    cast: float(0),
    silhouette: 0,
    crease: 0,
    darkness: 0,
    id: inkId("shade"),
  });
  plain.name = "shade";
  return plain;
}

/** Which way shade falls from what casts it, and how far it is drawn out. */
export interface Sunlight {
  /** Unit vector (x, z) from a thing to its shade. */
  x: number;
  z: number;
  /** A shade's length for each metre of height that casts it (kept short when the sun is low). */
  reach: number;
}

/** The light that `sun` (the direction to it) throws. */
export function sunlight(sun: THREE.Vector3): Sunlight {
  const flat = Math.hypot(sun.x, sun.z) || 1;
  const up = Math.max(0.17, sun.y / sun.length());
  return { x: -sun.x / flat, z: -sun.z / flat, reach: Math.min(1.1, Math.sqrt(1 - up * up) / up) };
}

/** The sun straight overhead: shade lies under what casts it. */
export const OVERHEAD: Sunlight = { x: 1, z: 0, reach: 0 };

export class Grounding {
  private shape = new Shape();
  private light: Sunlight;
  private centre = new THREE.Vector3();

  constructor(light: Sunlight) {
    this.light = light;
  }

  /**
   * The shade of something `radius` across whose middle hangs `height`
   * over the ground at `(x, y, z)`, on ground of `colour` (or the colour
   * it has at each place). `ground` gives the ground's height where it
   * isn't level, and `lift` how far over it the shade is drawn.
   */
  add(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    colour: THREE.ColorRepresentation | ((x: number, z: number) => THREE.Color),
    ground?: (x: number, z: number) => number,
    lift = LIFT,
  ): void {
    const l = this.light;
    // Thrown a little way from the sun, and drawn out along its light.
    const throwBy = Math.min(height * l.reach, radius * 1.4);
    const long = radius * (1 + Math.min(0.9, l.reach * 0.6));
    const cx = x + l.x * throwBy;
    const cz = z + l.z * throwBy;
    const at = (px: number, pz: number) => (ground ? ground(px, pz) : y) + lift;
    const paint = typeof colour === "function" ? (q: THREE.Vector3) => colour(q.x, q.z) : colour;
    this.centre.set(cx, at(cx, cz), cz);
    const rim: THREE.Vector3[] = [];
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2;
      const u = Math.cos(a) * long;
      const w = Math.sin(a) * radius;
      const px = cx + l.x * u - l.z * w;
      const pz = cz + l.z * u + l.x * w;
      rim.push(new THREE.Vector3(px, at(px, pz), pz));
    }
    for (let i = 0; i < SIDES; i++) {
      const a = rim[i]!;
      const b = rim[(i + 1) % SIDES]!;
      // (Wound to face up whichever way the light falls.)
      this.shape.tri(this.centre.clone(), b, a, paint);
    }
  }

  /** How many shades it holds. */
  get count(): number {
    return this.shape.triangles / SIDES;
  }

  /** The shades as one mesh of `material` (null if there are none). */
  build(material: CelMaterial = shadeMaterial()): THREE.Mesh | null {
    if (this.shape.triangles === 0) return null;
    const mesh = this.shape.mesh(material, "none");
    mesh.name = "shade";
    mesh.layers.set(UNREFLECTED);
    return mesh;
  }
}
