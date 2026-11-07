// Race buoys: tall inflatable marks on a float collar, red (keep it on your
// right) or green (keep it on your left), with an arrow on a white band
// pointing down to the side to pass on. Ride into one and it gives: it is
// shoved aside and under, then swings back upright and bobs. That motion is
// a look, driven by where the riders are drawn; in the sim a buoy stays on
// its anchor (see `sim::buoy`), with the same size as drawn here.
import * as THREE from "three/webgpu";
import type { CourseData } from "./course.ts";
import { inklessBasic } from "./cel/material.ts";
import { Parts } from "./parts.ts";
import { waveHeight } from "./waves.ts";
import type { RiderView } from "./world.ts";

/** Keep red on your right, green on your left ("red right returning"). */
const BUOY_RED = 0xe8402a;
const BUOY_GREEN = 0x2fb34a;
const WHITE = 0xf6f4ee;
const INK = 0x1c2230;
const COLLAR = 0x2c313c;
const LAMP = 0xfff3b0;

/** The band the arrow is on: from and to, as fractions of the buoy's height. */
const BAND = { from: 0.46, to: 0.88 };
/** The arrow's length, as a fraction of the buoy's height. */
const ARROW = 0.44;

/** Springs of the buoys' swing (per second²) and their damping (per second). */
const SWING = { free: 26, held: 140, damp: 2.2, heldDamp: 14 };
const SLIDE = { free: 10, held: 90, damp: 3, heldDamp: 14 };
const DUNK = { free: 40, held: 160, damp: 5, heldDamp: 18 };
/** How far a hit swings a buoy (radians), shoves it (m) and dunks it (m), at full overlap. */
const MAX_SWING = 1.25;
const MAX_SLIDE = 1.3;
const MAX_DUNK = 1.0;
/** How much of the swell's slope a buoy leans with. */
const FOLLOW_SWELL = 0.7;

function lathe(color: THREE.ColorRepresentation, profile: [number, number][], parts: Parts): void {
  parts.add(
    new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r, y)),
      24,
    ),
    color,
  );
}

/** Splits triangles until no edge is longer than `max` (so they can bend round a curve). */
function subdivide(geo: THREE.BufferGeometry, max: number): THREE.BufferGeometry {
  const src = geo.attributes.position!;
  const out: number[] = [];
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(src, i);
  const split = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, depth: number) => {
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    if (longest <= max || depth > 6) {
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      return;
    }
    const ab = a.clone().lerp(b, 0.5);
    const bc = b.clone().lerp(c, 0.5);
    const ca = c.clone().lerp(a, 0.5);
    split(a, ab, ca, depth + 1);
    split(ab, b, bc, depth + 1);
    split(ca, bc, c, depth + 1);
    split(ab, bc, ca, depth + 1);
  };
  for (let i = 0; i < src.count; i += 3) split(v(i), v(i + 1), v(i + 2), 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return g;
}

/**
 * An arrow of `length` pointing 45° down and to the rider's left (`side`
 * -1) or right (+1), centred at height `y` and wrapped round the front
 * (+Z) of a band whose radius at each height is `radius`.
 */
function arrowOnBand(side: -1 | 1, length: number, radius: (y: number) => number, y: number): THREE.BufferGeometry {
  const half = length / 2;
  const shaft = length * 0.12;
  const head = length * 0.3;
  const headLength = length * 0.42;
  const s = new THREE.Shape();
  s.moveTo(-half, -shaft);
  s.lineTo(half - headLength, -shaft);
  s.lineTo(half - headLength, -head);
  s.lineTo(half, 0);
  s.lineTo(half - headLength, head);
  s.lineTo(half - headLength, shaft);
  s.lineTo(-half, shaft);
  s.closePath();
  const flat = new THREE.ShapeGeometry(s).toNonIndexed();
  flat.rotateZ(side < 0 ? -0.75 * Math.PI : -0.25 * Math.PI);
  const g = subdivide(flat, radius(y) * 0.12);
  flat.dispose();
  const pos = g.attributes.position!;
  const normals = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const at = y + pos.getY(i);
    const r = radius(at);
    const a = pos.getX(i) / r;
    pos.setXYZ(i, r * Math.sin(a), at, r * Math.cos(a));
    normals.set([Math.sin(a), 0, Math.cos(a)], i * 3);
  }
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return g;
}

/** The parts' merged geometry (without the material `Parts.build` makes for it). */
export function geometryOf(parts: Parts): THREE.BufferGeometry {
  const mesh = parts.build();
  const material = mesh.material;
  if (!Array.isArray(material)) material.dispose();
  return mesh.geometry;
}

/**
 * One buoy, `height` tall above the water line and `radius` wide at it, in
 * `color`, with its arrow pointing to `side` (seen from the front, +Z).
 */
function buoyGeometry(color: number, side: -1 | 1, radius: number, height: number): THREE.BufferGeometry {
  const r = radius;
  const h = height;
  const parts = new Parts();
  // The float collar the buoy is moored by, at the water line.
  lathe(
    COLLAR,
    [
      [0, -0.5],
      [r * 0.8, -0.5],
      [r * 0.97, -0.38],
      [r * 1.02, -0.15],
      [r, 0.06],
      [r * 0.9, 0.17],
      [r * 0.76, 0.2],
    ],
    parts,
  );
  // The inflatable: a tall column in panels, the white band, a round top.
  const col = (y: number) => r * (0.79 - 0.06 * (y / h));
  const seam = (y: number, depth: number): [number, number] => [col(y) - depth, y];
  lathe(
    color,
    [
      [r * 0.76, 0.2],
      [col(0.22), 0.24],
      seam(h * 0.17, -0.008),
      seam(h * 0.28, 0.014),
      seam(h * 0.38, -0.008),
      [col(h * BAND.from), h * BAND.from],
    ],
    parts,
  );
  lathe(
    WHITE,
    [
      [col(h * BAND.from), h * BAND.from],
      [col(h * BAND.to), h * BAND.to],
    ],
    parts,
  );
  const top = col(h * 0.9);
  const dome: [number, number][] = [[col(h * BAND.to), h * BAND.to]];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    dome.push([top * Math.cos(a), h * 0.9 + h * 0.1 * Math.sin(a)]);
  }
  lathe(color, dome, parts);
  // (Painted just off the band, so the two never fight for the same depth.)
  parts.add(
    arrowOnBand(side, h * ARROW, (y) => col(y) + 0.015, h * (BAND.from + BAND.to) * 0.5),
    INK,
  );
  // The lamp on top.
  parts.add(new THREE.CylinderGeometry(r * 0.12, r * 0.14, 0.14, 8), COLLAR, 0, h + 0.05, 0);
  return geometryOf(parts);
}

/** How one buoy swings, is shoved and dunked: each a spring back to rest. */
interface Swing {
  /** Lean of the top (horizontal, radians) and its rate. */
  tx: number;
  tz: number;
  wx: number;
  wz: number;
  /** Shove off the anchor (m) and its speed. */
  ox: number;
  oz: number;
  vx: number;
  vz: number;
  /** Dunk (m, negative = under) and its speed. */
  dy: number;
  vy: number;
}

interface Mark {
  x: number;
  z: number;
  yaw: number;
  /** Which batch draws it, and as which copy. */
  batch: THREE.InstancedMesh;
  index: number;
  swing: Swing;
}

/** Steps a spring toward `target`, `held` or free. Returns the new [value, rate]. */
function spring(
  x: number,
  v: number,
  target: number,
  held: boolean,
  s: { free: number; held: number; damp: number; heldDamp: number },
  dt: number,
): [number, number] {
  const k = held ? s.held : s.free;
  const c = held ? s.heldDamp : s.damp;
  const nv = v + (k * (target - x) - c * v) * dt;
  return [x + nv * dt, nv];
}

export class BuoyMarks {
  readonly group = new THREE.Group();
  private marks: Mark[] = [];
  private batches = new Map<"left" | "right", THREE.InstancedMesh>();
  private reach: number;
  private height: number;
  /** The next buoy to pass: a ring on the water round it, and its lamp flashing. */
  private ring: THREE.Mesh;
  private lamp: THREE.Mesh;
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private turn = new THREE.Quaternion();
  private axis = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private lampAt = new THREE.Vector3();

  constructor(data: CourseData) {
    const radius = data.buoyRadius;
    this.height = data.buoyHeight;
    this.reach = data.buoyRadius + data.riderRadius;
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5 });
    for (const keep of ["right", "left"] as const) {
      const list = data.buoys.filter((b) => b.keep === keep);
      if (list.length === 0) continue;
      // Keep it on your right = pass on its left: the arrow points down-left.
      const geo = buoyGeometry(
        keep === "right" ? BUOY_RED : BUOY_GREEN,
        keep === "right" ? -1 : 1,
        radius,
        this.height,
      );
      const batch = new THREE.InstancedMesh(geo, material, list.length);
      batch.castShadow = true;
      // (The copies move every frame: the batch is never culled as a whole.)
      batch.frustumCulled = false;
      this.batches.set(keep, batch);
      this.group.add(batch);
    }
    for (const b of data.buoys) {
      const batch = this.batches.get(b.keep)!;
      const index = this.marks.filter((m) => m.batch === batch).length;
      this.marks.push({
        x: b.x,
        z: b.z,
        yaw: b.yaw,
        batch,
        index,
        swing: { tx: 0, tz: 0, wx: 0, wz: 0, ox: 0, oz: 0, vx: 0, vz: 0, dy: 0, vy: 0 },
      });
    }
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius + 2, 0.12, 6, 40),
      new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.26, 10, 6), inklessBasic({ color: LAMP }));
    // (Hidden by shrinking, never by `visible`: what is hidden at warm-up isn't compiled.)
    for (const m of [this.ring, this.lamp]) {
      m.frustumCulled = false;
      m.scale.setScalar(0);
      this.group.add(m);
    }
  }

  /** Floats the buoys on the swell, swings them where riders hit them, and marks the next one. */
  update(waves: Float32Array, t: number, dt: number, riders: readonly RiderView[], next: number | null): void {
    const step = Math.min(dt, 1 / 20);
    const subs = Math.max(1, Math.ceil(step * 120));
    for (const m of this.marks) {
      const water = waveHeight(waves, m.x, m.z, t);
      this.swing(m, water, riders, step / subs, subs);
      this.place(m, waves, water, t);
    }
    for (const b of this.batches.values()) b.instanceMatrix.needsUpdate = true;

    const mark = next === null ? undefined : this.marks[next];
    if (mark) {
      const pulse = 1 + 0.12 * Math.sin(t * 6);
      this.ring.position.set(mark.x, waveHeight(waves, mark.x, mark.z, t) + 0.15, mark.z);
      this.ring.scale.setScalar(pulse);
      mark.batch.getMatrixAt(mark.index, this.matrix);
      this.lamp.position.copy(this.lampAt.set(0, this.height + 0.16, 0).applyMatrix4(this.matrix));
      this.lamp.scale.setScalar(t % 1 < 0.5 ? 1 : 0);
    } else {
      this.ring.scale.setScalar(0);
      this.lamp.scale.setScalar(0);
    }
  }

  /** Where riders overlap a buoy, it is pushed over, aside and under; free, it swings back. */
  private swing(m: Mark, water: number, riders: readonly RiderView[], dt: number, subs: number): void {
    let tx = 0;
    let tz = 0;
    let ox = 0;
    let oz = 0;
    let dy = 0;
    let held = false;
    for (const r of riders) {
      const dx = r.x - m.x;
      const dz = r.z - m.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= this.reach || r.y - water > this.height) continue;
      held = true;
      const overlap = (this.reach - dist) / this.reach;
      const speed = Math.hypot(r.vx, r.vz);
      let ux: number;
      let uz: number;
      if (speed > 0.5) {
        // Shoved to the far side from the rider's (who goes out the near
        // side, as the sim pushes them), and dragged along with the hull.
        const mx = r.vx / speed;
        const mz = r.vz / speed;
        const side = dx * -mz + dz * mx < 0 ? -1 : 1;
        ux = mz * side * 0.75 + mx * 0.65;
        uz = -mx * side * 0.75 + mz * 0.65;
      } else {
        ux = dist > 1e-3 ? -dx / dist : 1;
        uz = dist > 1e-3 ? -dz / dist : 0;
      }
      const len = Math.hypot(ux, uz);
      const hard = Math.min(1, overlap * (0.6 + speed / 25));
      tx += (ux / len) * hard * MAX_SWING;
      tz += (uz / len) * hard * MAX_SWING;
      ox += (ux / len) * hard * MAX_SLIDE;
      oz += (uz / len) * hard * MAX_SLIDE;
      dy -= overlap * MAX_DUNK;
    }
    const lean = Math.hypot(tx, tz);
    if (lean > MAX_SWING) {
      tx *= MAX_SWING / lean;
      tz *= MAX_SWING / lean;
    }
    const s = m.swing;
    for (let i = 0; i < subs; i++) {
      [s.tx, s.wx] = spring(s.tx, s.wx, tx, held, SWING, dt);
      [s.tz, s.wz] = spring(s.tz, s.wz, tz, held, SWING, dt);
      [s.ox, s.vx] = spring(s.ox, s.vx, ox, held, SLIDE, dt);
      [s.oz, s.vz] = spring(s.oz, s.vz, oz, held, SLIDE, dt);
      [s.dy, s.vy] = spring(s.dy, s.vy, Math.max(dy, -MAX_DUNK), held, DUNK, dt);
    }
  }

  /** The buoy's transform: on the swell, leaning with its slope and its swing, turned to face riders coming in. */
  private place(m: Mark, waves: Float32Array, water: number, t: number): void {
    const s = m.swing;
    const e = 0.6;
    const slopeX = (waveHeight(waves, m.x + e, m.z, t) - waveHeight(waves, m.x - e, m.z, t)) / (2 * e);
    const slopeZ = (waveHeight(waves, m.x, m.z + e, t) - waveHeight(waves, m.x, m.z - e, t)) / (2 * e);
    const lx = s.tx - slopeX * FOLLOW_SWELL;
    const lz = s.tz - slopeZ * FOLLOW_SWELL;
    const lean = Math.hypot(lx, lz);
    // The front faces riders coming in (see `sim::course::Frame`).
    this.turn.setFromAxisAngle(this.axis.set(0, 1, 0), m.yaw + Math.PI);
    if (lean > 1e-4) this.quat.setFromAxisAngle(this.axis.set(lz / lean, 0, -lx / lean), lean).multiply(this.turn);
    else this.quat.copy(this.turn);
    this.pos.set(m.x + s.ox, water + s.dy, m.z + s.oz);
    this.matrix.compose(this.pos, this.quat, this.one);
    m.batch.setMatrixAt(m.index, this.matrix);
  }
}
