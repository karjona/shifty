// What lies round the bay's course besides its land (see land.ts): the
// backdrop behind the town (scenery.ts), the boats moored along the quay
// and at anchor off its ends and out past the course, a trawler working
// along the coast, sails far out, and the train that runs behind the town.
import * as THREE from "three/webgpu";
import type { WaterScenery } from "./bay.ts";
import { UNREFLECTED } from "./cel/material.ts";
import { type Berth, Fleet, Roamer, ferry, mooredBerths, trawler, yacht } from "./coast/boats.ts";
import { boatMaterial } from "./coast/materials.ts";
import { Train } from "./coast/train.ts";
import type { CourseData } from "./course.ts";
import { buildScenery, farMaterial } from "./scenery.ts";
import type { Steps } from "./slices.ts";

/** The bay's boats at their berths: those the course has moored (the club's jetty draws its own), and the television's. */
function berths(course: CourseData): Berth[] {
  const out: Berth[] = mooredBerths(course);
  // The television's boats off each turn (see game/broadcast-bay.ts).
  const sh = course.straightHalf;
  const off = sh + course.outerLimit + 16;
  out.push({ x: off, z: 6, yaw: -Math.PI / 2, kind: "camera", seed: 1 });
  out.push({ x: -off, z: -6, yaw: Math.PI / 2, kind: "camera", seed: 2 });
  return out;
}

export class BaySide implements WaterScenery {
  readonly group = new THREE.Group();
  readonly gulls = new THREE.Vector3(40, 0, 40);
  readonly inland = null;
  private fleet!: Fleet;
  private roamers: Roamer[] = [];
  /** The train on the plain behind the town, at the foot of the hills. */
  private train = new Train(-1050, 1050, 2.2, 346);
  private course: CourseData;

  /** It is built by `build` (see slices.ts). */
  constructor(course: CourseData) {
    this.course = course;
  }

  /** Builds it, a piece at a time. */
  *build(): Steps {
    this.group.add(yield* buildScenery(), this.train.group);
    yield;
    this.fleet = new Fleet(berths(this.course));
    this.group.add(this.fleet.mesh);
    yield;
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
    this.train.update(t);
  }
}
