// The coast's railway: a line on a low bank across the plain behind the
// bay, and a little train that runs it from end to end and back, stopping
// a while at each. Far off: painted in the distance's material.
import * as THREE from "three/webgpu";
import { UNREFLECTED } from "../cel/material.ts";
import { farMaterial } from "../scenery.ts";
import { Shape, box, place } from "./shape.ts";

const CREAM = 0xf2ead6;
const RED = 0xc8442e;
const GLASS = 0x3f546c;
const ROOF = 0x8b919b;
const BALLAST = 0xb9ad98;
const RAIL = 0x6e675c;

/** A carriage's length and the gap to the next (m), how many make a train, its pace (m/s) and its wait at each end (s). */
const CAR = 17;
const GAP = 1.2;
const CARS = 4;
const PACE = 21;
const WAIT = 9;

/** One carriage, its middle at `x`, on rails at y = 0, running along x; `cab`: which end is rounded off (-1, 0, 1). */
function carriage(shape: Shape, x: number, cab: number): void {
  shape.take(box(CAR, 0.5, 2.3), RAIL, place(x, 0.25, 0));
  shape.take(box(CAR, 1.1, 2.8), RED, place(x, 0.75, 0));
  shape.take(box(CAR, 1.0, 2.82), GLASS, place(x, 1.85, 0));
  shape.take(box(CAR, 0.45, 2.8), CREAM, place(x, 2.85, 0));
  shape.take(box(CAR - 0.6, 0.3, 2.3), ROOF, place(x, 3.3, 0));
  // Posts between its windows.
  for (let k = -3; k <= 3; k++) shape.take(box(0.5, 1.0, 2.86), CREAM, place(x + k * (CAR / 7), 1.85, 0));
  if (cab !== 0) shape.take(box(1.4, 1.5, 2.84), CREAM, place(x + cab * (CAR / 2 - 0.7), 1.85, 0));
}

export class Train {
  readonly group = new THREE.Group();
  private train: THREE.Mesh;
  private from: number;
  private to: number;

  /** The line runs along x from `from` to `to` at `z`, its rails `y` over the sea. */
  constructor(from: number, to: number, y: number, z: number) {
    this.from = from;
    this.to = to;
    const bank = new Shape();
    bank.take(box(to - from + 80, y, 6), BALLAST, place((from + to) / 2, 0, z));
    bank.take(box(to - from + 80, 0.12, 2.2), RAIL, place((from + to) / 2, y, z));
    const line = bank.mesh(farMaterial(), "none");
    line.name = "railway";
    const cars = new Shape();
    for (let k = 0; k < CARS; k++)
      carriage(cars, (k - (CARS - 1) / 2) * (CAR + GAP), k === 0 ? -1 : k === CARS - 1 ? 1 : 0);
    this.train = cars.mesh(farMaterial(), "none");
    this.train.name = "train";
    this.train.position.set(from, y + 0.1, z);
    // (Too far off to show in the water.)
    for (const mesh of [line, this.train]) mesh.layers.set(UNREFLECTED);
    this.group.add(line, this.train);
    this.group.userData.noMerge = true;
  }

  /** Where the train is at `t` seconds. */
  update(t: number): void {
    const run = (this.to - this.from) / PACE;
    const round = (run + WAIT) * 2;
    const at = ((t % round) + round) % round;
    // Out, a wait, back, a wait; easing away from each stop and into the next.
    const leg = at < run + WAIT ? Math.min(1, at / run) : 1 - Math.min(1, (at - run - WAIT) / run);
    const eased = leg * leg * (3 - 2 * leg) * 0.35 + leg * 0.65;
    this.train.position.x = this.from + (this.to - this.from) * eased;
  }
}
