// The rider skeleton every model is skinned to (art/rider/rig.py writes
// the same bones). Model space: feet on y = 0, facing +Z, the rider's left
// toward +X, metres. The rest pose is an A-pose (arms 45° down, palms
// toward the body).
import * as THREE from "three/webgpu";

export const BONES = [
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "clavicle.L",
  "upperarm.L",
  "forearm.L",
  "hand.L",
  "fingers.L",
  "clavicle.R",
  "upperarm.R",
  "forearm.R",
  "hand.R",
  "fingers.R",
  "thigh.L",
  "shin.L",
  "foot.L",
  "toes.L",
  "thigh.R",
  "shin.R",
  "foot.R",
  "toes.R",
] as const;

export type BoneName = (typeof BONES)[number];

/** Each bone's index in BONES. */
export const BONE: Record<BoneName, number> = {
  root: 0,
  hips: 1,
  spine: 2,
  chest: 3,
  neck: 4,
  head: 5,
  "clavicle.L": 6,
  "upperarm.L": 7,
  "forearm.L": 8,
  "hand.L": 9,
  "fingers.L": 10,
  "clavicle.R": 11,
  "upperarm.R": 12,
  "forearm.R": 13,
  "hand.R": 14,
  "fingers.R": 15,
  "thigh.L": 16,
  "shin.L": 17,
  "foot.L": 18,
  "toes.L": 19,
  "thigh.R": 20,
  "shin.R": 21,
  "foot.R": 22,
  "toes.R": 23,
};

const isBone = (s: string): s is BoneName => (BONES as readonly string[]).includes(s);

const PARENT: Record<BoneName, BoneName | null> = {
  root: null,
  hips: "root",
  spine: "hips",
  chest: "spine",
  neck: "chest",
  head: "neck",
  "clavicle.L": "chest",
  "upperarm.L": "clavicle.L",
  "forearm.L": "upperarm.L",
  "hand.L": "forearm.L",
  "fingers.L": "hand.L",
  "clavicle.R": "chest",
  "upperarm.R": "clavicle.R",
  "forearm.R": "upperarm.R",
  "hand.R": "forearm.R",
  "fingers.R": "hand.R",
  "thigh.L": "hips",
  "shin.L": "thigh.L",
  "foot.L": "shin.L",
  "toes.L": "foot.L",
  "thigh.R": "hips",
  "shin.R": "thigh.R",
  "foot.R": "shin.R",
  "toes.R": "foot.R",
};

export const boneParent = (b: BoneName): BoneName | null => PARENT[b];

/** The bone a glTF node name stands for (three.js drops the dots, so the art writes underscores). */
export function boneOf(nodeName: string): BoneName | undefined {
  const name = nodeName.replace(/_([LR])$/, ".$1");
  return isBone(name) ? name : undefined;
}

/** A body's rest skeleton and the measures poses are built from. */
export interface Body {
  /** Rest positions of the bones, in BONES order. */
  rest: THREE.Vector3[];
  /** Standing height (m). */
  height: number;
  upperArm: number;
  foreArm: number;
  thigh: number;
  shin: number;
}

export function bodyFromRest(rest: THREE.Vector3[], height: number): Body {
  const d = (a: BoneName, b: BoneName) => rest[BONE[a]]!.distanceTo(rest[BONE[b]]!);
  return {
    rest,
    height,
    upperArm: d("upperarm.L", "forearm.L"),
    foreArm: d("forearm.L", "hand.L"),
    thigh: d("thigh.L", "shin.L"),
    shin: d("shin.L", "foot.L"),
  };
}
