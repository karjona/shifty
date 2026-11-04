// A rider's body: proportions from the look (body, height, build, nose),
// the skeleton's rest pose and the body parts it is lofted from. Model
// space: feet on y = 0, facing +Z, the rider's left toward +X, metres. The
// rest pose is an A-pose (arms 45° down) so the shoulders deform well.
import * as THREE from "three/webgpu";
import type { Look } from "@shifty/rider";
import { type Section, angleDiff, bell, keyed, smoothstep } from "./curve.ts";

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
export const BONE = Object.fromEntries(BONES.map((b, i) => [b, i])) as Record<BoneName, number>;

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

/** A bone and how much it moves a vertex. */
export type Influence = [bone: number, weight: number];

export type PartName =
  | "torso"
  | "head"
  | "arm.L"
  | "arm.R"
  | "hand.L"
  | "hand.R"
  | "thumb.L"
  | "thumb.R"
  | "leg.L"
  | "leg.R"
  | "foot.L"
  | "foot.R"
  | "ear.L"
  | "ear.R";

/** A body part lofted along t: its cross-sections and how the skeleton moves it. */
export interface Part {
  name: PartName;
  /** The part runs over this range of t. */
  t0: number;
  t1: number;
  at(t: number): Section;
  /** Values of t that always get a ring (joints, features). */
  marks: number[];
  /** Close the ends with a point (a crown, a fingertip). */
  capStart: THREE.Vector3 | null;
  capEnd: THREE.Vector3 | null;
  /** More ring vertices in front (0-0.8): faces. */
  frontBias: number;
  /** Relative ring count (1 = the style's default). */
  rings: number;
  /** Relative vertices per ring. */
  sides: number;
  weights(t: number, phi: number, p: THREE.Vector3): Influence[];
}

const HEIGHTS = { male: [1.66, 1.72, 1.78, 1.84, 1.9], female: [1.56, 1.62, 1.67, 1.72, 1.78] };
const BUILDS = [-1, -0.5, 0, 0.5, 1];
const REF_HEIGHT = { male: 1.76, female: 1.66 };

/**
 * Noses, as a profile down the middle of the face: [head height (0 chin,
 * 1 crown), how far it stands out, half width] from the root between the
 * eyes to the base under the tip.
 */
const NOSES: readonly (readonly (readonly number[])[])[] = [
  // Straight.
  [
    [0.235, 0, 0.015],
    [0.255, 0.012, 0.017],
    [0.29, 0.025, 0.015],
    [0.33, 0.021, 0.012],
    [0.42, 0.011, 0.01],
    [0.52, 0.003, 0.011],
  ],
  // Small and turned up.
  [
    [0.245, 0, 0.015],
    [0.27, 0.012, 0.017],
    [0.3, 0.018, 0.016],
    [0.33, 0.014, 0.012],
    [0.42, 0.006, 0.01],
    [0.5, 0.002, 0.011],
  ],
  // Aquiline: a bump on the bridge.
  [
    [0.235, 0, 0.015],
    [0.255, 0.012, 0.016],
    [0.3, 0.027, 0.013],
    [0.36, 0.024, 0.011],
    [0.43, 0.018, 0.01],
    [0.52, 0.004, 0.011],
  ],
  // Broad.
  [
    [0.24, 0, 0.022],
    [0.26, 0.013, 0.025],
    [0.29, 0.021, 0.022],
    [0.33, 0.018, 0.018],
    [0.42, 0.009, 0.014],
    [0.5, 0.003, 0.014],
  ],
  // Long and narrow.
  [
    [0.22, 0, 0.013],
    [0.24, 0.013, 0.014],
    [0.27, 0.028, 0.012],
    [0.33, 0.024, 0.01],
    [0.43, 0.013, 0.009],
    [0.53, 0.004, 0.01],
  ],
];

/** Lip fullness and mouth width per mouth preset. */
const MOUTHS = [
  { lips: 1, width: 1 },
  { lips: 0.6, width: 0.95 },
  { lips: 1.5, width: 1.02 },
  { lips: 1.1, width: 1.15 },
  { lips: 0.9, width: 0.88 },
];

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const X = v3(1, 0, 0);
const Y = v3(0, 1, 0);
const Z = v3(0, 0, 1);

/** Blends of bones, normalized. */
function mix(...pairs: Influence[]): Influence[] {
  const out = pairs.filter(([, w]) => w > 1e-4);
  const sum = out.reduce((s, [, w]) => s + w, 0);
  return out.map(([b, w]) => [b, w / sum]);
}

export class Anatomy {
  readonly male: boolean;
  /** Standing height and head height (chin to crown), m. */
  readonly height: number;
  readonly headH: number;
  /** -1 slim to 1 heavy. */
  readonly build: number;
  /** Rest positions of the bones (model space). */
  readonly rest: THREE.Vector3[];
  readonly parts = new Map<PartName, Part>();
  /** Segment lengths of the limbs. */
  readonly upperArm: number;
  readonly foreArm: number;
  readonly thigh: number;
  readonly shin: number;
  /** Where the head is: the chin's height and the head's section at any height (head units, 0 chin, 1 crown). */
  readonly chinY: number;
  readonly headAt: (u: number) => Section;
  /** The head part's t at head height u, and the inverse. */
  readonly headT: (u: number) => number;
  readonly headU: (t: number) => number;
  /** Mouth width scale, for the face texture. */
  readonly mouthWidth: number;

  constructor(look: Look, headScale = 1) {
    const male = look.body === "male";
    this.male = male;
    const H = (male ? HEIGHTS.male : HEIGHTS.female)[look.height] ?? REF_HEIGHT[look.body];
    this.height = H;
    const build = BUILDS[look.build] ?? 0;
    this.build = build;
    // Girth grows slower than height.
    const g = Math.sqrt(H / REF_HEIGHT[look.body]);
    const fat = 1 + build * (build > 0 ? 0.16 : 0.1);
    const limb = g * (1 + build * (build > 0 ? 0.15 : 0.1));
    const headH = (male ? 0.226 : 0.216) * headScale;
    this.headH = headH;
    const chinY = H - headH;
    this.chinY = chinY;

    // Skeleton.
    const sx = (male ? 0.116 : 0.102) * H * (1 + build * 0.03);
    const hx = (male ? 0.05 : 0.056) * H * (1 + build * 0.08);
    const shoulderY = 0.805 * H;
    const neckBase = 0.836 * H;
    const hipY = 0.52 * H;
    const kneeY = 0.285 * H;
    const ankleY = 0.045 * H;
    const A = Math.PI / 4;
    this.upperArm = 0.186 * H;
    this.foreArm = 0.148 * H;
    const handLen = 0.108 * H;
    this.thigh = Math.hypot(hipY - kneeY, 0.012);
    this.shin = Math.hypot(kneeY - ankleY, 0.02);
    const shoulder = (side: number) => v3(side * sx, shoulderY, -0.012);
    const armDir = (side: number) => v3(side * Math.sin(A), -Math.cos(A), 0);
    const elbow = (side: number) => shoulder(side).addScaledVector(armDir(side), this.upperArm);
    const wrist = (side: number) => elbow(side).addScaledVector(armDir(side), this.foreArm);
    const knuckles = (side: number) => wrist(side).addScaledVector(armDir(side), handLen * 0.48);
    const hip = (side: number) => v3(side * hx, hipY, 0);
    const knee = (side: number) => v3(side * hx * 0.94, kneeY, 0.012);
    const ankle = (side: number) => v3(side * hx * 0.9, ankleY, -0.008);
    const ball = (side: number) => v3(side * hx * 0.94, 0.012, 0.13 * (H / 1.76));
    const headPivot = v3(0, chinY + headH * 0.2, -0.012);
    const rest: Record<BoneName, THREE.Vector3> = {
      root: v3(0, 0, 0),
      hips: v3(0, 0.53 * H, 0),
      spine: v3(0, 0.6 * H, -0.006),
      chest: v3(0, 0.69 * H, -0.012),
      neck: v3(0, neckBase - 0.01, -0.02),
      head: headPivot,
      "clavicle.L": v3(0.02, shoulderY + 0.01, -0.005),
      "upperarm.L": shoulder(1),
      "forearm.L": elbow(1),
      "hand.L": wrist(1),
      "fingers.L": knuckles(1),
      "clavicle.R": v3(-0.02, shoulderY + 0.01, -0.005),
      "upperarm.R": shoulder(-1),
      "forearm.R": elbow(-1),
      "hand.R": wrist(-1),
      "fingers.R": knuckles(-1),
      "thigh.L": hip(1),
      "shin.L": knee(1),
      "foot.L": ankle(1),
      "toes.L": ball(1),
      "thigh.R": hip(-1),
      "shin.R": knee(-1),
      "foot.R": ankle(-1),
      "toes.R": ball(-1),
    };
    this.rest = BONES.map((b) => rest[b]);

    // Torso, crotch to the base of the neck: [height / H, z, half width, front, back].
    const torsoKeys = male
      ? [
          [0.47, 0.0, 0.06, 0.045, 0.06],
          [0.49, 0.0, 0.135, 0.075, 0.095],
          [0.515, 0.0, 0.168, 0.09, 0.112],
          [0.545, 0.0, 0.172, 0.095, 0.105],
          [0.58, 0.0, 0.16, 0.098, 0.092],
          [0.615, 0.0, 0.148, 0.1, 0.088],
          [0.66, -0.003, 0.152, 0.104, 0.092],
          [0.71, -0.005, 0.165, 0.112, 0.098],
          [0.755, -0.008, 0.176, 0.108, 0.102],
          [0.79, -0.012, 0.186, 0.096, 0.1],
          [0.806, -0.014, 0.176, 0.084, 0.092],
          [0.818, -0.016, 0.148, 0.07, 0.08],
          [0.829, -0.018, 0.1, 0.054, 0.064],
          [0.84, -0.02, 0.045, 0.034, 0.04],
        ]
      : [
          [0.47, 0.0, 0.065, 0.045, 0.065],
          [0.49, 0.0, 0.15, 0.075, 0.105],
          [0.515, 0.0, 0.178, 0.085, 0.118],
          [0.545, 0.0, 0.18, 0.088, 0.105],
          [0.58, 0.0, 0.158, 0.088, 0.088],
          [0.62, 0.0, 0.128, 0.085, 0.078],
          [0.665, -0.003, 0.13, 0.09, 0.08],
          [0.715, -0.005, 0.142, 0.1, 0.086],
          [0.755, -0.008, 0.15, 0.098, 0.09],
          [0.79, -0.01, 0.158, 0.088, 0.09],
          [0.806, -0.012, 0.15, 0.076, 0.082],
          [0.818, -0.014, 0.126, 0.064, 0.072],
          [0.829, -0.015, 0.088, 0.05, 0.058],
          [0.84, -0.016, 0.04, 0.03, 0.036],
        ];
    const torsoY0 = 0.47;
    const torsoY1 = 0.84;
    const torso = keyed(torsoKeys);
    const bust = male ? 0.008 : 0.032 * (1 + build * 0.25);
    const bustY = (male ? 0.735 : 0.71) * H;
    const seat = male ? 0.014 : 0.022;
    const belly = Math.max(0, build) * 0.045;
    const torsoAt = (t: number): Section => {
      const yf = torsoY0 + t * (torsoY1 - torsoY0);
      const [z, w, df, db] = torso(yf) as [number, number, number, number];
      const y = yf * H;
      // Fat goes on the waist and belly more than the chest.
      const waist = bell(yf - 0.6, 0.08);
      const wf = g * (fat + (fat - 1) * waist * 0.6);
      return {
        c: v3(0, y, z),
        side: X,
        front: Z,
        w: w * wf,
        df: df * wf,
        db: db * wf,
        nf: 2.3,
        nb: 2.2,
        bump: (phi) => {
          const chest = bell(y - bustY, male ? 0.05 : 0.04) * bell(Math.abs(phi) - 0.42, male ? 0.4 : 0.32) * bust;
          const bum = bell(yf - 0.505, 0.025) * bell(Math.abs(angleDiff(phi, Math.PI)) - 0.45, 0.35) * seat;
          const gut = bell(yf - 0.6, 0.045) * bell(phi, 0.8) * belly;
          const blades = bell(yf - 0.74, 0.03) * bell(Math.abs(angleDiff(phi, Math.PI)) - 0.55, 0.3) * 0.006;
          const spineGroove = -bell(angleDiff(phi, Math.PI), 0.12) * smoothstep(0.56, 0.62, yf) * 0.004;
          return chest + bum + gut + blades + spineGroove;
        },
      };
    };
    const shoulderL = rest["upperarm.L"];
    const shoulderR = rest["upperarm.R"];
    const hipL = rest["thigh.L"];
    const hipR = rest["thigh.R"];
    this.parts.set("torso", {
      name: "torso",
      t0: 0,
      t1: 1,
      at: torsoAt,
      marks: [0, 1],
      capStart: v3(0, (torsoY0 - 0.004) * H, 0),
      capEnd: null,
      frontBias: 0.2,
      rings: 1,
      sides: 1,
      weights: (t, _phi, p) => {
        const y = p.y / H;
        const toSpine = smoothstep(0.55, 0.62, y);
        const toChest = smoothstep(0.63, 0.71, y);
        const trunk: Influence[] = [
          [BONE.hips, 1 - toSpine],
          [BONE.spine, toSpine * (1 - toChest)],
          [BONE.chest, toChest],
        ];
        const side = p.x >= 0 ? 1 : -1;
        const sh = side > 0 ? shoulderL : shoulderR;
        const d = p.distanceTo(sh);
        const arm = (1 - smoothstep(0.02, 0.1, d)) * 0.55;
        const clav = (1 - smoothstep(0.03, 0.15, d)) * smoothstep(0.74, 0.8, y) * 0.5;
        const neck = smoothstep(0.82, 0.845, y) * 0.5;
        const hp = side > 0 ? hipL : hipR;
        const thigh = (1 - smoothstep(0.47, 0.53, y)) * smoothstep(0.0, 0.03, Math.abs(p.x)) * 0.55;
        const rest = 1 - Math.min(0.95, arm + clav + neck + thigh);
        void t;
        void hp;
        return mix(
          ...trunk.map(([b, w]) => [b, w * rest] as Influence),
          [BONE[side > 0 ? "upperarm.L" : "upperarm.R"], arm],
          [BONE[side > 0 ? "clavicle.L" : "clavicle.R"], clav],
          [BONE.neck, neck],
          [BONE[side > 0 ? "thigh.L" : "thigh.R"], thigh],
        );
      },
    });

    // Neck and head, one tube: the neck from inside the shoulders, then the
    // head from under the jaw to the crown. Neck keys: [0-1 base to jaw, z, w, front, back].
    const neckW = male ? 1 : 0.86;
    const neckFat = g * (1 + build * 0.14);
    const neckKeys = [
      [-0.3, -0.026, 0.056, 0.047, 0.056],
      [0, -0.022, 0.055, 0.05, 0.056],
      [0.5, -0.016, 0.05, 0.05, 0.052],
      [1, -0.012, 0.051, 0.052, 0.055],
    ];
    // Head keys: [head height (0 chin, 1 crown), z, w, front, back], for an
    // average male head; female heads are a little smaller, with a softer jaw.
    const headKeys = [
      [-0.09, -0.012, 0.051, 0.052, 0.055],
      [-0.02, -0.008, 0.055, 0.073, 0.058],
      [0.03, -0.005, 0.062, 0.088, 0.062],
      [0.13, -0.002, 0.069, 0.094, 0.07],
      [0.22, 0.0, 0.073, 0.096, 0.082],
      [0.3, 0.0, 0.075, 0.094, 0.09],
      [0.4, 0.0, 0.075, 0.09, 0.098],
      [0.48, 0.0, 0.076, 0.087, 0.103],
      [0.56, 0.0, 0.078, 0.093, 0.106],
      [0.66, -0.002, 0.079, 0.093, 0.107],
      [0.78, -0.006, 0.075, 0.084, 0.104],
      [0.88, -0.01, 0.064, 0.066, 0.09],
      [0.95, -0.012, 0.053, 0.051, 0.073],
      [0.985, -0.014, 0.031, 0.029, 0.043],
    ];
    const neck = keyed(neckKeys);
    const head = keyed(headKeys);
    const nose = keyed(NOSES[look.nose] ?? NOSES[0]!);
    const mouth = MOUTHS[look.mouth] ?? MOUTHS[0]!;
    this.mouthWidth = mouth.width;
    const hs = (headH / 0.226) * (male ? 1 : 0.98);
    const neckY0 = neckBase - 0.012;
    const jawY = chinY - 0.09 * headH;
    // t: 0 to tn is the neck, tn to 1 the head (by height).
    const yBottom = neckY0 - 0.3 * (jawY - neckY0);
    const yTop = H;
    const tOf = (y: number) => (y - yBottom) / (yTop - yBottom);
    const yOf = (t: number) => yBottom + t * (yTop - yBottom);
    const tn = tOf(jawY);
    this.headT = (u: number) => tOf(chinY + u * headH);
    this.headU = (t: number) => (yOf(t) - chinY) / headH;
    const jaw = male ? 1 : 0.9;
    const chinSize = male ? 0.009 : 0.006;
    const browSize = male ? 0.006 : 0.003;
    const cheek = 0.004 + Math.max(0, build) * 0.006;
    const headSection = (u: number): Section => {
      const [z, w, df, db] = head(u) as [number, number, number, number];
      // A softer, narrower jaw on female heads, fuller cheeks on heavier ones.
      const lower = 1 - smoothstep(0.1, 0.45, u);
      const wj = (male ? 1 : 0.97) * (1 - (1 - jaw) * lower) * (1 + build * 0.05 * lower);
      const y = chinY + u * headH;
      return {
        c: v3(0, y, z * hs),
        side: X,
        front: Z,
        w: w * hs * wj,
        df: df * hs * (male ? 1 : 0.985),
        db: db * hs,
        nf: 2.25,
        nb: 2.05,
        bump: (phi) => {
          const a = Math.abs(phi);
          const r = 0.09 * hs;
          const [np, nw] = nose(u) as [number, number];
          const inNose = u > 0.2 && u < 0.56 ? bell(phi * r, nw * hs) * np * hs : 0;
          const sockets = -bell(u - 0.48, 0.06) * bell(a - 0.36, 0.2) * 0.007 * hs;
          const brow = bell(u - 0.565, 0.04) * bell(a - 0.33, 0.32) * browSize * hs;
          const cheekbones = bell(u - 0.39, 0.06) * bell(a - 0.62, 0.26) * cheek * hs;
          const lipW = 0.22 * mouth.width;
          const lips = (bell(u - 0.17, 0.03) + bell(u - 0.105, 0.03)) * bell(phi, lipW) * 0.0055 * mouth.lips * hs;
          const chin = bell(u - 0.03, 0.05) * bell(phi, male ? 0.36 : 0.26) * chinSize * hs;
          const temples = -bell(u - 0.62, 0.06) * bell(a - 1.0, 0.25) * 0.003 * hs;
          return inNose + sockets + brow + cheekbones + lips + chin + temples;
        },
      };
    };
    this.headAt = headSection;
    const headPart: Part = {
      name: "head",
      t0: 0,
      t1: tOf(chinY + 0.985 * headH),
      at: (t) => {
        const y = yOf(t);
        if (y >= jawY) return headSection((y - chinY) / headH);
        const f = (y - neckY0) / (jawY - neckY0);
        const [z, w, df, db] = neck(f) as [number, number, number, number];
        return {
          c: v3(0, y, z * hs),
          side: X,
          front: Z,
          w: w * neckW * neckFat * hs,
          df: df * neckW * neckFat * hs,
          db: db * neckW * neckFat * hs,
          nf: 2,
          nb: 2,
        };
      },
      marks: [tn, ...[0.03, 0.105, 0.17, 0.24, 0.27, 0.3, 0.34, 0.42, 0.48, 0.56].map((u) => tOf(chinY + u * headH))],
      capStart: null,
      capEnd: v3(0, H, -0.014 * hs),
      frontBias: 0.5,
      rings: 1.6,
      sides: 1.6,
      weights: (_t, _phi, p) => {
        const toHead = smoothstep(jawY - 0.015, jawY + 0.02, p.y);
        const fromChest = 1 - smoothstep(neckY0 - 0.01, neckY0 + 0.025, p.y);
        return mix(
          [BONE.chest, fromChest * 0.7],
          [BONE.neck, (1 - toHead) * (1 - fromChest * 0.7)],
          [BONE.head, toHead],
        );
      },
    };
    this.parts.set("head", headPart);

    // Ears: small flattened lobes on the sides of the head.
    for (const side of [1, -1]) {
      const u = 0.4;
      const s = headSection(u);
      const base = v3(side * (s.w - 0.006), s.c.y, -0.012 * hs);
      const out = v3(side, 0, -0.35).normalize();
      const up = Y;
      const fwd = new THREE.Vector3().crossVectors(out, up).multiplyScalar(-side).normalize();
      const ear = keyed([
        [0, 0.012, 0.022, 0.012],
        [0.5, 0.009, 0.03, 0.016],
        [1, 0.004, 0.02, 0.01],
      ]);
      this.parts.set(side > 0 ? "ear.L" : "ear.R", {
        name: side > 0 ? "ear.L" : "ear.R",
        t0: 0,
        t1: 1,
        at: (t) => {
          const [w, h, d] = ear(t) as [number, number, number];
          return {
            c: base.clone().addScaledVector(out, t * 0.016 * hs),
            side: up,
            front: fwd,
            w: h * hs,
            df: d * hs,
            db: w * hs,
            nf: 2,
            nb: 2,
          };
        },
        marks: [0, 1],
        capStart: null,
        capEnd: base.clone().addScaledVector(out, 0.019 * hs),
        frontBias: 0,
        rings: 0.25,
        sides: 0.6,
        weights: () => [[BONE.head, 1]],
      });
    }

    // Arms: from inside the shoulder to the wrist; [t, outer, front, back].
    const armKeys = [
      [-0.14, 0.028, 0.028, 0.03],
      [-0.07, 0.046, 0.044, 0.046],
      [0, 0.054, 0.051, 0.054],
      [0.15, 0.05, 0.05, 0.05],
      [0.35, 0.043, 0.046, 0.043],
      [0.52, 0.037, 0.038, 0.04],
      [0.56, 0.036, 0.036, 0.04],
      [0.66, 0.04, 0.04, 0.038],
      [0.85, 0.031, 0.031, 0.028],
      [1, 0.021, 0.028, 0.026],
    ];
    const arm = keyed(armKeys);
    const armScale = (male ? 1 : 0.84) * limb;
    const armLen = this.upperArm + this.foreArm;
    const tElbow = this.upperArm / armLen;
    for (const side of [1, -1]) {
      const S = shoulder(side);
      const d = armDir(side);
      const outer = v3(side * Math.cos(A), Math.sin(A), 0);
      // Inside the shoulder the arm runs in toward the neck, not up, so it stays under the skin of the trapezius.
      const inward = v3(-side * 0.97, 0.12, 0).normalize();
      const L = side > 0 ? "L" : "R";
      this.parts.set(`arm.${L}`, {
        name: `arm.${L}`,
        t0: -0.14,
        t1: 1,
        at: (t) => {
          const [w, df, db] = arm(t) as [number, number, number];
          return {
            c:
              t >= 0 ? S.clone().addScaledVector(d, t * armLen) : S.clone().addScaledVector(inward, -t * armLen * 0.85),
            side: outer,
            front: Z,
            w: w * armScale,
            df: df * armScale,
            db: db * armScale,
            nf: 2,
            nb: 2,
          };
        },
        marks: [0, tElbow, 1],
        capStart: S.clone().addScaledVector(inward, 0.15 * armLen * 0.85),
        capEnd: null,
        frontBias: 0,
        rings: 1,
        sides: 0.75,
        weights: (t) => {
          const fore = smoothstep(tElbow - 0.07, tElbow + 0.05, t);
          const hand = smoothstep(0.9, 1.02, t) * 0.4;
          const clav = (1 - smoothstep(-0.05, 0.12, t)) * 0.35;
          return mix(
            [BONE[`clavicle.${L}`], clav],
            [BONE[`upperarm.${L}`], (1 - fore) * (1 - clav)],
            [BONE[`forearm.${L}`], fore * (1 - hand)],
            [BONE[`hand.${L}`], hand],
          );
        },
      });

      // Hand: a mitten from the wrist to the fingertips, palm toward the body.
      const W = wrist(side);
      const handKeys = keyed([
        [0, 0.019, 0.028, 0.028],
        [0.15, 0.021, 0.039, 0.039],
        [0.45, 0.016, 0.044, 0.044],
        [0.56, 0.0135, 0.042, 0.042],
        [0.8, 0.012, 0.039, 0.039],
        [0.97, 0.009, 0.033, 0.033],
      ]);
      const hscale = (male ? 1 : 0.88) * g;
      const tKnuckle = 0.48;
      this.parts.set(`hand.${L}`, {
        name: `hand.${L}`,
        t0: 0,
        t1: 0.97,
        at: (t) => {
          const [w, df, db] = handKeys(t) as [number, number, number];
          return {
            c: W.clone()
              .addScaledVector(d, t * handLen)
              .addScaledVector(outer, -0.004),
            side: outer,
            front: Z,
            w: w * hscale,
            df: df * hscale,
            db: db * hscale,
            nf: 2.6,
            nb: 2.6,
          };
        },
        marks: [0, tKnuckle],
        capStart: null,
        capEnd: W.clone().addScaledVector(d, handLen),
        frontBias: 0,
        rings: 0.6,
        sides: 0.75,
        weights: (t) => {
          const f = smoothstep(tKnuckle - 0.04, tKnuckle + 0.08, t);
          return mix([BONE[`hand.${L}`], 1 - f], [BONE[`fingers.${L}`], f]);
        },
      });
      // Thumb, off the front edge of the palm.
      const tRoot = W.clone()
        .addScaledVector(d, handLen * 0.18)
        .addScaledVector(Z, 0.03 * hscale)
        .addScaledVector(outer, -0.012);
      const tDir = d.clone().multiplyScalar(0.6).addScaledVector(Z, 0.65).addScaledVector(outer, -0.35).normalize();
      const tSide = new THREE.Vector3().crossVectors(tDir, Z).normalize();
      const tFront = new THREE.Vector3().crossVectors(tSide, tDir).normalize();
      const thumbLen = 0.062 * hscale * (H / 1.76);
      this.parts.set(`thumb.${L}`, {
        name: `thumb.${L}`,
        t0: 0,
        t1: 0.92,
        at: (t) => {
          const r = (0.013 - t * 0.004) * hscale;
          return {
            c: tRoot.clone().addScaledVector(tDir, t * thumbLen),
            side: tSide,
            front: tFront,
            w: r,
            df: r * 0.9,
            db: r * 0.9,
            nf: 2,
            nb: 2,
          };
        },
        marks: [0],
        capStart: null,
        capEnd: tRoot.clone().addScaledVector(tDir, thumbLen),
        frontBias: 0,
        rings: 0.3,
        sides: 0.6,
        weights: () => [[BONE[`hand.${L}`], 1]],
      });

      // Leg: from inside the pelvis through the knee to the ankle; [t, outer, front, back].
      const legKeys = male
        ? [
            [-0.08, 0.082, 0.076, 0.082],
            [0, 0.086, 0.08, 0.086],
            [0.12, 0.08, 0.078, 0.078],
            [0.3, 0.068, 0.068, 0.064],
            [0.45, 0.055, 0.058, 0.052],
            [0.5, 0.05, 0.055, 0.048],
            [0.6, 0.05, 0.048, 0.058],
            [0.7, 0.048, 0.045, 0.055],
            [0.85, 0.036, 0.035, 0.036],
            [0.97, 0.03, 0.03, 0.032],
            [1.04, 0.033, 0.036, 0.036],
          ]
        : [
            [-0.08, 0.088, 0.078, 0.086],
            [0, 0.092, 0.08, 0.09],
            [0.12, 0.084, 0.078, 0.08],
            [0.3, 0.068, 0.066, 0.064],
            [0.45, 0.052, 0.054, 0.05],
            [0.5, 0.046, 0.05, 0.045],
            [0.6, 0.045, 0.044, 0.052],
            [0.7, 0.043, 0.041, 0.05],
            [0.85, 0.032, 0.032, 0.033],
            [0.97, 0.027, 0.027, 0.029],
            [1.04, 0.03, 0.032, 0.033],
          ];
      const leg = keyed(legKeys);
      const P = hip(side);
      const K = knee(side);
      const An = ankle(side);
      const tKnee = this.thigh / (this.thigh + this.shin);
      const legScale = g * (1 + build * (build > 0 ? 0.13 : 0.09));
      const legCentre = (t: number) =>
        t <= tKnee ? P.clone().lerp(K, t / tKnee) : K.clone().lerp(An, (t - tKnee) / (1 - tKnee));
      const legOuter = v3(side, 0, 0);
      this.parts.set(`leg.${L}`, {
        name: `leg.${L}`,
        t0: -0.08,
        t1: 1.04,
        at: (t) => {
          const [w, df, db] = leg(t) as [number, number, number];
          return {
            c: legCentre(t),
            side: legOuter,
            front: Z,
            w: w * legScale,
            df: df * legScale,
            db: db * legScale,
            nf: 2,
            nb: 2,
          };
        },
        marks: [0, tKnee, 1],
        capStart: null,
        capEnd: null,
        frontBias: 0,
        rings: 1.2,
        sides: 0.75,
        weights: (t) => {
          const shin = smoothstep(tKnee - 0.05, tKnee + 0.05, t);
          const foot = smoothstep(0.95, 1.04, t) * 0.5;
          const hips = (1 - smoothstep(-0.05, 0.1, t)) * 0.4;
          return mix(
            [BONE.hips, hips],
            [BONE[`thigh.${L}`], (1 - shin) * (1 - hips)],
            [BONE[`shin.${L}`], shin * (1 - foot)],
            [BONE[`foot.${L}`], foot],
          );
        },
      });

      // Foot: heel to toes, with a flat sole; [t, y, z, half width, top, bottom].
      const fs = (male ? 1 : 0.9) * (H / REF_HEIGHT[look.body]) * (male ? 1 : 1.04);
      const footKeys = keyed([
        [0, 0.038, -0.06, 0.024, 0.026, 0.026],
        [0.1, 0.042, -0.045, 0.033, 0.036, 0.034],
        [0.3, 0.05, 0.0, 0.036, 0.046, 0.042],
        [0.55, 0.036, 0.07, 0.044, 0.032, 0.026],
        [0.75, 0.024, 0.125, 0.05, 0.022, 0.02],
        [0.9, 0.019, 0.165, 0.046, 0.017, 0.015],
        [0.98, 0.016, 0.188, 0.036, 0.012, 0.012],
      ]);
      this.parts.set(`foot.${L}`, {
        name: `foot.${L}`,
        t0: 0,
        t1: 0.98,
        at: (t) => {
          const [y, z, w, up, down] = footKeys(t) as [number, number, number, number, number];
          return {
            c: v3(An.x + side * 0.004, y * fs, An.z + z * fs),
            side: legOuter,
            front: Y,
            w: w * fs * g,
            df: up * fs,
            db: down * fs,
            nf: 2.4,
            nb: 4,
          };
        },
        marks: [0, 0.75],
        capStart: v3(An.x + side * 0.004, 0.038 * fs, An.z - 0.064 * fs),
        capEnd: v3(An.x + side * 0.004, 0.016 * fs, An.z + 0.196 * fs),
        frontBias: 0,
        rings: 0.7,
        sides: 0.75,
        weights: (t) => {
          const toes = smoothstep(0.7, 0.8, t);
          return mix([BONE[`foot.${L}`], 1 - toes], [BONE[`toes.${L}`], toes]);
        },
      });
    }
  }

  part(name: PartName): Part {
    return this.parts.get(name)!;
  }
}
