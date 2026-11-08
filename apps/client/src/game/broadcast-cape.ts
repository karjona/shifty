// Television cameras round the cape, placed from the course: up on the
// watchtower over the point, on the harbour mole's head by the mouth, on
// the lifeguard tower on the beach, on the cliff over the arch's way out,
// on camera boats off the point and off the stacks, a helicopter high and
// wide, and a drone. They all follow your rider.
import * as THREE from "three/webgpu";
import { CoastGround, LIFEGUARD, MOLE_TOP, onBeach, watchtowerSpot } from "../render/cape.ts";
import { chevronSpots } from "../render/chevrons.ts";
import type { CourseData } from "../render/course.ts";
import { landDistance } from "../render/land.ts";
import type { Environment } from "../render/world.ts";
import { helicopter, spot } from "./broadcast-bay.ts";
import { type Rig, drone } from "./broadcast-rig.ts";

/** Standing camera's eye over what it stands on (m), and a camera boat's over the water. */
const EYE = 1.7;
const BOAT_EYE = 5.5;
/** How tall what stands on the land is (m): the town's houses, a stack, the arch, the watchtower. */
const TOWN_TOP = 14;
const STACK_TOP = 26;
const ARCH_TOP = 27;
const TOWER_TOP = 13;
/** A chevron board's half width and top (see render/chevrons.ts). */
const BOARD = { half: 2.2, top: 2.4 };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** How high what stands round the cape is at `(x, z)` (0: open water), for what hides a rider. */
function solid(course: CourseData, ground: CoastGround): (x: number, z: number) => number {
  const boards = chevronSpots(course);
  const tall = course.land.filter((l) => l.kind === "stack" || l.kind === "arch");
  const tower = watchtowerSpot(ground, course.land);
  return (x, z) => {
    const g = ground.sample(x, z);
    let h = g.kind === "town" ? TOWN_TOP : Math.max(0, g.h);
    for (const l of tall) if (landDistance(l, x, z) < 0) h = Math.max(h, l.kind === "stack" ? STACK_TOP : ARCH_TOP);
    if (tower && Math.hypot(x - tower.x, z - tower.z) < 3.8) h = Math.max(h, tower.y + TOWER_TOP);
    for (const b of boards) if (Math.hypot(x - b.x, z - b.z) < BOARD.half) h = Math.max(h, BOARD.top);
    for (const r of course.ramps) if (Math.hypot(x - r.x, z - r.z) < r.length / 2) h = Math.max(h, r.height);
    for (const b of course.buoys)
      if (Math.hypot(x - b.x, z - b.z) < course.buoyRadius) h = Math.max(h, course.buoyHeight);
    return h;
  };
}

/** The centre line at `s`, `offset` m to its right. */
function along(course: CourseData, s: number, offset: number): { x: number; z: number } {
  const step = course.path.length > 1 ? course.path[1]!.s : 2;
  const p = course.path[Math.round(s / step) % course.path.length] ?? course.path[0]!;
  return { x: p.x - Math.cos(p.yaw) * offset, z: p.z + Math.sin(p.yaw) * offset };
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
  // On the mole's head, by the light: riders come at it from the stacks and turn in through the mouth.
  if (mole) rigs.push(spot("mole", v(mole.bx - 2, MOLE_TOP + EYE, mole.bz - 2.5), solidAt, env));

  const beach = course.land.find((l) => l.kind === "beach");
  // Up the lifeguard tower: the start, and the ramp down the beach.
  if (beach) {
    const at = onBeach(ground, beach, LIFEGUARD.z, LIFEGUARD.inland);
    rigs.push(spot("beach", v(at.x, at.y + LIFEGUARD.top + EYE, at.z), solidAt, env));
  }

  const legs = course.land.filter((l) => l.kind === "arch");
  if (legs.length > 0) {
    // On the cliff edge beside the arch's way out: riders shoot out from under it.
    const ax = legs.reduce((sum, l) => sum + (l.ax + l.bx) / 2, 0) / legs.length;
    const north = Math.min(...legs.map((l) => l.az - l.radius));
    const x = ax + 26;
    let z = north - 6;
    for (let k = 0; k < 20 && ground.sample(x, z).inland < 2; k++) z -= 1;
    rigs.push(spot("arch", v(x, ground.height(x, z) + EYE, z), solidAt, env));
  }

  // Camera boats outside the limit: off the point's sweeper, and off the stacks.
  const out = course.outerLimit + 16;
  const boat = (name: string, s: number) => {
    const p = along(course, s, -out);
    if (course.land.some((l) => landDistance(l, p.x, p.z) < 6)) return;
    rigs.push(spot(name, v(p.x, BOAT_EYE, p.z), solidAt, env, true));
  };
  // Halfway round the widest right-hander (the point), and round the bend off the stacks.
  const rights = course.path.filter((p) => p.curve > 1e-4);
  const widest = Math.min(...rights.map((p) => p.curve));
  const sweep = rights.filter((p) => Math.abs(p.curve - widest) < 1e-5);
  const middle = sweep[Math.floor(sweep.length / 2)];
  if (middle) boat("boat-point", middle.s);
  boat("boat-stacks", course.length * 0.73);
  return rigs;
}
