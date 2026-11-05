// The jetski course: buoys (with an arrow showing the side to pass), the
// breakwater and its lighthouse, the land, the start/finish gate, floating
// ramps and the boundary markers. Geometry comes from the sim (`courseJson`), so what
// you see is what you collide with.
import * as THREE from "three/webgpu";
import { buildLand } from "./land.ts";
import { waveHeight } from "./waves.ts";

export interface CourseData {
  length: number;
  laps: number;
  straightHalf: number;
  radius: number;
  laneHalf: number;
  breakwaterRadius: number;
  outerLimit: number;
  rampSink: number;
  start: { x: number; z: number; yaw: number };
  buoys: { x: number; z: number; yaw: number; keep: "left" | "right" }[];
  ramps: { x: number; z: number; yaw: number; length: number; width: number; height: number }[];
  land: LandData[];
}

/** Solid land: a capsule around the segment a-b (see `sim::course::LandDef`). */
export interface LandData {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number;
  kind: "town" | "island" | "rock";
}

/** Distance from (x, z) to a piece of land's shore (negative inside it). */
export function landDistance(l: LandData, x: number, z: number): number {
  const abx = l.bx - l.ax;
  const abz = l.bz - l.az;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 1e-6 ? Math.min(1, Math.max(0, ((x - l.ax) * abx + (z - l.az) * abz) / len2)) : 0;
  return Math.hypot(x - (l.ax + abx * t), z - (l.az + abz * t)) - l.radius;
}

/** Keep red on your right, green on your left ("red right returning"). */
const RED = 0xe8402a;
const GREEN = 0x2fb34a;
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

/** An arrow pointing along +X in its own plane (XY), centred. */
function arrowShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-0.9, -0.22);
  s.lineTo(0.2, -0.22);
  s.lineTo(0.2, -0.55);
  s.lineTo(0.95, 0);
  s.lineTo(0.2, 0.55);
  s.lineTo(0.2, 0.22);
  s.lineTo(-0.9, 0.22);
  s.closePath();
  return s;
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
  private buoyMeshes: THREE.Group[] = [];
  private boundary: THREE.InstancedMesh;
  private boundaryPoints: { x: number; z: number }[] = [];
  private ring: THREE.Mesh;
  private matrix = new THREE.Matrix4();

  readonly data: CourseData;

  constructor(data: CourseData) {
    this.data = data;
    this.buildBreakwater();
    this.group.add(buildLand(this.data.land));
    this.buildStartGate();
    this.buildBuoys();
    this.buildRamps();
    this.boundary = this.buildBoundary();
    this.buildBoats();
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.12, 6, 32),
      new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);
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
    const hull = new THREE.BoxGeometry(5.2, 1, 1.9, 8, 2, 2);
    const pos = hull.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) / 2.6;
      const k = Math.abs(x);
      // Pinched at bow and stern, rising toward them, a round bilge.
      pos.setZ(i, pos.getZ(i) * (1 - Math.pow(k, 2.6)) * (pos.getY(i) < 0 ? 0.75 : 1));
      pos.setY(i, pos.getY(i) + k * k * (x > 0 ? 0.55 : 0.3));
    }
    hull.computeVertexNormals();
    const colours = [0xf4f1ea, 0x2f6fb0, 0xf4f1ea, 0x2d8a7a, 0xc8483a, 0xf4f1ea];
    const stripes = [0x2f6fb0, 0xf4f1ea, 0xc8483a, 0xf2c14e];
    let seed = 11;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let a = 8; a < len - 8; a += 9 + rnd() * 10) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(hull, std(colours[Math.floor(rnd() * colours.length)]!));
      body.position.y = 0.15;
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(4.2, 0.14, 1.95),
        std(stripes[Math.floor(rnd() * stripes.length)]!),
      );
      rail.position.y = 0.62;
      g.add(body, rail);
      if (rnd() < 0.6) {
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1.2), std(0xf4f1ea));
        cabin.position.set(-0.6, 1.1, 0);
        g.add(cabin);
      }
      if (rnd() < 0.5) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4, 6), std(0x7a5a3c));
        mast.position.set(1, 2.4, 0);
        g.add(mast);
      }
      for (const m of g.children) m.castShadow = true;
      const d = town.radius + 5 + rnd() * 3;
      const x = town.ax + ux * a + nx * d;
      const z = town.az + uz * a + nz * d;
      g.rotation.y = Math.atan2(-uz, ux) + (rnd() - 0.5) * 0.3;
      g.position.set(x, 0, z);
      this.group.add(g);
      this.floating.push({ obj: g, x, z, lift: 0 });
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

  private buildBuoys(): void {
    const body = new THREE.CylinderGeometry(0.55, 0.65, 1.5, 12);
    const band = new THREE.CylinderGeometry(0.58, 0.6, 0.3, 12);
    const arrowGeo = new THREE.ShapeGeometry(arrowShape());
    const white = std(0xf4f4f0);
    for (const b of this.data.buoys) {
      const color = b.keep === "right" ? RED : GREEN;
      const g = new THREE.Group();
      const m = new THREE.Mesh(body, std(color, { roughness: 0.45 }));
      m.position.y = 0.45;
      m.castShadow = true;
      const w = new THREE.Mesh(band, white);
      w.position.y = 0.75;
      g.add(m, w);
      // The arrow faces the riders and points to the side to pass on:
      // keep it on your right = pass on its left.
      const arrow = new THREE.Mesh(
        arrowGeo,
        std(color, { emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide }),
      );
      arrow.position.y = 2.6;
      // Plane faces +Z by default; turn it to face oncoming riders (-forward).
      arrow.rotation.y = b.yaw + Math.PI;
      // Seen from the front, the plane's +X is the rider's right.
      if (b.keep === "right") arrow.rotateZ(Math.PI);
      g.add(arrow);
      g.position.set(b.x, 0, b.z);
      this.group.add(g);
      this.buoyMeshes.push(g);
      this.floating.push({ obj: g, x: b.x, z: b.z, lift: 0 });
    }
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

  private buildBoundary(): THREE.InstancedMesh {
    const d = this.data;
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
      // No markers on (or right against) land: the shore is the boundary there.
      if (d.land.some((l) => landDistance(l, x, z) < 3)) continue;
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

  /** Float everything on the swells and mark the next buoy. */
  update(waves: Float32Array, t: number, nextBuoy: number | null): void {
    for (const f of this.floating) f.obj.position.y = waveHeight(waves, f.x, f.z, t) + f.lift;
    this.boundaryPoints.forEach((p, i) => {
      this.matrix.makeTranslation(p.x, waveHeight(waves, p.x, p.z, t), p.z);
      this.boundary.setMatrixAt(i, this.matrix);
    });
    this.boundary.instanceMatrix.needsUpdate = true;

    const b = nextBuoy === null ? undefined : this.buoyMeshes[nextBuoy];
    this.ring.visible = b !== undefined;
    if (b) {
      const pulse = 1 + 0.12 * Math.sin(t * 6);
      this.ring.position.set(b.position.x, b.position.y + 0.15, b.position.z);
      this.ring.scale.setScalar(pulse);
    }
    this.buoyMeshes.forEach((g, i) => g.children[2]!.scale.setScalar(i === nextBuoy ? 1.5 : 1));
  }
}
