// Poses for the podium: the winner with both fists up, pumping; the others
// clapping or waving to the crowd. Built on the standing idle (poses.ts),
// in the rig's model space (feet on y = 0, facing +Z, the rider's left
// toward +X).
import * as THREE from "three/webgpu";
import type { Pose, Reach } from "./rig.ts";
import { idlePose } from "./poses.ts";
import { BONE, type Body } from "./skeleton.ts";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
const both = <T>(f: (side: number) => T): [T, T] => [f(1), f(-1)];
const rest = (a: Body, b: keyof typeof BONE) => a.rest[BONE[b]]!.clone();
const reach = (a: Body) => a.upperArm + a.foreArm;

/** Both fists up in a V, pumping, chest out and chin up, at time `t` (s). */
export function championPose(a: Body, t: number): Pose {
  const base = idlePose(a, t);
  // Short pumps of the fists, a beat apart.
  const pump = Math.max(0, Math.sin(t * 5.2)) ** 2;
  const arms = both((side): Reach => {
    const shoulder = rest(a, side > 0 ? "upperarm.L" : "upperarm.R");
    const len = reach(a);
    return {
      target: shoulder.add(v3(side * len * (0.42 - pump * 0.06), len * (0.84 + pump * 0.1), 0.05)),
      bend: v3(side, -0.2, -0.5),
      fingers: v3(side * 0.2, 1, 0.15).normalize(),
      palm: v3(0, 0.1, 1).normalize(),
      curl: 1.5,
    };
  });
  return {
    ...base,
    hips: base.hips.clone().add(v3(0, pump * 0.012, 0)),
    spine: euler(-0.04, 0, 0),
    chest: euler(-0.1 - pump * 0.03, 0, 0),
    neck: euler(-0.06, 0, 0),
    head: euler(-0.16 - pump * 0.04, Math.sin(t * 0.7) * 0.12, 0),
    arms,
  };
}

/** Clapping in front of the chest, at time `t` (s). */
export function clapPose(a: Body, t: number): Pose {
  const base = idlePose(a, t);
  const chestY = rest(a, "chest").y;
  // A clap a little over twice a second: the hands meet for a moment.
  const together = (t * 2.4) % 1 < 0.28;
  const arms = both((side): Reach => ({
    target: v3(side * (together ? 0.045 : 0.15), chestY - 0.02 + (together ? 0.02 : 0), 0.3),
    bend: v3(side, -0.7, -0.2),
    fingers: v3(-side * 0.3, 0.6, 1).normalize(),
    palm: v3(-side, 0, 0.15).normalize(),
    curl: 0.15,
  }));
  return { ...base, chest: euler(-0.04, 0, 0), head: euler(-0.06, Math.sin(t * 0.5) * 0.1, 0), arms };
}

/** Waving with the right hand held high, at time `t` (s). */
export function wavePose(a: Body, t: number): Pose {
  const base = idlePose(a, t);
  const sway = Math.sin(t * 6.5);
  const len = reach(a);
  const shoulder = rest(a, "upperarm.R");
  const wave: Reach = {
    target: shoulder.add(v3(-len * (0.42 + sway * 0.1), len * 0.66, 0.12)),
    bend: v3(-1, -0.4, -0.1),
    fingers: v3(-0.25 - sway * 0.35, 1, 0.1).normalize(),
    palm: v3(0, 0, 1),
    curl: 0.1,
  };
  return {
    ...base,
    chest: euler(-0.03, 0.06, 0),
    head: euler(-0.08, -0.12, 0.05),
    arms: [base.arms[0], wave],
  };
}
