// Television cameras round the cape, placed from the course: up on the
// watchtower over the point, on the harbour mole's head by the mouth, on
// the lifeguard tower on the beach, on the cliff over the arch's way out,
// on camera boats off the point and off the stacks, a helicopter high and
// wide, and a drone. They all follow your rider.
import * as THREE from "three/webgpu";
import {
  ARCH_TOP,
  CoastGround,
  LIFEGUARD,
  MOLE_TOP,
  cameraBoats,
  onBeach,
  watchtowerSpot,
} from "../render/cape.ts";
import { chevronSpots } from "../render/chevrons.ts";
import type { CourseData } from "../render/course.ts";
import { moleCamera } from "../render/coast/harbour.ts";
import { landDistance } from "../render/land.ts";
import type { Environment } from "../render/world.ts";
import { helicopter, spot } from "./broadcast-bay.ts";
import { type Rig, drone } from "./broadcast-rig.ts";

/** Standing camera's eye over what it stands on (m), and a camera boat's over the water. */
const EYE = 1.7;
const BOAT_EYE = 5.5;
/** How tall what stands on the land is (m): the town's houses, a stack, the watchtower. */
const TOWN_TOP = 14;
const STACK_TOP = 28;
const TOWER_TOP = 13;
/** What stands on the mole's deck (its parapet, people), and the light on its head, over the deck (m). */
const CROWD = 2;
const LIGHT = 7;
/** A chevron board's half width and top (see render/chevrons.ts). */
const BOARD = { half: 2.2, top: 2.4 };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** How high what stands round the cape is at `(x, z)` (0: open water), for what hides a rider. */
function solid(course: CourseData, ground: CoastGround): (x: number, z: number) => number {
  const boards = chevronSpots(course);
  const tall = course.land.filter((l) => l.kind === "stack" || l.kind === "arch");
  const moles = course.land.filter((l) => l.kind === "mole");
  const tower = watchtowerSpot(ground, course.land);
  return (x, z) => {
    const g = ground.sample(x, z);
    let h = g.kind === "town" ? TOWN_TOP : Math.max(0, g.h);
    // A cliff's rock stands at its full height right from the shore (and a little out past it).
    const shore = ground.cliffs(x, z);
    if (shore < 2 && shore > -5) {
      const gx = ground.cliffs(x + 1, z) - ground.cliffs(x - 1, z);
      const gz = ground.cliffs(x, z + 1) - ground.cliffs(x, z - 1);
      const len = Math.hypot(gx, gz) || 1;
      const inland = shore + 5.5;
      h = Math.max(h, ground.height(x - (gx / len) * inland, z - (gz / len) * inland) * 1.1 + 0.6);
    }
    for (const l of tall) if (landDistance(l, x, z) < 0) h = Math.max(h, l.kind === "stack" ? STACK_TOP : ARCH_TOP);
    for (const l of moles) {
      const d = landDistance(l, x, z);
      if (d < -1) h = Math.max(h, MOLE_TOP + CROWD);
      else if (d < 2.5) h = Math.max(h, MOLE_TOP);
      if (Math.hypot(x - l.bx, z - l.bz) < l.radius) h = Math.max(h, MOLE_TOP + LIGHT);
    }
    if (tower && Math.hypot(x - tower.x, z - tower.z) < 3.8) h = Math.max(h, tower.y + TOWER_TOP);
    for (const b of boards) if (Math.hypot(x - b.x, z - b.z) < BOARD.half) h = Math.max(h, BOARD.top);
    for (const r of course.ramps) if (Math.hypot(x - r.x, z - r.z) < r.length / 2) h = Math.max(h, r.height);
    for (const b of course.buoys)
      if (Math.hypot(x - b.x, z - b.z) < course.buoyRadius) h = Math.max(h, course.buoyHeight);
    return h;
  };
}

export function capeRigs(course: CourseData, env: Environment): Rig[] {
  const ground = new CoastGround(course.land);
  const solidAt = solid(course, ground);
  const water = (x: number, z: number, t: number) => Math.max(env.ground(x, z, t), ground.height(x, z));
  const rigs: Rig[] = [helicopter(solidAt), drone("drone", water)];

  const tower = watchtowerSpot(ground, course.land);
  // On the watchtower's top, over the sweeper round the point.
  if (tower) rigs.push(spot("watchtower", v(tower.x + 2.5, tower.y + TOWER_TOP + EYE, tower.z + 1.5), solidAt, env));

  const mole = course.land.find((l) => l.kind === "mole");
  // On the mole's parapet, by the light: riders come at it from the stacks and turn in through the mouth.
  if (mole) {
    const at = moleCamera(mole, MOLE_TOP, mole.bx >= mole.ax ? 1 : -1);
    rigs.push(spot("mole", v(at.x, at.y, at.z), solidAt, env));
  }

  const beach = course.land.find((l) => l.kind === "beach");
  // Up the lifeguard tower: the start, and the ramp down the beach.
  if (beach) {
    const at = onBeach(ground, beach, LIFEGUARD.z, LIFEGUARD.inland);
    // (At the seaward corner of its deck, clear of its flag: the sea is to the west.)
    rigs.push(spot("beach", v(at.x - 2.2, at.y + LIFEGUARD.top + EYE + 0.3, at.z + 1.2), solidAt, env));
  }

  const legs = course.land.filter((l) => l.kind === "arch");
  if (legs.length > 0) {
    // Over the cliff's edge beside the arch's way out: riders shoot out from under it.
    const ax = legs.reduce((sum, l) => sum + (l.ax + l.bx) / 2, 0) / legs.length;
    const north = Math.min(...legs.map((l) => l.az - l.radius));
    const x = ax + 30;
    let z = north - 6;
    for (let k = 0; k < 30 && ground.cliffs(x, z) > -1; k++) z -= 1;
    // (The rock stands at its full height from the shore: the camera hangs over its rim.)
    rigs.push(spot("arch", v(x, ground.height(x, z - 6) * 1.1 + EYE + 1, z), solidAt, env));
  }

  // Camera boats outside the limit: off the point's sweeper, and off the stacks.
  for (const b of cameraBoats(course)) rigs.push(spot(b.name, v(b.x, BOAT_EYE, b.z), solidAt, env, true));
  return rigs;
}
