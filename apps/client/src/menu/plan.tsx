// What a race plan is, as the menus pick it: the Tilt, or one race whose
// circuit, season, weather and time of day are each picked or left to the
// draw. The pickers offer only what fits together: seasons the circuit's
// sport rides, weathers every season left in play brings, and the named
// times of the season's daylight.
import {
  CIRCUITS,
  type CircuitSport,
  type PlanRequest,
  type RaceSpec,
  SEASONS,
  SPORT_SEASONS,
  type Season,
  TIMES_OF_DAY,
  TILT,
  WEATHERS,
  type Weather,
  circuit,
  cleanSpec,
  namedTime,
  timeOf,
  weathersIn,
} from "@shifty/rider";
import { circuitName } from "../game/conditions.ts";
import { useT } from "../i18n/index.ts";
import { Picker } from "./ui.tsx";

/** The picker's "draw" value. */
const DRAW = -1;

/** The seasons a spec can still come up in. */
function seasonsOf(spec: RaceSpec): readonly Season[] {
  if (spec.season !== undefined) return [SEASONS[spec.season]!];
  const c = spec.course === undefined ? undefined : circuit(spec.course);
  if (c) return SPORT_SEASONS[c.sport];
  return SEASONS;
}

/** The weathers every season still in play brings. */
function weathersOf(spec: RaceSpec): Weather[] {
  const seasons = seasonsOf(spec);
  return WEATHERS.filter((w) => seasons.every((s) => weathersIn(s).includes(w)));
}

/** A spec with only what fits (see `seasonsOf`, `weathersOf`). */
export function fitSpec(spec: RaceSpec): RaceSpec {
  const out = cleanSpec(spec);
  const ok = weathersOf(out);
  if (out.weather !== undefined && !ok.includes(WEATHERS[out.weather]!)) delete out.weather;
  if (out.turns !== undefined && !ok.includes(WEATHERS[out.turns]!)) delete out.turns;
  if (out.season === undefined) delete out.time;
  return out;
}

/** The sports that ride a season, in the menus' words. */
export function seasonSports(season: Season): CircuitSport[] {
  return (["jetski", "snow"] as const).filter((s) => SPORT_SEASONS[s].includes(season));
}

/** The plan in a line: "One race · The Bay · Winter · Storm · Dusk", "Draw" for what's left to chance. */
export function usePlanSummary(plan: PlanRequest): string {
  const t = useT();
  if (plan.tilt) return t.play.events.gp;
  const r = plan.race;
  const c = r.course === undefined ? undefined : circuit(r.course);
  const season = r.season === undefined ? undefined : SEASONS[r.season];
  return [
    t.play.events.race,
    c ? circuitName(c.id, c.sport) : t.room.draw,
    season ? t.seasons[season] : t.room.draw,
    r.weather === undefined ? t.room.draw : t.weathers[WEATHERS[r.weather]!],
    season && r.time !== undefined ? t.timesOfDay[namedTime(season, r.time)] : t.room.draw,
  ].join(" · ");
}

/**
 * The plan's pickers: the Tilt or one race, and for one race its circuit
 * (`fields` "circuit"), or its circuit, season, weather and time of day
 * ("all"), each with "Draw" first.
 */
export function PlanPickers({
  plan,
  onChange,
  fields,
}: {
  plan: PlanRequest;
  onChange: (plan: PlanRequest) => void;
  fields: "event" | "circuit" | "all";
}) {
  const t = useT();
  const spec = plan.tilt ? {} : plan.race;
  const set = (patch: Partial<Record<keyof RaceSpec, number>>) => {
    const next: RaceSpec = { ...spec };
    for (const k of ["course", "season", "weather", "turns", "time"] as const) {
      const v = patch[k];
      if (v === DRAW) delete next[k];
      else if (v !== undefined) next[k] = v;
    }
    onChange({ tilt: false, race: fitSpec(next) });
  };
  const draw = { value: DRAW, label: t.room.draw };
  const season = spec.season === undefined ? undefined : SEASONS[spec.season];
  return (
    <>
      <Picker<"gp" | "race">
        label={t.room.event}
        options={[
          { value: "gp", label: t.play.events.gp },
          { value: "race", label: t.play.events.race },
        ]}
        value={plan.tilt ? "gp" : "race"}
        onChange={(v) => onChange(v === "gp" ? TILT : { tilt: false, race: plan.tilt ? {} : spec })}
      />
      {fields !== "event" && !plan.tilt && (
        <Picker<number>
          label={t.room.circuit}
          options={[draw, ...CIRCUITS.map((c) => ({ value: c.id, label: circuitName(c.id, c.sport) }))]}
          value={spec.course ?? DRAW}
          onChange={(course) => set({ course })}
        />
      )}
      {fields === "all" && !plan.tilt && (
        <>
          <Picker<number>
            label={t.room.season}
            options={[
              draw,
              ...seasonsOf({ course: spec.course }).map((s) => ({ value: SEASONS.indexOf(s), label: t.seasons[s] })),
            ]}
            value={spec.season ?? DRAW}
            onChange={(s) => set({ season: s })}
          />
          <Picker<number>
            label={t.room.weather}
            options={[
              draw,
              ...weathersOf({ course: spec.course, season: spec.season }).map((w) => ({
                value: WEATHERS.indexOf(w),
                label: t.weathers[w],
              })),
            ]}
            value={spec.weather ?? DRAW}
            onChange={(weather) => set({ weather })}
          />
          <Picker<number>
            label={t.room.time}
            options={[
              draw,
              ...(season ? TIMES_OF_DAY.map((n) => ({ value: timeOf(season, n), label: t.timesOfDay[n] })) : []),
            ]}
            value={spec.time ?? DRAW}
            onChange={(time) => set({ time })}
          />
        </>
      )}
    </>
  );
}
