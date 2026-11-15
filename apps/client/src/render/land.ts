// Land along the bay's course, drawn from the sim's capsules (`courseJson`),
// so the shore you see is the shore you hit: the town on its quay
// (coast/town.ts), the islet with its pines and hermitage, and rocks. All
// of it is out in the weather (see cel/look.ts): snow on roofs and rocks
// in winter, grass and trees in the season's colours.
import * as THREE from "three/webgpu";
import type { Season } from "../game/conditions.ts";
import type { LandData } from "./course.ts";
import { propMaterial } from "./coast/materials.ts";
import {
  CLIFF,
  type CliffStyle,
  DRY_GRASS,
  LIMESTONE,
  LIMESTONE_TOP,
  boulderGeometry,
  cragGeometry,
  rockMaterial,
  roundShore,
  stonePaint,
  sweepCliff,
} from "./coast/rock.ts";
import { Shape, box, place, turned } from "./coast/shape.ts";
import { capsuleOutline, landDistance, prism, rng } from "./coast/outline.ts";
import { buildTown } from "./coast/town.ts";
import { Planting } from "./coast/trees.ts";

export { capsuleOutline, landDistance, prism, rng };

const ROOF = 0xc0623a;

/** Instanced boxes: `add` one per call, `build` makes the mesh. */
export class Boxes {
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
export function unitBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/** How the islet's cliffs are cut: short planes round a small rock. */
const ISLET: CliffStyle = { ...CLIFF, face: [3, 5.5], out: [0.7, 1.5], flange: 2.2, ledge: [0.5, 1.1], tiers: 4 };

/** The hermitage on the islet: a whitewashed chapel with a bell gable over its door, facing `yaw`. */
function chapel(shape: Shape, x: number, y: number, z: number, yaw: number): void {
  const white = 0xf6f2ea;
  const m = (dx: number, dy: number, dz: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return place(x + dx * c + dz * s, y + dy, z - dx * s + dz * c, yaw);
  };
  shape.take(box(3, 2.6, 4.2), white, m(0, 0, 0));
  // A gabled roof of tiles, its ridge along the nave.
  const roof = new THREE.CylinderGeometry(0.01, 1.9, 1.2, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 1.75);
  shape.take(roof, ROOF, m(0, 3.2, 0), { flat: true });
  // The bell gable over the door, with its arch and bell.
  shape.take(box(1.7, 2.2, 0.45), white, m(0, 2.6, 2.0));
  shape.take(box(0.55, 0.8, 0.5), 0x3f4a5a, m(0, 3.6, 2.0));
  shape.take(
    new THREE.CylinderGeometry(0.01, 1.05, 0.5, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.36),
    ROOF,
    m(0, 5.05, 2.0),
    {
      flat: true,
    },
  );
  shape.take(box(0.08, 0.7, 0.08), 0x3a3f46, m(0, 5.2, 2.0));
  shape.take(box(0.4, 0.08, 0.08), 0x3a3f46, m(0, 5.6, 2.0));
  shape.take(box(0.9, 1.7, 0.2), 0x6a4a32, m(0, 0, 2.08));
  shape.take(box(0.2, 0.7, 0.5), 0x3f4a5a, m(1.45, 1.3, -0.4));
}

/** A rocky islet: cliffs round a grassy top, stone pines leaning over it and a white hermitage. */
function island(l: LandData, seed: number): THREE.Group {
  const g = new THREE.Group();
  const r = rng(seed);
  const stone = new Shape();
  const turn = r() * 6;
  // The islet's beds dip: its rim stands high on one side and low on the other.
  const top = (a: number) => 4.9 + Math.sin(a + turn) * 1.5 + Math.sin(a * 3 + turn * 2) * 0.4;
  const rim = sweepCliff(stone, roundShore(l.ax, l.az, l.radius, top, 0.8), true, seed, ISLET);
  // The top: a low dome of grass inside the rim.
  const crown = new THREE.Vector3(l.ax, 6.2, l.az);
  for (let i = 0; i < rim.length; i++) stone.tri(rim[i]!, crown, rim[(i + 1) % rim.length]!, DRY_GRASS);
  const kit = [boulderGeometry(seed), boulderGeometry(seed + 3)];
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2;
    const s = 1.4 + r() * 1.6;
    const d = l.radius + 0.6 + r() * 0.8;
    stone.add(
      kit[i % 2]!,
      stonePaint(LIMESTONE, LIMESTONE_TOP, r),
      turned(l.ax + Math.cos(a) * d, 0.2, l.az + Math.sin(a) * d, r(), r() * 6, r(), s),
      { flat: true },
    );
  }
  for (const k of kit) k.dispose();
  g.add(stone.mesh(rockMaterial()));

  const works = new Shape();
  // Facing the course.
  chapel(works, l.ax + 1.2, 5.6, l.az + 0.6, Math.atan2(-l.ax, -l.az));
  g.add(works.mesh(propMaterial()));

  const plants = new Planting({ shadows: true, reflected: true });
  plants.add("pine", l.ax - 2.6, 5.5, l.az - 1.2, 7.5);
  plants.add("pine", l.ax + 0.4, 5.6, l.az - 3.2, 6.2, 0.92);
  plants.add("pine", l.ax - 1.2, 5.6, l.az + 2.8, 5.4, 1.06);
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2;
    const d = 2.5 + r() * 2.2;
    plants.add(i % 2 === 0 ? "agave" : "bush", l.ax + Math.cos(a) * d, 5.5, l.az + Math.sin(a) * d, 1 + r() * 0.5);
  }
  g.add(plants.build(true));
  return g;
}

/** A rock in the sea: a crag with a couple of boulders against it. */
function boulder(l: LandData, seed: number): THREE.Mesh {
  const r = rng(seed);
  const stone = new Shape();
  stone.take(
    cragGeometry(l.radius, 2.3 + r() * 0.8, seed),
    stonePaint(LIMESTONE, LIMESTONE_TOP, r),
    place(l.ax, 0, l.az),
    {
      flat: true,
    },
  );
  const kit = boulderGeometry(seed + 5);
  for (let i = 0; i < 3; i++) {
    const a = r() * Math.PI * 2;
    const s = 1.2 + r() * 1.2;
    stone.add(
      kit,
      stonePaint(LIMESTONE, LIMESTONE_TOP, r),
      turned(l.ax + Math.cos(a) * (l.radius + 0.3), 0.15, l.az + Math.sin(a) * (l.radius + 0.3), r(), r() * 6, r(), s),
      { flat: true },
    );
  }
  kit.dispose();
  return stone.mesh(rockMaterial());
}

/** The bay's land, as it is in `season`. */
export function buildLand(land: LandData[], season: Season = "summer"): THREE.Group {
  const g = new THREE.Group();
  land.forEach((l, i) => {
    const seed = 1000 + i * 97;
    if (l.kind === "town") g.add(buildTown(l, seed, season).group);
    else if (l.kind === "island") g.add(island(l, seed));
    else g.add(boulder(l, seed));
  });
  return g;
}
