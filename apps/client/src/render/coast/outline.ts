// Land as the sim gives it: capsules round a segment (`LandDef` in
// `sim::course`). Distances to them, and their outlines as shapes.
import * as THREE from "three/webgpu";
import type { LandData } from "../course.ts";

/** Distance from (x, z) to a piece of land's shore (negative inside it). */
export function landDistance(l: LandData, x: number, z: number): number {
  const abx = l.bx - l.ax;
  const abz = l.bz - l.az;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 1e-6 ? Math.min(1, Math.max(0, ((x - l.ax) * abx + (z - l.az) * abz) / len2)) : 0;
  return Math.hypot(x - (l.ax + abx * t), z - (l.az + abz * t)) - l.radius;
}

/** Seeded noise in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Outline of a capsule in world xz, counter-clockwise seen from above. */
export function capsuleOutline(l: LandData, steps = 16): THREE.Vector2[] {
  const dir = Math.atan2(l.bz - l.az, l.bx - l.ax);
  const out: THREE.Vector2[] = [];
  const arc = (cx: number, cz: number, from: number) => {
    for (let i = 0; i <= steps; i++) {
      const a = from + (i / steps) * Math.PI;
      out.push(new THREE.Vector2(cx + Math.cos(a) * l.radius, cz + Math.sin(a) * l.radius));
    }
  };
  arc(l.bx, l.bz, dir - Math.PI / 2);
  arc(l.ax, l.az, dir + Math.PI / 2);
  return out;
}

/** A prism over `outline` (world xz) from `bottom` to `top`: [top, sides] material groups. */
export function prism(outline: THREE.Vector2[], bottom: number, top: number): THREE.BufferGeometry {
  // Shape y is world -z (the extrusion is turned to stand up along +y).
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottom, 0);
  return geo;
}
