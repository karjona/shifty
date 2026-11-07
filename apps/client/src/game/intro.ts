// The start of a race on screen. While the race waits on the grid for every
// screen, and through its intro, the fly-over and the title card have the
// screen (the HUD stays off); the intro ends behind your rider, and the
// countdown runs on the chase camera.
import { messages } from "../i18n/index.ts";
import type { CameraShot, Environment } from "../render/world.ts";
import type { RaceView } from "../ui/hud.ts";
import { IntroCard, type IntroFacts } from "../ui/intro-card.ts";
import type { CourseInfo } from "../wasm-json.ts";
import { courseName } from "./courses.ts";
import { Flyover } from "./flyover.ts";
import { seasonOf } from "./season-change.ts";
import { PALETTE } from "./seasons.ts";

/** `sim::Phase`: waiting on the grid, and the intro. */
export const GRID = 0;
export const INTRO = 4;

/** The card leaves this long (s) before the intro ends, as the camera comes down behind your rider. */
const CARD_LEAVES = 1.6;
/** Dev: how long a pinned intro is taken to be (`sim::race::tuning::INTRO_TICKS`). */
const PINNED_SECONDS = 7;

/** The race as the intro needs it. */
export type IntroRace = RaceView & { course: number; eventIndex: number; eventCount: number };

export class RaceIntro {
  private card: IntroCard;
  private flyover: Flyover | null = null;
  private info: CourseInfo | null = null;
  private course = -1;
  /** What the card says now (course, race of the plan, language). */
  private said = "";
  /** Dev: the intro's camera held this many seconds in, whatever the race is doing (test shots). */
  pinned: number | null = null;

  constructor(root: HTMLElement) {
    this.card = new IntroCard(root);
  }

  /** The course on screen, once it is built. */
  setCourse(course: number, info: CourseInfo, env: Environment): void {
    this.course = course;
    this.info = info;
    this.flyover = new Flyover(info, env);
  }

  /** The start has the screen: the race waits on the grid, or the intro runs. */
  static active(phase: number): boolean {
    return phase === GRID || phase === INTRO;
  }

  /**
   * Per frame. `drawn`: this race's course is built and drawn; `covered`:
   * a season card is over it; `tick`: the fractional sim tick drawn; `now`:
   * ms. Returns the camera, or null for the chase camera.
   */
  frame(race: IntroRace, drawn: boolean, covered: boolean, tick: number, now: number): CameraShot | null {
    const flyover = this.flyover;
    if (import.meta.env.DEV && this.pinned !== null && drawn && flyover) {
      this.describe(race);
      this.card.show(!covered && this.pinned < PINNED_SECONDS - CARD_LEAVES);
      return flyover.intro(this.pinned, PINNED_SECONDS);
    }
    if (!drawn || !flyover || race.course !== this.course || !RaceIntro.active(race.phase)) {
      this.card.show(false);
      return null;
    }
    this.describe(race);
    if (race.phase === GRID) {
      this.card.show(!covered, true);
      return flyover.waiting(now / 1000);
    }
    const seconds = race.phaseLength / race.tickHz;
    const t = Math.max(0, (tick - race.phaseStart) / race.tickHz);
    this.card.show(!covered && t < seconds - CARD_LEAVES);
    return flyover.intro(t, seconds);
  }

  private describe(race: IntroRace): void {
    const info = this.info;
    const m = messages();
    const key = `${race.course}:${race.eventIndex}:${race.eventCount}:${m.intro.waiting}`;
    if (!info || key === this.said) return;
    this.said = key;
    const i = m.intro;
    const season = seasonOf(race.course);
    const rows: IntroFacts["rows"] = [[i.season, m.seasons[season]]];
    if (info.sport === "snow") {
      rows.push([i.run, i.km((info.run.finishS - info.run.startS) / 1000)]);
      rows.push([i.checkpoints, String(info.run.checkpoints.length)]);
    } else {
      rows.push([i.laps, String(info.bay.laps)]);
      rows.push([i.lap, i.metres(info.bay.length)]);
    }
    this.card.set({
      kicker: race.eventCount > 1 ? i.tilt(race.eventIndex + 1, race.eventCount) : m.place,
      title: courseName(info.id),
      subtitle: race.eventCount > 1 ? `${i.sports[info.sport]} · ${m.place}` : i.sports[info.sport],
      rows,
      accent: `#${PALETTE[season].accent.toString(16).padStart(6, "0")}`,
      waiting: i.waiting,
    });
  }

  remove(): void {
    this.card.remove();
  }
}
