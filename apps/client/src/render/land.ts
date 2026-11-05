// Land along the course, drawn from the sim's capsules (`courseJson`), so
// the shore you see is the shore you hit: the town quay with its waterfront,
// the island with its pines and chapel, and rocks. Low-poly and
// flat-shaded; anything repeated is instanced.
import * as THREE from "three/webgpu";
import type { LandData } from "./course.ts";
import { Fn, float, fract, fwidth, mix, positionWorld, smoothstep, vec3 } from "three/tsl";

/** Seeded noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const mat = (color: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, flatShading: true, ...opts });

const STONE = 0xb4a58c;
const PAVING = 0xd9cbb0;
const ROCK = 0x8a8072;
const GRASS = 0x6f9a4a;
const PINE = 0x2f5e34;
const TRUNK = 0x7a5a3c;
const PALM = 0x4f8a3a;
const ROOF = 0xc0623a;
const WALLS = [0xf6f2ea, 0xf3ead8, 0xf2e2b6, 0xf0d5c4, 0xe8e4dc, 0xdfe8ea];
/** Awnings over the waterfront. */
const AWNINGS = [0x2a8fb0, 0xd94a3a, 0x3f8a4a, 0xf2c14e, 0xf6f2ea];
/** Window shutters, Mediterranean greens and blues. */
const SHUTTERS = [0x2f7d6b, 0x3a6ea5, 0x2d8a9a, 0x4f7f3a, 0x6b8fb3, 0x2f7d6b];

/** Outline of a capsule in world xz, counter-clockwise seen from above. */
function capsuleOutline(l: LandData, steps = 16): THREE.Vector2[] {
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
function prism(outline: THREE.Vector2[], bottom: number, top: number): THREE.BufferGeometry {
  // Shape y is world -z (the extrusion is turned to stand up along +y).
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottom, 0);
  return geo;
}

/** Instanced boxes: `add` one per call, `build` makes the mesh. */
class Boxes {
  private items: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  add(x: number, y: number, z: number, w: number, h: number, d: number, color: number, yaw = 0): void {
    this.q.setFromEuler(this.e.set(0, yaw, 0));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(w, h, d));
    this.items.push({ m, c: new THREE.Color(color) });
  }

  build(geo: THREE.BufferGeometry, material: THREE.Material, shadows = true): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, material, this.items.length);
    this.items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, it.c);
    });
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** A box geometry sitting on y = 0. */
function unitBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/** A four-sided roof sitting on y = 0. */
function unitRoof(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);
  return g;
}

/** A seven-sided cone sitting on y = 0 (pines, palm crowns). */
function unitCone(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.5, 1, 7);
  g.translate(0, 0.5, 0);
  return g;
}

/** Jitter a geometry's vertices so it reads as rock (seeded, radial in xz). */
function roughen(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const pos = geo.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const k = 1 + (r() - 0.5) * amount;
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
    pos.setY(i, pos.getY(i) + (r() - 0.5) * amount * 2);
  }
  geo.computeVertexNormals();
  return geo;
}

const QUAY_TOP = 2.2;

/** The town quay: a stone block with a palm promenade and the town on top. */
function town(l: LandData, seed: number): THREE.Group {
  const g = new THREE.Group();
  const quay = new THREE.Mesh(prism(capsuleOutline(l, 24), -6, QUAY_TOP), [mat(PAVING), mat(STONE)]);
  quay.receiveShadow = true;
  g.add(quay);

  const r = rng(seed);
  // The waterfront faces the course: walk along the near edge of the capsule.
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  // Unit normal from the spine toward the course side (toward the origin).
  let nx = -uz;
  let nz = ux;
  if (nx * -l.ax + nz * -l.az < 0) {
    nx = -nx;
    nz = -nz;
  }
  const yaw = Math.atan2(nx, nz);
  const at = (along: number, inland: number) => {
    const d = l.radius - inland;
    return { x: l.ax + ux * along + nx * d, z: l.az + uz * along + nz * d };
  };

  const walls = new Boxes();
  const roofs = new Boxes();
  const windows = new Boxes();
  const trunks = new Boxes();
  const crowns = new Boxes();
  const awnings = new Boxes();

  // Palms along the promenade.
  for (let a = -10; a <= len + 10; a += 13 + r() * 3) {
    const p = at(a, 4);
    const h = 6 + r() * 3;
    trunks.add(p.x, QUAY_TOP, p.z, 0.5, h, 0.5, TRUNK);
    crowns.add(p.x, QUAY_TOP + h - 0.6, p.z, 4.6, 1.6, 4.6, PALM, r() * Math.PI);
  }
  // Two rows of houses: low ones on the front, taller ones behind.
  // Rows behind them fill the quay back to its far side, in blocks with streets between.
  const rows = [
    { inland: 14, depth: 9, minH: 5, maxH: 9 },
    { inland: 27, depth: 10, minH: 8, maxH: 15 },
  ];
  for (let inland = 41; inland + 6 < l.radius * 2 - 8; inland += 13) {
    const back = inland / (l.radius * 2);
    rows.push({ inland, depth: 10, minH: 7 + back * 4, maxH: 13 + back * 6 });
  }
  for (const row of rows) {
    // Along the quay as far as its rounded ends allow at this depth.
    const fromSpine = Math.abs(l.radius - row.inland);
    const reach = Math.sqrt(Math.max(0, l.radius * l.radius - fromSpine * fromSpine)) - 8;
    for (let a = -Math.min(20, reach); a < len + Math.min(20, reach);) {
      // A street now and then between blocks.
      if (row.inland > 30 && r() < 0.12) {
        a += 6 + r() * 4;
        continue;
      }
      const w = 6 + r() * 7;
      const h = row.minH + r() * (row.maxH - row.minH);
      const p = at(a + w / 2, row.inland);
      walls.add(p.x, QUAY_TOP, p.z, w, h, row.depth, WALLS[Math.floor(r() * WALLS.length)]!, yaw);
      if (r() < 0.6) roofs.add(p.x, QUAY_TOP + h, p.z, w * 1.05, 1.6 + r(), row.depth * 1.05, ROOF, yaw);
      // An awning over the ground floor on the waterfront row.
      if (row.inland === 14 && r() < 0.6) {
        const front0 = { x: p.x + nx * (row.depth / 2 + 0.9), z: p.z + nz * (row.depth / 2 + 0.9) };
        awnings.add(
          front0.x,
          QUAY_TOP + 2.7,
          front0.z,
          w * 0.85,
          0.12,
          1.8,
          AWNINGS[Math.floor(r() * AWNINGS.length)]!,
          yaw,
        );
      }
      // Windows on the face toward the water, one row per storey.
      const shutter = SHUTTERS[Math.floor(r() * SHUTTERS.length)]!;
      const front = { x: p.x + nx * (row.depth / 2 + 0.05), z: p.z + nz * (row.depth / 2 + 0.05) };
      for (let y = 1.6; y < h - 1; y += 3) {
        for (let wx = -w / 2 + 1.5; wx < w / 2 - 1; wx += 2.4) {
          windows.add(front.x + ux * wx, QUAY_TOP + y, front.z + uz * wx, 1.1, 1.4, 0.12, shutter, yaw);
        }
      }
      a += w + 0.6 + r() * 1.5;
    }
  }
  // The church: a bell tower over the rooftops.
  const c = at(len * 0.4, 22);
  walls.add(c.x, QUAY_TOP, c.z, 5, 22, 5, 0xf3ead8, yaw);
  roofs.add(c.x, QUAY_TOP + 22, c.z, 5.6, 4, 5.6, ROOF, yaw);

  const plain = mat(0xffffff);
  g.add(
    walls.build(unitBox(), plain),
    roofs.build(unitRoof(), tiledRoof()),
    windows.build(unitBox(), mat(0xffffff, { roughness: 0.3 }), false),
    trunks.build(unitBox(), plain),
    crowns.build(palmCrown(), mat(0xffffff, { side: THREE.DoubleSide })),
    awnings.build(unitBox(), plain),
  );
  return g;
}

/** Terracotta roofs in rows of tiles: darker lines every course. */
function tiledRoof(): THREE.MeshStandardNodeMaterial {
  const m = mat(0xffffff);
  m.userData.colorNode = Fn(() => {
    const row = fract(positionWorld.y.mul(2.2));
    const w = fwidth(positionWorld.y.mul(2.2)).max(1e-4);
    const line = smoothstep(w.mul(1.5), float(0), row);
    return mix(vec3(1), vec3(0.72, 0.62, 0.6), line);
  })();
  return m;
}

/** A palm's crown of drooping fronds, about a unit across, its heart at y = 0. */
function palmCrown(): THREE.BufferGeometry {
  const pos: number[] = [];
  const fronds = 9;
  const segs = 7;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + Math.sin(f * 2.3) * 0.25;
    const lift = 0.35 + Math.sin(f * 1.7) * 0.2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const point = (t: number, side: number): [number, number, number] => {
      const reach = t * 0.55;
      const w = 0.11 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.6) * side;
      const y = lift * t - 1.25 * t * t - Math.abs(side) * 0.04;
      return [ca * reach - sa * w, y, sa * reach + ca * w];
    };
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      for (const side of [-1, 1]) {
        pos.push(...point(t0, 0), ...point(t0, side), ...point(t1, side));
        pos.push(...point(t0, 0), ...point(t1, side), ...point(t1, 0));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.translate(0, 0.6, 0);
  return g;
}

/** A rocky island with a grass cap, pines and a white chapel. */
function island(l: LandData, seed: number): THREE.Group {
  const g = new THREE.Group();
  const r = rng(seed);
  const rock = new THREE.Mesh(
    roughen(new THREE.CylinderGeometry(l.radius * 0.7, l.radius * 1.02, 10, 16, 3), 0.12, seed),
    mat(ROCK),
  );
  rock.position.y = -1;
  const cap = new THREE.Mesh(
    roughen(new THREE.CylinderGeometry(l.radius * 0.62, l.radius * 0.74, 1.2, 14, 1), 0.08, seed + 1),
    mat(GRASS),
  );
  cap.position.y = 4.4;
  rock.castShadow = cap.castShadow = true;
  rock.receiveShadow = cap.receiveShadow = true;
  g.add(rock, cap);

  const pines = new Boxes();
  const trunks = new Boxes();
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * l.radius * 0.45;
    const h = 4 + r() * 4;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    trunks.add(x, 4.8, z, 0.4, 1.4, 0.4, TRUNK);
    pines.add(x, 5.8, z, 2.6 + r(), h, 2.6 + r(), PINE);
  }
  const plain = mat(0xffffff);
  g.add(pines.build(unitCone(), plain), trunks.build(unitBox(), plain));

  // A small chapel facing the course.
  const chapel = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(3, 3.2, 4.2), mat(0xf6f2ea));
  body.position.y = 1.6;
  const roof = new THREE.Mesh(unitRoof(), mat(ROOF));
  roof.scale.set(3.3, 1.6, 4.5);
  roof.position.y = 3.2;
  const bell = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 1), mat(0xf6f2ea));
  bell.position.set(0, 4.3, 1.6);
  for (const m of [body, roof, bell]) m.castShadow = true;
  chapel.add(body, roof, bell);
  chapel.position.set(l.radius * 0.25, 4.9, l.radius * 0.2);
  chapel.rotation.y = r() * Math.PI;
  g.add(chapel);

  g.position.set(l.ax, 0, l.az);
  return g;
}

function boulder(l: LandData, seed: number): THREE.Mesh {
  const m = new THREE.Mesh(roughen(new THREE.IcosahedronGeometry(l.radius * 1.05, 1), 0.25, seed), mat(ROCK));
  m.scale.y = 0.9;
  m.position.set(l.ax, l.radius * 0.15, l.az);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildLand(land: LandData[]): THREE.Group {
  const g = new THREE.Group();
  land.forEach((l, i) => {
    const seed = 1000 + i * 97;
    if (l.kind === "town") g.add(town(l, seed));
    else if (l.kind === "island") g.add(island(l, seed));
    else g.add(boulder(l, seed));
  });
  return g;
}
