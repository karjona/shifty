// The end of a Tilt: the top three on a podium on the town quay's
// promenade, below the church, with the bay and the sky behind them. The
// champion stands in the middle with both fists up, the others clap and
// wave, confetti falls in the seasons' colours, and a low camera rises
// slowly to the three of them. It is built from what the race left behind
// (names, looks, points), so it needs nothing more from the race server.
import * as THREE from "three/webgpu";
import { type Appearance, type Sport, botAppearance } from "@shifty/rider";
import { Confetti, STEPS, buildPodium } from "../render/podium.ts";
import { championPose, clapPose, wavePose } from "../render/rider/cheer.ts";
import { RiderFigure } from "../render/rider/model.ts";
import type { Pose } from "../render/rider/rig.ts";
import type { Body } from "../render/rider/skeleton.ts";
import { sharedBay } from "./backdrops.ts";
import { disposeTree } from "./dispose.ts";
import type { Engine, Stage } from "./engine.ts";
import type { RosterName, TiltRow } from "../ui/results.ts";
import { type Season, seasonOf } from "./season-change.ts";
import { PALETTE, SEASONS, setAccent } from "./seasons.ts";

export interface PodiumRider {
  slot: number;
  name: string;
  bot: boolean;
  look: Appearance;
  /** Tilt points. */
  points: number;
  me: boolean;
}

/** A finished Tilt: everyone's final standing, best first, and how its last race was ridden. */
export interface PodiumData {
  riders: PodiumRider[];
  /** The last race's season (the accent) and sport (what the riders wear). */
  season: Season;
  sport: Sport;
}

/** The podium of a Tilt from its final standings, the riders' names and looks, and the course it ended on. */
export function podiumData(
  rows: TiltRow[],
  riders: Map<number, RosterName>,
  looks: Map<number, Appearance>,
  mySlot: number,
  course: number,
  sport: "jetski" | "snow",
): PodiumData {
  return {
    riders: rows.map((r) => ({
      slot: r.slot,
      name: riders.get(r.slot)?.name ?? `#${r.slot + 1}`,
      bot: riders.get(r.slot)?.bot ?? false,
      look: looks.get(r.slot) ?? botAppearance(1, r.slot),
      points: r.total,
      me: r.slot === mySlot,
    })),
    season: seasonOf(course),
    sport: sport === "snow" ? "winter" : "summer",
  };
}

/** Where the podium stands (its foot, on the promenade between two palms), facing the town (+z), the bay behind. */
const SPOT = new THREE.Vector3(-24.6, 2.2, 68);
const FACING = 0;
/** The key light, from the camera's left and in front of the riders. */
const SUN = new THREE.Vector3(-14, 60, 22);

/** Anime motion: poses are held on twos (12 a second). */
const ON_TWOS = 12;
/** How long the camera takes to rise to its shot (s). */
const RISE = 7;
/** How long the podium waits for the riders' art before it shows without the late ones (ms). */
const ART_WAIT_MS = 8000;

/** The camera, in the podium's frame (riders face +z): it starts low and close on the champion and rises back,
 * looking up, until all three stand in the shot left of the middle (the standings take the right). It stays in
 * front of the houses behind it. */
const EYE_FROM = new THREE.Vector3(-0.7, 0.5, 3.1);
const EYE_TO = new THREE.Vector3(0.6, 1.0, 7.2);
const LOOK_FROM = new THREE.Vector3(-0.1, 2.3, 0);
const LOOK_TO = new THREE.Vector3(1.25, 1.75, 0);
const FOV_FROM = 40;
const FOV_TO = 47;

const POSES: ((a: Body, t: number) => Pose)[] = [championPose, clapPose, wavePose];

const easeOut = (k: number) => 1 - (1 - k) ** 3;

export class Podium implements Stage {
  private engine: Engine | null = null;
  private group = new THREE.Group();
  private podium: THREE.Group;
  private figures: RiderFigure[] = [];
  private confetti: Confetti;
  private t = 0;
  private eye = new THREE.Vector3();
  private look = new THREE.Vector3();
  private season: Season;
  private markShown: () => void = () => {};
  /** Resolves once the podium is on screen: its art in and drawing smoothly. */
  readonly shown: Promise<void>;

  constructor(data: PodiumData) {
    this.shown = new Promise((resolve) => (this.markShown = resolve));
    this.season = data.season;
    const colours = SEASONS.map((s) => PALETTE[s].accent);
    this.podium = buildPodium(colours, PALETTE[data.season].accent);
    this.confetti = new Confetti([...colours, 0xf6f1e7, 0xf2c14e]);
    this.group.add(this.podium, this.confetti.mesh);
    data.riders.slice(0, STEPS.length).forEach((r, i) => {
      const figure = new RiderFigure(r.look, data.sport);
      const step = STEPS[i]!;
      figure.group.position.set(step.x, step.height, 0.05);
      // The champion faces the camera; the others turn a little toward the middle.
      figure.group.rotation.y = -Math.sign(step.x) * 0.22;
      const pose = POSES[i]!;
      const t = i * 1.7;
      figure.onBuilt = () => {
        if (figure.body) figure.pose(pose(figure.body, t));
      };
      this.group.add(figure.group);
      this.figures.push(figure);
    });
    this.group.position.copy(SPOT);
    this.group.rotation.y = FACING;
    this.group.updateMatrixWorld(true);
  }

  start(engine: Engine): void {
    this.engine = engine;
    setAccent(PALETTE[this.season].accent);
    if (!engine.render) {
      this.markShown();
      return;
    }
    const world = engine.world;
    world.setEnvironment(sharedBay(engine));
    world.setSunOffset(SUN.x, SUN.y, SUN.z);
    world.setShadowBox(8);
    world.scene.add(this.group);
    void (async () => {
      await Promise.race([this.loaded(), new Promise((resolve) => setTimeout(resolve, ART_WAIT_MS))]);
      await engine.settled();
      this.t = 0;
      this.markShown();
    })();
  }

  compile(root?: THREE.Object3D): Promise<void> {
    return this.engine?.world.compile(root) ?? Promise.resolve();
  }

  loaded(): Promise<void> {
    return Promise.all(this.figures.map((f) => f.ready)).then(() => {});
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    this.t += dt;
    const t = this.t;
    const k = easeOut(Math.min(1, t / RISE));
    // Held on twos, like every rider.
    const held = Math.floor(t * ON_TWOS) / ON_TWOS;
    this.figures.forEach((f, i) => {
      if (f.body) f.pose(POSES[i]!(f.body, held + i * 1.7));
    });
    this.confetti.update(t);
    // Once risen, the camera drifts a little from side to side.
    const drift = Math.sin(t * 0.21) * 0.35 * k;
    this.eye.lerpVectors(EYE_FROM, EYE_TO, k);
    this.eye.x += drift;
    this.look.lerpVectors(LOOK_FROM, LOOK_TO, k);
    this.group.localToWorld(this.eye);
    this.group.localToWorld(this.look);
    engine.world.renderFrom(this.eye, this.look, now / 1000, dt, FOV_FROM + (FOV_TO - FOV_FROM) * k);
  }

  stop(): void {
    const world = this.engine?.world;
    this.group.removeFromParent();
    world?.setShadowBox();
    world?.clearEnvironment();
    for (const f of this.figures) f.dispose();
    this.figures = [];
    this.confetti.dispose();
    disposeTree(this.podium);
  }
}

/** The card's fade (see .season-change in menu.css). */
const CARD_FADE_MS = 900;

/**
 * The card that covers the swap from the last race to the podium: the
 * whole year's colours, "The Tilt" and the place. Up until `hide`.
 */
export class PodiumCard {
  private el: HTMLDivElement;
  private gone = false;

  constructor(title: string, place: string) {
    this.el = document.createElement("div");
    this.el.className = "season-change season-year loading";
    const b = document.createElement("b");
    b.textContent = title;
    const span = document.createElement("span");
    span.textContent = place;
    this.el.append(b, span);
    document.body.insertBefore(this.el, document.querySelector("#root"));
    requestAnimationFrame(() => this.el.classList.add("shown"));
  }

  /** Resolves once the card has washed over the screen. */
  covered(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, CARD_FADE_MS));
  }

  hide(): void {
    if (this.gone) return;
    this.gone = true;
    this.el.classList.remove("shown");
    setTimeout(() => this.el.remove(), CARD_FADE_MS);
  }
}
