// A snowboarder. The board follows the sim exactly and wears the colours of
// the rider's board; the rider on it is render-only and posed every frame:
// knees that load for a pop and soak up landings, a low tuck, sitting back
// into a skid, arms out for balance in the air, a hand on the board for
// grabs, rocking heel to toe with arms windmilling after a sketchy landing,
// and a tumble when bailing.
import * as THREE from "three/webgpu";
import { type Appearance, type Colourway, botAppearance, item } from "@shifty/rider";
import { SLOT_COLORS } from "./rider.ts";
import { RiderFigure } from "./rider/model.ts";
import { snowboardPose } from "./rider/ride.ts";
import type { RiderModel, RiderView } from "./world.ts";

/** Board size (m) and stance: feet this far either side of the middle. */
const BOARD_LENGTH = 1.55;
const BOARD_WIDTH = 0.27;
const STANCE = 0.27;
/** The deck's top, where the soles stand (m). */
const DECK = 0.03;
/** How far a grab pulls the board up toward the rider (m). */
const GRAB_LIFT = 0.25;

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

/** The board's colours (deck, bindings, stripe), or the seat's colour with dark bindings. */
function boardColours(appearance: Appearance, slot: number): Colourway {
  const board = appearance.outfits.winter.ride;
  const it = board ? item(board) : undefined;
  return it?.colours ?? [SLOT_COLORS[slot % SLOT_COLORS.length]!, 0x1d2025, 0xf2f2ee];
}

export class BoarderModel implements RiderModel {
  readonly mesh = new THREE.Group();
  /** Board and rider, yawed sideways when skidding. */
  private rig = new THREE.Group();
  /** The rider, in "body space": chest toward +Z, left toward +X, from the board's middle. */
  private body = new THREE.Group();
  private board = new THREE.Group();
  private figure: RiderFigure;

  private crouch = new Spring(90, 12);
  private lean = new Spring(60, 10);
  private reach = new Spring(40, 9);
  private skid = new Spring(30, 9);
  private lift = new Spring(70, 12);
  private tumble = 0;
  /** Time, for the wobble's rocking. */
  private clock = 0;
  private lastVel: THREE.Vector3 | null = null;

  /** Without an appearance, a rider made up for the seat. */
  constructor(slot: number, appearance: Appearance | null) {
    const look = appearance ?? botAppearance(1, slot);
    const [main, second, accent] = boardColours(look, slot);
    const deckMat = flat(main, 0.5);
    const bindingMat = flat(second);
    const stripeMat = flat(accent, 0.5);

    // The board: a deck with kicked-up nose and tail, a stripe, and two bindings.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(BOARD_WIDTH, 0.025, BOARD_LENGTH - 0.3), deckMat);
    deck.position.y = 0.0125;
    deck.castShadow = true;
    this.board.add(deck);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.004, BOARD_LENGTH - 0.4), stripeMat);
    stripe.position.y = 0.027;
    this.board.add(stripe);
    for (const end of [1, -1]) {
      const kick = new THREE.Mesh(new THREE.BoxGeometry(BOARD_WIDTH * 0.96, 0.025, 0.2), deckMat);
      kick.position.set(0, 0.04, end * (BOARD_LENGTH / 2 - 0.1));
      kick.rotation.x = -end * 0.35;
      kick.castShadow = true;
      this.board.add(kick);
      const binding = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.16), bindingMat);
      binding.position.set(0, 0.04, end * STANCE);
      this.board.add(binding);
    }
    this.rig.add(this.board);

    // The rider stands sideways: body space +Z (chest) is the board's -X
    // (the toe edge, on the right of travel), body +X (left) is the nose.
    this.figure = new RiderFigure(look, "winter");
    this.body.add(this.figure.group);
    this.body.rotation.y = -Math.PI / 2;
    this.rig.add(this.body);
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
    this.clock += dt;
    const wobble = r.bailing ? 0 : r.wobble;
    const crouchTarget = r.bailing
      ? 0.3
      : !r.grounded
        ? r.grab
          ? 0.7
          : 0.32
        : 0.22 + tuck * 0.38 + r.charge * 0.5 + wobble * 0.3;
    this.crouch.step(Math.min(0.85, crouchTarget), 0.012 * up, dt);
    this.lean.step(r.grounded ? tuck * 0.5 - brake * 0.35 : 0.1, -0.02 * forward, dt);
    this.reach.step(r.grounded ? wobble : 1, 0, dt);
    // Sitting back throws the board sideways into a skid (drawn only).
    this.skid.step(r.grounded && !r.bailing && r.speed > 3 ? brake * 0.9 * (r.steer >= 0 ? 1 : -1) : 0, 0, dt);
    this.rig.rotation.y = this.skid.x;
    // Grabbing in the air, the knees come up and bring the board to the hand.
    this.lift.step(!r.grounded && !r.bailing && r.grab ? GRAB_LIFT : 0, 0, dt);
    const lift = Math.max(0, this.lift.x);
    this.board.position.y = lift;

    // Bailing: the rider goes down beside the board.
    this.tumble += ((r.bailing ? 1 : 0) - this.tumble) * (1 - Math.exp(-dt * (r.bailing ? 9 : 4)));
    const windmill = wobble * Math.sin(this.clock * 13);
    this.body.position.set(-0.55 * this.tumble, -0.15 * this.tumble, 0);
    this.body.rotation.set(0, -Math.PI / 2, 0);
    // A wobble rocks the rider between the toe and heel edges.
    this.body.rotateX(-1.45 * this.tumble + windmill * 0.28);
    this.board.rotation.z = this.tumble * 0.3;

    const body = this.figure.body;
    if (!body) return;
    this.figure.pose(
      snowboardPose(body, this.figure.scale, {
        stance: STANCE,
        deck: DECK,
        crouch: Math.max(0, Math.min(0.85, this.crouch.x)),
        lean: this.lean.x,
        spread: this.reach.x,
        grab: r.grab,
        windmill,
        length: BOARD_LENGTH,
        lift,
      }),
    );
  }

  dispose(): void {
    this.figure.dispose();
    this.board.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      const m: unknown = o.material;
      if (m instanceof THREE.Material) m.dispose();
    });
  }
}
