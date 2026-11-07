// The circuits and the conditions a race can be run in, as the menus and
// the lobby need them: which seasons each circuit rides, each season's
// climate and daylight, and the plan a room asks the race server for. The
// sim (`crates/sim/src/conditions.rs`) draws the races; these tables mirror
// its own, and a fixture both sides render (`test/conditions.txt`) keeps
// them equal.

/** The seasons, in wire order (`sim::Season`), which is also the Tilt's. */
export const SEASONS = ["summer", "fall", "winter", "spring"] as const;
export type Season = (typeof SEASONS)[number];

/** The weathers, in wire order (`sim::Weather`). */
export const WEATHERS = ["clear", "cloudy", "windy", "fog", "rain", "storm", "snow"] as const;
export type Weather = (typeof WEATHERS)[number];

/** The named times of day the menus offer. */
export const TIMES_OF_DAY = ["dawn", "morning", "noon", "afternoon", "dusk"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export type CircuitSport = "jetski" | "snow";

export interface Circuit {
  /** `sim::CourseId`. */
  id: number;
  /** Its name's key in the menus' text. */
  key: string;
  sport: CircuitSport;
}

/** Every circuit, in id order (`sim::CourseId::ALL`). */
export const CIRCUITS: readonly Circuit[] = [
  { id: 0, key: "bay", sport: "jetski" },
  { id: 1, key: "mountain", sport: "snow" },
  { id: 3, key: "glades", sport: "snow" },
];

export const circuit = (id: number): Circuit | undefined => CIRCUITS.find((c) => c.id === id);

/** The seasons each sport rides. */
export const SPORT_SEASONS: Record<CircuitSport, readonly Season[]> = {
  jetski: SEASONS,
  snow: ["fall", "winter", "spring"],
};

/** Each season's climate: the weight of each weather (in `WEATHERS` order); 0 never comes up. */
export const CLIMATE: Record<Season, readonly number[]> = {
  summer: [7, 2, 2, 1, 0, 1, 0],
  fall: [3, 3, 2, 2, 3, 3, 1],
  winter: [4, 3, 2, 1, 1, 1, 4],
  spring: [5, 3, 2, 1, 2, 1, 1],
};

/** The weathers a season brings. */
export const weathersIn = (season: Season): Weather[] => WEATHERS.filter((_, i) => (CLIMATE[season][i] ?? 0) > 0);

/** Ten-minute steps in a day, and noon (times are local solar time in these steps from midnight). */
export const STEPS_PER_DAY = 144;
export const NOON = 72;

/** The first and last start time of a race in each season (dawn to dusk). */
export const DAYLIGHT: Record<Season, readonly [number, number]> = {
  summer: [32, 111],
  fall: [39, 104],
  winter: [47, 96],
  spring: [39, 104],
};

/** The start time of a named time of day in a season. */
export function timeOf(season: Season, named: TimeOfDay): number {
  const [first, last] = DAYLIGHT[season];
  const times: Record<TimeOfDay, number> = {
    dawn: first,
    morning: Math.floor((first + NOON) / 2),
    noon: NOON,
    afternoon: Math.floor((NOON + last) / 2),
    dusk: last,
  };
  return times[named];
}

/** The named time of day closest to a start time. */
export function namedTime(season: Season, time: number): TimeOfDay {
  let best: TimeOfDay = "noon";
  for (const n of TIMES_OF_DAY)
    if (Math.abs(timeOf(season, n) - time) < Math.abs(timeOf(season, best) - time)) best = n;
  return best;
}

/** One race as asked for: each field picked (wire numbers), or left out to be drawn. */
export interface RaceSpec {
  course?: number;
  season?: number;
  weather?: number;
  turns?: number;
  time?: number;
}

/** What a room races: the Tilt (everything drawn), or one race. */
export type PlanRequest = { tilt: true } | { tilt: false; race: RaceSpec };

export const TILT: PlanRequest = { tilt: true };

const isInt = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < max;

/**
 * A race spec with only what fits: a known circuit, a season its sport
 * rides, weathers the season brings and a time in its daylight (the race
 * server draws the rest).
 */
export function cleanSpec(v: unknown): RaceSpec {
  const o: Record<string, unknown> = {};
  if (typeof v === "object" && v !== null)
    for (const k of ["course", "season", "weather", "turns", "time"]) o[k] = Reflect.get(v, k);
  const spec: RaceSpec = {};
  const c = isInt(o.course, 256) ? circuit(o.course) : undefined;
  if (c) spec.course = c.id;
  if (isInt(o.season, SEASONS.length)) {
    const season = SEASONS[o.season]!;
    if (!c || SPORT_SEASONS[c.sport].includes(season)) spec.season = o.season;
  }
  const season = spec.season === undefined ? undefined : SEASONS[spec.season]!;
  for (const k of ["weather", "turns"] as const) {
    const w = o[k];
    if (isInt(w, WEATHERS.length) && (!season || (CLIMATE[season][w] ?? 0) > 0)) spec[k] = w;
  }
  if (isInt(o.time, STEPS_PER_DAY)) {
    const [first, last] = season ? DAYLIGHT[season] : [0, STEPS_PER_DAY - 1];
    spec.time = Math.min(last, Math.max(first, o.time));
  }
  return spec;
}

/** A plan request from untrusted JSON, or null if it isn't one. */
export function parsePlan(v: unknown): PlanRequest | null {
  if (typeof v !== "object" || v === null) return null;
  const tilt: unknown = Reflect.get(v, "tilt");
  if (tilt === true) return TILT;
  if (tilt !== false) return null;
  return { tilt: false, race: cleanSpec(Reflect.get(v, "race")) };
}

/** The fixture the sim renders too (`crates/sim/src/conditions.rs`): one line per fact. */
export function conditionsFixture(): string {
  const lines: string[] = [];
  for (const c of CIRCUITS) lines.push(`circuit ${c.id} ${c.sport}`);
  for (const sport of ["jetski", "snow"] as const)
    lines.push(`sport ${sport} ${SPORT_SEASONS[sport].map((s) => SEASONS.indexOf(s)).join(" ")}`);
  for (const [i, s] of SEASONS.entries()) {
    const [first, last] = DAYLIGHT[s];
    const times = TIMES_OF_DAY.map((n) => timeOf(s, n)).join(" ");
    lines.push(`season ${i} climate ${CLIMATE[s].join(" ")} daylight ${first} ${last} times ${times}`);
  }
  return `${lines.join("\n")}\n`;
}
