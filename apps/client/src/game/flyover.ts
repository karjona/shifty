// The intro's camera: a few sweeping shots over the course, keyed to the
// intro's sim time so every screen shows the same thing at the same moment,
// then down to the grid and into the chase camera behind your rider. While
// the race waits for every screen, the opening shot holds, drifting.
import * as THREE from "three/webgpu";
import type { RunPoint } from "../render/mountain.ts";
import type { CameraShot, Environment } from "../render/world.ts";
import type { CourseInfo } from "../wasm-json.ts";

/** A camera pose: where it is, what it looks at, its field of view (degrees). */
interface Pose {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

/** One shot: `seconds` long (a share of the intro), its pose `at` 0-1 through it. */
interface Shot {
  seconds: number;
  at(u: number, pose: Pose): void;
}

/** The last shot hands over to the chase camera over this long (s). */
const HANDOVER = 1.3;
/** The camera keeps at least this high above the ground or the water (m). */
const CLEARANCE = 1.5;

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
/** A move that starts and ends gently but keeps going in between. */
const glide = (u: number) => 0.4 * u + 0.6 * smooth(u);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A straight move from one pose to another. */
function dolly(seconds: number, from: Pose, to: Pose): Shot {
  return {
    seconds,
    at(u, pose) {
      const k = glide(u);
      pose.eye.copy(from.eye).lerp(to.eye, k);
      pose.look.copy(from.look).lerp(to.look, k);
      pose.fov = lerp(from.fov, to.fov, k);
    },
  };
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Where the riders line up, and which way they face. */
interface Grid {
  centre: THREE.Vector3;
  yaw: number;
}

/**
 * Round the grid from in front of it (angle 0, along the riders' heading) to
 * behind and above it (π), coming closer, looking at the riders.
 */
function round(seconds: number, grid: Grid, ground: (x: number, z: number) => number, chaseFov: number): Shot {
  const fx = Math.sin(grid.yaw);
  const fz = Math.cos(grid.yaw);
  return {
    seconds,
    at(u, pose) {
      const k = glide(u);
      const a = lerp(0.45, Math.PI, k);
      const r = lerp(24, 16, k);
      // Forward, and the riders' right (-fz, fx), scaled round the circle.
      const x = grid.centre.x + (fx * Math.cos(a) - fz * Math.sin(a)) * r;
      const z = grid.centre.z + (fz * Math.cos(a) + fx * Math.sin(a)) * r;
      // Rising behind the grid, so the way down into the chase camera passes over the riders.
      const y = Math.max(grid.centre.y + lerp(3.5, 9, k), ground(x, z) + CLEARANCE);
      pose.eye.set(x, y, z);
      pose.look.set(grid.centre.x + fx * 4 * k, grid.centre.y + 1, grid.centre.z + fz * 4 * k);
      pose.fov = lerp(48, chaseFov, k);
    },
  };
}

/** The summer bay: the whole bay from the sea, the island, the town quay, the grid. */
function bayShots(course: Extract<CourseInfo, { sport: "jetski" }>["bay"], env: Environment): Shot[] {
  const s = course.start;
  // The grid: two rows of four, 10 and 18 m behind the start line.
  const back = 14;
  const grid: Grid = {
    centre: v(s.x - Math.sin(s.yaw) * back, 0.6, s.z - Math.cos(s.yaw) * back),
    yaw: s.yaw,
  };
  // The island, past the first straight; the back straight runs along the quay.
  const island = course.land.find((l) => l.kind === "island") ?? { ax: 80, az: -63 };
  const r = course.radius;
  return [
    dolly(
      2.0,
      { eye: v(-260, 36, -170), look: v(-40, 2, 30), fov: 46 },
      { eye: v(-120, 28, -200), look: v(40, 2, 40), fov: 46 },
    ),
    dolly(
      1.5,
      { eye: v(island.ax - 56, 3.5, -r + 8), look: v(island.ax + 10, 3, island.az - 20), fov: 50 },
      { eye: v(island.ax - 26, 3, -r + 6), look: v(island.ax + 20, 3, island.az - 40), fov: 50 },
    ),
    dolly(
      1.5,
      { eye: v(-150, 10, r - 16), look: v(-60, 2, r + 18), fov: 52 },
      { eye: v(-80, 8, r - 18), look: v(10, 2, r + 20), fov: 52 },
    ),
    round(2.0, grid, (x, z) => env.ground(x, z, 0), env.camera.fov),
  ];
}

/**
 * The cape: the whole headland from the open sea with the sierra behind,
 * low through the arch, weaving down past the stacks, then the grid off
 * the beach.
 */
function capeShots(course: Extract<CourseInfo, { sport: "jetski" }>["bay"], env: Environment): Shot[] {
  const s = course.start;
  const back = 14;
  const grid: Grid = {
    centre: v(s.x - Math.sin(s.yaw) * back, 0.6, s.z - Math.cos(s.yaw) * back),
    yaw: s.yaw,
  };
  /** A point `at` m round the centre line, `side` m to its right, `up` m over the water. */
  const on = (at: number, up: number, side = 0) => {
    const step = course.path.length > 1 ? course.path[1]!.s : 2;
    const n = course.path.length;
    const p = course.path[((Math.round(at / step) % n) + n) % n] ?? course.path[0]!;
    return v(p.x - Math.cos(p.yaw) * side, up, p.z + Math.sin(p.yaw) * side);
  };
  const legs = course.land.filter((l) => l.kind === "arch");
  const archX = legs.length > 0 ? legs.reduce((sum, l) => sum + l.ax + l.bx, 0) / (legs.length * 2) : 0;
  // Where the line passes under the arch, and where it enters the stacks.
  const arch = course.path.reduce((best, p) =>
    Math.abs(p.x - archX) < Math.abs(best.x - archX) && p.z < 0 ? p : best,
  );
  const stacks = course.length * 0.71;
  return [
    dolly(
      2.2,
      { eye: v(-60, 75, 430), look: v(-10, 12, 0), fov: 44 },
      { eye: v(40, 58, 400), look: v(0, 10, -20), fov: 44 },
    ),
    dolly(
      1.6,
      { eye: on(arch.s - 85, 4.5, 4), look: on(arch.s + 10, 7), fov: 52 },
      { eye: on(arch.s - 45, 3.6, 3), look: on(arch.s + 40, 6), fov: 52 },
    ),
    dolly(
      1.6,
      { eye: on(stacks - 40, 9, -6), look: on(stacks + 40, 5), fov: 50 },
      { eye: on(stacks - 5, 6, -4), look: on(stacks + 75, 4), fov: 50 },
    ),
    round(2.0, grid, (x, z) => env.ground(x, z, 0), env.camera.fov),
  ];
}

/** The centre line of a run at `s` (from its points every few metres; straight on behind the top). */
function runAt(path: RunPoint[], s: number): RunPoint {
  const first = path[0]!;
  if (s < first.s) {
    const back = first.s - s;
    return { ...first, s, x: first.x - Math.sin(first.yaw) * back, z: first.z - Math.cos(first.yaw) * back };
  }
  const step = path.length > 1 ? path[1]!.s - first.s : 1;
  const i = Math.min(path.length - 2, Math.max(0, Math.floor((s - first.s) / step)));
  const a = path[i]!;
  const b = path[i + 1] ?? a;
  const t = Math.min(1, Math.max(0, (s - a.s) / Math.max(1e-6, b.s - a.s)));
  return { ...a, s, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), yaw: lerp(a.yaw, b.yaw, t) };
}

/** The winter mountain: the start hut and the run below it, the chairlift, the gully, the grid. */
function mountainShots(run: Extract<CourseInfo, { sport: "snow" }>["run"], env: Environment): Shot[] {
  const ground = (x: number, z: number) => env.ground(x, z, 0);
  /** A point `offset` m right of the run's centre line at `s`, `up` m above the snow. */
  const on = (s: number, offset: number, up: number) => {
    const p = runAt(run.path, s);
    const x = p.x + Math.cos(p.yaw) * -offset;
    const z = p.z + Math.sin(p.yaw) * offset;
    return new THREE.Vector3(x, ground(x, z) + up, z);
  };
  const start = runAt(run.path, run.startS - 8);
  const grid: Grid = { centre: new THREE.Vector3(start.x, start.y + 0.4, start.z), yaw: start.yaw };
  // The gully winds down from here.
  const gully = 1150;
  return [
    dolly(
      2.0,
      { eye: on(-34, -20, 7), look: on(60, 6, 0), fov: 50 },
      { eye: on(-22, -16, 24), look: on(200, 4, 0), fov: 50 },
    ),
    dolly(
      1.5,
      { eye: on(540, -34, 16), look: on(660, 6, 0), fov: 50 },
      { eye: on(600, -30, 13), look: on(720, 4, 0), fov: 50 },
    ),
    dolly(
      1.5,
      { eye: on(gully, -8, 22), look: on(gully + 90, 4, 0), fov: 50 },
      { eye: on(gully + 45, -6, 18), look: on(gully + 140, 4, 0), fov: 50 },
    ),
    round(2.0, grid, ground, env.camera.fov),
  ];
}

export class Flyover {
  private shots: Shot[];
  private pose: Pose = { eye: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };
  private shot: CameraShot = { eye: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50, chase: 0 };

  constructor(course: CourseInfo, env: Environment) {
    if (course.sport === "snow") this.shots = mountainShots(course.run, env);
    else if (course.bay.place === "cape") this.shots = capeShots(course.bay, env);
    else this.shots = bayShots(course.bay, env);
  }

  /** Seconds the shots last, before they are fitted to the intro. */
  private get length(): number {
    return this.shots.reduce((sum, s) => sum + s.seconds, 0);
  }

  /** The camera `t` seconds into an intro `seconds` long (it ends behind your rider). */
  intro(t: number, seconds: number): CameraShot {
    const scale = seconds / this.length;
    const shots = this.shots;
    let from = 0;
    let i = 0;
    while (i < shots.length - 1 && t >= from + shots[i]!.seconds * scale) {
      from += shots[i]!.seconds * scale;
      i++;
    }
    const shot = shots[i]!;
    const last = i === shots.length - 1;
    shot.at(Math.min(1, Math.max(0, (t - from) / (shot.seconds * scale))), this.pose);
    return this.out(last ? smooth((t - (seconds - HANDOVER)) / HANDOVER) : 0);
  }

  /** The opening shot held while the race waits, drifting slowly (`t`: any clock, seconds). */
  waiting(t: number): CameraShot {
    this.shots[0]!.at(0, this.pose);
    this.pose.eye.x += Math.sin(t * 0.21) * 6;
    this.pose.eye.y += Math.sin(t * 0.13) * 2;
    this.pose.eye.z += Math.cos(t * 0.17) * 4;
    return this.out(0);
  }

  private out(chase: number): CameraShot {
    this.shot.eye.copy(this.pose.eye);
    this.shot.look.copy(this.pose.look);
    this.shot.fov = this.pose.fov;
    this.shot.chase = chase;
    return this.shot;
  }
}
