// Television cameras round the bay, placed from the course: on the
// breakwater by the start and in the middle, on the island, up the
// lighthouse, on the town quay by each ramp, on a boat off each turn, a
// helicopter high and wide, and a drone. They all follow your rider.
import * as THREE from "three/webgpu";
import { chevronSpots } from "../render/chevrons.ts";
import type { CourseData } from "../render/course.ts";
import type { Environment } from "../render/world.ts";
import { type Rig, type Watch, clear, drone, onRider } from "./broadcast-rig.ts";

/** Fixed cameras see this far (m); past it the fog takes the rider. */
const RANGE = 130;
/** The rider fills this tall a slice of the picture (m) on the fixed cameras. */
const FRAME = 5.5;
/** The helicopter's distance out from the rider and height (m). */
const HELI_OUT = 72;
const HELI_UP = 24;
/** The camera boats' eye over the water (m): high enough to see over the chevron boards. */
const BOAT_EYE = 5.5;
/** Standing camera's eye over what it stands on (m). */
const EYE = 1.7;
/** Breakwater crest, quay top, the island's grass and pines, a rock, the lighthouse (m) (see render/course.ts, render/land.ts). */
const BREAKWATER_TOP = 2.5;
const QUAY_TOP = 2.2;
const ISLAND_TOP = 5;
const PINES_TOP = 10;
const ROCK_TOP = 3;
const LIGHTHOUSE = { radius: 1.9, top: 16 };
/** A chevron board's half width and top (see render/chevrons.ts). */
const BOARD = { half: 2.2, top: 2.4 };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** How high what stands on the bay is at `(x, z)` (0: open water), for what hides a rider. */
function solid(course: CourseData): (x: number, z: number) => number {
  const sh = course.straightHalf;
  const bw = course.breakwaterRadius;
  const light = lighthouse(course);
  const boards = chevronSpots(course);
  return (x, z) => {
    let h = 0;
    const dx = Math.max(0, Math.abs(x) - sh);
    if (Math.hypot(dx, z) < bw * 0.85) h = BREAKWATER_TOP;
    if (Math.hypot(x - light.x, z - light.z) < LIGHTHOUSE.radius) h = LIGHTHOUSE.top;
    for (const b of boards) if (Math.hypot(x - b.x, z - b.z) < BOARD.half) h = Math.max(h, BOARD.top);
    for (const r of course.ramps) if (Math.hypot(x - r.x, z - r.z) < r.length / 2) h = Math.max(h, r.height);
    for (const l of course.land) {
      const ax = l.bx - l.ax;
      const az = l.bz - l.az;
      const len2 = ax * ax + az * az;
      const k = len2 > 0 ? Math.min(1, Math.max(0, ((x - l.ax) * ax + (z - l.az) * az) / len2)) : 0;
      const d = Math.hypot(x - (l.ax + ax * k), z - (l.az + az * k));
      if (d >= l.radius) continue;
      const top =
        l.kind === "island" ? (d < l.radius * 0.5 ? PINES_TOP : ISLAND_TOP) : l.kind === "rock" ? ROCK_TOP : QUAY_TOP;
      h = Math.max(h, top);
    }
    return h;
  };
}

/** The lighthouse on the breakwater's east tip (see render/course.ts). */
function lighthouse(course: CourseData): { x: number; z: number } {
  return { x: course.straightHalf + course.breakwaterRadius * 0.45, z: 0 };
}

/** A camera standing at `eye` (floating if `afloat`), following your rider. */
function spot(
  name: string,
  eye: THREE.Vector3,
  solidAt: (x: number, z: number) => number,
  env: Environment,
  afloat = false,
): Rig {
  const at = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const here = eye.clone();
  /** Where the camera is now (a boat rides the swell). */
  const place = (w: Watch) => {
    if (afloat) here.y = env.ground(eye.x, eye.z, w.simT) + eye.y;
    return here;
  };
  return {
    name,
    minShot: 3.5,
    maxShot: 9,
    rate(w) {
      const r = w.me;
      if (!r) return null;
      const e = place(w);
      at.set(r.x, r.y + 1, r.z);
      ahead.set(r.x + r.vx * 2, r.y + 1, r.z + r.vz * 2);
      const d = e.distanceTo(at);
      const d2 = e.distanceTo(ahead);
      if (d > RANGE && d2 > RANGE) return null;
      const seen = d < RANGE && clear(e, at, solidAt);
      if (!seen && !(d2 < RANGE && clear(e, ahead, solidAt))) return null;
      const close = Math.min(1, Math.max(0, 1 - (d2 - 30) / 100));
      const toward = Math.max(0, Math.min(1, (d - d2) / (r.speed * 2 + 1)));
      const tooClose = d2 < 10 ? 0.3 : 0;
      return { slot: r.slot, score: 0.55 * close + 0.35 * toward + (seen ? 0.1 : 0) - tooClose };
    },
    aim(w, r, out) {
      const e = place(w);
      out.eye.copy(e);
      out.frame = FRAME;
      out.follow = 6;
      onRider(out, r);
      if (afloat) {
        // The boat rolls with the swell under it.
        const s = 2;
        const slope = (env.ground(e.x + s, e.z, w.simT) - env.ground(e.x - s, e.z, w.simT)) / (2 * s);
        out.roll = Math.atan(slope) * 0.6 + Math.sin(w.t * 0.9) * 0.015;
      }
    },
    holds(w, r) {
      const e = place(w);
      at.set(r.x, r.y + 1, r.z);
      const d = e.distanceTo(at);
      const leaving = (r.vx * (r.x - e.x) + r.vz * (r.z - e.z)) / Math.max(1, d * r.speed) > 0.5;
      return d < RANGE && !(leaving && d > 90) && clear(e, at, solidAt);
    },
  };
}

/**
 * A helicopter off the rider's outside (or inside, rather than over the
 * land), high and wide, circling slowly: the rider small against the bay
 * and the far shore.
 */
function helicopter(solidAt: (x: number, z: number) => number): Rig {
  let angle = 0;
  let from = 0;
  return {
    name: "helicopter",
    minShot: 5,
    maxShot: 7,
    rest: 22,
    rate: (w) => (w.me ? { slot: w.me.slot, score: 0.32 } : null),
    begin(w, r) {
      angle = Math.atan2(r.z, r.x);
      // Over the water the whole shot (it turns 0.06 rad/s for up to 7 s).
      const over = (a: number) => solidAt(r.x + Math.cos(a) * HELI_OUT, r.z + Math.sin(a) * HELI_OUT) > 0;
      if (over(angle) || over(angle + 0.45)) angle += Math.PI;
      from = w.t;
    },
    aim(w, r, out) {
      const a = angle + (w.t - from) * 0.06;
      out.eye.set(r.x + Math.cos(a) * HELI_OUT, HELI_UP, r.z + Math.sin(a) * HELI_OUT);
      out.look.set(r.x + r.vx * 0.2, r.y + 0.5, r.z + r.vz * 0.2);
      out.frame = 30;
      out.follow = 3;
    },
    holds: () => true,
  };
}

export function bayRigs(course: CourseData, env: Environment): Rig[] {
  const sh = course.straightHalf;
  const bw = course.breakwaterRadius;
  const solidAt = solid(course);
  // On the breakwater's flank, facing a straight.
  const flank = (x: number, side: number) => {
    const z = side * bw * 0.55;
    return v(x, 0.22 * Math.sqrt(bw * bw - z * z) - 0.6 + EYE, z);
  };
  const startSide = Math.sign(course.start.z) || -1;
  const rigs: Rig[] = [
    spot("breakwater-start", flank(course.start.x + 20, startSide), solidAt, env),
    spot("breakwater", flank(sh * 0.2, -startSide), solidAt, env),
    // Up by the lighthouse gallery on the breakwater's tip, over the turn.
    spot("lighthouse", v(lighthouse(course).x + 4, 14, 0), solidAt, env),
    // On a camera boat's platform, out past the chevron boards round each turn.
    spot("boat-east", v(sh + course.outerLimit + 16, BOAT_EYE, 6), solidAt, env, true),
    spot("boat-west", v(-(sh + course.outerLimit + 16), BOAT_EYE, -6), solidAt, env, true),
    helicopter(solidAt),
    drone("drone", (x, z, t) => env.ground(x, z, t)),
  ];
  const island = course.land.find((l) => l.kind === "island");
  if (island) {
    // On the island's shore facing the course.
    const toward = Math.sign(-island.az) || 1;
    rigs.push(spot("island", v(island.ax, ISLAND_TOP + EYE, island.az + toward * island.radius * 0.9), solidAt, env));
  }
  const town = course.land.find((l) => l.kind === "town");
  if (town) {
    // On the quay's edge just past each ramp (riders come at it and fly off toward it), or along the back straight.
    const side = Math.sign(town.az) || 1;
    const edge = town.az - side * (town.radius - 1);
    const xs = course.ramps.length > 0 ? course.ramps.map((r) => r.x + Math.sin(r.yaw) * 18) : [sh * 0.4, -sh * 0.4];
    xs.forEach((x, i) => rigs.push(spot(`quay-${i + 1}`, v(x, QUAY_TOP + EYE + 1, edge), solidAt, env)));
  }
  return rigs;
}
