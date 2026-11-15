// The coast's people: simple painted figures (a head and its hair or hat,
// a body, arms and legs) standing, strolling, sitting, lying in the sun or
// fishing off the quay. They are part of the scenery's meshes; the arms of
// those who wave are a batch of their own, raised when a rider comes by.
import * as THREE from "three/webgpu";
import type { Conditions } from "../../game/conditions.ts";
import { UNREFLECTED } from "../cel/material.ts";
import { propMaterial } from "./materials.ts";
import { type Shape, pick } from "./shape.ts";

const SKIN = [0xf0c8a0, 0xe0ac80, 0xc68c5c, 0x8a5a3a, 0xf4d4b4];
const HAIR = [0x2a2420, 0x5a3a22, 0x8a6a3a, 0xd8c8a0, 0x3a3030, 0xb0b0b0];
const SHIRTS = [0xf6f2ea, 0xd94a3a, 0x2f6fb0, 0xf2c14e, 0x3f8a6a, 0xf08a3c, 0x7a5aa8, 0x2a8fb0, 0xe87a9a, 0x3a3f4a];
const LEGS = [0x2f3f5a, 0x4a5568, 0xd8cdb4, 0x6a4a32, 0x2a8fb0, 0xd94a3a, 0xf6f2ea];
const SWIM = [0xd94a3a, 0x2f6fb0, 0xf2c14e, 0x2d8a7a, 0xf08a3c, 0xe87a9a, 0x3a3f4a];
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
}

/** How a figure is dressed. */
interface Dress {
  skin: THREE.Color;
  hair: THREE.Color;
  top: THREE.Color;
  legs: THREE.Color;
  /** Shorts: the shins are bare. */
  shorts: boolean;
  hat: boolean;
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
  };
}

const HEAD = new THREE.SphereGeometry(0.115, 6, 4);
const CAP = new THREE.SphereGeometry(0.125, 6, 3, 0, Math.PI * 2, 0, Math.PI * 0.55);
const BRIM = new THREE.CylinderGeometry(0.24, 0.26, 0.03, 8);

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
  // The hips' height over the root: standing on the feet, sitting on the seat, lying on the back.
  const hip = pose === "lie" ? 0.12 : seated ? 0.1 : 0.84;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  /** A limb's segment hanging from `from`, swung forward by `rx` and out by `rz`; returns where it ends. */
  const seg = (
    from: THREE.Vector3,
    rx: number,
    rz: number,
    len: number,
    w: number,
    colour: THREE.Color,
  ): THREE.Vector3 => {
    q.setFromEuler(e.set(rx, 0, rz));
    m.compose(from, q, new THREE.Vector3(1, 1, 1));
    const geo = new THREE.BoxGeometry(w, len, w * 0.9).translate(0, -len / 2, 0);
    shape.take(geo, colour, root.clone().multiply(m));
    return new THREE.Vector3(0, -len, 0).applyQuaternion(q).add(from);
  };
  // Legs: a thigh and a shin each.
  const stride = pose === "walk" ? 0.38 : pose === "stand" || pose === "cheer" ? 0.04 : 0;
  for (const side of [-1, 1]) {
    const top = new THREE.Vector3(side * 0.09, hip, 0);
    const thigh = seated ? -1.5 : side * stride;
    const knee = seg(top, thigh, 0, 0.42, 0.13, d.legs);
    seg(
      knee,
      seated ? 0.05 : side * stride * 0.4 + (pose === "walk" && side > 0 ? 0.35 : 0),
      0,
      0.42,
      0.1,
      d.shorts ? d.skin : d.legs,
    );
  }
  // The body and the head.
  const lean = pose === "fish" ? 0.25 : pose === "walk" ? 0.06 : 0;
  q.setFromEuler(e.set(lean, 0, 0));
  m.compose(new THREE.Vector3(0, hip, 0), q, new THREE.Vector3(1, 1, 1));
  const body = root.clone().multiply(m);
  shape.take(new THREE.BoxGeometry(0.34, 0.56, 0.2).translate(0, 0.28, 0), d.top, body);
  const neck = new THREE.Matrix4().makeTranslation(0, 0.68, 0.01);
  shape.add(HEAD, d.skin, body.clone().multiply(neck));
  if (d.hat) {
    shape.add(BRIM, STRAW, body.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.76, 0.01)));
    shape.add(CAP, STRAW, body.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.7, 0.01)));
  } else {
    // Hair over the crown and down the back of the head.
    q.setFromEuler(e.set(-0.5, 0, 0));
    shape.add(
      CAP,
      d.hair,
      body
        .clone()
        .multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, 0.685, 0.0), q, new THREE.Vector3(1, 1, 1))),
    );
  }
  // Arms, from the shoulders (in the body's frame).
  const sleeve = d.top;
  const arm = (side: number, rx: number, rz: number) => {
    const from = new THREE.Vector3(side * 0.21, 0.52, 0).applyQuaternion(q.setFromEuler(e.set(lean, 0, 0)));
    from.y += hip;
    const elbow = seg(from, rx, rz, 0.3, 0.09, sleeve);
    seg(elbow, rx * 1.2 + (pose === "fish" ? -0.5 : 0), rz * 0.6, 0.28, 0.075, d.skin);
  };
  const swing = pose === "walk" ? 0.3 : 0;
  if (pose === "cheer") {
    arm(-1, -2.7, -0.35);
    if (!o.armless) arm(1, -2.7, 0.35);
  } else if (pose === "fish") {
    arm(-1, -1.0, 0.1);
    arm(1, -1.0, -0.1);
    // The rod, out over the water.
    q.setFromEuler(e.set(-1.15, 0, 0));
    m.compose(new THREE.Vector3(0.05, hip + 0.42, 0.42), q, new THREE.Vector3(1, 1, 1));
    shape.take(
      new THREE.BoxGeometry(0.025, 3.4, 0.025).translate(0, 1.5, 0),
      new THREE.Color(0x3a3f46),
      root.clone().multiply(m),
    );
  } else {
    arm(-1, swing, -0.1);
    if (!o.armless) arm(1, -swing, 0.1);
  }
  const shoulder = new THREE.Vector3(0.21, hip + 0.52, 0).applyMatrix4(root);
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
  add(shape: Shape, x: number, y: number, z: number, yaw: number, r: () => number, beach = false): void {
    const p = addPerson(shape, x, y, z, yaw, r, { pose: "stand", beach, armless: true });
    this.wavers.push({ shoulder: p.shoulder, yaw, phase: r() * 20 });
    this.colours.push(p.sleeve);
  }

  /** The arms, once everyone is added (null if nobody waves). */
  build(): THREE.InstancedMesh | null {
    if (this.wavers.length === 0) return null;
    const geo = new THREE.BoxGeometry(0.085, 0.6, 0.08).translate(0, -0.3, 0);
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
