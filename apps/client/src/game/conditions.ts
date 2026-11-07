// A race's conditions on screen: the season, the weather (and what it turns
// to along the race) and the time of day, as the sim has them
// (`crates/sim/src/conditions.rs`), plus where the sun stands. The tables
// (seasons, weathers, named times, daylight) come from `@shifty/rider`.
import {
  type CircuitSport,
  NOON,
  SEASONS,
  STEPS_PER_DAY,
  type Season,
  type TimeOfDay,
  WEATHERS,
  type Weather,
  circuit,
  namedTime,
} from "@shifty/rider";
import { messages } from "../i18n/index.ts";

export { SEASONS, TIMES_OF_DAY, WEATHERS, timeOf } from "@shifty/rider";
export type { Season, TimeOfDay, Weather } from "@shifty/rider";

export interface Conditions {
  season: Season;
  /** The weather at the start: a loop's first lap, the top of a run. */
  weather: Weather;
  /** What it turns to: a loop's last lap, the bottom of a run (the same: steady). */
  turns: Weather;
  /** Local solar time at the start, in 10-minute steps from midnight (72 = noon). */
  time: number;
}

/** Costa Nevada's latitude and the Earth's axial tilt, degrees. */
export const LATITUDE = 37;
export const AXIAL_TILT = 23.4;

/** Reads the wire bytes `[season, weather, turns, time]`; null if any is out of range. */
export function parseConditions(bytes: ArrayLike<number>): Conditions | null {
  const season = SEASONS[bytes[0] ?? -1];
  const weather = WEATHERS[bytes[1] ?? -1];
  const turns = WEATHERS[bytes[2] ?? -1];
  const time = bytes[3] ?? -1;
  if (!season || !weather || !turns || !Number.isInteger(time) || time < 0 || time >= STEPS_PER_DAY) return null;
  return { season, weather, turns, time };
}

/** The wire bytes of some conditions. */
export function conditionsBytes(c: Conditions): Uint8Array {
  return Uint8Array.of(SEASONS.indexOf(c.season), WEATHERS.indexOf(c.weather), WEATHERS.indexOf(c.turns), c.time);
}

/** A sport's conditions when nothing says otherwise: a clear noon, in summer on the water and winter on the snow. */
export function homeConditions(sport: CircuitSport): Conditions {
  return { season: sport === "snow" ? "winter" : "summer", weather: "clear", turns: "clear", time: NOON };
}

/** Names one race (a circuit in its conditions): a new key is a new race to build. */
export const eventKey = (course: number, c: Conditions): string =>
  `${course}:${c.season}:${c.weather}:${c.turns}:${c.time}`;

/** Whether two conditions are the same. */
export const sameConditions = (a: Conditions, b: Conditions): boolean =>
  a.season === b.season && a.weather === b.weather && a.turns === b.turns && a.time === b.time;

/** The sun's declination in a season, degrees: the 23.4° tilt at work. */
export function declination(season: Season): number {
  return season === "summer" ? AXIAL_TILT : season === "winter" ? -AXIAL_TILT : 0;
}

/**
 * Where the sun stands at a solar time (10-minute steps; fractions are fine)
 * in a season: `elevation` above the horizon and `azimuth` from north
 * toward east (south, π, at noon), both in radians.
 */
export function sunAt(season: Season, time: number): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  const lat = LATITUDE * rad;
  const dec = declination(season) * rad;
  const h = ((time - NOON) / NOON) * Math.PI;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // From south, positive toward the west; then from north toward east.
  const fromSouth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
  return { elevation, azimuth: fromSouth + Math.PI };
}

/** The named time of day a race starts at (the closest one). */
export const timeOfDay = (c: Conditions): TimeOfDay => namedTime(c.season, c.time);

/** A start time on the clock, "HH:MM". */
export function clockTime(time: number): string {
  const minutes = Math.round(time * 10);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * How far a race's weather has turned (0 = `weather`, 1 = `turns`) at a
 * point of its progress (0 at the start, 1 at the finish; see the sim's
 * `World::weather_progress`): steady through the first part, turning in the
 * middle, settled at the end. On a loop the first lap is all `weather` and
 * the last all `turns`. The same as the sim's `turn_blend`.
 */
export function turnBlend(progress: number, looped: boolean, laps: number): number {
  const [from, to] = looped && laps >= 3 ? [1 / laps, (laps - 1) / laps] : [0.2, 0.8];
  const x = Math.max(0, Math.min(1, (progress - from) / (to - from)));
  return x * x * (3 - 2 * x);
}

/** The weather at a turn of the race (`turn` from `turnBlend`, or the race's `weatherAt`): blending `from` into `to`. */
export function weatherAt(c: Conditions, turn: number): { from: Weather; to: Weather; mix: number } {
  return { from: c.weather, to: c.turns, mix: c.weather === c.turns ? 0 : Math.max(0, Math.min(1, turn)) };
}

/** A circuit's name, by its id (one without a name is named for its sport). */
export function circuitName(course: number, sport: CircuitSport): string {
  const i = messages().intro;
  const names: Record<string, string> = i.courses;
  return names[circuit(course)?.key ?? ""] ?? (sport === "snow" ? i.courses.mountain : i.courses.bay);
}
