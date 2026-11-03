// A rider on a jetski, drawn as boxes. The ski follows the sim exactly; the
// body on top is render-only and carries its own inertia: the knees soak up
// landings and swells, and the body lags behind the hull when it speeds up
// or digs in.
import * as THREE from "three/webgpu";
import type { RiderView } from "./world.ts";

const SLOT_COLORS = [0xff5a36, 0x2bb3ff, 0xffd23f, 0x7ae582, 0xc77dff, 0xff8fab, 0xf4a261, 0xe9edf2];

/** Leg length and the feet's place on the deck, in hull space. */
const LEGS = 0.55;
const FEET = new THREE.Vector3(0, 0.675, -0.35);

/** Body springs: stiffness (1/s²) and damping (1/s). */
const STIFFNESS = 80;
const DAMPING = 11;
/** Knee bend per m/s² of upward hull acceleration, and lean per m/s² of forward acceleration (rad). */
const CROUCH_GAIN = 0.8;
const LEAN_GAIN = 1.3;
/** Hull accelerations past this are clipped (network corrections, respawns). */
const MAX_ACCEL = 70;
/** Knee bend held in the air. */
const AIR_TUCK = 0.12;
/** Soft limits: knee bend and stretch (fraction of leg length), lean (rad). */
const MAX_CROUCH = 0.4;
const MAX_STRETCH = 0.06;
const MAX_LEAN = 0.35;

/** One axis of the rider's body: a damped spring driven by the hull's motion. */
class Spring {
  x = 0;
  v = 0;

  step(target: number, drive: number, dt: number): void {
    this.v += (STIFFNESS * (target - this.x) - DAMPING * this.v + drive) * dt;
    this.x += this.v * dt;
  }
}

function part(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  parent: THREE.Group,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

export class RiderModel {
  readonly mesh = new THREE.Group();
  /** The whole rider, moved off the ski when bailing. */
  private body = new THREE.Group();
  /** Pivots at the feet: leans the rider fore and aft. */
  private pose = new THREE.Group();
  private legs: THREE.Mesh;
  /** Hips up: torso and head, tipped forward as the knees bend. */
  private upper = new THREE.Group();

  private crouch = new Spring();
  private lean = new Spring();
  private lastVel: THREE.Vector3 | null = null;

  constructor(slot: number) {
    const colour = SLOT_COLORS[slot % SLOT_COLORS.length];
    const paint = new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.45 });
    const white = new THREE.MeshStandardNodeMaterial({ color: 0xf4f4f0, roughness: 0.6 });
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x23262b, roughness: 0.7 });
    // Hull (the rider position is the bottom of the hull), nose, seat.
    part(new THREE.BoxGeometry(1.1, 0.5, 2.5), paint, this.mesh, 0, 0.25, -0.1);
    const nose = part(new THREE.BoxGeometry(0.9, 0.42, 0.7), white, this.mesh, 0, 0.3, 1.25);
    nose.rotation.x = 0.35;
    part(new THREE.BoxGeometry(0.5, 0.2, 1.0), dark, this.mesh, 0, 0.6, -0.3);
    // Rider, standing slightly back: legs from the feet up, then torso and head.
    const legs = new THREE.BoxGeometry(0.42, LEGS, 0.3);
    legs.translate(0, LEGS / 2, 0);
    this.legs = part(legs, dark, this.pose, 0, 0, 0);
    part(new THREE.BoxGeometry(0.5, 0.6, 0.32), paint, this.upper, 0, 0.3, 0.1);
    part(new THREE.SphereGeometry(0.2, 10, 8), white, this.upper, 0, 0.75, 0.13);
    this.upper.position.y = LEGS;
    this.pose.add(this.upper);
    this.pose.position.copy(FEET);
    this.body.add(this.pose);
    this.mesh.add(this.body);
    this.mesh.rotation.order = "YXZ";
  }

  update(r: RiderView, dt: number): void {
    this.mesh.position.set(r.x, r.y, r.z);
    this.mesh.rotation.set(-r.pitch, r.yaw, r.roll);
    if (r.bailing) {
      // The rider lies in the water beside the ski.
      this.body.position.set(1.3, -1.1, -0.4);
      this.body.rotation.set(0.3, 0, 1.45);
    } else {
      this.body.position.set(0, 0, 0);
      this.body.rotation.set(0, 0, 0);
    }

    const vel = new THREE.Vector3(r.vx, r.vy, r.vz);
    if (this.lastVel && dt > 0 && dt < 0.1 && !r.bailing) {
      const acc = vel.clone().sub(this.lastVel).divideScalar(dt).clampLength(0, MAX_ACCEL);
      const forward = acc.x * Math.sin(r.yaw) + acc.z * Math.cos(r.yaw);
      // Free fall is not felt; in the air the rider just tucks a little.
      const up = r.grounded ? acc.y : 0;
      this.crouch.step(r.grounded ? 0 : AIR_TUCK, CROUCH_GAIN * up, dt);
      this.lean.step(0, -LEAN_GAIN * forward, dt);
    } else if (r.bailing) {
      this.crouch.x = this.crouch.v = this.lean.x = this.lean.v = 0;
    }
    this.lastVel = vel;

    const k = this.crouch.x > 0 ? MAX_CROUCH : MAX_STRETCH;
    const c = k * Math.tanh(this.crouch.x / k);
    const l = MAX_LEAN * Math.tanh(this.lean.x / MAX_LEAN);
    this.legs.scale.y = 1 - c;
    this.upper.position.y = LEGS * (1 - c);
    this.upper.rotation.x = c * 0.9;
    this.pose.rotation.x = l;
  }
}
