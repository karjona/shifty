// Props round a run that only some runs have (see runs.ts): a lake, the
// creek in a gully, and the log a log lip is made of (its ends sticking out
// of the snow).
import * as THREE from "three/webgpu";
import { Fn, float, fwidth, mix, positionWorld, smoothstep, vec2, vec3, vertexStage } from "three/tsl";
import { LOOK, cut0 } from "./cel/look.ts";
import { CelMaterial } from "./cel/material.ts";
import { noise4 } from "./cel/noise.ts";
import { fadingInk, snowLoad } from "./mountain-look.ts";
import type { LipData, RunData, RunPoint } from "./mountain.ts";
import type { RunScenery } from "./runs.ts";

/** Ground heights at many points at once: `[x0, z0, x1, z1, ...]`. */
export type Heights = (points: Float32Array) => Float32Array;

const flat = (color: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, flatShading: true, ...opts });

/** The centre line at `s` (from the run's points every few metres; straight on past either end). */
export function runPoint(run: RunData, s: number): RunPoint {
  const path = run.path;
  const first = path[0]!;
  const last = path.at(-1)!;
  if (s <= first.s || s >= last.s) {
    const p = s <= first.s ? first : last;
    const d = s - p.s;
    return { ...p, s, x: p.x + Math.sin(p.yaw) * d, z: p.z + Math.cos(p.yaw) * d };
  }
  const step = path[1]!.s - first.s;
  const i = Math.min(path.length - 2, Math.floor((s - first.s) / step));
  const a = path[i]!;
  const b = path[i + 1]!;
  const t = (s - a.s) / (b.s - a.s);
  const lerp = (u: number, v: number) => u + (v - u) * t;
  let dyaw = b.yaw - a.yaw;
  if (dyaw > Math.PI) dyaw -= Math.PI * 2;
  if (dyaw < -Math.PI) dyaw += Math.PI * 2;
  return {
    s,
    x: lerp(a.x, b.x),
    y: lerp(a.y, b.y),
    z: lerp(a.z, b.z),
    yaw: a.yaw + dyaw * t,
    half: lerp(a.half, b.half),
    wall: lerp(a.wall, b.wall),
    limit: lerp(a.limit, b.limit),
  };
}

/** World x, z `offset` m right of the centre line at `s`. */
export function runAt(run: RunData, s: number, offset: number): { x: number; z: number; yaw: number } {
  const p = runPoint(run, s);
  return { x: p.x - Math.cos(p.yaw) * offset, z: p.z + Math.sin(p.yaw) * offset, yaw: p.yaw };
}

/** A frozen lake: flat ice over the lowest ground, with its edge sunk into the snow. */
export function lake(run: RunData, spot: NonNullable<RunScenery["lake"]>, heights: Heights): THREE.Mesh {
  const c = runAt(run, spot.s, spot.offset);
  const fx = Math.sin(c.yaw);
  const fz = Math.cos(c.yaw);
  const rings = 8;
  const around = 40;
  const pts = new Float32Array((rings * around + 1) * 2);
  const place = (ring: number, k: number): [number, number] => {
    const t = ring / rings;
    const a = (k / around) * Math.PI * 2;
    // A little lumpy round the shore.
    const wob = 1 + 0.08 * Math.sin(a * 3 + 1) + 0.05 * Math.sin(a * 7);
    const u = Math.cos(a) * spot.along * t * wob;
    const v = Math.sin(a) * spot.across * t * wob;
    return [c.x + fx * u - fz * v, c.z + fz * u + fx * v];
  };
  pts.set([c.x, c.z], 0);
  for (let r = 1; r <= rings; r++)
    for (let k = 0; k < around; k++) pts.set(place(r, k), (1 + (r - 1) * around + k) * 2);
  const ys = heights(pts);
  // The ice lies flat over the ground inside the shore (a little proud of
  // it where the ground dips), and its edge banks down into the snow.
  const inner = Array.from(ys.subarray(0, 1 + around * (rings - 2))).toSorted((a, b) => a - b);
  const ice = inner[Math.floor(inner.length * 0.95)]! + 0.05;
  const pos: number[] = [c.x, ice, c.z];
  for (let r = 1; r <= rings; r++) {
    for (let k = 0; k < around; k++) {
      const [x, z] = place(r, k);
      // The outer ring dips under the snow.
      const y = r === rings ? Math.min(ice, ys[1 + (r - 1) * around + k]!) - 0.4 : ice;
      pos.push(x, y, z);
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < around; k++) idx.push(0, 1 + ((k + 1) % around), 1 + k);
  for (let r = 1; r < rings; r++) {
    for (let k = 0; k < around; k++) {
      const a = 1 + (r - 1) * around + k;
      const b = 1 + (r - 1) * around + ((k + 1) % around);
      const a2 = a + around;
      const b2 = b + around;
      idx.push(a, b, a2, b, b2, a2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, lakeMaterial());
  mesh.receiveShadow = true;
  mesh.userData.noMerge = true;
  return mesh;
}

/**
 * The lake's surface: where snow lies, ice under drifts of blown snow, with
 * dark windows of clear ice and a few cracks; below the snow line, open
 * water in the season's colours.
 */
function lakeMaterial(): CelMaterial {
  const m = new CelMaterial({
    colorNode: Fn(() => {
      const p = positionWorld;
      const frozen = cut0(vertexStage(snowLoad(p)).sub(0.35));
      const wide = noise4(p.xz.mul(0.045));
      const fine = noise4(p.xz.mul(0.21));
      // Drifts of snow over the ice, clear ice between them.
      const drift = cut0(wide.x.add(fine.y.mul(0.3)).add(0.12));
      const clear = mix(vec3(0.42, 0.62, 0.78), vec3(0.3, 0.5, 0.7), cut0(wide.z.add(0.1)));
      // Cracks: thin pale lines where a stretched noise crosses zero.
      const crack = fine.z.add(wide.w.mul(0.6)).abs();
      const w = fwidth(crack).max(1e-4);
      const cracked = smoothstep(w.mul(2.2), w.mul(0.8), crack).mul(float(1).sub(drift));
      const ice = mix(mix(clear, vec3(0.8, 0.9, 0.97), cracked.mul(0.7)), vec3(0.92, 0.95, 1.0), drift);
      const ripple = cut0(noise4(p.xz.mul(vec2(0.5, 1.6)).add(LOOK.time.mul(0.05))).x.sub(0.25));
      const water = mix(LOOK.seaMid, LOOK.seaLight, ripple.mul(0.5));
      return mix(water, ice, frozen);
    })(),
    shade: new THREE.Color(0.62, 0.68, 0.95),
  });
  return fadingInk(m, 0.5, 0, 0, 0.5);
}

/** The creek along the foot of a gully's wall: a strip of ice in the snow. */
export function creek(run: RunData, spot: NonNullable<RunScenery["creek"]>, heights: Heights): THREE.Mesh {
  const rows: { x: number; z: number }[][] = [];
  for (let s = spot.from; s <= spot.to; s += 2) {
    const p = runPoint(run, s);
    // Narrow where it comes out of the snow and goes back under it.
    const open = Math.min(1, (s - spot.from) / 30, (spot.to - s) / 30);
    const wander = Math.sin(s * 0.07) * 0.4;
    const mid = (p.half + 0.6 + wander) * spot.side;
    const w = (0.2 + 0.4 * open) * spot.side;
    rows.push([runAt(run, s, mid - w), runAt(run, s, mid + w)]);
  }
  const pts = new Float32Array(rows.length * 4);
  rows.forEach(([a, b], i) => pts.set([a!.x, a!.z, b!.x, b!.z], i * 4));
  const ys = heights(pts);
  const pos: number[] = [];
  rows.forEach(([a, b], i) => {
    // Level across, just over the snow.
    const y = Math.min(ys[i * 2]!, ys[i * 2 + 1]!) + 0.06;
    pos.push(a!.x, y, a!.z, b!.x, y, b!.z);
  });
  const idx: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, flat(0x6f8fa8, { roughness: 0.2, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

/** What log lips are made of: the log's ends out of the snow either side of the run. */
export function lipProps(run: RunData, lips: LipData[], ground: (x: number, z: number) => number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const bark = flat(0x4a3526);
  const cut = flat(0xc8a27a);
  for (const lip of lips) {
    if (lip.kind !== "log") continue;
    const p = runPoint(run, lip.lip);
    const reach = lip.halfWidth + 3.2;
    const a = runAt(run, lip.lip, lip.offset - reach);
    const b = runAt(run, lip.lip, lip.offset + reach);
    const ya = ground(a.x, a.z);
    const yb = ground(b.x, b.z);
    const len = Math.hypot(b.x - a.x, b.z - a.z, yb - ya);
    const log = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, len, 9), bark);
    trunk.rotation.z = Math.PI / 2;
    const end = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.04, 9), cut);
    end.rotation.z = Math.PI / 2;
    end.position.x = len / 2;
    log.add(trunk, end);
    // A broken branch stub.
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.9, 5), bark);
    stub.position.set(-len / 2 + 0.8, 0.45, 0.1);
    stub.rotation.z = 0.5;
    log.add(stub);
    log.position.set((a.x + b.x) / 2, (ya + yb) / 2 + 0.2, (a.z + b.z) / 2);
    log.rotation.y = p.yaw;
    log.rotation.z = Math.atan2(ya - yb, len);
    log.traverse((o) => (o.castShadow = true));
    out.push(log);
  }
  return out;
}
