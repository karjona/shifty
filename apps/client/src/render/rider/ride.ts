// Poses for riding. On a jetski: straddling the seat with the feet in the
// footwells and the hands on the bars, knees soaking up the swell, the body
// leaning into turns and rocking with the throttle; floating on the back
// beside the ski after a bail. On a snowboard: regular stance (left foot
// forward, chest to the toe edge), shoulders open down the run, knees that
// load and soak up landings, arms out for balance in the air, a hand on the
// board for grabs.
import * as THREE from "three/webgpu";
import type { Pose, Reach, Step } from "./rig.ts";
import { BONE, type Body } from "./skeleton.ts";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
const both = <T>(f: (side: number, i: 0 | 1) => T): [T, T] => [f(1, 0), f(-1, 1)];
const rest = (a: Body, b: keyof typeof BONE) => a.rest[BONE[b]]!.clone();

/** What a jetski rider is doing, for their pose. Points are in the figure's model space (left first). */
export interface JetskiRide {
  /** Where the soles stand, in the footwells. */
  feet: [THREE.Vector3, THREE.Vector3];
  /** Wrists, on the grips. */
  grips: [THREE.Vector3, THREE.Vector3];
  /** Knee bend beyond riding height: up to about 0.4 deep, a little negative stretches the legs. */
  crouch: number;
  /** Lean fore (+) and aft (-), rad. */
  lean: number;
  /** Steering, -1 (left) to 1 (right). */
  steer: number;
}

/** Riding height: how far the hips sit below standing, as a fraction of the leg. */
const RIDE_DROP = 0.36;
/** The torso's tip toward the bars when riding, and how much more crouching and leaning add (rad). */
const TIP = 0.75;
const TIP_PER_CROUCH = 0.7;
const TIP_PER_LEAN = 0.8;

export function jetskiPose(a: Body, r: JetskiRide): Pose {
  const leg = a.thigh + a.shin;
  const hipsRest = rest(a, "hips");
  const feetZ = (r.feet[0].z + r.feet[1].z) / 2;
  const drop = (RIDE_DROP + r.crouch) * leg;
  // Hips over the seat, a little behind the feet; further back crouched or thrown back.
  const hips = v3(-r.steer * 0.05, hipsRest.y - drop, feetZ - 0.16 - r.crouch * 0.15 + r.lean * 0.18);
  const tip = TIP + r.crouch * TIP_PER_CROUCH + r.lean * TIP_PER_LEAN;
  const ankle = rest(a, "foot.L").y;
  const legs = both((side, i): Step => ({
    target: r.feet[i].clone().add(v3(0, ankle, 0)),
    bend: v3(side * 0.55, 0, 1),
    toes: v3(side * 0.2, 0, 1).normalize(),
    sole: v3(0, -1, 0),
  }));
  const arms = both((side, i): Reach => ({
    target: r.grips[i].clone(),
    // Elbows out and down, like holding a pair of bars.
    bend: v3(side * 0.9, -0.5, -0.4),
    fingers: v3(side * 0.1, -0.35, 1).normalize(),
    palm: v3(0, -1, -0.25).normalize(),
    curl: 1.25,
  }));
  return {
    hips,
    // Into the turn: the hips drop to the inside and the shoulders follow.
    hipsTurn: euler(tip * 0.4, -r.steer * 0.12, r.steer * 0.12),
    spine: euler(tip * 0.35, -r.steer * 0.05, r.steer * 0.08),
    chest: euler(tip * 0.25, 0, r.steer * 0.05),
    // Eyes up ahead, whatever the back does, glancing into the turn.
    neck: euler(-tip * 0.45, -r.steer * 0.15, -r.steer * 0.08),
    head: euler(-tip * 0.35, -r.steer * 0.25, -r.steer * 0.1),
    arms,
    legs,
  };
}

/** Floating on the back after a bail, arms out, at time `t` (s). The caller lays the figure down. */
export function floatPose(a: Body, t: number): Pose {
  const bob = Math.sin(t * 2.1);
  const hips = rest(a, "hips").add(v3(0, -0.04 * a.height, 0));
  const legs = both((side): Step => {
    const ankle = rest(a, side > 0 ? "foot.L" : "foot.R");
    return {
      target: v3(ankle.x * 2.2, ankle.y + 0.05, 0.12 + side * bob * 0.02),
      bend: v3(side * 0.3, 0, 1),
      toes: v3(side * 0.35, 0.3, 1).normalize(),
      sole: v3(0, -1, 0.3).normalize(),
    };
  });
  const arms = both((side): Reach => {
    const shoulder = rest(a, side > 0 ? "upperarm.L" : "upperarm.R");
    const len = (a.upperArm + a.foreArm) * 0.95;
    // Out wide, sculling a little.
    return {
      target: shoulder.add(v3(side * len * 0.85, len * 0.3, -0.05 + Math.sin(t * 2.1 + side) * 0.06)),
      bend: v3(0, 0, -1),
      fingers: v3(side, 0.3, 0).normalize(),
      palm: v3(0, 0, -1),
      curl: 0.4,
    };
  });
  return {
    hips,
    hipsTurn: euler(0, 0, 0),
    spine: euler(-0.05, 0, 0),
    chest: euler(-0.05, 0, 0),
    // Head up out of the water, looking back at the ski.
    neck: euler(0.35, 0.2, 0),
    head: euler(0.2, 0.3, 0),
    arms,
    legs,
  };
}

/** What a snowboarder is doing, for their pose. */
export interface BoardRide {
  /** Feet either side of the board's middle (m), and the deck's height under the soles (m). */
  stance: number;
  deck: number;
  /** Knee bend, 0-0.85. */
  crouch: number;
  /** Lean toward the nose (+, tucked) or back (-, sitting into a skid). */
  lean: number;
  /** Arms from riding (0) to out wide for balance (1). */
  spread: number;
  /** The grab held (0 = none). */
  grab: number;
  /** Windmilling arms after a sketchy landing, -1 to 1. */
  windmill: number;
  /** The board's length (m), for nose and tail grabs. */
  length: number;
  /** How far the board is pulled up under the rider for a grab (m). */
  lift: number;
}

const GRAB_INDY = 1;
const GRAB_NOSE = 2;
const GRAB_TAIL = 3;
const GRAB_MELON = 4;
const GRAB_METHOD = 5;

/** Where a hand goes for a grab (m, from the board's middle), if this hand (+1 front, -1 back) does the grab. */
function grabTarget(grab: number, side: number, length: number): THREE.Vector3 | null {
  const front = side > 0;
  const edge = 0.16;
  switch (grab) {
    case GRAB_INDY:
      return front ? null : v3(-0.05, 0.12, edge);
    case GRAB_NOSE:
      return front ? v3(length / 2 - 0.12, 0.12, 0) : null;
    case GRAB_TAIL:
      return front ? null : v3(-length / 2 + 0.12, 0.12, 0);
    case GRAB_MELON:
    case GRAB_METHOD:
      return front ? v3(0.05, 0.14, -edge) : null;
    default:
      return null;
  }
}

/**
 * A snowboarder in the figure's model space: facing the toe edge (+Z), the
 * nose toward their left (+X). `scale` is the figure's size against the
 * art: the board is the same for everyone, so its points are scaled in.
 */
export function snowboardPose(a: Body, scale: number, r: BoardRide): Pose {
  const deck = (r.deck + r.lift) / scale;
  const ankle = rest(a, "foot.L").y;
  // Standing with soft knees, lower as they bend; a grab pulls the board up to the hand.
  const hipY = r.deck / scale + rest(a, "hips").y - 0.18 - r.crouch * 0.42;
  // Hips sit back over the heels a little, more when crouched or sitting back.
  const hipZ = -0.06 - r.crouch * 0.1 - Math.max(0, -r.lean) * 0.15;
  // The upper body tips toward the toes as the knees bend, upright in the air, further forward tucked.
  const tilt = 0.25 + r.crouch * 0.55 + r.lean * 0.5 + (r.grab ? 0.4 : 0);
  const legs = both((side): Step => ({
    target: v3((side * r.stance) / scale, deck + ankle, 0.02 / scale),
    bend: v3(0, 0, 1),
    // Duck stance: both toes turned out a little.
    toes: v3(side * 0.3, 0, 1).normalize(),
    sole: v3(0, -1, 0),
  }));
  const arms = both((side): Reach => {
    // Riding: front hand toward the nose, back hand low by the hip. In the air: out wide for balance.
    const ride = v3(side * 0.45, hipY - 0.05 + (side > 0 ? 0.15 : 0), 0.22);
    const wide = v3(side * 0.85, 0.42 + hipY * 0.6 + side * r.windmill * 0.35, 0.05 + r.windmill * 0.2);
    const grab = grabTarget(r.grab, side, r.length);
    return {
      target: grab ? grab.setY(grab.y + r.lift).divideScalar(scale) : ride.lerp(wide, r.spread),
      bend: v3(side * 0.3, -0.4, -1),
      curl: grab ? 1.3 : 0.6,
    };
  });
  return {
    hips: v3(0, hipY, hipZ),
    // Shoulders open toward the nose (down the run), so from behind you see the rider's back.
    hipsTurn: euler(tilt * 0.25, 0.35, 0),
    spine: euler(tilt * 0.4, 0.3, 0),
    chest: euler(tilt * 0.35, 0.2, 0),
    // Looking down the run, past the nose.
    neck: euler(-tilt * 0.3, 0.15, 0),
    head: euler(-tilt * 0.3, 0.2, 0),
    arms,
    legs,
  };
}
