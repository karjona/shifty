// Between two races of a Grand Prix: the camera lifts away from the course
// as the screen washes over in the next season's colours and its name, the
// next course comes up behind, and the wash clears.
import * as THREE from "three/webgpu";
import { messages } from "../i18n/index.ts";
import type { Engine } from "./engine.ts";

export type Season = "summer" | "fall" | "winter" | "spring";

/** Seconds the camera lifts before the courses swap. */
const LIFT = 1.2;
/** Seconds the season card stays up after the swap. */
const HOLD = 1.8;

export class SeasonChange {
  active = true;
  private t = 0;
  private card: HTMLDivElement;
  private eye: THREE.Vector3;
  private look: THREE.Vector3;
  private swapped = false;

  private engine: Engine;
  private swap: () => void;

  constructor(engine: Engine, season: Season, swap: () => void) {
    this.engine = engine;
    this.swap = swap;
    const cam = engine.world.camera;
    this.eye = cam.position.clone();
    this.look = new THREE.Vector3(0, 0, -30).applyQuaternion(cam.quaternion).add(cam.position);
    const m = messages();
    this.card = document.createElement("div");
    this.card.className = `season-change season-${season}`;
    this.card.innerHTML = `<b></b><span></span>`;
    this.card.querySelector("b")!.textContent = m.seasons[season];
    this.card.querySelector("span")!.textContent = m.place;
    document.body.append(this.card);
    // Next frame, so the fade-in transition runs.
    requestAnimationFrame(() => this.card.classList.add("shown"));
  }

  frame(dt: number): void {
    this.t += dt;
    const k = Math.min(1, this.t / LIFT);
    const ease = k * k * (3 - 2 * k);
    const eye = this.eye.clone().add(new THREE.Vector3(0, 60 * ease, 0));
    eye.lerp(this.look, -0.6 * ease);
    this.engine.world.renderFrom(eye, this.look, performance.now() / 1000, dt, this.engine.world.camera.fov);
    if (this.t >= LIFT && !this.swapped) {
      this.swapped = true;
      this.swap();
      this.active = false;
      setTimeout(() => this.finish(), HOLD * 1000);
    }
  }

  /** Takes the card away without swapping courses (the race is over). */
  cancel(): void {
    this.swapped = true;
    this.finish();
  }

  /** Clears the card (now, or when the hold is over). */
  finish(): void {
    if (!this.swapped) {
      this.swapped = true;
      this.swap();
    }
    this.active = false;
    this.card.classList.remove("shown");
    setTimeout(() => this.card.remove(), 900);
  }
}
