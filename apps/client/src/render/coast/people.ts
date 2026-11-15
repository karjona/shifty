// The coast's people: painted figures with a little anatomy (shoulders
// wider than the waist, limbs that taper, feet, a head of hair, a hat, a
// skirt), standing, strolling, sitting, lying in the sun or fishing off
// the quay. They are part of the scenery's meshes; the arms of those who
// wave are a batch of their own, raised when a rider comes by, and a few
// walk up and down the promenade (`Walkers`).
import * as THREE from "three/webgpu";
import { Fn, attribute, float, fract, mix, normalLocal, positionLocal, sin, step, vec3 } from "three/tsl";
import type { Conditions } from "../../game/conditions.ts";
import { LOOK } from "../cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId } from "../cel/material.ts";
import type { Grounding } from "./grounding.ts";
import { propMaterial } from "./materials.ts";
import { Shape, pick, random } from "./shape.ts";

const SKIN = [0xf0c8a0, 0xe0ac80, 0xc68c5c, 0x8a5a3a, 0xf4d4b4];
const HAIR = [0x2a2420, 0x5a3a22, 0x8a6a3a, 0xd8c8a0, 0x3a3030, 0xb0b0b0];
const SHIRTS = [0xf6f2ea, 0xd94a3a, 0x2f6fb0, 0xf2c14e, 0x3f8a6a, 0xf08a3c, 0x7a5aa8, 0x2a8fb0, 0xe87a9a, 0x3a3f4a];
const LEGS = [0x2f3f5a, 0x4a5568, 0xd8cdb4, 0x6a4a32, 0x2a8fb0, 0xd94a3a, 0xf6f2ea];
const SWIM = [0xd94a3a, 0x2f6fb0, 0xf2c14e, 0x2d8a7a, 0xf08a3c, 0xe87a9a, 0x3a3f4a];
const SHOES = [0x3a3430, 0xf0ece2, 0x6a4a32, 0x2f3f5a];
const STRAW = 0xe2c98a;

export type Pose = "stand" | "walk" | "sit" | "lie" | "fish" | "cheer";

export interface PersonOptions {
  pose?: Pose;
  /** Dressed for the beach: swimwear. */
  beach?: boolean;
  /** Leave the right arm off (a waver's is drawn apart, see `Crowd`). */
  armless?: boolean;
  /** Metres tall (1.7 if left out). */
  height?: number;
  /** Which foot leads a walker's stride (1 or -1). */
  step?: 1 | -1;
  /** Where its shade is laid on the ground, and the ground's colour (standing figures only). */
  shade?: { on: Grounding; colour: THREE.ColorRepresentation };
}

/** How a figure is dressed. */
interface Dress {
  skin: THREE.Color;
  hair: THREE.Color;
  top: THREE.Color;
  legs: THREE.Color;
  shoes: THREE.Color;
  /** Shorts: the shins are bare. */
  shorts: boolean;
  /** A skirt over the thighs. */
  skirt: boolean;
  /** Hair down to the shoulders. */
  long: boolean;
  hat: boolean;
  /** Bare feet (on the sand). */
  barefoot: boolean;
}

function dress(r: () => number, beach: boolean): Dress {
  const skin = new THREE.Color(pick(SKIN, r));
  const bare = beach && r() < 0.5;
  return {
    skin,
    hair: new THREE.Color(pick(HAIR, r)),
    top: bare ? skin : new THREE.Color(pick(beach ? SWIM : SHIRTS, r)),
    legs: new THREE.Color(pick(beach ? SWIM : LEGS, r)),
    shorts: beach || r() < 0.55,
    hat: r() < (beach ? 0.3 : 0.15),
    shoes: new THREE.Color(pick(SHOES, r)),
    skirt: !beach && r() < 0.24,
    long: r() < 0.4,
    barefoot: beach,
  };
}

const HEAD = new THREE.SphereGeometry(0.112, 6, 4).scale(0.94, 1.12, 1);
const CAP = new THREE.SphereGeometry(0.124, 6, 2, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.96, 1.1, 1.02);
const LOCKS = new THREE.SphereGeometry(0.12, 5, 3).scale(0.98, 1.45, 0.62);
const BRIM = new THREE.CylinderGeometry(0.24, 0.26, 0.03, 7);
const HAND = new THREE.SphereGeometry(0.043, 4, 2);
/** The trunk: shoulders wider than the waist, flat from front to back. */
const TORSO = new THREE.CylinderGeometry(1, 0.74, 0.44, 6).translate(0, 0.22, 0).scale(0.2, 1, 0.115);
const HIPS = new THREE.CylinderGeometry(0.92, 1, 0.2, 6, 1, true).translate(0, 0.1, 0).scale(0.165, 1, 0.115);
const SKIRT = new THREE.CylinderGeometry(0.62, 1, 0.46, 6, 1, true).translate(0, -0.23, 0).scale(0.25, 1, 0.19);
const NECK = new THREE.CylinderGeometry(0.045, 0.05, 0.1, 4, 1, true);
const FOOT = new THREE.BoxGeometry(0.085, 0.07, 0.23).translate(0, 0.035, 0.06);

/** A limb's segment hanging from the origin: `top` thick at the joint, `end` at its far end. */
function limb(len: number, top: number, end: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(top, end, len, 4, 1, true).translate(0, -len / 2, 0).rotateY(Math.PI / 4);
}

/**
 * Adds a figure to `shape`, its feet (or, sitting, its seat; lying, its
 * back) at `(x, y, z)`, facing `yaw`. Returns where its right shoulder is
 * and its sleeve's colour (for a waver's arm).
 */
export function addPerson(
  shape: Shape,
  x: number,
  y: number,
  z: number,
  yaw: number,
  r: () => number,
  o: PersonOptions = {},
): { shoulder: THREE.Vector3; sleeve: THREE.Color; yaw: number } {
  const pose = o.pose ?? "stand";
  const d = dress(r, o.beach === true);
  const k = (o.height ?? 1.62 + r() * 0.2) / 1.7;
  const root = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pose === "lie" ? -Math.PI / 2 : 0, yaw, 0, "YXZ")),
    new THREE.Vector3(k, k, k),
  );
  const seated = pose === "sit" || pose === "fish";
  const upright = pose === "stand" || pose === "walk" || pose === "cheer";
  // The hips' height over the root: standing on the feet, sitting on the seat, lying on the back.
  const hip = pose === "lie" ? 0.12 : seated ? 0.1 : 0.86;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  /** A limb's segment hanging from `from`, swung forward by `rx` and out by `rz`; returns where it ends. */
  const seg = (
    from: THREE.Vector3,
    rx: number,
    rz: number,
    len: number,
    top: number,
    end: number,
    colour: THREE.Color,
  ): THREE.Vector3 => {
    q.setFromEuler(e.set(rx, 0, rz));
    m.compose(from, q, one);
    shape.take(limb(len, top, end), colour, root.clone().multiply(m));
    return new THREE.Vector3(0, -len, 0).applyQuaternion(q).add(from);
  };
  // Legs: a thigh, a shin and a foot each.
  const lead = o.step ?? 1;
  const stride = pose === "walk" ? 0.4 * lead : upright ? 0.04 : 0;
  for (const side of [-1, 1]) {
    const top = new THREE.Vector3(side * 0.085, hip, 0);
    const thigh = seated ? -1.5 : -side * stride;
    const knee = seg(top, thigh, side * 0.03, 0.43, 0.088, 0.066, d.skirt ? d.skin : d.legs);
    // (The trailing leg's knee bends.)
    const shin = seated ? 0.05 : -side * stride * 0.4 + (pose === "walk" && side * lead < 0 ? 0.5 : 0);
    const ankle = seg(knee, shin, 0, 0.41, 0.064, 0.045, d.shorts || d.skirt ? d.skin : d.legs);
    if (pose !== "lie") {
      q.setFromEuler(e.set(seated ? 0.3 : 0, 0, 0));
      m.compose(ankle.setY(ankle.y - 0.03), q, one);
      shape.add(FOOT, d.barefoot ? d.skin : d.shoes, root.clone().multiply(m));
    }
  }
  // The hips, the trunk, the neck and the head.
  const lean = pose === "fish" ? 0.25 : pose === "walk" ? 0.06 : 0;
  q.setFromEuler(e.set(lean, 0, 0));
  m.compose(new THREE.Vector3(0, hip, 0), q, one);
  const body = root.clone().multiply(m);
  const up = (h: number, forward = 0) => body.clone().multiply(new THREE.Matrix4().makeTranslation(0, h, forward));
  shape.add(HIPS, d.legs, up(-0.04));
  if (d.skirt && upright) shape.add(SKIRT, d.legs, up(0.12));
  shape.add(TORSO, d.top, up(0.13));
  shape.add(NECK, d.skin, up(0.61));
  shape.add(HEAD, d.skin, up(0.76, 0.01));
  if (d.hat) {
    shape.add(BRIM, STRAW, up(0.84, 0.01));
    shape.add(CAP, STRAW, up(0.78, 0.01));
  } else {
    // Hair over the crown and down the back of the head; long hair to the shoulders.
    q.setFromEuler(e.set(-0.5, 0, 0));
    shape.add(CAP, d.hair, body.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, 0.768, 0), q, one)));
    if (d.long) shape.add(LOCKS, d.hair, up(0.69, -0.055));
  }
  // Arms, from the shoulders (in the body's frame): a sleeve, a forearm and a hand.
  const sleeve = d.top;
  const arm = (side: number, rx: number, rz: number) => {
    const from = new THREE.Vector3(side * 0.215, 0.54, 0).applyQuaternion(q.setFromEuler(e.set(lean, 0, 0)));
    from.y += hip;
    const elbow = seg(from, rx, rz, 0.3, 0.056, 0.044, sleeve);
    const wrist = seg(elbow, rx * 1.2 + (pose === "fish" ? -0.5 : 0), rz * 0.6, 0.27, 0.042, 0.034, d.skin);
    shape.add(HAND, d.skin, root.clone().multiply(m.makeTranslation(wrist.x, wrist.y - 0.02, wrist.z)));
  };
  const swing = pose === "walk" ? 0.36 * lead : 0;
  if (pose === "cheer") {
    arm(-1, -2.7, -0.35);
    if (!o.armless) arm(1, -2.7, 0.35);
  } else if (pose === "fish") {
    arm(-1, -1.0, 0.1);
    arm(1, -1.0, -0.1);
    // The rod, out over the water.
    q.setFromEuler(e.set(-1.15, 0, 0));
    m.compose(new THREE.Vector3(0.05, hip + 0.42, 0.42), q, one);
    shape.take(
      new THREE.BoxGeometry(0.025, 3.4, 0.025).translate(0, 1.5, 0),
      new THREE.Color(0x3a3f46),
      root.clone().multiply(m),
    );
  } else {
    arm(-1, -swing, -0.1);
    if (!o.armless) arm(1, swing, 0.1);
  }
  if (o.shade && upright) o.shade.on.add(x, y, z, 0.34 * k, 0.9 * k, o.shade.colour);
  const shoulder = new THREE.Vector3(0.215, hip + 0.54, 0).applyMatrix4(root);
  return { shoulder, sleeve, yaw };
}

const SEASON_CROWD = { summer: 1, spring: 0.65, fall: 0.45, winter: 0.25 };
const WEATHER_CROWD = { clear: 1, cloudy: 0.85, windy: 0.7, fog: 0.5, rain: 0.2, storm: 0.06, snow: 0.3 };

/** How many people are out (0-1): fewer out of season, hardly any in a storm. */
export function crowdOf(c: Conditions): number {
  return SEASON_CROWD[c.season] * Math.min(WEATHER_CROWD[c.weather], WEATHER_CROWD[c.turns]);
}

interface Waver {
  shoulder: THREE.Vector3;
  yaw: number;
  phase: number;
}

/** People who wave: their arms as one batch, raised and swung when a rider is near (and now and then anyway). */
export class Crowd {
  private wavers: Waver[] = [];
  private colours: THREE.Color[] = [];
  private mesh: THREE.InstancedMesh | null = null;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private one = new THREE.Vector3(1, 1, 1);

  /** Adds a standing figure to `shape` whose right arm waves. */
  add(
    shape: Shape,
    x: number,
    y: number,
    z: number,
    yaw: number,
    r: () => number,
    beach = false,
    shade?: PersonOptions["shade"],
  ): void {
    const p = addPerson(shape, x, y, z, yaw, r, { pose: "stand", beach, armless: true, shade });
    this.wavers.push({ shoulder: p.shoulder, yaw, phase: r() * 20 });
    this.colours.push(p.sleeve);
  }

  /** The arms, once everyone is added (null if nobody waves). */
  build(): THREE.InstancedMesh | null {
    if (this.wavers.length === 0) return null;
    const geo = new THREE.CylinderGeometry(0.056, 0.036, 0.58, 5, 1, true).translate(0, -0.29, 0);
    const mesh = new THREE.InstancedMesh(geo, propMaterial(), this.wavers.length);
    this.colours.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.layers.set(UNREFLECTED);
    mesh.userData.noMerge = true;
    mesh.name = "arms";
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.update(0, []);
    return mesh;
  }

  /** Raises the arms of those with a rider within sight, and swings them. */
  update(t: number, riders: readonly { x: number; z: number }[]): void {
    const mesh = this.mesh;
    if (!mesh) return;
    // Held on twos, like the riders' poses.
    const tt = Math.floor(t * 12) / 12;
    this.wavers.forEach((w, i) => {
      let near = false;
      for (const r of riders) if (Math.hypot(r.x - w.shoulder.x, r.z - w.shoulder.z) < 75) near = true;
      const idle = Math.sin(tt * 0.35 + w.phase) > 0.8;
      const up = near || idle;
      const rx = up ? -2.75 : 0;
      const rz = up ? 0.25 + Math.sin(tt * 9 + w.phase) * 0.4 : 0.1;
      this.q.setFromEuler(this.e.set(rx, w.yaw, rz, "YXZ"));
      this.m.compose(w.shoulder, this.q, this.one);
      mesh.setMatrixAt(i, this.m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }
}

let walking: CelMaterial | null = null;

/**
 * The walkers' material: each figure slides along its beat and back (it
 * turns round at the ends), and of its two strides only the one for where
 * it is in its step is drawn. What a vertex needs rides on it: `walkA`
 * (the beat's start x and z, and its heading as a unit x and z) and
 * `walkB` (the beat's length, the pace in m/s, where in its round it
 * starts (0-1), and which stride the vertex belongs to: 0, 1, or 2 for
 * both).
 */
function walkerMaterial(): CelMaterial {
  if (walking) return walking;
  const m = new CelMaterial({ vertexColors: true, crease: 0.8, darkness: 0.85, id: inkId("prop") });
  m.positionNode = Fn(() => {
    const a = attribute<"vec4">("walkA", "vec4");
    const b = attribute<"vec4">("walkB", "vec4");
    const round = fract(LOOK.time.mul(b.y).div(b.x.mul(2)).add(b.z)).mul(2);
    const back = step(1, round);
    const along = mix(round, float(2).sub(round), back).mul(b.x);
    // Two strides to 1.5 m, each held.
    const gait = step(0.5, fract(along.div(1.5)));
    const shown = mix(mix(float(1).sub(gait), gait, b.w.min(1)), float(1), step(1.5, b.w));
    const facing = float(1).sub(back.mul(2));
    const p = positionLocal;
    const local = p.xz.sub(a.xy).mul(facing).mul(shown);
    const n = normalLocal;
    normalLocal.assign(vec3(n.x.mul(facing), n.y, n.z.mul(facing)));
    const bob = sin(along.mul(Math.PI / 0.75))
      .abs()
      .mul(0.035);
    return vec3(
      a.x.add(local.x).add(a.z.mul(along)),
      mix(float(-4), p.y.add(bob), shown),
      a.y.add(local.y).add(a.w.mul(along)),
    );
  })();
  m.name = "walkers";
  walking = m;
  return m;
}

/** People who walk a beat up and down: all of them one mesh, moved in its shader. */
export class Walkers {
  private shape = new Shape();
  private a: number[] = [];
  private b: number[] = [];

  /**
   * A walker whose beat starts at `(x, y, z)` and runs `span` m along the
   * unit heading `(ux, uz)`, at `pace` m/s; `seed` dresses it (`beach`: for
   * the sand), `ground` is the colour of what it walks on.
   */
  add(
    x: number,
    y: number,
    z: number,
    ux: number,
    uz: number,
    span: number,
    pace: number,
    seed: number,
    ground: THREE.ColorRepresentation,
    beach = false,
  ): void {
    const yaw = Math.atan2(ux, uz);
    const start = (random(seed + 5)() * 0.9) % 1;
    const mark = (from: number, stride: number) => {
      for (let i = from; i < this.shape.triangles * 3; i++) {
        this.a.push(x, z, ux, uz);
        this.b.push(span, pace, start, stride);
      }
    };
    for (const [stride, lead] of [
      [0, 1],
      [1, -1],
    ] as const) {
      const from = this.shape.triangles * 3;
      addPerson(this.shape, x, y, z, yaw, random(seed), { pose: "walk", step: lead, beach });
      mark(from, stride);
    }
    // Its shade goes with it.
    const from = this.shape.triangles * 3;
    const tone = new THREE.Color(ground).multiply(SHADE_TONE);
    const centre = new THREE.Vector3(x + 0.12, y + 0.03, z + 0.08);
    for (let i = 0; i < 8; i++) {
      const p0 = (i / 8) * Math.PI * 2;
      const p1 = ((i + 1) / 8) * Math.PI * 2;
      this.shape.tri(
        centre.clone(),
        new THREE.Vector3(centre.x + Math.cos(p1) * 0.36, centre.y, centre.z + Math.sin(p1) * 0.3),
        new THREE.Vector3(centre.x + Math.cos(p0) * 0.36, centre.y, centre.z + Math.sin(p0) * 0.3),
        tone,
      );
    }
    mark(from, 2);
  }

  /** The walkers as a mesh (null if there are none). */
  build(): THREE.Mesh | null {
    if (this.shape.triangles === 0) return null;
    const mesh = this.shape.mesh(walkerMaterial(), "none");
    mesh.geometry.setAttribute("walkA", new THREE.Float32BufferAttribute(this.a, 4));
    mesh.geometry.setAttribute("walkB", new THREE.Float32BufferAttribute(this.b, 4));
    mesh.name = "walkers";
    // (Every walker on a circuit can be drawn as one.)
    mesh.userData.noMerge = false;
    mesh.layers.set(UNREFLECTED);
    // (They move in the shader: their bounds are their beats'.)
    mesh.frustumCulled = false;
    return mesh;
  }
}

/** What a walker's shade does to the ground's colour. */
const SHADE_TONE = new THREE.Color(0.66, 0.65, 0.8);
