// Jetski stunts in the air (the sim's `jetski::stunts`): the no hander
// (standing on the footwells, arms out wide), the handstand (up over the
// bars, legs to the sky), the superman (stretched out flat behind the bars),
// the nac-nac (a leg kicked out to the left and back) and the can-can (a
// leg kicked out to the right and forward). Each is posed from the same
// anchors as riding (the grips and the footwells) and blended in from the
// riding pose as the rider reaches into it, held on twos.
import * as THREE from "three/webgpu";
import type { JetskiRide } from "./ride.ts";
import type { Pose, Reach, Step } from "./rig.ts";
import { BONE, type Body } from "./skeleton.ts";

export const NO_HANDER = 1;
export const HANDSTAND = 2;
export const SUPERMAN = 3;
export const NAC_NAC = 4;
export const CAN_CAN = 5;

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
const both = <T>(f: (side: number, i: 0 | 1) => T): [T, T] => [f(1, 0), f(-1, 1)];
const rest = (a: Body, b: keyof typeof BONE) => a.rest[BONE[b]]!.clone();

/** Measures a stunt is built from: limb reaches and the torso, and the anchors' middles. */
function measures(a: Body, r: JetskiRide) {
  const arm = a.upperArm + a.foreArm;
  const leg = a.thigh + a.shin;
  const torso = rest(a, "upperarm.L").y - rest(a, "hips").y;
  const bars = r.grips[0].clone().add(r.grips[1]).multiplyScalar(0.5);
  const feet = r.feet[0].clone().add(r.feet[1]).multiplyScalar(0.5);
  const ankle = rest(a, "foot.L").y;
  return { arm, leg, torso, bars, feet, ankle };
}

/** Hands on the grips, elbows toward `bend` (mirrored per side). */
function onGrips(r: JetskiRide, bend: (side: number) => THREE.Vector3, palm: THREE.Vector3): [Reach, Reach] {
  return both((side, i) => ({
    target: r.grips[i].clone(),
    bend: bend(side),
    fingers: v3(side * 0.1, -0.35, 1).normalize(),
    palm,
    curl: 1.25,
  }));
}

/** A stunt's pose, or null for an unknown one. */
export function stuntPose(a: Body, r: JetskiRide, stunt: number): Pose | null {
  const m = measures(a, r);
  switch (stunt) {
    case NO_HANDER: {
      // Standing tall on the footwells, leaning back a little, arms out wide and up.
      const hips = v3(m.feet.x, rest(a, "hips").y - 0.06 * m.leg, m.feet.z - 0.06);
      const legs = both((side, i): Step => ({
        target: r.feet[i].clone().add(v3(0, m.ankle, 0)),
        bend: v3(side * 0.3, 0, 1),
        toes: v3(side * 0.2, 0, 1).normalize(),
        sole: v3(0, -1, 0),
      }));
      const arms = both((side): Reach => {
        const shoulder = rest(a, side > 0 ? "upperarm.L" : "upperarm.R");
        return {
          target: shoulder.add(v3(side * m.arm * 0.9, m.arm * 0.35, -0.04)),
          bend: v3(0, 0.3, -1),
          fingers: v3(side, 0.4, 0).normalize(),
          palm: v3(0, -0.3, 1).normalize(),
          curl: 0.3,
        };
      });
      return {
        hips,
        hipsTurn: euler(-0.08, 0, 0),
        spine: euler(-0.08, 0, 0),
        chest: euler(-0.1, 0, 0),
        neck: euler(0.12, 0, 0),
        head: euler(0.1, 0, 0),
        arms,
        legs,
      };
    }
    case HANDSTAND: {
      // Upside down over the bars on straight arms, back arched, toes to the sky.
      const hips = m.bars.clone().add(v3(0, m.arm * 0.92 + m.torso * 0.95, -0.12));
      const legs = both((side): Step => ({
        target: hips.clone().add(v3(side * 0.09, m.leg * 0.97, -0.22)),
        bend: v3(0, 0, -1),
        toes: v3(0, 1, -0.25).normalize(),
        sole: v3(0, 0.25, 1).normalize(),
      }));
      return {
        hips,
        hipsTurn: euler(Math.PI - 0.12, 0, 0),
        spine: euler(-0.08, 0, 0),
        chest: euler(-0.05, 0, 0),
        // Head back, eyes on the water ahead.
        neck: euler(-0.45, 0, 0),
        head: euler(-0.35, 0, 0),
        arms: onGrips(r, (side) => v3(side, 0, 0.2), v3(0, -1, 0)),
        legs,
      };
    }
    case SUPERMAN: {
      // Flat out behind the bars, chest to the water, legs together and up a little.
      const shoulders = m.bars.clone().add(v3(0, 0.06, -m.arm * 0.92));
      const hips = shoulders.clone().add(v3(0, 0.1, -m.torso));
      const legs = both((side): Step => ({
        target: hips.clone().add(v3(side * 0.1, 0.22, -m.leg * 0.97)),
        bend: v3(0, -1, 0),
        toes: v3(0, 0.15, -1).normalize(),
        sole: v3(0, 1, 0.15).normalize(),
      }));
      return {
        hips,
        hipsTurn: euler(Math.PI / 2 + 0.12, 0, 0),
        spine: euler(-0.08, 0, 0),
        chest: euler(-0.1, 0, 0),
        // Chin up, looking ahead past the bars.
        neck: euler(-0.7, 0, 0),
        head: euler(-0.45, 0, 0),
        arms: onGrips(r, (side) => v3(side * 0.6, -0.6, 0), v3(0, -1, -0.2).normalize()),
        legs,
      };
    }
    case NAC_NAC:
    case CAN_CAN: {
      // One leg kicked straight out, the rider leaning the other way on the bars. Nac-nac: the left leg, out to the
      // left and back. Can-can: the right leg, out to the right and forward.
      const nac = stunt === NAC_NAC;
      const side = nac ? 1 : -1;
      const hips = v3(m.feet.x - side * 0.08, rest(a, "hips").y - 0.2 * m.leg, m.feet.z - 0.12);
      const stays = (i: 0 | 1): Step => ({
        target: r.feet[i].clone().add(v3(0, m.ankle, 0)),
        bend: v3((i === 0 ? 1 : -1) * 0.5, 0, 1),
        toes: v3(0, 0, 1),
        sole: v3(0, -1, 0),
      });
      const out = nac ? v3(side * 0.78, 0.12, -0.6) : v3(side * 0.72, 0.4, 0.5);
      const kicked: Step = {
        target: hips
          .clone()
          .add(v3(side * 0.1, 0, 0))
          .addScaledVector(out.clone().normalize(), m.leg * 0.98),
        bend: nac ? v3(0, -1, 0) : v3(0, 1, 0.3),
        toes: out.clone().normalize(),
        sole: v3(0, -1, 0),
      };
      const legs: [Step, Step] = nac ? [kicked, stays(1)] : [stays(0), kicked];
      return {
        hips,
        hipsTurn: euler(nac ? 0.45 : 0.15, side * 0.2, -side * 0.2),
        spine: euler(0.15, side * 0.1, -side * 0.1),
        chest: euler(0.1, side * 0.05, -side * 0.06),
        // Looking back at the leg, then ahead.
        neck: euler(-0.3, side * 0.3, 0),
        head: euler(-0.2, side * 0.2, 0),
        arms: onGrips(r, (s) => v3(s * 0.9, -0.5, -0.4), v3(0, -1, -0.25).normalize()),
        legs,
      };
    }
    default:
      return null;
  }
}

const lerpV = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);
const lerpDir = (a: THREE.Vector3 | undefined, b: THREE.Vector3 | undefined, t: number) =>
  a && b ? a.clone().lerp(b, t).normalize() : (b ?? a);
const slerp = (a: THREE.Quaternion, b: THREE.Quaternion, t: number) => a.clone().slerp(b, t);

/** A pose `t` of the way from `a` to `b`. */
export function blendPose(a: Pose, b: Pose, t: number): Pose {
  const arm = (x: Reach, y: Reach): Reach => ({
    target: lerpV(x.target, y.target, t),
    bend: lerpV(x.bend, y.bend, t),
    fingers: lerpDir(x.fingers, y.fingers, t),
    palm: lerpDir(x.palm, y.palm, t),
    curl: (x.curl ?? 0.25) + ((y.curl ?? 0.25) - (x.curl ?? 0.25)) * t,
  });
  const leg = (x: Step, y: Step): Step => ({
    target: lerpV(x.target, y.target, t),
    bend: lerpV(x.bend, y.bend, t),
    toes: lerpDir(x.toes, y.toes, t),
    sole: lerpDir(x.sole, y.sole, t),
  });
  return {
    hips: lerpV(a.hips, b.hips, t),
    hipsTurn: slerp(a.hipsTurn, b.hipsTurn, t),
    spine: slerp(a.spine, b.spine, t),
    chest: slerp(a.chest, b.chest, t),
    neck: slerp(a.neck, b.neck, t),
    head: slerp(a.head, b.head, t),
    arms: [arm(a.arms[0], b.arms[0]), arm(a.arms[1], b.arms[1])],
    legs: [leg(a.legs[0], b.legs[0]), leg(a.legs[1], b.legs[1])],
  };
}

/** Anime motion: the stunt's progress is held on twos (12 a second), not tweened. */
const ON_TWOS = 12;

/** Which stunt a rider shows and how far into it, held on twos. */
export class StuntHold {
  private stunt = 0;
  private reach = 0;
  private frame = -1;

  /** The stunt (0 = none) and its eased reach (0-1) to show at time `t` (s), from the sim's. */
  update(stunt: number, reach: number, t: number): { stunt: number; reach: number } {
    const frame = Math.floor(t * ON_TWOS);
    if (stunt === 0 || reach <= 0) {
      this.stunt = 0;
      this.reach = 0;
    } else if (frame !== this.frame || stunt !== this.stunt) {
      this.stunt = stunt;
      this.reach = reach;
    }
    this.frame = frame;
    const x = Math.max(0, Math.min(1, this.reach));
    return { stunt: this.stunt, reach: x * x * (3 - 2 * x) };
  }
}
