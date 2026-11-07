// A rider standing about, off the board: the menus' character (the main
// menu, the creator, the wardrobe, the club), dressed for a sport, with a
// slow idle: breathing, a weight shift, a glance. Their ride can stand
// with them: a board on its tail at their side, a jetski parked behind.
import * as THREE from "three/webgpu";
import { type Appearance, type Colourway, type Sport, botAppearance, item } from "@shifty/rider";
import { Ride } from "./ride/ride.ts";
import { RiderFigure } from "./rider/model.ts";
import { crossedPose, idlePose } from "./rider/poses.ts";

/** Anime motion: poses are held on twos (12 a second), not tweened. */
const ON_TWOS = 12;
/** Colours for a ride without an item. */
const PLAIN: Colourway = [0xf2f0ea, 0x1c1d21, 0xd9382e];

/** Where the ride stands, in the rider's frame (facing +z): a board on its tail at the rider's right, a jetski
 * behind them, turned to show its side. */
const STANDS: Record<Sport, { at: THREE.Vector3; turn: THREE.Quaternion }> = {
  winter: {
    at: new THREE.Vector3(-0.5, 0.79, -0.05),
    // Nose up, topsheet to the front, leaning in a little.
    turn: new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, Math.PI - 0.35, -0.08, "YXZ"))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))),
  },
  summer: {
    at: new THREE.Vector3(0.6, 0, -1.7),
    turn: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.15, 0)),
  },
};

export class Avatar {
  readonly mesh = new THREE.Group();
  private figure: RiderFigure;
  private t: number;
  /** Arms crossed, as on a character select (else standing about). */
  crossed = false;
  private appearance: Appearance;
  private sport: Sport;
  private ride: Ride | null = null;
  private stand = new THREE.Group();

  /** Without an appearance, a rider made up for the seat. */
  constructor(appearance: Appearance | null, slot: number, sport: Sport = "summer") {
    this.t = slot * 2.7;
    this.appearance = appearance ?? botAppearance(1, slot);
    this.sport = sport;
    this.figure = new RiderFigure(this.appearance, sport);
    this.figure.onBuilt = () => this.update(0);
    this.mesh.add(this.figure.group);
  }

  /** Resolves once the art has first gone on. */
  get ready(): Promise<void> {
    return this.figure.ready;
  }

  /** How tall the rider stands (m). */
  get height(): number {
    return this.figure.height;
  }

  /** Dresses the avatar (rebuilt only when something changed). */
  set(appearance: Appearance, sport: Sport): void {
    this.appearance = appearance;
    this.sport = sport;
    this.figure.set(appearance, sport);
    if (this.ride) this.putRide();
  }

  /** Shows the ride of the sport they are dressed for with them, or not. */
  showRide(on: boolean): void {
    if (on === (this.ride !== null)) return;
    if (on) {
      this.mesh.add(this.stand);
      this.putRide();
    } else {
      this.ride?.dispose();
      this.ride = null;
      this.stand.removeFromParent();
    }
  }

  private putRide(): void {
    const id = this.appearance.outfits[this.sport].ride;
    const colours = (id ? item(id)?.colours : undefined) ?? PLAIN;
    if (this.ride) this.ride.set(this.sport, id, colours);
    else {
      this.ride = new Ride(this.sport, id, colours);
      this.stand.add(this.ride.group);
    }
    const s = STANDS[this.sport];
    this.stand.position.copy(s.at);
    this.stand.quaternion.copy(s.turn);
  }

  /** Idle for `dt` seconds. */
  update(dt: number): void {
    this.t += dt;
    const t = Math.floor(this.t * ON_TWOS) / ON_TWOS;
    if (this.figure.body) this.figure.pose((this.crossed ? crossedPose : idlePose)(this.figure.body, t));
  }

  dispose(): void {
    this.figure.dispose();
    this.ride?.dispose();
  }
}
