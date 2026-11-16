// The last picks on the mode select (the mode, each panel's plan, the bots,
// the time trial's circuit, season, weather and time of day), kept in this browser so they
// survive a race and a reload. The first time in, single player is one race
// on the first circuit.
import {
  CIRCUITS,
  type PlanRequest,
  SEASONS,
  STEPS_PER_DAY,
  type Season,
  TILT,
  WEATHERS,
  type Weather,
  parsePlan,
} from "@shifty/rider";
import type { Mode } from "./api.ts";

const KEY = "shifty.picks";
const MODES: readonly Mode[] = ["trial", "single", "room", "matchmaking"];

export interface Picks {
  mode: Mode;
  single: PlanRequest;
  room: PlanRequest;
  bots: number;
  /** The time trial: its circuit, season and weather, and its time of day (left out: drawn). */
  trial: { course: number; season: Season; weather: Weather; time?: number };
}

const FIRST: Picks = {
  mode: "single",
  single: { tilt: false, race: { course: CIRCUITS[0]?.id ?? 0 } },
  room: TILT,
  bots: 3,
  trial: { course: CIRCUITS[0]?.id ?? 0, season: "summer", weather: "clear" },
};

let picks: Picks | null = null;

/** The picks as last left (checked: anything unknown falls back to the first time's). */
export function lastPicks(): Picks {
  if (picks) return picks;
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    saved = null;
  }
  const get = (k: string): unknown => (typeof saved === "object" && saved !== null ? Reflect.get(saved, k) : undefined);
  const trial = get("trial");
  const course = typeof trial === "object" && trial !== null ? Reflect.get(trial, "course") : undefined;
  const season = typeof trial === "object" && trial !== null ? Reflect.get(trial, "season") : undefined;
  const weather = typeof trial === "object" && trial !== null ? Reflect.get(trial, "weather") : undefined;
  const time: unknown = typeof trial === "object" && trial !== null ? Reflect.get(trial, "time") : undefined;
  const bots = get("bots");
  picks = {
    mode: MODES.find((m) => m === get("mode")) ?? FIRST.mode,
    single: parsePlan(get("single")) ?? FIRST.single,
    room: parsePlan(get("room")) ?? FIRST.room,
    bots: typeof bots === "number" && Number.isInteger(bots) && bots >= 0 && bots <= 7 ? bots : FIRST.bots,
    trial: {
      course: CIRCUITS.find((c) => c.id === course)?.id ?? FIRST.trial.course,
      season: SEASONS.find((s) => s === season) ?? FIRST.trial.season,
      weather: WEATHERS.find((w) => w === weather) ?? FIRST.trial.weather,
      ...(typeof time === "number" && Number.isInteger(time) && time >= 0 && time < STEPS_PER_DAY ? { time } : {}),
    },
  };
  return picks;
}

/** Keeps a change to the picks. */
export function keepPicks(change: Partial<Picks>): Picks {
  picks = { ...lastPicks(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(picks));
  } catch {
    // Private windows may refuse storage: the picks last until the page closes.
  }
  return picks;
}
