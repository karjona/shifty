// The season card: the screen washed over in a season's colours, with its
// name and the place. It covers a course while it loads (joining a race),
// and between two races of a Tilt, where the camera lifts away from
// the course as the card washes over, the next course loads behind it, and
// the card clears.
import * as THREE from "three/webgpu";
import { messages } from "../i18n/index.ts";
import { holdLoading } from "../loading.ts";
import type { Engine } from "./engine.ts";

export type Season = "summer" | "fall" | "winter" | "spring";

/** Seconds the camera lifts before the courses swap. */
const LIFT = 1.2;
/** Seconds the season card stays up after the swap, at least. */
const HOLD = 1.8;
/** The card's fade (see .season-change in menu.css). */
const FADE_MS = 900;

/** The season of a course (`sim::CourseId`). */
export function seasonOf(course: number): Season {
  return course === 1 ? "winter" : "summer";
}

/** Which circuit a course is (`sim::CourseId`), for its name. */
export function circuitOf(course: number): "bay" | "mountain" | "cape" {
  return course === 1 ? "mountain" : course === 2 ? "cape" : "bay";
}

/** What the card says under the season: the circuit, if known, and the place. */
function where(course: number | null): string {
  const m = messages();
  return course === null ? m.place : `${m.intro.courses[circuitOf(course)]} · ${m.place}`;
}

/** The card itself, under the menus (the race menu, the status): up until `hide`. */
export class SeasonCard {
  private el: HTMLDivElement;
  private gone = false;
  private release: (() => void) | null = null;

  /** `course`: the course coming up (`sim::CourseId`), if known. */
  constructor(season: Season, fadeIn = true, course: number | null = null) {
    const m = messages();
    this.el = document.createElement("div");
    this.el.className = `season-change season-${season}`;
    this.el.innerHTML = `<b></b><span></span>`;
    this.el.querySelector("b")!.textContent = m.seasons[season];
    this.el.querySelector("span")!.textContent = where(course);
    document.body.insertBefore(this.el, document.querySelector("#root"));
    if (fadeIn) requestAnimationFrame(() => this.el.classList.add("shown"));
    else this.el.classList.add("shown");
  }

  set season(season: Season) {
    this.el.className = this.el.className.replace(/season-(?:summer|fall|winter|spring)/u, `season-${season}`);
    this.el.querySelector("b")!.textContent = messages().seasons[season];
  }

  /** The course coming up (`sim::CourseId`). */
  set course(course: number) {
    this.el.querySelector("span")!.textContent = where(course);
  }

  /** Puts the loading sign up while something loads behind it. */
  set loading(on: boolean) {
    if (on) this.release ??= holdLoading();
    else {
      this.release?.();
      this.release = null;
    }
  }

  /** Fades the card out; resolves once it is gone. */
  hide(): Promise<void> {
    if (this.gone) return Promise.resolve();
    this.gone = true;
    this.loading = false;
    this.el.classList.remove("shown");
    return new Promise((resolve) =>
      setTimeout(() => {
        this.el.remove();
        resolve();
      }, FADE_MS),
    );
  }
}

export class SeasonChange {
  active = true;
  private t = 0;
  private card: SeasonCard;
  private eye: THREE.Vector3;
  private look: THREE.Vector3;
  private swapped = false;

  private engine: Engine;
  private swap: () => Promise<void>;
  private cleared: () => void;

  /**
   * `swap` puts the next course up behind the card; it clears once that is
   * done, and `cleared` runs once it is gone. `course`: the next course
   * (`sim::CourseId`).
   */
  constructor(
    engine: Engine,
    season: Season,
    swap: () => Promise<void>,
    cleared: () => void = () => {},
    course: number | null = null,
  ) {
    this.engine = engine;
    this.swap = swap;
    this.cleared = cleared;
    const cam = engine.world.camera;
    this.eye = cam.position.clone();
    this.look = new THREE.Vector3(0, 0, -30).applyQuaternion(cam.quaternion).add(cam.position);
    this.card = new SeasonCard(season, true, course);
  }

  frame(dt: number): void {
    this.t += dt;
    const k = Math.min(1, this.t / LIFT);
    const ease = k * k * (3 - 2 * k);
    const eye = this.eye.clone().add(new THREE.Vector3(0, 60 * ease, 0));
    eye.lerp(this.look, -0.6 * ease);
    this.engine.world.renderFrom(eye, this.look, performance.now() / 1000, dt, this.engine.world.camera.fov);
    if (this.t >= LIFT && !this.swapped) this.doSwap();
  }

  private doSwap(): void {
    this.swapped = true;
    this.active = false;
    this.card.loading = true;
    const hold = new Promise((resolve) => setTimeout(resolve, HOLD * 1000));
    void Promise.all([this.swap(), hold]).finally(() => this.card.hide().then(this.cleared));
  }

  /** Takes the card away without swapping courses (the race is over). */
  cancel(): void {
    this.swapped = true;
    this.active = false;
    void this.card.hide();
  }

  /** Swaps now (if it hasn't yet), and clears the card once the next course is up. */
  finish(): void {
    if (!this.swapped) this.doSwap();
  }
}
