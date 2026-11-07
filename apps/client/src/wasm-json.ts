// JSON from our own WASM, parsed defensively anyway: a malformed field
// becomes a default value instead of a crash or a lie in the types.
import type { CourseData } from "./render/course.ts";
import type { GateData, LipData, ObstacleData, RunData, RunPoint, SpineData, TableData } from "./render/mountain.ts";
import type { RaceEvent, StandingView } from "./ui/hud.ts";
import type { RosterName } from "./ui/results.ts";

/** A course (`id`: `sim::CourseId`): the bay (jetski) or a run down the mountain (snowboard). */
export type CourseInfo = { sport: "jetski"; id: number; bay: CourseData } | { sport: "snow"; id: number; run: RunData };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (o: Obj, k: string): number => (typeof o[k] === "number" ? o[k] : 0);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).filter(isObj) : []);

export function parseStandings(json: string): StandingView[] {
  return list(JSON.parse(json)).map((o) => ({
    slot: num(o, "slot"),
    place: num(o, "place"),
    lap: num(o, "lap"),
    finishTicks: num(o, "finishTicks"),
    misses: num(o, "misses"),
    tricks: num(o, "tricks"),
    points: num(o, "points"),
  }));
}

/** Riders' names by seat, and which of them are bots. */
export function parseRosterNames(json: string): Map<number, RosterName> {
  const out = new Map<number, RosterName>();
  for (const o of list(JSON.parse(json))) {
    if (typeof o.slot === "number" && typeof o.name === "string")
      out.set(o.slot, { name: o.name, bot: o.bot === true });
  }
  return out;
}

/** Tilt points by seat. */
export function parseGrandPrix(json: string): Map<number, number> {
  return new Map(list(JSON.parse(json)).map((o) => [num(o, "slot"), num(o, "points")]));
}

export function parseEvents(json: string): RaceEvent[] {
  const out: RaceEvent[] = [];
  for (const o of list(JSON.parse(json))) {
    const kind = o.kind;
    if (
      kind !== "buoy" &&
      kind !== "checkpoint" &&
      kind !== "lap" &&
      kind !== "finish" &&
      kind !== "trick" &&
      kind !== "sketchy" &&
      kind !== "bail"
    )
      continue;
    out.push({
      tick: num(o, "tick"),
      slot: num(o, "slot"),
      kind,
      buoy: num(o, "buoy"),
      ok: o.ok === true,
      meter: num(o, "meter"),
      lap: num(o, "lap"),
      ticks: num(o, "ticks"),
      spin: num(o, "spin"),
      flip: num(o, "flip"),
      roll: num(o, "roll"),
      grab: num(o, "grab"),
      stunt: num(o, "stunt"),
      grabTicks: num(o, "grabTicks"),
      points: num(o, "points"),
      sketchy: o.sketchy === true,
      index: num(o, "index"),
    });
  }
  return out;
}

export function parseCourse(json: string): CourseInfo {
  const raw: unknown = JSON.parse(json);
  const o = isObj(raw) ? raw : {};
  const id = num(o, "id");
  if (o.sport === "snow" && isObj(o.run)) return { sport: "snow", id, run: parseRun(o.run) };
  return { sport: "jetski", id, bay: parseBay(o) };
}

const gate = (v: unknown): GateData => {
  const g = isObj(v) ? v : {};
  return {
    s: num(g, "s"),
    x: num(g, "x"),
    y: num(g, "y"),
    z: num(g, "z"),
    yaw: num(g, "yaw"),
    half: num(g, "half"),
    limit: num(g, "limit"),
  };
};

function parseRun(o: Obj): RunData {
  return {
    length: num(o, "length"),
    startS: num(o, "startS"),
    finishS: num(o, "finishS"),
    startGate: gate(o.startGate),
    finish: gate(o.finish),
    checkpoints: list(o.checkpoints).map(gate),
    path: list(o.path).map((p): RunPoint => ({
      s: num(p, "s"),
      x: num(p, "x"),
      y: num(p, "y"),
      z: num(p, "z"),
      yaw: num(p, "yaw"),
      half: num(p, "half"),
      wall: num(p, "wall"),
      limit: num(p, "limit"),
    })),
    obstacles: list(o.obstacles).map((b): ObstacleData => ({
      x: num(b, "x"),
      y: num(b, "y"),
      z: num(b, "z"),
      radius: num(b, "radius"),
      height: num(b, "height"),
      kind: b.kind === "tower" ? "tower" : b.kind === "rock" ? "rock" : "pine",
    })),
    tables: list(o.tables).map((t): TableData => ({
      s: num(t, "s"),
      lip: num(t, "lip"),
      offset: num(t, "offset"),
      halfWidth: num(t, "halfWidth"),
    })),
    lips: list(o.lips).map((t): LipData => ({
      s: num(t, "s"),
      lip: num(t, "lip"),
      offset: num(t, "offset"),
      halfWidth: num(t, "halfWidth"),
      height: num(t, "height"),
      kind: t.kind === "log" ? "log" : t.kind === "rock" ? "rock" : "wind",
    })),
    spines: list(o.spines).map((t): SpineData => ({
      s: num(t, "s"),
      end: num(t, "end"),
      offset: num(t, "offset"),
      halfWidth: num(t, "halfWidth"),
      height: num(t, "height"),
    })),
  };
}

function parseBay(o: Obj): CourseData {
  const start = isObj(o.start) ? o.start : {};
  return {
    length: num(o, "length"),
    laps: num(o, "laps"),
    straightHalf: num(o, "straightHalf"),
    radius: num(o, "radius"),
    laneHalf: num(o, "laneHalf"),
    breakwaterRadius: num(o, "breakwaterRadius"),
    outerLimit: num(o, "outerLimit"),
    rampSink: num(o, "rampSink"),
    buoyRadius: num(o, "buoyRadius"),
    buoyHeight: num(o, "buoyHeight"),
    riderRadius: num(o, "riderRadius"),
    start: { x: num(start, "x"), z: num(start, "z"), yaw: num(start, "yaw") },
    buoys: list(o.buoys).map((b) => ({
      x: num(b, "x"),
      z: num(b, "z"),
      yaw: num(b, "yaw"),
      keep: b.keep === "left" ? "left" : "right",
    })),
    ramps: list(o.ramps).map((r) => ({
      x: num(r, "x"),
      z: num(r, "z"),
      yaw: num(r, "yaw"),
      length: num(r, "length"),
      width: num(r, "width"),
      height: num(r, "height"),
    })),
    land: list(o.land).map((l) => ({
      ax: num(l, "ax"),
      az: num(l, "az"),
      bx: num(l, "bx"),
      bz: num(l, "bz"),
      radius: num(l, "radius"),
      kind: l.kind === "town" ? "town" : l.kind === "island" ? "island" : "rock",
    })),
  };
}
