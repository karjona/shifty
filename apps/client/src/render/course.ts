// The jetski course: buoys (see buoys.ts), chevron boards on the turns
// (chevrons.ts), the breakwater and its lighthouse, the land, the
// start/finish gate, floating ramps and the boundary markers. Geometry
// comes from the sim (`courseJson`), so what you see is what you collide
// with.
import * as THREE from "three/webgpu";
import type { Season } from "../game/conditions.ts";
import { BuoyMarks } from "./buoys.ts";
import { ChevronBoards } from "./chevrons.ts";
import { type Lantern, buildBreakwater, flashLanterns } from "./coast/harbour.ts";
import { Life } from "./coast/life.ts";
import { Crowd } from "./coast/people.ts";
import { buildLand, landDistance } from "./land.ts";
import { waveHeight } from "./waves.ts";
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

function checkerTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 32;
  const g = c.getContext("2d")!;
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 === 0 ? "#111" : "#f4f4f0";
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** A ramp wedge: `length` along +Z, rising from 0 to `height`, centred on the footprint. */
function wedge(length: number, width: number, height: number): THREE.BufferGeometry {
  const l = length / 2;
  const w = width / 2;
  // prettier-ignore
  const v = [
    -w, 0, -l,  w, 0, -l,  w, height, l,  -w, height, l, // deck
    -w, 0, -l,  -w, 0, l,  -w, height, l, // left side
    w, 0, -l,  w, height, l,  w, 0, l, // right side
    -w, 0, l,  -w, height, l,  w, height, l,  w, 0, l, // back
  ];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 11, 10, 13, 12];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

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

  readonly data: CourseData;

  /** `season` and `crowd` (how many people are out, 0-1) dress the bay's land. */
  constructor(data: CourseData, season: Season = "summer", crowd = 1) {
    this.data = data;
    if (data.place === "bay") {
      this.buildBreakwater(crowd);
      const life = new Life();
      this.group.add(buildLand(this.data.land, season, crowd, this.crowd, life));
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

  private buildBreakwater(crowd: number): void {
    const d = this.data;
    const breakwater = buildBreakwater(
      d.straightHalf,
      d.breakwaterRadius,
      d.straightHalf + d.breakwaterRadius * 0.45,
      crowd,
      this.crowd,
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
    const poleMat = std(0xf4f4f0);
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 9, 8), poleMat);
      const px = x + rx * half * side;
      const pz = z + rz * half * side;
      pole.position.set(px, 3.5, pz);
      pole.castShadow = true;
      this.group.add(pole);
      this.floating.push({ obj: pole, x: px, z: pz, lift: 3.5 });
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, 1.6),
      new THREE.MeshStandardNodeMaterial({ map: checkerTexture(), side: THREE.DoubleSide, roughness: 0.8 }),
    );
    banner.position.set(x, 7.2, z);
    banner.rotation.y = yaw;
    this.group.add(banner);
  }

  private buildRamps(): void {
    const deck = std(0xf2b630, { roughness: 0.7 });
    for (const r of this.data.ramps) {
      const m = new THREE.Mesh(wedge(r.length, r.width, r.height), deck);
      m.castShadow = true;
      m.receiveShadow = true;
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
