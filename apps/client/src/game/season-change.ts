// The season card: the screen washed over in a season's colours, with its
// name and the place. It covers a course while it loads (joining a race),
// and between two races of a Tilt, where the camera lifts away from
// the course as the card washes over, the next course loads behind it, and
// the card clears. While something loads behind it, a bar under the place
// says what and how far along (see loading.ts).
import * as THREE from "three/webgpu";
import { messages } from "../i18n/index.ts";
import { type Step, type Wait, cardWait, closeCard } from "../loading.ts";
import { circuit } from "@shifty/rider";
import { type Season, circuitName } from "./conditions.ts";
import type { Engine } from "./engine.ts";

export type { Season } from "./conditions.ts";

/** Seconds the camera lifts before the courses swap. */
const LIFT = 1.2;
/** Seconds the season card stays up after the swap, at least. */
const HOLD = 1.8;
/** The card's fade (see .season-change in menu.css). */
const FADE_MS = 900;

/** What the card says under the season: the circuit, if known, and the place. */
function where(course: number | null): string {
  const m = messages();
  return course === null ? m.place : `${circuitName(course, circuit(course)?.sport ?? "jetski")} · ${m.place}`;
}

/** The card itself, under the menus (the race menu, the status): up until `hide`. */
/** What loading a course goes through (after joining, when the card covers that too). */
export const COURSE_STEPS: Step[] = ["art", "scene", "shaders", "settle"];

/** The wait a course is remembered by (each one loads its own way). */
export const courseWait = (course: number) => `course:${course}`;

export class SeasonCard {
  private el: HTMLDivElement;
  private gone = false;
  private wait: Wait | null = null;

  /** `course`: the course coming up (`sim::CourseId`), if known. */
  constructor(season: Season, fadeIn = true, course: number | null = null) {
    const m = messages();
    this.el = document.createElement("div");
    this.el.className = `season-change season-${season}`;
    this.el.innerHTML =
      `<b></b><span></span>` +
      `<div class="load" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">` +
      `<div class="load-bar"><i class="load-fill"></i></div>` +
      `<div class="load-line"><div class="load-what"></div><div class="load-pct"></div></div></div>`;
    this.el.querySelector<HTMLElement>(".load")!.hidden = true;
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
    this.wait?.rename(courseWait(course));
  }

  /** Shows on its bar what loads behind it from now on (`name` weighs its `plan`'s steps); it fills as the card
   * goes. */
  load(name: string, plan: Step[]): Wait {
    if (this.wait && !this.wait.closed) return this.wait;
    this.el.querySelector<HTMLElement>(".load")!.hidden = false;
    this.wait = cardWait(name, plan, this.el);
    return this.wait;
  }

  /** What loads behind it (null before `load`). */
  get loading(): Wait | null {
    return this.wait;
  }

  /** Fades the card out; resolves once it is gone. */
  hide(): Promise<void> {
    if (this.gone) return Promise.resolve();
    this.gone = true;
    if (this.wait) closeCard(this.wait);
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
  private course: number | null;

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
    this.course = course;
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
    this.card.load(this.course === null ? "course" : courseWait(this.course), COURSE_STEPS);
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
