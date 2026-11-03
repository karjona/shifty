// A snowboarder, drawn low-poly. The board follows the sim exactly; the
// rider on it is render-only and posed every frame: regular stance (left
// foot forward, chest to the toe edge), knees that load for a pop and soak
// up landings, a low tuck, sitting back into a skid, arms out for balance
// in the air, a hand on the board for grabs, and a tumble when bailing.
import * as THREE from "three/webgpu";
import { SLOT_COLORS } from "./rider.ts";
import type { RiderModel, RiderView } from "./world.ts";

/** Board size (m) and stance: feet this far either side of the middle. */
const BOARD_LENGTH = 1.55;
const BOARD_WIDTH = 0.27;
const STANCE = 0.27;
/** Leg segments (shin, thigh) and the standing hip height. */
const SHIN = 0.46;
const THIGH = 0.46;
const ANKLE = 0.07;
const STAND = 0.84;
/** Arm segments. */
const UPPER_ARM = 0.3;
const FOREARM = 0.3;

const GRAB_INDY = 1;
const GRAB_NOSE = 2;
const GRAB_TAIL = 3;
const GRAB_MELON = 4;
const GRAB_METHOD = 5;

const PANTS = [0x2d3a4f, 0x3b2f2a, 0x24443a, 0x4a2c3a, 0x2f2f36, 0x3a3a52, 0x4f3a24, 0x26364a];
const SKIN = 0xd9a07a;

const flat = (c: number, rough = 0.8) =>
  new THREE.MeshStandardNodeMaterial({ color: c, roughness: rough, flatShading: true });

/** A damped spring toward a target. */
class Spring {
  x = 0;
  v = 0;
  private stiffness: number;
  private damping: number;
  constructor(stiffness: number, damping: number) {
    this.stiffness = stiffness;
    this.damping = damping;
  }

  step(target: number, drive: number, dt: number): void {
    this.v += (this.stiffness * (target - this.x) - this.damping * this.v + drive) * dt;
    this.x += this.v * dt;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** A box stretched between two points (its local Y runs from `a` to `b`). */
class Limb {
  readonly mesh: THREE.Mesh;
  private dir = new THREE.Vector3();
  constructor(width: number, depth: number, mat: THREE.Material, parent: THREE.Object3D) {
    const geo = new THREE.BoxGeometry(width, 1, depth);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }

  span(a: THREE.Vector3, b: THREE.Vector3): void {
    this.dir.subVectors(b, a);
    const len = this.dir.length();
    this.mesh.position.copy(a);
    this.mesh.scale.set(1, Math.max(len, 1e-3), 1);
    this.mesh.quaternion.setFromUnitVectors(UP, this.dir.multiplyScalar(1 / Math.max(len, 1e-6)));
  }
}

/**
 * Two-bone reach from `root` toward `target`: the middle joint, bent toward
 * `bend`. Writes it into `out`.
 */
function joint(
  root: THREE.Vector3,
  target: THREE.Vector3,
  a: number,
  b: number,
  bend: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const d = target.clone().sub(root);
  const len = Math.min(d.length(), a + b - 1e-3);
  const dir = d.normalize();
  // Distance along the reach to the joint, and how far it sticks out.
  const along = (a * a - b * b + len * len) / (2 * len);
  const out2 = Math.sqrt(Math.max(0, a * a - along * along));
  const side = bend
    .clone()
    .sub(dir.clone().multiplyScalar(bend.dot(dir)))
    .normalize();
  return out.copy(root).addScaledVector(dir, along).addScaledVector(side, out2);
}

export class BoarderModel implements RiderModel {
  readonly mesh = new THREE.Group();
  /** Board and rider, yawed sideways when skidding. */
  private rig = new THREE.Group();
  /** The rider, in "body space": chest toward +Z, left toward +X, from the board's middle. */
  private body = new THREE.Group();
  private board: THREE.Group;

  private legs: [Limb, Limb, Limb, Limb];
  private arms: [Limb, Limb, Limb, Limb];
  private hands: [THREE.Mesh, THREE.Mesh];
  private pelvis: THREE.Mesh;
  private torso: THREE.Group;
  private head: THREE.Group;

  private crouch = new Spring(90, 12);
  private lean = new Spring(60, 10);
  private reach = new Spring(40, 9);
  private skid = new Spring(30, 9);
  private tumble = 0;
  private lastVel: THREE.Vector3 | null = null;

  constructor(slot: number) {
    const color = SLOT_COLORS[slot % SLOT_COLORS.length]!;
    const jacket = flat(color, 0.7);
    const pants = flat(PANTS[slot % PANTS.length]!);
    const dark = flat(0x1d2025);
    const skin = flat(SKIN);
    const white = flat(0xf2f2ee);

    // The board: a deck with kicked-up nose and tail, and two bindings.
    this.board = new THREE.Group();
    const deckMat = flat(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35).getHex(), 0.5);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(BOARD_WIDTH, 0.025, BOARD_LENGTH - 0.3), deckMat);
    deck.position.y = 0.0125;
    deck.castShadow = true;
    this.board.add(deck);
    for (const end of [1, -1]) {
      const kick = new THREE.Mesh(new THREE.BoxGeometry(BOARD_WIDTH * 0.96, 0.025, 0.2), deckMat);
      kick.position.set(0, 0.04, end * (BOARD_LENGTH / 2 - 0.1));
      kick.rotation.x = -end * 0.35;
      kick.castShadow = true;
      this.board.add(kick);
      const binding = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.13), dark);
      binding.position.set(0, 0.05, end * STANCE);
      this.board.add(binding);
    }
    this.rig.add(this.board);

    // The rider stands sideways: body space +Z (chest) is the board's -X
    // (the toe edge, on the right of travel), body +X (left) is the nose.
    this.body.rotation.y = -Math.PI / 2;
    this.rig.add(this.body);
    this.legs = [
      new Limb(0.15, 0.17, pants, this.body),
      new Limb(0.17, 0.19, pants, this.body),
      new Limb(0.15, 0.17, pants, this.body),
      new Limb(0.17, 0.19, pants, this.body),
    ];
    for (const x of [STANCE, -STANCE]) {
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.3), dark);
      boot.position.set(x, 0.09, 0.03);
      boot.castShadow = true;
      this.body.add(boot);
    }
    this.pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.18, 0.24), pants);
    this.pelvis.castShadow = true;
    this.body.add(this.pelvis);
    this.torso = new THREE.Group();
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.52, 0.28), jacket);
    chest.position.y = 0.27;
    chest.castShadow = true;
    this.torso.add(chest);
    this.head = new THREE.Group();
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), skin);
    face.position.y = 0.12;
    this.head.add(face);
    const beanie = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.24), flat(color));
    beanie.position.y = 0.25;
    this.head.add(beanie);
    const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.07, 0.04), flat(0x14181f, 0.2));
    goggles.position.set(0, 0.16, 0.115);
    this.head.add(goggles);
    this.head.position.y = 0.56;
    this.torso.add(this.head);
    this.body.add(this.torso);
    this.arms = [
      new Limb(0.12, 0.12, jacket, this.body),
      new Limb(0.11, 0.11, jacket, this.body),
      new Limb(0.12, 0.12, jacket, this.body),
      new Limb(0.11, 0.11, jacket, this.body),
    ];
    this.hands = [
      new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), white),
      new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), white),
    ];
    for (const h of this.hands) {
      h.castShadow = true;
      this.body.add(h);
    }
    this.mesh.add(this.rig);
    this.mesh.rotation.order = "YXZ";
  }

  update(r: RiderView, dt: number): void {
    this.mesh.position.set(r.x, r.y, r.z);
    this.mesh.rotation.set(-r.pitch, r.yaw, r.roll);

    // Body springs: knees soak up the board's vertical bumps, the body lags
    // on speed changes.
    const vel = new THREE.Vector3(r.vx, r.vy, r.vz);
    let up = 0;
    let forward = 0;
    if (this.lastVel && dt > 0 && dt < 0.1 && !r.bailing) {
      const acc = vel.clone().sub(this.lastVel).divideScalar(dt).clampLength(0, 60);
      up = r.grounded ? acc.y : 0;
      forward = acc.x * Math.sin(r.yaw) + acc.z * Math.cos(r.yaw);
    }
    this.lastVel = vel;
    const tuck = Math.max(0, r.lean);
    const brake = Math.max(0, -r.lean);
    const crouchTarget = r.bailing ? 0.3 : !r.grounded ? (r.grab ? 0.62 : 0.32) : 0.22 + tuck * 0.38 + r.charge * 0.5;
    this.crouch.step(Math.min(0.85, crouchTarget), 0.012 * up, dt);
    this.lean.step(r.grounded ? tuck * 0.5 - brake * 0.35 : 0.1, -0.02 * forward, dt);
    this.reach.step(r.grounded ? 0 : 1, 0, dt);
    // Sitting back throws the board sideways into a skid (drawn only).
    this.skid.step(r.grounded && !r.bailing && r.speed > 3 ? brake * 0.9 * (r.steer >= 0 ? 1 : -1) : 0, 0, dt);
    this.rig.rotation.y = this.skid.x;

    // Bailing: the rider goes down beside the board.
    this.tumble += ((r.bailing ? 1 : 0) - this.tumble) * (1 - Math.exp(-dt * (r.bailing ? 9 : 4)));
    this.pose(Math.max(0, Math.min(0.85, this.crouch.x)), this.lean.x, this.reach.x, r.grab, dt);
    this.body.position.set(-0.55 * this.tumble, -0.15 * this.tumble, 0);
    this.body.rotation.set(0, -Math.PI / 2, 0);
    this.body.rotateX(-1.45 * this.tumble);
    this.board.rotation.z = this.tumble * 0.3;
  }

  /** Places the limbs for a crouch (0-0.85), a lean (+ forward), arms out (`spread`) and a grab. */
  private pose(crouch: number, lean: number, spread: number, grab: number, _dt: number): void {
    const hipY = STAND - crouch * 0.42 + (grab ? 0.08 : 0);
    // Hips sit back over the heels a little, more when crouched or sitting back.
    const hipZ = -0.06 - crouch * 0.1 - Math.max(0, -lean) * 0.15;
    const knee = new THREE.Vector3();
    const bend = new THREE.Vector3(0, 0, 1);
    for (const [i, side] of [
      [0, 1],
      [2, -1],
    ] as const) {
      // Grabbing pulls the knees (and the board) up toward the chest.
      const foot = new THREE.Vector3(side * STANCE, ANKLE + (grab ? 0.06 : 0), 0.02);
      const hip = new THREE.Vector3(side * 0.12, hipY, hipZ);
      joint(foot, hip, SHIN, THIGH, bend, knee);
      this.legs[i].span(foot, knee);
      this.legs[i + 1]!.span(knee, hip);
    }
    this.pelvis.position.set(0, hipY + 0.04, hipZ);
    this.pelvis.rotation.y = 0.35;
    // Torso: leans toward the toes (forward) as the knees bend, upright in
    // the air, further forward tucked.
    const tilt = 0.25 + crouch * 0.55 + lean * 0.5;
    this.torso.position.set(0, hipY + 0.1, hipZ);
    // Shoulders open toward the nose (down the run), so from behind you
    // see the rider's back.
    this.torso.rotation.set(0, 0.85, 0);
    this.torso.rotateX(tilt);
    // Look down the run: toward the nose (body +X).
    this.head.rotation.set(-tilt * 0.6, 0.35, 0);
    this.torso.updateMatrix();

    // Shoulders, in body space.
    const shoulder = (side: number) => new THREE.Vector3(side * 0.25, 0.48, 0).applyMatrix4(this.torso.matrix);
    const elbow = new THREE.Vector3();
    for (const [i, side] of [
      [0, 1],
      [2, -1],
    ] as const) {
      const s = shoulder(side);
      // Riding: front hand toward the nose, back hand low by the hip. In
      // the air: out wide for balance.
      const ride = new THREE.Vector3(side * 0.45, hipY - 0.05 + (side > 0 ? 0.15 : 0), 0.22);
      const wide = new THREE.Vector3(side * 0.85, 0.42 + hipY * 0.6, 0.05);
      let hand = ride.lerp(wide, spread);
      const target = this.grabTarget(grab, side);
      if (target) hand = target;
      joint(s, hand, UPPER_ARM, FOREARM, new THREE.Vector3(side * 0.3, -0.4, -1), elbow);
      this.arms[i].span(s, elbow);
      this.arms[i + 1]!.span(elbow, hand);
      this.hands[i / 2]!.position.copy(hand);
    }
  }

  /** Where a hand goes for a grab (body space), if this hand does the grab. */
  private grabTarget(grab: number, side: number): THREE.Vector3 | null {
    const front = side > 0;
    const edge = 0.16;
    switch (grab) {
      case GRAB_INDY:
        return front ? null : new THREE.Vector3(-0.05, 0.12, edge);
      case GRAB_NOSE:
        return front ? new THREE.Vector3(BOARD_LENGTH / 2 - 0.12, 0.12, 0) : null;
      case GRAB_TAIL:
        return front ? null : new THREE.Vector3(-BOARD_LENGTH / 2 + 0.12, 0.12, 0);
      case GRAB_MELON:
      case GRAB_METHOD:
        return front ? new THREE.Vector3(0.05, 0.14, -edge) : null;
      default:
        return null;
    }
  }
}
