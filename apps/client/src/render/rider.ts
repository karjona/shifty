// A rider on a jetski. The ski follows the sim exactly and is the rider's
// ride in its colourway; the rider on it is render-only and carries
// their own inertia: the knees soak up landings and swells, the body lags
// behind the hull when it speeds up or digs in, and leans into turns with
// the bars. In the air the rider reaches into stunts and back.
import * as THREE from "three/webgpu";
import { type Appearance, type Colourway, botAppearance, item } from "@shifty/rider";
import { Ride } from "./ride/ride.ts";
import { RiderFigure } from "./rider/model.ts";
import { floatPose, type JetskiRide, jetskiPose } from "./rider/ride.ts";
import { StuntHold, blendPose, stuntPose } from "./rider/stunts.ts";
import type { RiderModel, RiderView } from "./world.ts";

export const SLOT_COLORS = [0xff5a36, 0x2bb3ff, 0xffd23f, 0x7ae582, 0xc77dff, 0xff8fab, 0xf4a261, 0xe9edf2];

/** The deck the feet stand on (hull space), the footwells either side of the seat (every model has them there). */
const DECK = new THREE.Vector3(0, 0.5, -0.25);
const FOOTWELL = 0.34;
/** Where the bars turn (hull space), and the grips either side of it (every model has them there). */
const BARS = new THREE.Vector3(0, 1.12, 0.22);
const GRIP = 0.3;
/** How far the bars turn at full lock (rad), and how fast they follow the stick (1/s). */
const BAR_LOCK = 0.4;
const BAR_FOLLOW = 10;

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
export class Spring {
  x = 0;
  v = 0;

  step(target: number, drive: number, dt: number): void {
    this.v += (STIFFNESS * (target - this.x) - DAMPING * this.v + drive) * dt;
    this.x += this.v * dt;
  }
}

/** The ride's colourway, or the seat's colour with a white deck and dark trim. */
function rideColours(appearance: Appearance, slot: number): Colourway {
  const ride = appearance.outfits.summer.ride;
  const it = ride ? item(ride) : undefined;
  return it?.colours ?? [SLOT_COLORS[slot % SLOT_COLORS.length]!, 0xf4f4f0, 0x23262b];
}

export class JetskiModel implements RiderModel {
  readonly mesh = new THREE.Group();
  /** The ski, its bars turning with the stick. */
  private ski: Ride;
  /** The rider, moved off the ski when bailing. */
  private body = new THREE.Group();
  private figure: RiderFigure;
  /** Resolves once the rider's and the ski's art are in. */
  readonly ready: Promise<void>;

  private crouch = new Spring();
  private lean = new Spring();
  private steer = 0;
  private clock = 0;
  private stunt = new StuntHold();
  private lastVel: THREE.Vector3 | null = null;

  /** Without an appearance, a rider made up for the seat. */
  constructor(slot: number, appearance: Appearance | null) {
    const look = appearance ?? botAppearance(1, slot);
    this.ski = new Ride("summer", look.outfits.summer.ride, rideColours(look, slot));
    this.mesh.add(this.ski.group);

    this.figure = new RiderFigure(look, "summer");
    this.figure.group.position.copy(DECK);
    this.body.add(this.figure.group);
    this.mesh.add(this.body);
    this.mesh.rotation.order = "YXZ";
    this.ready = Promise.all([this.figure.ready, this.ski.ready]).then(() => {});
  }

  update(r: RiderView, dt: number): void {
    this.mesh.position.set(r.x, r.y, r.z);
    this.mesh.rotation.set(-r.pitch, r.yaw, r.roll);
    this.clock += dt;

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
    // In a stunt the stick only picked the stunt: the bars stay straight.
    const steer = r.bailing || r.grab > 0 ? 0 : Math.max(-1, Math.min(1, r.steer));
    this.steer += (steer - this.steer) * (1 - Math.exp(-BAR_FOLLOW * dt));
    const bars = -this.steer * BAR_LOCK;
    this.ski.steer(bars);

    const body = this.figure.body;
    if (!body) return;
    if (r.bailing) {
      // Floating on the back in the water beside the ski, head toward the stern.
      this.body.position.set(1.4, -0.35, -0.2);
      this.body.rotation.set(-Math.PI / 2 + 0.25, 0.4, 0);
      this.figure.pose(floatPose(body, this.clock));
      return;
    }
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    const k = this.crouch.x > 0 ? MAX_CROUCH : MAX_STRETCH;
    const crouch = k * Math.tanh(this.crouch.x / k);
    const lean = MAX_LEAN * Math.tanh(this.lean.x / MAX_LEAN);
    // Hull-space points, in the figure's own (unscaled) space.
    const s = this.figure.scale;
    const local = (p: THREE.Vector3) => p.sub(DECK).divideScalar(s);
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bars);
    const grip = (side: number) => local(new THREE.Vector3(side * GRIP, 0, 0).applyQuaternion(turn).add(BARS));
    const foot = (side: number) => local(new THREE.Vector3(side * FOOTWELL, DECK.y, DECK.z));
    const ride: JetskiRide = { feet: [foot(1), foot(-1)], grips: [grip(1), grip(-1)], crouch, lean, steer: this.steer };
    const riding = jetskiPose(body, ride);
    const shown = this.stunt.update(r.grab, r.charge, this.clock);
    const stunt = shown.stunt > 0 ? stuntPose(body, ride, shown.stunt) : null;
    this.figure.pose(stunt ? blendPose(riding, stunt, shown.reach) : riding);
  }

  dispose(): void {
    this.figure.dispose();
    this.ski.dispose();
  }
}
