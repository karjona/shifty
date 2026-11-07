// The television cameras' common ground: what a camera sees, how it says
// where it points, and what it takes to be one (see broadcast.ts).
import * as THREE from "three/webgpu";
import type { RiderView } from "../render/world.ts";

/** What the cameras see this frame. */
export interface Watch {
  riders: readonly RiderView[];
  /** Your rider, if it is on the course. */
  me: RiderView | undefined;
  /** Seconds (a steady clock), sim time (s, for the water) and the frame's length. */
  t: number;
  simT: number;
  dt: number;
  /** How long (s) each seat's rider has been still (0: moving). */
  still: (slot: number) => number;
  /** The results are up over the middle of the picture. */
  results: boolean;
}

/** Where a camera is and what it frames this frame. */
export interface Aim {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  /** How tall a slice of the world (m) the picture spans at the rider: the zoom follows the distance... */
  frame: number;
  /** ...unless this is set: a fixed field of view (degrees). */
  fov: number | null;
  /** How fast the camera turns after the rider (per second). */
  follow: number;
  /** Horizon tilt (rad), for cameras on the water. */
  roll: number;
}

/** A camera: who it would show, how well, and how. */
export interface Rig {
  readonly name: string;
  /** A shot lasts at least, and at most, this long (s). */
  readonly minShot: number;
  readonly maxShot: number;
  /** Rested this long (s) after a shot before it comes up again. */
  readonly rest?: number;
  /** A new place every time: it may follow itself. */
  readonly repeats?: boolean;
  /** The seat it would show now and how good the shot would be (0-1), or null. */
  rate(w: Watch): { slot: number; score: number } | null;
  /** A shot of `r` begins. */
  begin?(w: Watch, r: RiderView): void;
  /** This frame's camera on `r`. */
  aim(w: Watch, r: RiderView, out: Aim): void;
  /** The shot still shows `r`. */
  holds(w: Watch, r: RiderView): boolean;
}

/**
 * Aims `out` at `r`, `up` m over it, led by its velocity so the operator's
 * lag (`out.follow`) brings the picture onto the rider as it moves.
 */
export function onRider(out: Aim, r: RiderView, up = 0.9): void {
  const lead = 1 / out.follow;
  out.look.set(r.x + r.vx * lead, r.y + up + r.vy * lead, r.z + r.vz * lead);
}

/**
 * Whether the line from `eye` to `at` is clear of what `height` says stands
 * in the way, sampled at least `samples` times along it and every `step` m
 * (not within `skip` m of the eye, where the camera itself stands).
 */
export function clear(
  eye: THREE.Vector3,
  at: THREE.Vector3,
  height: (x: number, z: number) => number,
  samples = 16,
  skip = 3,
  step = 1.5,
): boolean {
  const d = eye.distanceTo(at);
  const n = Math.max(samples, Math.ceil(d / step));
  for (let i = 1; i < n; i++) {
    const k = i / n;
    if (d * k < skip) continue;
    const x = eye.x + (at.x - eye.x) * k;
    const z = eye.z + (at.z - eye.z) * k;
    const y = eye.y + (at.y - eye.y) * k;
    if (height(x, z) > y - 0.2) return false;
  }
  return true;
}

/** A drone behind and beside the rider, low, following its path smoothly. */
export function drone(name: string, ground: (x: number, z: number, t: number) => number): Rig {
  const eye = new THREE.Vector3();
  const to = new THREE.Vector3();
  let heading = 0;
  let side = 1;
  return {
    name,
    minShot: 4,
    maxShot: 6.5,
    rest: 18,
    rate: (w) => (w.me && w.me.speed > 5 ? { slot: w.me.slot, score: 0.3 } : null),
    begin(w, r) {
      heading = Math.atan2(r.vx, r.vz);
      side = Math.sin(w.t * 7.3) > 0 ? 1 : -1;
      eye.set(r.x - Math.sin(heading) * 11, r.y + 3.5, r.z - Math.cos(heading) * 11);
    },
    aim(w, r, out) {
      if (r.speed > 2) {
        const travel = Math.atan2(r.vx, r.vz);
        heading += Math.atan2(Math.sin(travel - heading), Math.cos(travel - heading)) * (1 - Math.exp(-w.dt * 1.5));
      }
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      const x = r.x - fx * 10 - fz * 3.5 * side;
      const z = r.z - fz * 10 + fx * 3.5 * side;
      const y = Math.max(r.y + 3.2, ground(x, z, w.simT) + 2.5);
      eye.lerp(to.set(x, y, z), 1 - Math.exp(-w.dt * 3));
      out.eye.copy(eye);
      out.look.set(r.x + r.vx * 0.3, r.y + 0.8, r.z + r.vz * 0.3);
      out.fov = 46;
      out.follow = 8;
    },
    holds: () => true,
  };
}
