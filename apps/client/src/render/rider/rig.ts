// The rider's skeleton and how a pose drives it: the hips and spine are set
// directly, arms and legs reach for targets (two-bone IK, elbows and knees
// bent toward a hint), hands and feet turn to an orientation.
import * as THREE from "three/webgpu";
import { type Anatomy, BONE, BONES, type BoneName, boneParent } from "./anatomy.ts";

/** An arm reaching for a point (wrist), elbow toward `bend`; the hand turned so the fingers and palm point along `fingers` and `palm`. */
export interface Reach {
  target: THREE.Vector3;
  bend: THREE.Vector3;
  fingers?: THREE.Vector3;
  palm?: THREE.Vector3;
  /** Fingers curled (rad): a grip. */
  curl?: number;
}

/** A leg reaching for a point (ankle), knee toward `bend`; the foot pointing along `toes` with its sole facing `sole`. */
export interface Step {
  target: THREE.Vector3;
  bend: THREE.Vector3;
  toes?: THREE.Vector3;
  sole?: THREE.Vector3;
}

/** A whole pose, in model space (the rider's own frame: feet on y = 0, facing +Z). */
export interface Pose {
  hips: THREE.Vector3;
  hipsTurn: THREE.Quaternion;
  /** Bends of the spine, chest, neck and head from their rest (local rotations). */
  spine: THREE.Quaternion;
  chest: THREE.Quaternion;
  neck: THREE.Quaternion;
  head: THREE.Quaternion;
  arms: [Reach, Reach];
  legs: [Step, Step];
}

const v = () => new THREE.Vector3();
const q = () => new THREE.Quaternion();

/** The rotation taking the frame (a1, b1) to (a2, b2); `a` is kept exactly, `b` is made perpendicular. */
function frameTurn(a1: THREE.Vector3, b1: THREE.Vector3, a2: THREE.Vector3, b2: THREE.Vector3, out: THREE.Quaternion) {
  const m1 = basis(a1, b1);
  const m2 = basis(a2, b2);
  return out.setFromRotationMatrix(m2.multiply(m1.transpose()));
}

const mA = new THREE.Matrix4();
const mB = new THREE.Matrix4();
let flipM = false;
function basis(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const x = a.clone().normalize();
  const y = b.clone().addScaledVector(x, -b.dot(x));
  if (y.lengthSq() < 1e-10)
    y.crossVectors(x, Math.abs(x.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  y.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  flipM = !flipM;
  return (flipM ? mA : mB).makeBasis(x, y, z);
}

/** Two-bone reach: where the middle joint goes. */
function solve(
  root: THREE.Vector3,
  target: THREE.Vector3,
  a: number,
  b: number,
  bend: THREE.Vector3,
  out: THREE.Vector3,
) {
  const d = target.clone().sub(root);
  const len = Math.max(1e-4, Math.min(d.length(), a + b - 1e-4));
  const dir = d.normalize();
  const along = (a * a - b * b + len * len) / (2 * len);
  const off = Math.sqrt(Math.max(0, a * a - along * along));
  const side = bend.clone().addScaledVector(dir, -bend.dot(dir));
  if (side.lengthSq() < 1e-8) side.set(0, 0, 1);
  side.normalize();
  return out.copy(root).addScaledVector(dir, along).addScaledVector(side, off);
}

export class Rig {
  readonly root: THREE.Bone;
  readonly bones: THREE.Bone[];
  readonly skeleton: THREE.Skeleton;
  private rest: THREE.Vector3[];
  private modelP: THREE.Vector3[];
  private modelQ: THREE.Quaternion[];
  private lengths: Record<"upperArm" | "foreArm" | "thigh" | "shin", number>;
  /** Rest frames of the limb ends. */
  private handRest: { fingers: THREE.Vector3; palm: THREE.Vector3 }[];
  private curlAxis: THREE.Vector3[];

  constructor(anatomy: Anatomy) {
    this.rest = anatomy.rest.map((p) => p.clone());
    this.bones = BONES.map((name) => {
      const b = new THREE.Bone();
      b.name = name;
      return b;
    });
    BONES.forEach((name, i) => {
      const parent = boneParent(name);
      const b = this.bones[i]!;
      if (parent) {
        this.bones[BONE[parent]]!.add(b);
        b.position.copy(this.rest[i]!).sub(this.rest[BONE[parent]]!);
      } else b.position.copy(this.rest[i]!);
    });
    this.root = this.bones[0]!;
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
    this.modelP = BONES.map(() => v());
    this.modelQ = BONES.map(() => q());
    this.lengths = {
      upperArm: anatomy.upperArm,
      foreArm: anatomy.foreArm,
      thigh: this.restPos("shin.L").distanceTo(this.restPos("thigh.L")),
      shin: this.restPos("foot.L").distanceTo(this.restPos("shin.L")),
    };
    this.handRest = [1, -1].map((side) => {
      const fingers = this.restPos(side > 0 ? "fingers.L" : "fingers.R")
        .sub(this.restPos(side > 0 ? "hand.L" : "hand.R"))
        .normalize();
      // Palms face the body in the rest pose.
      const palm = new THREE.Vector3(-side * Math.cos(Math.PI / 4), -Math.sin(Math.PI / 4), 0);
      return { fingers, palm };
    });
    this.curlAxis = this.handRest.map(({ fingers, palm }) =>
      new THREE.Vector3().crossVectors(fingers, palm).normalize(),
    );
  }

  restPos(b: BoneName): THREE.Vector3 {
    return this.rest[BONE[b]]!.clone();
  }

  /** Model-space position of a bone, as of the last pose. */
  pos(b: BoneName): THREE.Vector3 {
    return this.modelP[BONE[b]]!;
  }

  /** Model-space rotation of a bone, as of the last pose. */
  rot(b: BoneName): THREE.Quaternion {
    return this.modelQ[BONE[b]]!;
  }

  private setLocal(i: number, local: THREE.Quaternion): void {
    const name = BONES[i]!;
    const parent = boneParent(name);
    const bone = this.bones[i]!;
    bone.quaternion.copy(local);
    if (parent === null) {
      this.modelQ[i]!.copy(local);
      this.modelP[i]!.copy(bone.position);
      return;
    }
    const p = BONE[parent];
    this.modelQ[i]!.copy(this.modelQ[p]!).multiply(local);
    this.modelP[i]!.copy(bone.position).applyQuaternion(this.modelQ[p]!).add(this.modelP[p]!);
  }

  /** Sets a bone's model-space rotation (its local one follows from the parent's). */
  private setModel(i: number, model: THREE.Quaternion): void {
    const parent = boneParent(BONES[i]!);
    const local = parent === null ? model.clone() : this.modelQ[BONE[parent]]!.clone().invert().multiply(model);
    this.setLocal(i, local);
  }

  apply(pose: Pose): void {
    const ident = q();
    this.setLocal(BONE.root, ident);
    this.bones[BONE.hips]!.position.copy(pose.hips);
    this.setLocal(BONE.hips, pose.hipsTurn);
    this.setLocal(BONE.spine, pose.spine);
    this.setLocal(BONE.chest, pose.chest);
    this.setLocal(BONE.neck, pose.neck);
    this.setLocal(BONE.head, pose.head);
    for (const [k, L] of [
      [0, "L"],
      [1, "R"],
    ] as const) {
      // Arms.
      this.setLocal(BONE[`clavicle.${L}`], ident);
      const reach = pose.arms[k];
      this.limb(
        BONE[`upperarm.${L}`],
        BONE[`forearm.${L}`],
        BONE[`hand.${L}`],
        this.lengths.upperArm,
        this.lengths.foreArm,
        reach.target,
        reach.bend,
        new THREE.Vector3(0, 0, -1),
      );
      const hand = BONE[`hand.${L}`];
      if (reach.fingers && reach.palm) {
        const rest = this.handRest[k]!;
        this.setModel(hand, frameTurn(rest.fingers, rest.palm, reach.fingers, reach.palm, q()));
      } else this.setLocal(hand, ident);
      this.setLocal(BONE[`fingers.${L}`], q().setFromAxisAngle(this.curlAxis[k]!, reach.curl ?? 0.25));

      // Legs.
      const step = pose.legs[k];
      this.limb(
        BONE[`thigh.${L}`],
        BONE[`shin.${L}`],
        BONE[`foot.${L}`],
        this.lengths.thigh,
        this.lengths.shin,
        step.target,
        step.bend,
        new THREE.Vector3(0, 0, 1),
      );
      const foot = BONE[`foot.${L}`];
      if (step.toes && step.sole) {
        this.setModel(
          foot,
          frameTurn(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0), step.toes, step.sole, q()),
        );
      } else this.setLocal(foot, ident);
      this.setLocal(BONE[`toes.${L}`], ident);
    }
  }

  /** A two-bone chain from bone `u` (upper) and `l` (lower) to `e` (end), reaching for `target`. */
  private limb(
    u: number,
    l: number,
    e: number,
    a: number,
    b: number,
    target: THREE.Vector3,
    bend: THREE.Vector3,
    restBend: THREE.Vector3,
  ): void {
    // Where the chain starts, with the parent posed.
    this.setLocal(u, q());
    const root = this.modelP[u]!.clone();
    const mid = solve(root, target, a, b, bend, v());
    const end = target.clone().sub(root);
    if (end.length() > a + b) end.setLength(a + b - 1e-4);
    end.add(root);
    const restU = this.rest[l]!.clone().sub(this.rest[u]!).normalize();
    const restL = this.rest[e]!.clone().sub(this.rest[l]!).normalize();
    const restN = new THREE.Vector3().crossVectors(restBend, restU).normalize();
    const dirU = mid.clone().sub(root).normalize();
    const dirL = end.clone().sub(mid).normalize();
    // The hinge: perpendicular to the plane of the bend.
    let n = new THREE.Vector3().crossVectors(dirU, dirL);
    if (n.lengthSq() < 1e-6) n = new THREE.Vector3().crossVectors(bend, dirU);
    n.normalize();
    this.setModel(u, frameTurn(restU, restN, dirU, n, q()));
    this.setModel(l, frameTurn(restL, restN, dirL, n, q()));
  }
}
