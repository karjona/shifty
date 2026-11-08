// The jetski course: buoys (see buoys.ts), chevron boards on the turns
// (chevrons.ts), the breakwater and its lighthouse, the land, the
// start/finish gate, floating ramps and the boundary markers. Geometry
// comes from the sim (`courseJson`), so what you see is what you collide
// with.
import * as THREE from "three/webgpu";
import { BobbingBatch, type Bobbing, at, placed } from "./bobbing.ts";
import { BuoyMarks } from "./buoys.ts";
import { ChevronBoards } from "./chevrons.ts";
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

const RED = 0xe8402a;
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

/** A llaüt's hull: 5.2 m, pinched at bow and stern, rising toward them, a round bilge. */
function llautHull(): THREE.BufferGeometry {
  const hull = new THREE.BoxGeometry(5.2, 1, 1.9, 8, 2, 2);
  const pos = hull.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / 2.6;
    const k = Math.abs(x);
    pos.setZ(i, pos.getZ(i) * (1 - Math.pow(k, 2.6)) * (pos.getY(i) < 0 ? 0.75 : 1));
    pos.setY(i, pos.getY(i) + k * k * (x > 0 ? 0.55 : 0.3));
  }
  hull.computeVertexNormals();
  return hull;
}

/** Where a boat lies moored: the middle of its hull at the water line, and its heading. */
export interface Mooring {
  x: number;
  z: number;
  yaw: number;
}

/**
 * Fishing boats (llaüts), one per mooring, riding the swell as a few
 * batches (hulls, rails, cabins, masts). `seed` picks their colours.
 */
export function mooredBoats(spots: readonly Mooring[], seed: number): BobbingBatch[] {
  const hull = llautHull();
  const colours = [0xf4f1ea, 0x2f6fb0, 0xf4f1ea, 0x2d8a7a, 0xc8483a, 0xf4f1ea];
  const stripes = [0x2f6fb0, 0xf4f1ea, 0xc8483a, 0xf2c14e];
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const bodies: (Bobbing & { color: number })[] = [];
  const rails: (Bobbing & { color: number })[] = [];
  const cabins: Bobbing[] = [];
  const masts: Bobbing[] = [];
  for (const { x, z, yaw } of spots) {
    const body = colours[Math.floor(rnd() * colours.length)]!;
    const rail = stripes[Math.floor(rnd() * stripes.length)]!;
    bodies.push({ x, z, base: placed(x, z, yaw, at(0, 0.15, 0)), color: body });
    rails.push({ x, z, base: placed(x, z, yaw, at(0, 0.62, 0)), color: rail });
    if (rnd() < 0.6) cabins.push({ x, z, base: placed(x, z, yaw, at(-0.6, 1.1, 0)) });
    if (rnd() < 0.5) masts.push({ x, z, base: placed(x, z, yaw, at(1, 2.4, 0)) });
  }
  const batches = [
    new BobbingBatch(hull, std(0xffffff), bodies),
    new BobbingBatch(new THREE.BoxGeometry(4.2, 0.14, 1.95), std(0xffffff), rails),
    new BobbingBatch(new THREE.BoxGeometry(1.4, 1, 1.2), std(0xf4f1ea), cabins),
    new BobbingBatch(new THREE.CylinderGeometry(0.06, 0.08, 4, 6), std(0x7a5a3c), masts),
  ];
  for (const b of batches) b.mesh.castShadow = true;
  return batches;
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
  /** Batches riding the swell: moored boats. */
  private bobbing: BobbingBatch[] = [];
  private buoys: BuoyMarks;
  private chevrons: ChevronBoards;
  private boundary: THREE.InstancedMesh;
  private boundaryPoints: { x: number; z: number }[] = [];
  private matrix = new THREE.Matrix4();

  readonly data: CourseData;

  constructor(data: CourseData) {
    this.data = data;
    if (data.place === "bay") {
      this.buildBreakwater();
      this.group.add(buildLand(this.data.land));
    }
    this.buildStartGate();
    this.buoys = new BuoyMarks(this.data);
    this.chevrons = new ChevronBoards(this.data);
    this.buildRamps();
    this.boundary = this.buildBoundary();
    if (data.place === "bay") this.buildBoats();
    for (const g of [this.buoys.group, this.chevrons.group]) {
      g.userData.noMerge = true;
      this.group.add(g);
    }
    for (const f of this.floating) f.obj.userData.noMerge = true;
  }

  private buildBreakwater(): void {
    const d = this.data;
    const rock = std(0x8a8072, { roughness: 0.95, flatShading: true });
    const geo = new THREE.CapsuleGeometry(d.breakwaterRadius, d.straightHalf * 2, 6, 14);
    geo.rotateZ(Math.PI / 2);
    // Jitter the vertices so it reads as piled rocks, not a pill.
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const n = Math.sin(i * 12.9898) * 43758.5453;
      const j = (n - Math.floor(n) - 0.5) * 1.6;
      pos.setY(i, pos.getY(i) + j);
      pos.setZ(i, pos.getZ(i) + j * 0.6);
    }
    geo.computeVertexNormals();
    const mound = new THREE.Mesh(geo, rock);
    mound.scale.set(1, 0.22, 1);
    mound.position.y = -0.6;
    mound.castShadow = true;
    mound.receiveShadow = true;
    this.group.add(mound);
    this.group.add(this.armourStones());

    // Lighthouse on the east tip.
    const lh = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.8, 13, 12), std(0xf4f1ea));
    tower.position.y = 6.5;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.55, 2, 12), std(RED));
    band.position.y = 8;
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 1.4, 10),
      std(0xfff2b0, { emissive: 0xffd760, emissiveIntensity: 0.8 }),
    );
    lamp.position.y = 13.7;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.8, 12), std(RED));
    cap.position.y = 15.3;
    for (const m of [tower, band, lamp, cap]) {
      m.castShadow = true;
      lh.add(m);
    }
    lh.position.set(d.straightHalf + d.breakwaterRadius * 0.45, 1.6, 0);
    this.group.add(lh);
  }

  /** Fishing boats (llaüts) moored off the town quay, riding the swell. */
  private buildBoats(): void {
    const town = this.data.land.find((l) => l.kind === "town");
    if (!town) return;
    const dx = town.bx - town.ax;
    const dz = town.bz - town.az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    let nx = -uz;
    let nz = ux;
    if (nx * -town.ax + nz * -town.az < 0) {
      nx = -nx;
      nz = -nz;
    }
    const hull = llautHull();
    const colours = [0xf4f1ea, 0x2f6fb0, 0xf4f1ea, 0x2d8a7a, 0xc8483a, 0xf4f1ea];
    const stripes = [0x2f6fb0, 0xf4f1ea, 0xc8483a, 0xf2c14e];
    let seed = 11;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const bodies: (Bobbing & { color: number })[] = [];
    const rails: (Bobbing & { color: number })[] = [];
    const cabins: Bobbing[] = [];
    const masts: Bobbing[] = [];
    for (let a = 8; a < len - 8; a += 9 + rnd() * 10) {
      const body = colours[Math.floor(rnd() * colours.length)]!;
      const rail = stripes[Math.floor(rnd() * stripes.length)]!;
      const cabin = rnd() < 0.6;
      const mast = rnd() < 0.5;
      const d = town.radius + 5 + rnd() * 3;
      const x = town.ax + ux * a + nx * d;
      const z = town.az + uz * a + nz * d;
      const yaw = Math.atan2(-uz, ux) + (rnd() - 0.5) * 0.3;
      bodies.push({ x, z, base: placed(x, z, yaw, at(0, 0.15, 0)), color: body });
      rails.push({ x, z, base: placed(x, z, yaw, at(0, 0.62, 0)), color: rail });
      if (cabin) cabins.push({ x, z, base: placed(x, z, yaw, at(-0.6, 1.1, 0)) });
      if (mast) masts.push({ x, z, base: placed(x, z, yaw, at(1, 2.4, 0)) });
    }
    const batches = [
      new BobbingBatch(hull, std(0xffffff), bodies),
      new BobbingBatch(new THREE.BoxGeometry(4.2, 0.14, 1.95), std(0xffffff), rails),
      new BobbingBatch(new THREE.BoxGeometry(1.4, 1, 1.2), std(0xf4f1ea), cabins),
      new BobbingBatch(new THREE.CylinderGeometry(0.06, 0.08, 4, 6), std(0x7a5a3c), masts),
    ];
    for (const b of batches) {
      b.mesh.castShadow = true;
      this.group.add(b.mesh);
      this.bobbing.push(b);
    }
  }

  /** The mound faced with big squared stones, so it draws as a breakwater. */
  private armourStones(): THREE.InstancedMesh {
    const d = this.data;
    const len = d.straightHalf * 2 + d.breakwaterRadius * 2;
    const per = Math.floor(len / 2.4);
    const items: THREE.Matrix4[] = [];
    const colours: number[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const greys = [0xa49c8e, 0x958d80, 0xb3ab9c, 0x8c8578];
    for (const side of [-1, 1]) {
      for (const row of [0, 1]) {
        for (let i = 0; i < per; i++) {
          const x = -len / 2 + (i + 0.5 + (rnd() - 0.5) * 0.5) * (len / per);
          // Round the ends of the capsule.
          const end = Math.max(0, Math.abs(x) - d.straightHalf) / d.breakwaterRadius;
          const reach = d.breakwaterRadius * (row === 0 ? 0.95 : 0.6) * Math.sqrt(Math.max(0, 1 - end * end));
          const s = 1.5 + rnd() * 1.4;
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 0.6, rnd() * Math.PI, rnd() * 0.6));
          items.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(x, row === 0 ? -0.3 : 0.9, side * reach),
              q,
              new THREE.Vector3(s, s * 0.8, s),
            ),
          );
          colours.push(greys[Math.floor(rnd() * greys.length)]!);
        }
      }
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      std(0xffffff, { roughness: 0.95, flatShading: true }),
      items.length,
    );
    items.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, new THREE.Color(colours[i]));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
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

    for (const b of this.bobbing) b.update(waves, t);
    this.buoys.update(waves, t, dt, riders, nextBuoy);
    this.chevrons.update(waves, t);
  }
}
