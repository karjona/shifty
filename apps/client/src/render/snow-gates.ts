// A run's gates: either side of the gap a slalom panel (two poles and a
// cloth between them, red then blue down the mountain), a dye line across
// the gap on the snow, and a marker floating over the gate to pass next
// (a smaller, paler one over the gate after it). A panel a rider brushes
// folds over and whips back up: a look, driven by where the riders are
// drawn; in the sim a gate is only its line.
import * as THREE from "three/webgpu";
import { Fn, attribute, mix, normalLocal, positionLocal, sin } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LOOK } from "./cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId, inklessBasic } from "./cel/material.ts";
import { fadingInk, gustAt, windNow } from "./mountain-look.ts";
import type { RiderView } from "./world.ts";

/** A gate: its centre on the snow, the run's heading there and half the gap between its poles (m). */
export interface SnowGate {
  x: number;
  y: number;
  z: number;
  yaw: number;
  half: number;
}

const RED = 0xd8342a;
const BLUE = 0x2456c8;
const POLE = 0x23262e;
const DYE = 0x2f6fd0;
const NEXT = { lit: 0xffd23a, shade: 0xe08a12, top: 0xb86a08 };
const AFTER = { lit: 0xf6f4ee, shade: 0xb9c0d0, top: 0x8f98ac };

/** A panel: its width between the poles, the poles' height, and where its cloth hangs (m). */
const PANEL = { wide: 1.1, tall: 2.3, clothFrom: 1.4, clothTo: 2.25, buried: 0.5, pole: 0.036 };
/** How high the marker floats over the snow (m), its size, and how it bobs and turns. */
const MARKER = { high: 4, wide: 0.62, tall: 1.05, bob: 0.14, turn: 1.3 };
/** The dye line's width (m), how far it lies over the snow and how long its pieces are. */
const LINE = { wide: 0.4, lift: 0.1, step: 0.5 };
/** How near a rider folds a panel (m), how far it folds (radians), and its springs (per second², per second). */
const FOLD = { reach: 0.85, most: 1.35, held: 260, heldDamp: 22, free: 46, damp: 3.4 };

/** A panel standing at the origin, its poles along x: `mask.x` is how freely a vertex flaps, `mask.y` 1 on what takes the gate's colour. */
function panelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const put = (geo: THREE.BufferGeometry, colour: number, mask: (p: THREE.Vector3) => [number, number]) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pos = g.attributes.position!;
    const c = new THREE.Color(colour);
    const colours = new Float32Array(pos.count * 3);
    const masks = new Float32Array(pos.count * 2);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      colours.set([c.r, c.g, c.b], i * 3);
      masks.set(mask(p.fromBufferAttribute(pos, i)), i * 2);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    g.setAttribute("mask", new THREE.BufferAttribute(masks, 2));
    g.deleteAttribute("uv");
    parts.push(g);
  };
  const high = PANEL.tall + PANEL.buried;
  for (const side of [-1, 1]) {
    put(
      new THREE.CylinderGeometry(PANEL.pole * 0.8, PANEL.pole, high, 6).translate(
        (side * PANEL.wide) / 2,
        high / 2 - PANEL.buried,
        0,
      ),
      POLE,
      () => [0, 0],
    );
    // A cap in the gate's colour on each pole.
    put(
      new THREE.CylinderGeometry(PANEL.pole * 1.5, PANEL.pole * 1.5, 0.09, 6).translate(
        (side * PANEL.wide) / 2,
        PANEL.tall + 0.02,
        0,
      ),
      0xffffff,
      () => [0, 1],
    );
  }
  const tall = PANEL.clothTo - PANEL.clothFrom;
  put(new THREE.PlaneGeometry(PANEL.wide, tall, 6, 3).translate(0, PANEL.clothFrom + tall / 2, 0), 0xffffff, (p) => [
    1 - Math.abs(p.x / (PANEL.wide / 2)) ** 2,
    1,
  ]);
  // A white stripe across the cloth, as race panels carry.
  put(
    new THREE.PlaneGeometry(PANEL.wide, tall * 0.2, 6, 1).translate(0, PANEL.clothFrom + tall * 0.5, 0.004),
    0xffffff,
    (p) => [1 - Math.abs(p.x / (PANEL.wide / 2)) ** 2, 0],
  );
  put(
    new THREE.PlaneGeometry(PANEL.wide, tall * 0.2, 6, 1)
      .rotateY(Math.PI)
      .translate(0, PANEL.clothFrom + tall * 0.5, -0.004),
    0xffffff,
    (p) => [1 - Math.abs(p.x / (PANEL.wide / 2)) ** 2, 0],
  );
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("the gate panel has no geometry");
  return merged;
}

let panels: CelMaterial | null = null;

/** Poles and cloth: the cloth takes its gate's `tint` and flaps between the poles. */
function panelMaterial(): CelMaterial {
  if (panels) return panels;
  const mask = attribute<"vec2">("mask", "vec2");
  const paint = attribute<"vec3">("color", "vec3");
  const m = new CelMaterial({
    colorNode: mix(paint, paint.mul(attribute<"vec3">("tint", "vec3")), mask.y),
    side: THREE.DoubleSide,
    shade: new THREE.Color(0.66, 0.62, 0.84),
    richness: 1.2,
    id: inkId("gate"),
  });
  fadingInk(m, 0.9, 0, inkId("gate"), 0.75);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const { speed } = windNow();
    const wave = sin(LOOK.time.mul(speed.mul(0.5).add(4.5)).sub(p.x.mul(5)).add(p.y.mul(2.6)));
    const reach = speed.mul(0.012).add(0.03).mul(gustAt(p.xz).mul(0.7).add(0.5));
    return p.add(normalLocal.mul(wave.mul(mask.x).mul(reach)));
  })();
  panels = m;
  return m;
}

/** An upside-down pyramid, its point at the origin, its faces in two tones and a darker top. */
function markerGeometry(tones: { lit: number; shade: number; top: number }): THREE.BufferGeometry {
  const w = MARKER.wide;
  const h = MARKER.tall;
  const tip = [0, 0, 0];
  const corners = [
    [w, h, w],
    [-w, h, w],
    [-w, h, -w],
    [w, h, -w],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const paint = (colour: number, ...points: number[][]) => {
    const c = new THREE.Color(colour);
    for (const p of points) {
      pos.push(...p);
      col.push(c.r, c.g, c.b);
    }
  };
  corners.forEach((a, k) => {
    const b = corners[(k + 1) % 4]!;
    paint(k % 2 === 0 ? tones.lit : tones.shade, tip, b, a);
  });
  paint(tones.top, corners[0]!, corners[1]!, corners[2]!);
  paint(tones.top, corners[0]!, corners[2]!, corners[3]!);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

interface Panel {
  x: number;
  y: number;
  z: number;
  turn: number;
  /** How far it is folded over, about x and z (radians), and how fast that changes. */
  fx: number;
  fz: number;
  vx: number;
  vz: number;
}

export class SnowGates {
  readonly group = new THREE.Group();
  private gates: readonly SnowGate[];
  private panels: Panel[] = [];
  private batch: THREE.InstancedMesh | null = null;
  private next: THREE.Mesh;
  private after: THREE.Mesh;
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private fold = new THREE.Quaternion();
  private axis = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(gates: readonly SnowGate[], ground: (x: number, z: number) => number) {
    this.gates = gates;
    this.group.name = "snow-gates";
    this.group.userData.noMerge = true;
    const glow = inklessBasic({ vertexColors: true, fog: false });
    this.next = new THREE.Mesh(markerGeometry(NEXT), glow);
    this.after = new THREE.Mesh(markerGeometry(AFTER), glow);
    for (const m of [this.next, this.after]) {
      m.layers.set(UNREFLECTED);
      m.scale.setScalar(0);
      m.frustumCulled = false;
      this.group.add(m);
    }
    if (gates.length === 0) return;

    const tints = new Float32Array(gates.length * 2 * 3);
    const lines: THREE.BufferGeometry[] = [];
    gates.forEach((g, i) => {
      // Across the run, to the rider's right.
      const ax = -Math.cos(g.yaw);
      const az = Math.sin(g.yaw);
      const tint = new THREE.Color(i % 2 === 0 ? RED : BLUE);
      for (const side of [-1, 1]) {
        const o = side * (g.half + PANEL.wide / 2);
        const x = g.x + ax * o;
        const z = g.z + az * o;
        tints.set([tint.r, tint.g, tint.b], this.panels.length * 3);
        this.panels.push({ x, y: ground(x, z), z, turn: g.yaw + Math.PI, fx: 0, fz: 0, vx: 0, vz: 0 });
      }
      lines.push(dyeLine(g, ground));
    });
    const geometry = panelGeometry();
    geometry.setAttribute("tint", new THREE.InstancedBufferAttribute(tints, 3));
    const batch = new THREE.InstancedMesh(geometry, panelMaterial(), this.panels.length);
    batch.name = "gate-panels";
    batch.castShadow = true;
    batch.frustumCulled = false;
    batch.layers.set(UNREFLECTED);
    this.batch = batch;
    this.panels.forEach((p, i) => this.place(p, i));
    this.group.add(batch);

    const dye = mergeGeometries(lines);
    for (const l of lines) l.dispose();
    if (dye) {
      const material = new CelMaterial({ color: DYE, silhouette: 0, crease: 0, id: inkId("snow") });
      material.polygonOffset = true;
      material.polygonOffsetFactor = -2;
      material.polygonOffsetUnits = -2;
      const mesh = new THREE.Mesh(dye, material);
      mesh.name = "gate-lines";
      mesh.receiveShadow = true;
      mesh.layers.set(UNREFLECTED);
      this.group.add(mesh);
    }
  }

  /** Folds the panels riders brush, and puts the markers over the gate to pass next and the one after it. */
  update(t: number, dt: number, riders: readonly RiderView[], next: number | null): void {
    const step = Math.min(dt, 1 / 20);
    const subs = Math.max(1, Math.ceil(step * 120));
    let moved = false;
    this.panels.forEach((p, i) => {
      if (this.swing(p, riders, step / subs, subs)) {
        this.place(p, i);
        moved = true;
      }
    });
    if (moved && this.batch) this.batch.instanceMatrix.needsUpdate = true;
    this.mark(this.next, next, t, 1);
    this.mark(this.after, next === null ? null : next + 1, t + 0.7, 0.6);
  }

  private mark(mesh: THREE.Mesh, index: number | null, t: number, size: number): void {
    const g = index === null ? undefined : this.gates[index];
    if (!g) {
      mesh.scale.setScalar(0);
      return;
    }
    mesh.scale.setScalar(size);
    mesh.position.set(g.x, g.y + MARKER.high + Math.sin(t * 2.6) * MARKER.bob, g.z);
    mesh.rotation.y = t * MARKER.turn;
  }

  /** Where a rider is on a panel it is pushed over the way the rider goes; free, it springs back. Whether it moved. */
  private swing(p: Panel, riders: readonly RiderView[], dt: number, subs: number): boolean {
    let tx = 0;
    let tz = 0;
    let held = false;
    for (const r of riders) {
      const dx = r.x - p.x;
      const dz = r.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= FOLD.reach || r.y - p.y > PANEL.tall) continue;
      const speed = Math.hypot(r.vx, r.vz);
      if (speed < 0.5) continue;
      held = true;
      const push = (FOLD.most * (FOLD.reach - dist)) / FOLD.reach + 0.5;
      // Folding toward +x turns about z, toward +z about x.
      tx = (r.vx / speed) * Math.min(FOLD.most, push);
      tz = (r.vz / speed) * Math.min(FOLD.most, push);
    }
    if (!held && p.fx === 0 && p.fz === 0 && p.vx === 0 && p.vz === 0) return false;
    const k = held ? FOLD.held : FOLD.free;
    const c = held ? FOLD.heldDamp : FOLD.damp;
    for (let i = 0; i < subs; i++) {
      p.vx += ((tx - p.fx) * k - p.vx * c) * dt;
      p.vz += ((tz - p.fz) * k - p.vz * c) * dt;
      p.fx += p.vx * dt;
      p.fz += p.vz * dt;
    }
    if (!held && Math.abs(p.fx) + Math.abs(p.fz) < 1e-3 && Math.abs(p.vx) + Math.abs(p.vz) < 1e-2) {
      p.fx = 0;
      p.fz = 0;
      p.vx = 0;
      p.vz = 0;
    }
    return true;
  }

  private place(p: Panel, index: number): void {
    const lean = Math.hypot(p.fx, p.fz);
    this.quat.setFromAxisAngle(this.up, p.turn);
    if (lean > 1e-4) {
      // Leaning toward (fx, fz): a turn about the level axis across it.
      this.axis.set(p.fz / lean, 0, -p.fx / lean);
      this.quat.premultiply(this.fold.setFromAxisAngle(this.axis, lean));
    }
    this.matrix.compose(this.pos.set(p.x, p.y, p.z), this.quat, this.one);
    this.batch?.setMatrixAt(index, this.matrix);
  }
}

/** The dye line across a gate's gap, laid on the snow in short pieces. */
function dyeLine(g: SnowGate, ground: (x: number, z: number) => number): THREE.BufferGeometry {
  const ax = -Math.cos(g.yaw);
  const az = Math.sin(g.yaw);
  const fx = Math.sin(g.yaw);
  const fz = Math.cos(g.yaw);
  const pieces = Math.max(2, Math.ceil((g.half * 2) / LINE.step));
  const pos: number[] = [];
  const norm: number[] = [];
  const at = (k: number, along: number): [number, number, number] => {
    const o = -g.half + (k / pieces) * g.half * 2;
    const x = g.x + ax * o + fx * along;
    const z = g.z + az * o + fz * along;
    return [x, ground(x, z) + LINE.lift, z];
  };
  for (let k = 0; k < pieces; k++) {
    const a = at(k, -LINE.wide / 2);
    const b = at(k + 1, -LINE.wide / 2);
    const c = at(k + 1, LINE.wide / 2);
    const d = at(k, LINE.wide / 2);
    const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      .cross(new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2]))
      .normalize();
    if (n.y < 0) {
      n.negate();
      pos.push(...a, ...c, ...b, ...a, ...d, ...c);
    } else pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) norm.push(n.x, n.y, n.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(norm, 3));
  return geo;
}
