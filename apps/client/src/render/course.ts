// The jetski course: buoys (see buoys.ts), chevron boards on the turns
// (chevrons.ts), the breakwater and its lighthouse, the land, the
// start/finish gate, floating ramps and the boundary markers. Geometry
// comes from the sim (`courseJson`), so what you see is what you collide
// with.
import * as THREE from "three/webgpu";
import type { Season } from "../game/conditions.ts";
import { BuoyMarks } from "./buoys.ts";
import { ChevronBoards } from "./chevrons.ts";
import { type Lantern, breakwaterCameras, buildBreakwater, flashLanterns } from "./coast/harbour.ts";
import { OVERHEAD, type Sunlight } from "./coast/grounding.ts";
import { COSTA_NEVADA, DOWNWIND, Life } from "./coast/life.ts";
import { boatMaterial, clothMaterial } from "./coast/materials.ts";
import { Crowd } from "./coast/people.ts";
import { Shape, box, place, post } from "./coast/shape.ts";
import { buildLand, landDistance } from "./land.ts";
import { waveHeight } from "./waves.ts";
import { UNREFLECTED } from "./cel/material.ts";
import type { RiderView } from "./world.ts";

/** Which water course: the bay's oval, or the cape's loop. */
export type WaterPlace = "bay" | "cape";

/** A point on a loop's centre line: how sharply it turns there (1 / radius, positive to the right). */
export interface PathPoint {
  s: number;
  x: number;
  z: number;
  yaw: number;
  curve: number;
}

export interface CourseData {
  place: WaterPlace;
  length: number;
  laps: number;
  /** The bay's oval (zero on other loops). */
  straightHalf: number;
  radius: number;
  laneHalf: number;
  breakwaterRadius: number;
  /** On the oval, from the breakwater's axis; on other loops, either side of the centre line. */
  outerLimit: number;
  rampSink: number;
  /** A buoy's radius at the water line and its height above it, and a rider's radius (see `sim::buoy`). */
  buoyRadius: number;
  buoyHeight: number;
  riderRadius: number;
  start: { x: number; z: number; yaw: number };
  buoys: { x: number; z: number; s: number; yaw: number; keep: "left" | "right" }[];
  ramps: { x: number; z: number; yaw: number; length: number; width: number; height: number }[];
  land: LandData[];
  /** The centre line every 2 m. */
  path: PathPoint[];
}

export type LandKind = "town" | "island" | "rock" | "headland" | "coast" | "beach" | "mole" | "stack" | "arch";

/** Solid land: a capsule around the segment a-b (see `sim::course::LandDef`). */
export interface LandData {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number;
  kind: LandKind;
}

const BOUNDARY_SPACING = 18;

const std = (color: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.6, ...opts });

/** The race's colours on what floats on the course: marker orange, white, ink, and the ramps' yellow. */
const MARK = { orange: 0xf2682a, white: 0xf6f4ee, ink: 0x1c2230, yellow: 0xf7bd2c, steel: 0x9aa1ab, red: 0xd6402e };

/** A float: a tube lying along z, `length` long, its top `above` the water. */
function tube(shape: Shape, x: number, z: number, length: number, radius: number, above: number, colour: number): void {
  const geo = new THREE.CapsuleGeometry(radius, length - radius * 2, 3, 8).rotateX(Math.PI / 2);
  shape.take(geo, colour, place(x, above - radius, z));
}

/**
 * One tower of the start gate, its foot at the water: a raft on two
 * floats, a banded mast `tall` high with a lamp head, and stays down to
 * the raft's corners.
 */
function gateTower(tall: number): THREE.Mesh {
  const shape = new Shape();
  for (const side of [-1, 1]) tube(shape, side * 1.05, 0, 4.4, 0.5, 0.42, MARK.orange);
  shape.take(box(2.9, 0.16, 3.2), MARK.white, place(0, 0.4, 0));
  shape.take(box(1.1, 0.5, 1.1), MARK.steel, place(0, 0.56, 0));
  // The mast, in bands.
  const bands = 6;
  const from = 1.06;
  for (let k = 0; k < bands; k++) {
    const h = (tall - from) / bands;
    shape.take(post(0.3, 0.3, h, 8), k % 2 === 0 ? MARK.white : MARK.red, place(0, from + k * h, 0));
  }
  shape.take(post(0.42, 0.42, 0.18, 8), MARK.ink, place(0, tall, 0));
  shape.take(new THREE.SphereGeometry(0.34, 8, 5).translate(0, 0.42, 0), MARK.yellow, place(0, tall, 0));
  // Stays: struts from the mast to the raft's corners.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const foot = new THREE.Vector3(sx * 1.25, 0.56, sz * 1.4);
      const head = new THREE.Vector3(0, 3.6, 0);
      const mid = foot.clone().add(head).multiplyScalar(0.5);
      const m = new THREE.Matrix4()
        .lookAt(foot, head, new THREE.Vector3(0, 1, 0))
        .setPosition(mid)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      shape.take(new THREE.BoxGeometry(0.1, foot.distanceTo(head), 0.1), MARK.steel, m);
    }
  const mesh = shape.mesh(boatMaterial(), "cast");
  mesh.name = "gate-tower";
  return mesh;
}

/**
 * The start gate's span, `width` across (along x, centred), its banner's
 * foot at y = 0: a truss of two chords and posts, the chequered banner
 * hung in it, a board in Costa Nevada's colours over its middle and
 * pennants at its ends. `yaw` is the heading it will be turned to.
 */
function gateSpan(width: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  const shape = new Shape();
  const half = width / 2;
  const tall = 1.6;
  for (const y of [-0.12, tall + 0.12])
    shape.take(new THREE.BoxGeometry(width, 0.2, 0.2), MARK.steel, place(0, y, 0));
  const bays = 16;
  for (let k = 0; k <= bays; k++)
    shape.take(new THREE.BoxGeometry(0.1, tall + 0.24, 0.24), MARK.steel, place(-half + (k / bays) * width, tall / 2, 0));
  // The banner: two rows of squares, seen from both sides.
  const cell = width / bays;
  for (let k = 0; k < bays; k++)
    for (let row = 0; row < 2; row++) {
      const colour = (k + row) % 2 === 0 ? MARK.ink : MARK.white;
      const x0 = -half + k * cell;
      const y0 = row * (tall / 2);
      for (const z of [0.06, -0.06]) {
        const a = new THREE.Vector3(x0, y0, z);
        const b = new THREE.Vector3(x0 + cell, y0, z);
        const c = new THREE.Vector3(x0 + cell, y0 + tall / 2, z);
        const d = new THREE.Vector3(x0, y0 + tall / 2, z);
        if (z > 0) shape.quad(a, b, c, d, colour);
        else shape.quad(b, a, d, c, colour);
      }
    }
  // The board over the middle, in three stripes.
  const board = Math.min(7, width * 0.42);
  COSTA_NEVADA.forEach((colour, k) =>
    shape.take(new THREE.BoxGeometry(board / 3, 1.0, 0.16), colour, place((k - 1) * (board / 3), tall + 0.76, 0)),
  );
  shape.take(new THREE.BoxGeometry(board + 0.3, 0.12, 0.26), MARK.ink, place(0, tall + 1.3, 0));
  shape.take(new THREE.BoxGeometry(board + 0.3, 0.12, 0.26), MARK.ink, place(0, tall + 0.22, 0));
  // Pennants flying from both ends.
  const cloth = new Shape();
  for (const side of [-1, 1]) {
    const x = side * (half - 0.2);
    shape.take(post(0.05, 0.04, 3.6, 5), MARK.steel, place(x, tall, 0));
    COSTA_NEVADA.forEach((colour, k) => {
      const geo = new THREE.PlaneGeometry(1.9, 0.4, 5, 1).translate(0.95, -(k + 0.5) * 0.4, 0);
      cloth.take(geo, colour, place(x, tall + 3.55, 0, DOWNWIND - yaw), { weight: (p) => Math.hypot(p.x - x, p.z) });
    });
  }
  const frame = shape.mesh(boatMaterial(), "cast");
  frame.name = "gate-span";
  g.add(frame);
  const pennants = cloth.mesh(clothMaterial(), "none");
  pennants.layers.set(UNREFLECTED);
  pennants.frustumCulled = false;
  g.add(pennants);
  return g;
}

/**
 * A ramp, `length` along +z rising from the water to `height`, centred on
 * its footprint: a yellow deck with arrows pointing up it and a white lip,
 * red and white skirts, and a float along each side.
 */
function rampMesh(length: number, width: number, height: number): THREE.Mesh {
  const shape = new Shape();
  const l = length / 2;
  const w = width / 2;
  const at = (x: number, t: number, lift = 0) => new THREE.Vector3(x * w, t * height + lift, -l + t * length);
  // The deck: yellow, white along its lip.
  shape.quad(at(1, 0), at(-1, 0), at(-1, 0.9), at(1, 0.9), MARK.yellow);
  shape.quad(at(1, 0.9), at(-1, 0.9), at(-1, 1), at(1, 1), MARK.white);
  // Arrows up the deck.
  for (const t of [0.16, 0.42, 0.68]) {
    const lift = 0.02;
    const arm = 0.16;
    const tip = at(0, t + arm, lift);
    for (const side of [-1, 1]) {
      const outer = at(side * 0.62, t, lift);
      const inner = at(side * 0.62, t - 0.09, lift);
      const notch = at(0, t + arm - 0.09, lift);
      if (side > 0) shape.quad(tip, outer, inner, notch, MARK.ink);
      else shape.quad(outer, tip, notch, inner, MARK.ink);
    }
  }
  // The skirts in red and white, and the back.
  const panels = 4;
  for (const side of [-1, 1])
    for (let k = 0; k < panels; k++) {
      const t0 = k / panels;
      const t1 = (k + 1) / panels;
      const colour = k % 2 === 0 ? MARK.red : MARK.white;
      const a = at(side, t0).setY(-0.4);
      const b = at(side, t1).setY(-0.4);
      if (side > 0) shape.quad(b, a, at(side, t0), at(side, t1), colour);
      else shape.quad(a, b, at(side, t1), at(side, t0), colour);
    }
  shape.quad(at(-1, 1).setY(-0.4), at(1, 1).setY(-0.4), at(1, 1), at(-1, 1), MARK.red);
  for (const side of [-1, 1]) tube(shape, side * (w + 0.4), 0, length * 0.94, 0.45, 0.4, MARK.orange);
  const mesh = shape.mesh(boatMaterial());
  mesh.name = "ramp";
  return mesh;
}

/** The start gate: how high the banner's foot hangs over the water (m), and the banner's height. */
const GATE = { foot: 6.4, banner: 1.6 };

interface Floating {
  obj: THREE.Object3D;
  x: number;
  z: number;
  lift: number;
}

export class CourseView {
  readonly group = new THREE.Group();
  private floating: Floating[] = [];
  private buoys: BuoyMarks;
  private chevrons: ChevronBoards;
  private boundary: THREE.InstancedMesh;
  private boundaryPoints: { x: number; z: number }[] = [];
  private matrix = new THREE.Matrix4();
  /** The breakwater's lamps. */
  private lanterns: Lantern[] = [];
  /** The people on the bay's land who wave. */
  private crowd = new Crowd();
  /** The start gate's span and the towers that carry it (`left` at the span's -x end). */
  private gate: { span: THREE.Object3D; left: THREE.Object3D; right: THREE.Object3D; width: number } | null = null;

  readonly data: CourseData;

  /** `season` and `crowd` (how many people are out, 0-1) dress the bay's land; `light` is which way its shade falls. */
  constructor(data: CourseData, season: Season = "summer", crowd = 1, light: Sunlight = OVERHEAD) {
    this.data = data;
    if (data.place === "bay") {
      this.buildBreakwater(crowd, light);
      const life = new Life();
      this.group.add(buildLand(this.data.land, season, crowd, this.crowd, life, light));
      this.group.add(...life.build());
      const arms = this.crowd.build();
      if (arms) this.group.add(arms);
    }
    this.buildStartGate();
    this.buoys = new BuoyMarks(this.data);
    this.chevrons = new ChevronBoards(this.data);
    this.buildRamps();
    this.boundary = this.buildBoundary();
    for (const g of [this.buoys.group, this.chevrons.group]) {
      g.userData.noMerge = true;
      this.group.add(g);
    }
    for (const f of this.floating) f.obj.userData.noMerge = true;
  }

  private buildBreakwater(crowd: number, light: Sunlight): void {
    const d = this.data;
    const breakwater = buildBreakwater(
      d.straightHalf,
      d.breakwaterRadius,
      d.straightHalf + d.breakwaterRadius * 0.45,
      crowd,
      this.crowd,
      breakwaterCameras(d.straightHalf, d.start.x, Math.sign(d.start.z) || -1),
      light,
    );
    this.lanterns.push(...breakwater.lanterns);
    this.group.add(breakwater.group);
  }

  private buildStartGate(): void {
    const d = this.data;
    const { x, z, yaw } = d.start;
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);
    const half = d.laneHalf + 2;
    const towers: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const tower = gateTower(GATE.foot + GATE.banner);
      const px = x + rx * half * side;
      const pz = z + rz * half * side;
      tower.position.set(px, 0, pz);
      tower.rotation.y = yaw;
      this.group.add(tower);
      this.floating.push({ obj: tower, x: px, z: pz, lift: 0 });
      towers.push(tower);
    }
    const span = gateSpan(half * 2, yaw);
    span.position.set(x, GATE.foot, z);
    span.rotation.y = yaw;
    span.userData.noMerge = true;
    this.group.add(span);
    this.gate = { span, right: towers[1]!, left: towers[0]!, width: half * 2 };
  }

  private buildRamps(): void {
    for (const r of this.data.ramps) {
      const m = rampMesh(r.length, r.width, r.height);
      m.position.set(r.x, 0, r.z);
      m.rotation.y = r.yaw;
      this.group.add(m);
      this.floating.push({ obj: m, x: r.x, z: r.z, lift: -this.data.rampSink });
    }
  }

  /** Markers along the outer limit on a loop's straights and gentle bends, off the land. */
  private loopBoundary(): void {
    const d = this.data;
    let next = 0;
    for (const p of d.path) {
      if (p.s < next) continue;
      next = p.s + BOUNDARY_SPACING;
      if (Math.abs(p.curve) > 1 / 90) continue;
      for (const side of [-1, 1]) {
        const x = p.x - Math.cos(p.yaw) * side * d.outerLimit;
        const z = p.z + Math.sin(p.yaw) * side * d.outerLimit;
        if (d.land.some((l) => landDistance(l, x, z) < 3)) continue;
        this.boundaryPoints.push({ x, z });
      }
    }
  }

  private buildBoundary(): THREE.InstancedMesh {
    const d = this.data;
    if (d.place !== "bay") {
      this.loopBoundary();
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.45, 8, 6),
        std(0xff9a3c, { roughness: 0.5 }),
        this.boundaryPoints.length,
      );
      this.group.add(mesh);
      return mesh;
    }
    const r = d.outerLimit;
    const straight = d.straightHalf * 2;
    const perimeter = straight * 2 + Math.PI * 2 * r;
    const n = Math.floor(perimeter / BOUNDARY_SPACING);
    for (let i = 0; i < n; i++) {
      let s = (i / n) * perimeter;
      let x: number;
      let z: number;
      if (s < straight) {
        x = s - d.straightHalf;
        z = -r;
      } else if ((s -= straight) < Math.PI * r) {
        const th = s / r - Math.PI / 2;
        x = d.straightHalf + r * Math.cos(th);
        z = r * Math.sin(th);
      } else if ((s -= Math.PI * r) < straight) {
        x = d.straightHalf - s;
        z = r;
      } else {
        const th = (s - straight) / r + Math.PI / 2;
        x = -d.straightHalf + r * Math.cos(th);
        z = r * Math.sin(th);
      }
      // No markers on (or right against) land: the shore is the boundary
      // there; nor round the turns, where the chevron boards stand.
      if (d.land.some((l) => landDistance(l, x, z) < 3) || Math.abs(x) > d.straightHalf + 1) continue;
      this.boundaryPoints.push({ x, z });
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.45, 8, 6),
      std(0xff9a3c, { roughness: 0.5 }),
      this.boundaryPoints.length,
    );
    this.group.add(mesh);
    return mesh;
  }

  /** Floats everything on the swells, swings the buoys riders hit, and marks the next buoy. */
  update(waves: Float32Array, t: number, dt: number, riders: readonly RiderView[], nextBuoy: number | null): void {
    for (const f of this.floating) f.obj.position.y = waveHeight(waves, f.x, f.z, t) + f.lift;
    if (this.gate) {
      // The span rides on its two towers.
      const { span, left, right, width } = this.gate;
      span.position.y = (left.position.y + right.position.y) / 2 + GATE.foot;
      span.rotation.z = Math.atan2(left.position.y - right.position.y, width);
    }
    this.boundaryPoints.forEach((p, i) => {
      this.matrix.makeTranslation(p.x, waveHeight(waves, p.x, p.z, t), p.z);
      this.boundary.setMatrixAt(i, this.matrix);
    });
    this.boundary.instanceMatrix.needsUpdate = true;

    flashLanterns(this.lanterns, t);
    this.crowd.update(t, riders);
    this.buoys.update(waves, t, dt, riders, nextBuoy);
    this.chevrons.update(waves, t);
  }
}
