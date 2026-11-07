// The wrong-way warning, steadied: the sim's flag says the rider moves
// against the course this tick; the warning goes up once that has held for
// a while, and down once the rider has gone the right way for a while, so
// it never flickers at the edge. Only riding counts: time in the air, in a
// bail or crawling along moves neither way.
import type { RiderView } from "../render/world.ts";
import type { RaceView } from "./hud.ts";

/** `sim::Phase::Racing`. */
const RACING = 2;
/** Seconds of going the wrong way before the warning goes up. */
const SHOW_AFTER = 0.5;
/** Seconds of going the right way before it comes down. */
const HIDE_AFTER = 0.35;
/** Slower than this (m/s), the rider is only crawling (turning round, getting going). */
const CRAWL = 6;

export class WrongWay {
  private shown = false;
  /** Ticks in a row the flag has disagreed with the warning. */
  private streak = 0;
  private lastTick = -1;

  /** Whether the warning is up, for this frame's race and rider. */
  update(race: RaceView, me: RiderView | undefined): boolean {
    const tick = race.phaseStart + race.phaseTicks;
    const ticks = this.lastTick < 0 ? 0 : Math.max(0, Math.min(tick - this.lastTick, race.tickHz));
    this.lastTick = tick;
    if (race.phase !== RACING || !race.racing || !me) {
      this.shown = false;
      this.streak = 0;
      return false;
    }
    if (!me.grounded || me.bailing || me.speed < CRAWL) return this.shown;
    if (race.wrongWay === this.shown) {
      this.streak = 0;
      return this.shown;
    }
    this.streak += ticks;
    if (this.streak >= (this.shown ? HIDE_AFTER : SHOW_AFTER) * race.tickHz) {
      this.shown = !this.shown;
      this.streak = 0;
    }
    return this.shown;
  }
}
