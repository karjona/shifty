// What lies round the bay's course besides its land (see land.ts): the
// backdrop behind the town (scenery.ts), the boats moored along the quay
// and at anchor off its ends and out past the course, a trawler working
// along the coast and sails far out.
import * as THREE from "three/webgpu";
import type { WaterScenery } from "./bay.ts";
import { UNREFLECTED } from "./cel/material.ts";
import { type Berth, Fleet, Roamer, ferry, trawler, yacht } from "./coast/boats.ts";
import { boatMaterial } from "./coast/materials.ts";
import { random } from "./coast/shape.ts";
import type { CourseData } from "./course.ts";
import { buildScenery, farMaterial } from "./scenery.ts";

/** The bay's boats at their berths. */
function berths(course: CourseData): Berth[] {
  const r = random(11);
  const out: Berth[] = [];
  const town = course.land.find((l) => l.kind === "town");
  if (town) {
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
    // Alongside the quay, bow to stern.
    for (let a = 6; a < len - 6; a += 8.5 + r() * 9) {
      const d = town.radius + 1.9 + r() * 0.5;
      out.push({
        x: town.ax + ux * a + nx * d,
        z: town.az + uz * a + nz * d,
        yaw: Math.atan2(ux, uz) + (r() < 0.5 ? Math.PI : 0) + (r() - 0.5) * 0.12,
        kind: r() < 0.82 ? "llaut" : "inflatable",
        seed: Math.floor(r() * 1000),
      });
    }
  }
  // At anchor off the quay's ends and out past the first straight, heads to the swell.
  const sh = course.straightHalf;
  const anchored: [number, number, Berth["kind"]][] = [
    [sh + 78, 96, "trawler"],
    [sh + 98, 124, "yacht"],
    [sh + 62, 130, "llaut"],
    [sh + 118, 88, "yacht"],
    [-sh - 76, 100, "yacht"],
    [-sh - 96, 128, "trawler"],
    [-sh - 60, 134, "llaut"],
    [-60, -128, "yacht"],
    [48, -152, "yacht"],
    [sh + 10, -134, "llaut"],
    [-sh - 44, -112, "yacht"],
  ];
  for (const [x, z, kind] of anchored)
    out.push({ x, z, yaw: Math.PI / 2 + (r() - 0.5) * 0.5, kind, seed: Math.floor(r() * 1000) });
  // The television's boats off each turn (see game/broadcast-bay.ts).
  const off = sh + course.outerLimit + 16;
  out.push({ x: off, z: 6, yaw: -Math.PI / 2, kind: "camera", seed: 1 });
  out.push({ x: -off, z: -6, yaw: Math.PI / 2, kind: "camera", seed: 2 });
  return out;
}

export class BaySide implements WaterScenery {
  readonly group = new THREE.Group();
  readonly gulls = new THREE.Vector3(40, 0, 40);
  readonly inland = null;
  private fleet: Fleet;
  private roamers: Roamer[];

  constructor(course: CourseData) {
    this.group.add(buildScenery());
    this.fleet = new Fleet(berths(course));
    this.group.add(this.fleet.mesh);
    const hull = boatMaterial();
    const sails: [number, number][] = [
      [-760, -430],
      [0, -540],
      [740, -450],
      [520, -660],
      [-320, -700],
    ];
    this.roamers = [
      new Roamer(
        trawler(7),
        hull,
        [
          [-380, -132],
          [0, -150],
          [380, -132],
          [430, -205],
          [0, -245],
          [-430, -205],
        ],
        4.2,
        0.1,
      ),
      new Roamer(yacht(3, true), hull, sails, 2.6, 0.05),
      new Roamer(yacht(8, true), hull, sails, 2.6, 0.31),
      new Roamer(yacht(12, true), hull, sails, 2.6, 0.72),
    ];
    // The ferry, far out, on its way along the coast.
    const liner = new Roamer(
      ferry(),
      farMaterial(),
      [
        [-2600, -1500],
        [0, -1750],
        [2600, -1500],
        [2900, -2300],
        [0, -2600],
        [-2900, -2300],
      ],
      6,
      0.2,
    );
    this.roamers.push(liner);
    // (All but the trawler are too far off to show in the water.)
    for (const boat of this.roamers.slice(1)) boat.mesh.layers.set(UNREFLECTED);
    for (const boat of this.roamers) this.group.add(boat.mesh);
  }

  update(waves: Float32Array, t: number): void {
    this.fleet.update(waves, t);
    for (const boat of this.roamers) boat.update(waves, t);
  }
}
