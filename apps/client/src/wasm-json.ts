// JSON from our own WASM, parsed defensively anyway: a malformed field
// becomes a default value instead of a crash or a lie in the types.
import type { CourseData } from "./render/course.ts";
import type { RaceEvent, StandingView } from "./ui/hud.ts";

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
  }));
}

export function parseEvents(json: string): RaceEvent[] {
  const out: RaceEvent[] = [];
  for (const o of list(JSON.parse(json))) {
    const kind = o.kind;
    if (kind !== "buoy" && kind !== "lap" && kind !== "finish") continue;
    out.push({
      tick: num(o, "tick"),
      slot: num(o, "slot"),
      kind,
      buoy: num(o, "buoy"),
      ok: o.ok === true,
      meter: num(o, "meter"),
      lap: num(o, "lap"),
      ticks: num(o, "ticks"),
    });
  }
  return out;
}

export function parseCourse(json: string): CourseData {
  const raw: unknown = JSON.parse(json);
  const o = isObj(raw) ? raw : {};
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
  };
}
