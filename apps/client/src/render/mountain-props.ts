// Props round a run that only some runs have (see runs.ts): rock outcrops
// on its walls, the chairlift's top station, a frozen lake, the creek in a
// gully, and what natural lips are made of (a log's ends sticking out of
// the snow, a rock's face under the crest).
import * as THREE from "three/webgpu";
import { FOLIAGE } from "./cel/look.ts";
import type { LipData, RunData, RunPoint } from "./mountain.ts";
import type { Outcrops, RunScenery } from "./runs.ts";

/** Ground heights at many points at once: `[x0, z0, x1, z1, ...]`. */
export type Heights = (points: Float32Array) => Float32Array;

/** Deterministic noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const flat = (color: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, flatShading: true, ...opts });

/** Out in the weather: snow settles on it as deep as it lies (see cel/look.ts). */
const weathered = (color: number) => {
  const m = flat(color);
  m.userData.outdoor = FOLIAGE.none;
  return m;
};

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

/** A lumpy rock, its foot at y = 0, about 2 m across. */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(1, 1);
  const rand = rng(seed);
  const pos = g.attributes.position!;
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let k = seen.get(key);
    if (k === undefined) seen.set(key, (k = 0.8 + rand() * 0.35));
    pos.setXYZ(i, pos.getX(i) * k, Math.max(-0.2, pos.getY(i) * k * 0.8) + 0.2, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Rock outcrops on the walls and round the run: one batch of rocks and one of the snow on them. */
export function outcrops(run: RunData, bands: Outcrops[], heights: Heights): THREE.Object3D[] {
  if (bands.length === 0) return [];
  const rand = rng(4242);
  const spots: { x: number; z: number; size: number; tall: number; turn: number }[] = [];
  for (const b of bands) {
    for (let k = 0; k < b.count; k++) {
      const s = b.from + rand() * (b.to - b.from);
      const p = runPoint(run, s);
      const side = rand() < 0.5 ? -1 : 1;
      const out = p.limit + b.near + rand() * rand() * (b.far - b.near);
      const at = runAt(run, s, side * out);
      const size = b.size * (0.35 + rand() * 0.65);
      spots.push({ x: at.x, z: at.z, size, tall: 0.5 + rand() * 0.7, turn: rand() * Math.PI * 2 });
    }
  }
  const pts = new Float32Array(spots.length * 2);
  spots.forEach((p, i) => pts.set([p.x, p.z], i * 2));
  const ys = heights(pts);
  const rocks = new THREE.InstancedMesh(rockGeometry(7), flat(0x67646b), spots.length);
  const caps = new THREE.InstancedMesh(rockGeometry(9), weathered(0x67646b), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  spots.forEach((p, i) => {
    const r = p.size / 2;
    q.setFromEuler(e.set(0, p.turn, 0));
    m.compose(new THREE.Vector3(p.x, ys[i]! - r * 0.35, p.z), q, new THREE.Vector3(r, r * p.tall, r));
    rocks.setMatrixAt(i, m);
    m.compose(
      new THREE.Vector3(p.x, ys[i]! - r * 0.35 + r * p.tall * 0.62, p.z),
      q,
      new THREE.Vector3(r * 0.78, r * p.tall * 0.42, r * 0.78),
    );
    caps.setMatrixAt(i, m);
  });
  for (const mesh of [rocks, caps]) {
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  return [rocks, caps];
}

/** The chairlift's top station: a housing over the bullwheel on a concrete base. Returns it and where its cable leaves. */
export function liftStation(
  run: RunData,
  top: NonNullable<RunScenery["liftTop"]>,
  towards: THREE.Vector3,
  ground: (x: number, z: number) => number,
): { station: THREE.Group; cable: THREE.Vector3 } {
  const at = runAt(run, top.s, top.offset);
  const y = ground(at.x, at.z);
  const station = new THREE.Group();
  const concrete = flat(0xb9b6ae);
  const steel = flat(0x9aa3ad, { roughness: 0.5 });
  // The base, the hut where the chairs come round, the housing over the
  // bullwheel reaching out over the line, and the wheel under it.
  const base = new THREE.Mesh(new THREE.BoxGeometry(8, 1.2, 12), concrete);
  base.position.y = 0.4;
  const hut = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5), flat(0x7a4a2c));
  hut.position.set(-3.5, 2.5, -3);
  const hutRoof = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.35, 5.6), weathered(0x4e4440));
  hutRoof.position.set(-3.5, 4.15, -3);
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 4.2, 1.6), steel);
  pillar.position.set(0, 3, 1);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(6.8, 1.6, 10), flat(0x1f3b6e));
  housing.position.set(0, 5.6, 3);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.3, 10.4), weathered(0x4e4440));
  roof.position.set(0, 6.55, 3);
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.3, 20), steel);
  wheel.position.set(0, 4.6, 5.5);
  station.add(base, hut, hutRoof, pillar, housing, roof, wheel);
  station.position.set(at.x, y - 0.3, at.z);
  // Its open end faces down the line.
  station.rotation.y = Math.atan2(towards.x - at.x, towards.z - at.z);
  station.traverse((o) => (o.castShadow = true));
  station.updateMatrixWorld(true);
  const cable = new THREE.Vector3(0, 4.6, 8).applyMatrix4(station.matrixWorld);
  return { station, cable };
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
  const mesh = new THREE.Mesh(geo, flat(0xa9c4dc, { roughness: 0.25, flatShading: false }));
  mesh.receiveShadow = true;
  return mesh;
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

/** What natural lips are made of: a log's ends out of the snow either side, a rock's face under a rock lip's crest. */
export function lipProps(run: RunData, lips: LipData[], ground: (x: number, z: number) => number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const bark = flat(0x4a3526);
  const cut = flat(0xc8a27a);
  const stone = flat(0x5f5c63);
  for (const lip of lips) {
    if (lip.kind === "log") {
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
    } else if (lip.kind === "rock") {
      // The crest is snow over the rock's top; its face shows below it, on the drop.
      const at = runAt(run, lip.lip + lip.height * 0.6, lip.offset);
      const r = lip.height * 1.25;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), stone);
      rock.scale.set(Math.max(lip.halfWidth, 1.5) * 0.9, r, r * 0.8);
      rock.position.set(at.x, ground(at.x, at.z) - r * 0.45, at.z);
      rock.rotation.y = at.yaw + Math.PI / 2;
      rock.castShadow = true;
      out.push(rock);
    }
  }
  return out;
}
