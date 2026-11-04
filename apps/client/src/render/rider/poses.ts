// Poses for the rider rig. Standing about (the menus): weight on one leg,
// breathing, arms hanging, a glance now and then.
import * as THREE from "three/webgpu";
import { type Anatomy, BONE } from "./anatomy.ts";
import type { Pose } from "./rig.ts";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));

/** Standing, at time `t` (s). */
export function idlePose(a: Anatomy, t: number): Pose {
  const rest = (b: keyof typeof BONE) => a.rest[BONE[b]]!.clone();
  const H = a.height;
  const breathe = Math.sin(t * 1.6);
  const shift = Math.sin(t * 0.37);
  const glance = Math.sin(t * 0.23) > 0.8 ? Math.sin(t * 0.23 * 3) * 0.35 : 0;
  // Hips: knees just unlocked, weight shifting from leg to leg.
  const hips = rest("hips").add(v3(shift * 0.025, -0.012 * H, 0));
  const feet = [1, -1].map((side) => {
    const ankle = rest(side > 0 ? "foot.L" : "foot.R");
    return {
      target: v3(ankle.x * 1.15, ankle.y, ankle.z - 0.01),
      bend: v3(side * 0.15, 0, 1),
      toes: v3(side * 0.14, 0, 1).normalize(),
      sole: v3(0, -1, 0),
    };
  }) as Pose["legs"];
  const arms = [1, -1].map((side) => {
    const shoulder = rest(side > 0 ? "upperarm.L" : "upperarm.R");
    const len = (a.upperArm + a.foreArm) * 0.97;
    const wrist = shoulder.add(v3(side * 0.035, -len, 0.03 + Math.sin(t * 0.5) * side * 0.01));
    return {
      target: wrist,
      bend: v3(side * 0.3, 0, -1),
      fingers: v3(side * 0.08, -1, 0.12).normalize(),
      palm: v3(-side, 0, 0.1).normalize(),
      curl: 0.6,
    };
  }) as Pose["arms"];
  return {
    hips,
    hipsTurn: euler(0, shift * 0.04, -shift * 0.035),
    spine: euler(breathe * 0.01, 0, shift * 0.02),
    chest: euler(-breathe * 0.015, -shift * 0.03, shift * 0.02),
    neck: euler(0.02, glance * 0.4, 0),
    head: euler(0.03, glance * 0.6, -shift * 0.02),
    arms,
    legs: feet,
  };
}
