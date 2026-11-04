// A rider standing about, off the board: the menus' character (the main
// menu, the creator, the wardrobe, the club), dressed for a sport, with a
// slow idle: breathing, a weight shift, a glance.
import * as THREE from "three/webgpu";
import { type Appearance, type Sport, botAppearance } from "@shifty/rider";
import { RiderMesh, STYLES } from "./rider/model.ts";
import { idlePose } from "./rider/poses.ts";
import { prototypeGarments } from "./rider/prototype-kit.ts";

export class Avatar {
  readonly mesh = new THREE.Group();
  private rider: RiderMesh | null = null;
  private t: number;
  private key = "";

  /** Without an appearance, a rider made up for the seat. */
  constructor(appearance: Appearance | null, slot: number, sport: Sport = "summer") {
    this.t = slot * 2.7;
    this.set(appearance ?? botAppearance(1, slot), sport);
  }

  /** Dresses the avatar (rebuilt only when something changed). */
  set(appearance: Appearance, sport: Sport): void {
    const key = JSON.stringify([appearance, sport]);
    if (key === this.key) return;
    this.key = key;
    if (this.rider) {
      this.rider.group.removeFromParent();
      this.rider.dispose();
    }
    this.rider = new RiderMesh(appearance.look, prototypeGarments(sport, appearance.outfits[sport]), STYLES.n64);
    this.mesh.add(this.rider.group);
    this.update(0);
  }

  /** Idle for `dt` seconds. */
  update(dt: number): void {
    this.t += dt;
    if (this.rider) this.rider.rig.apply(idlePose(this.rider.anatomy, this.t));
  }

  dispose(): void {
    this.rider?.dispose();
  }
}
