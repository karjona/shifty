// A rider standing about, off the board: the menus' character (the main
// menu, the creator, the wardrobe, the club), dressed for a sport, with a
// slow idle: breathing, a weight shift, a glance.
import * as THREE from "three/webgpu";
import { type Appearance, type Sport, botAppearance } from "@shifty/rider";
import { RiderFigure } from "./rider/model.ts";
import { crossedPose, idlePose } from "./rider/poses.ts";

/** Anime motion: poses are held on twos (12 a second), not tweened. */
const ON_TWOS = 12;

export class Avatar {
  readonly mesh = new THREE.Group();
  private figure: RiderFigure;
  private t: number;
  /** Arms crossed, as on a character select (else standing about). */
  crossed = false;

  /** Without an appearance, a rider made up for the seat. */
  constructor(appearance: Appearance | null, slot: number, sport: Sport = "summer") {
    this.t = slot * 2.7;
    this.figure = new RiderFigure(appearance ?? botAppearance(1, slot), sport);
    this.figure.onBuilt = () => this.update(0);
    this.mesh.add(this.figure.group);
  }

  /** Dresses the avatar (rebuilt only when something changed). */
  set(appearance: Appearance, sport: Sport): void {
    this.figure.set(appearance, sport);
  }

  /** Idle for `dt` seconds. */
  update(dt: number): void {
    this.t += dt;
    const t = Math.floor(this.t * ON_TWOS) / ON_TWOS;
    if (this.figure.body) this.figure.pose((this.crossed ? crossedPose : idlePose)(this.figure.body, t));
  }

  dispose(): void {
    this.figure.dispose();
  }
}
