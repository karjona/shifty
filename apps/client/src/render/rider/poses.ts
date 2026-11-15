// Poses for the rider rig, standing about (the menus): at ease with the
// weight on one leg, shifting to the other now and then, breathing, looking
// about; a hand on the hip; and the character-select stance, arms crossed.
import * as THREE from "three/webgpu";
import type { Pose, Reach, Step } from "./rig.ts";
import { BONE, type Body } from "./skeleton.ts";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
const both = <T>(f: (side: number) => T): [T, T] => [f(1), f(-1)];
const rest = (a: Body, b: keyof typeof BONE) => a.rest[BONE[b]]!.clone();

/** Which leg carries the weight at time `t` (s): 1 the left, -1 the right, held a while and then shifted across. */
function weightAt(t: number): number {
  return Math.tanh(2.4 * Math.sin(t * 0.21));
}

/** Where the head looks at time `t` (s): a slow wander (yaw and pitch, rad). */
function gazeAt(t: number): { yaw: number; pitch: number } {
  return {
    yaw: 0.16 * Math.sin(t * 0.31) + 0.09 * Math.sin(t * 0.13 + 1.3),
    pitch: 0.03 * Math.sin(t * 0.23 + 0.5),
  };
}

/** How far the eyes are closed at time `t` (s), 0-1: a blink every few seconds, now and then two in a row. */
export function blinkAt(t: number): number {
  const EVERY = 3.7;
  const cell = Math.floor(t / EVERY);
  const r = hash(cell);
  const at = cell * EVERY + 0.4 + r * (EVERY - 1.2);
  const twice = hash(cell + 0.5) < 0.22 ? blinkShape(t - at - 0.34) : 0;
  return Math.max(blinkShape(t - at), twice);
}

/** A blink `dt` seconds in: down fast, shut a moment, up a little slower. */
function blinkShape(dt: number): number {
  if (dt < 0 || dt > 0.24) return 0;
  if (dt < 0.07) return dt / 0.07;
  if (dt < 0.12) return 1;
  return 1 - (dt - 0.12) / 0.12;
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** An arm hanging at ease from its shoulder: `ease` (0-1) how far it swings forward and bends. */
function hanging(a: Body, side: number, ease: number, t: number): Reach {
  const len = a.upperArm + a.foreArm;
  const sway = Math.sin(t * 0.5 + side) * 0.006;
  return {
    target: v3(side * (0.02 + 0.02 * ease), -len * (0.945 - 0.035 * ease), 0.07 + 0.07 * ease + sway),
    fromShoulder: true,
    bend: v3(side * 0.35, 0, -1),
    fingers: v3(side * 0.04, -1, 0.22 + 0.15 * ease).normalize(),
    palm: v3(-side, 0, -0.18).normalize(),
    curl: 0.5 + 0.2 * ease,
  };
}

/** Standing at ease, at time `t` (s): contrapposto, the weight on one leg. */
export function idlePose(a: Body, t: number): Pose {
  const k = a.height / 1.78;
  const w = weightAt(t);
  const mid = 1 - Math.abs(w);
  const breathe = Math.sin(t * 1.5);
  const gaze = gazeAt(t);
  // The hips ride over the leg that carries them, a little lower through the shift.
  const hips = rest(a, "hips").add(v3(w * 0.05 * k, -(0.016 + 0.014 * mid) * k, 0.004 * k));
  const legs = both((side): Step => {
    const free = Math.max(0, -side * w);
    const ankle = rest(a, side > 0 ? "foot.L" : "foot.R");
    return {
      // The free leg stands out and ahead, its knee easy and its heel light.
      target: v3(
        ankle.x + side * (0.05 * free - 0.012) * k,
        ankle.y + 0.012 * free * k,
        ankle.z + (0.08 * free - 0.01) * k,
      ),
      bend: v3(side * (0.12 + 0.3 * free), 0, 1),
      toes: v3(side * (0.18 + 0.28 * free), -0.05 * free, 1).normalize(),
      sole: v3(0, -1, -0.05 * free).normalize(),
    };
  });
  const arms = both((side) => hanging(a, side, Math.max(0, -side * w) * 0.8 + 0.1, t));
  return {
    hips,
    // The hip of the free leg drops and comes forward; the shoulders tip the other way.
    hipsTurn: euler(0, w * 0.07, w * 0.065),
    spine: euler(0.01 + breathe * 0.008, -w * 0.03, -w * 0.05),
    chest: euler(-0.02 - breathe * 0.014, -w * 0.035, -w * 0.045),
    neck: euler(0.03 + gaze.pitch, gaze.yaw * 0.45, w * 0.012),
    head: euler(0.01, gaze.yaw * 0.55, w * 0.022),
    arms,
    legs,
    face: { blink: blinkAt(t) },
  };
}

/** At ease with a hand on the hip (the side that carries the weight), at time `t` (s). */
export function hipPose(a: Body, t: number): Pose {
  const k = a.height / 1.78;
  const base = idlePose(a, t);
  // The weight stays on one leg here: the stance holds, it only breathes.
  const still = idlePose(a, 7.4);
  const breathe = Math.sin(t * 1.5);
  const gaze = gazeAt(t);
  const hip = still.hips;
  const hand: Reach = {
    target: v3(hip.x + 0.19 * k, hip.y + 0.075 * k, hip.z + 0.035 * k),
    bend: v3(1, -0.1, -0.75),
    fingers: v3(-0.25, -0.55, 0.8).normalize(),
    palm: v3(-0.9, -0.1, -0.4).normalize(),
    curl: 0.45,
  };
  return {
    ...still,
    spine: euler(0.01 + breathe * 0.008, -0.03, -0.05),
    chest: euler(-0.03 - breathe * 0.014, -0.06, -0.045),
    neck: euler(0.03 + gaze.pitch, gaze.yaw * 0.45 - 0.05, 0.012),
    head: euler(-0.02, gaze.yaw * 0.55 - 0.06, 0.03),
    arms: [hand, hanging(a, -1, 0.5, t)],
    legs: still.legs,
    hips: hip.clone().add(v3(0, breathe * 0.0015, 0)),
    hipsTurn: base.hipsTurn.clone().slerp(still.hipsTurn, 1),
    face: base.face,
  };
}

/** Arms crossed over the chest, weight on one hip, chin up: the character-select stance, at time `t` (s). */
export function crossedPose(a: Body, t: number): Pose {
  const k = a.height / 1.78;
  const still = idlePose(a, 7.4);
  const breathe = Math.sin(t * 1.5);
  const gaze = gazeAt(t);
  const chestY = rest(a, "chest").y;
  // The left forearm lies over the right; each hand tucks against the other arm.
  const arms = both((side): Reach => {
    const over = side > 0;
    return {
      target: v3(
        -side * 0.115 * k + still.hips.x * 0.6,
        chestY + (0.035 + (over ? 0.03 : -0.012)) * k + breathe * 0.004,
        (over ? 0.275 : 0.24) * k,
      ),
      bend: v3(side * 1, -0.75, 0.3),
      fingers: v3(-side * 0.55, over ? -0.15 : 0.3, -0.8).normalize(),
      palm: v3(0, over ? -1 : 0.2, over ? 0.1 : -1).normalize(),
      curl: 0.9,
    };
  });
  return {
    ...still,
    spine: euler(-0.02 + breathe * 0.006, 0.05, -0.05),
    chest: euler(-0.06 - breathe * 0.012, 0.05, -0.04),
    // The head cocked and turned a little: confident.
    neck: euler(0.02, 0.06 + gaze.yaw * 0.25, 0.02),
    head: euler(0.0, 0.12 + gaze.yaw * 0.3, 0.07),
    arms,
    face: { blink: blinkAt(t) },
  };
}
