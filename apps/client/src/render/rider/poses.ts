// Poses for the rider rig. Standing about (the menus): weight on one leg,
// breathing, arms hanging, a glance now and then; and the character-select
// stance, arms crossed.
import * as THREE from "three/webgpu";
import type { Pose, Reach, Step } from "./rig.ts";
import { BONE, type Body } from "./skeleton.ts";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
const both = <T>(f: (side: number) => T): [T, T] => [f(1), f(-1)];
const rest = (a: Body, b: keyof typeof BONE) => a.rest[BONE[b]]!.clone();

/** Standing, at time `t` (s). */
export function idlePose(a: Body, t: number): Pose {
  const H = a.height;
  const breathe = Math.sin(t * 1.6);
  const shift = Math.sin(t * 0.37);
  const glance = Math.sin(t * 0.23) > 0.8 ? Math.sin(t * 0.23 * 3) * 0.35 : 0;
  // Hips: knees just unlocked, weight shifting from leg to leg.
  const hips = rest(a, "hips").add(v3(shift * 0.025, -0.012 * H, 0));
  const legs = both((side): Step => {
    const ankle = rest(a, side > 0 ? "foot.L" : "foot.R");
    return {
      target: v3(ankle.x * 1.15, ankle.y, ankle.z - 0.01),
      bend: v3(side * 0.15, 0, 1),
      toes: v3(side * 0.14, 0, 1).normalize(),
      sole: v3(0, -1, 0),
    };
  });
  const arms = both((side): Reach => {
    const shoulder = rest(a, side > 0 ? "upperarm.L" : "upperarm.R");
    const len = (a.upperArm + a.foreArm) * 0.97;
    return {
      target: shoulder.add(v3(side * 0.035, -len, 0.03 + Math.sin(t * 0.5) * side * 0.01)),
      bend: v3(side * 0.3, 0, -1),
      fingers: v3(side * 0.08, -1, 0.12).normalize(),
      palm: v3(-side, 0, 0.1).normalize(),
      curl: 0.6,
    };
  });
  return {
    hips,
    hipsTurn: euler(0, shift * 0.04, -shift * 0.035),
    spine: euler(breathe * 0.01, 0, shift * 0.02),
    chest: euler(-breathe * 0.015, -shift * 0.03, shift * 0.02),
    neck: euler(0.02, glance * 0.4, 0),
    head: euler(0.03, glance * 0.6, -shift * 0.02),
    arms,
    legs,
  };
}

/** Arms crossed over the chest, weight on one hip, chin up: the character-select stance, at time `t` (s). */
export function crossedPose(a: Body, t: number): Pose {
  const base = idlePose(a, t);
  const breathe = Math.sin(t * 1.6);
  const chestY = rest(a, "chest").y;
  // The left forearm lies over the right; each hand tucks against the other arm.
  const arms = both((side): Reach => {
    const over = side > 0;
    return {
      target: v3(-side * 0.12, chestY + 0.03 + (over ? 0.03 : -0.005) + breathe * 0.004, over ? 0.215 : 0.185),
      bend: v3(side * 1, -0.55, 0.35),
      fingers: v3(-side * 0.35, over ? -0.2 : 0.25, -1).normalize(),
      palm: v3(0, over ? -1 : 0.2, over ? 0.1 : -1).normalize(),
      curl: 0.9,
    };
  });
  const legs = both((side): Step => {
    const step = base.legs[side > 0 ? 0 : 1];
    const target = step.target.clone().add(v3(side * 0.03, 0, side < 0 ? 0.05 : 0));
    return { ...step, target, toes: v3(side * 0.3, 0, 1).normalize() };
  });
  return {
    ...base,
    hips: base.hips.clone().add(v3(0.03, -0.01, 0)),
    hipsTurn: euler(0, -0.12, -0.05),
    spine: euler(-0.02, 0.06, 0.03),
    chest: euler(-0.04 - breathe * 0.01, 0.04, 0.02),
    neck: euler(-0.05, 0.04, 0),
    head: euler(-0.06, 0.08 + Math.sin(t * 0.3) * 0.03, -0.06),
    arms,
    legs,
  };
}
