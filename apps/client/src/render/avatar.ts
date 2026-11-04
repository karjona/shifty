// A rider standing about, off the board: the menus' character (the main
// menu, the club). Low-poly boxes like the riders on the course, in the
// slot's colours, with a slow idle: breathing, a weight shift, a glance.
import * as THREE from "three/webgpu";
import { SLOT_COLORS } from "./rider.ts";

const PANTS = [0x2d3a4f, 0x3b2f2a, 0x24443a, 0x4a2c3a, 0x2f2f36, 0x3a3a52, 0x4f3a24, 0x26364a];
const SKIN = [0xd9a07a, 0xb57a55, 0xe8c0a0, 0x8d5a3c];
const HAIR = [0x2a1d14, 0x5a3a20, 0x1b1b1b, 0xb08a4a];

const flat = (c: number, rough = 0.8) =>
  new THREE.MeshStandardNodeMaterial({ color: c, roughness: rough, flatShading: true });

function box(w: number, h: number, d: number, mat: THREE.Material, y0 = 0): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  // Pivot at the top (limbs hang from it) unless told otherwise.
  geo.translate(0, -h / 2 + y0, 0);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class Avatar {
  readonly mesh = new THREE.Group();
  private hips = new THREE.Group();
  private chest = new THREE.Group();
  private head = new THREE.Group();
  private arms: [THREE.Group, THREE.Group];
  private legs: [THREE.Group, THREE.Group];
  private t: number;

  constructor(slot: number) {
    this.t = slot * 2.7;
    const jacket = flat(SLOT_COLORS[slot % SLOT_COLORS.length]!, 0.7);
    const pants = flat(PANTS[slot % PANTS.length]!);
    const skin = flat(SKIN[slot % SKIN.length]!);
    const hair = flat(HAIR[slot % HAIR.length]!);
    const shoes = flat(0xeeeeea, 0.6);
    const dark = flat(0x16181c, 0.3);

    this.hips.position.y = 0.92;
    this.mesh.add(this.hips);
    const legs: THREE.Group[] = [];
    for (const side of [1, -1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.11, 0, 0);
      leg.add(box(0.16, 0.86, 0.18, pants));
      const shoe = box(0.15, 0.08, 0.28, shoes, -0.84);
      shoe.position.z = 0.05;
      leg.add(shoe);
      this.hips.add(leg);
      legs.push(leg);
    }
    this.legs = [legs[0]!, legs[1]!];
    this.chest.position.y = 0.02;
    this.hips.add(this.chest);
    const torso = box(0.44, 0.58, 0.26, jacket, 0.6);
    this.chest.add(torso);
    // A zip and a collar make the jacket read as one.
    const zip = box(0.03, 0.5, 0.02, flat(0xf2f2ee, 0.5), 0.56);
    zip.position.z = 0.135;
    this.chest.add(zip);
    const arms: THREE.Group[] = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.29, 0.56, 0);
      arm.add(box(0.13, 0.36, 0.14, jacket));
      const fore = box(0.12, 0.3, 0.13, jacket, -0.36);
      arm.add(fore);
      arm.add(box(0.1, 0.1, 0.1, skin, -0.66));
      this.chest.add(arm);
      arms.push(arm);
    }
    this.arms = [arms[0]!, arms[1]!];
    this.head.position.y = 0.66;
    this.chest.add(this.head);
    this.head.add(box(0.1, 0.08, 0.1, skin, 0.08));
    this.head.add(box(0.26, 0.28, 0.26, skin, 0.36));
    // Hair, a cap's peak, sunglasses.
    this.head.add(box(0.28, 0.1, 0.28, hair, 0.4));
    const peak = box(0.26, 0.03, 0.14, jacket, 0.33);
    peak.position.z = 0.17;
    this.head.add(peak);
    const shades = box(0.24, 0.06, 0.03, dark, 0.27);
    shades.position.z = 0.135;
    this.head.add(shades);
  }

  /** Idle for `dt` seconds. */
  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const breathe = Math.sin(t * 1.6);
    const shift = Math.sin(t * 0.37);
    this.hips.position.x = shift * 0.03;
    this.hips.rotation.z = -shift * 0.03;
    this.chest.rotation.z = shift * 0.04;
    this.chest.scale.set(1 + breathe * 0.008, 1, 1 + breathe * 0.01);
    this.legs[0].rotation.z = 0.04 + shift * 0.03;
    this.legs[1].rotation.z = -0.04 + shift * 0.03;
    this.arms[0].rotation.z = 0.12 + breathe * 0.015;
    this.arms[1].rotation.z = -0.12 - breathe * 0.015;
    this.arms[0].rotation.x = Math.sin(t * 0.5) * 0.05;
    this.arms[1].rotation.x = -Math.sin(t * 0.5) * 0.05;
    // Now and then, a glance to the side.
    const glance = Math.sin(t * 0.23) > 0.8 ? Math.sin(t * 0.23 * 3) * 0.35 : 0;
    this.head.rotation.y += (glance - this.head.rotation.y) * Math.min(1, dt * 3);
  }
}
