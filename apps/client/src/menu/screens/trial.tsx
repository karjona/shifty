// The time trial, on the mode select: pick a circuit, a season it rides,
// the weather (the season's own, clear first: any other is practice,
// timed but not ranked and with no ghosts) and the time of day, see your
// best lap and the board of best laps, and pick the ghosts to race (your
// best and the record unless you choose others).
import {
  CIRCUITS,
  type Circuit,
  SEASONS,
  SPORT_SEASONS,
  type Season,
  WEATHERS,
  type Weather,
  weathersIn,
} from "@shifty/rider";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { circuitName } from "../../game/conditions.ts";
import { useLocale, useT } from "../../i18n/index.ts";
import { formatTime } from "../../ui/hud.ts";
import { type Board, type BoardRow, type GhostPick, type TrialRace, boardQuery } from "../api.ts";
import { useScrollEdges } from "../hooks.ts";
import { SpecPickers } from "../plan.tsx";
import { toast } from "../toast.tsx";
import { Button, Handle, Panel, Picker, Spinner } from "../ui.tsx";

/** The rows a board shows (the lobby's top ten): the empty ones as open places. */
const BOARD_ROWS = 10;

/** Most ghosts in one run. */
export const MAX_GHOSTS = 3;

/** The ghosts picked off a board: what each is called, and its time. */
function picksOf(board: Board | undefined, ids: string[]): GhostPick[] {
  if (!board) return [];
  const rows = [...board.top, ...(board.mine ? [board.mine] : [])];
  const record = board.top[0]?.ghost;
  return ids.flatMap((id): GhostPick[] => {
    const row = rows.find((r) => r.ghost === id);
    if (!row) return [];
    const label = row.me ? "best" : id === record ? "record" : row.handle;
    return [{ id, label, timeMs: row.timeMs }];
  });
}

/** What the time trial will race, as picked on the panel. */
export interface TrialChoice {
  course: number;
  sport: Circuit["sport"];
  season: number;
  /** `sim::Weather`: 0 (clear) ranks; any other is practice. */
  weather: number;
  /** 10-minute steps from midnight (left out: drawn). */
  time?: number;
  /** Null until the board is in. */
  race: TrialRace | null;
}

export function TrialPanel({
  label,
  initial,
  onChange,
}: {
  label: string;
  /** The circuit, season, weather and time of day picked last time. */
  initial: { course: number; season: Season; weather: Weather; time?: number };
  onChange: (c: TrialChoice) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const edges = useScrollEdges();
  const [course, setCourse] = useState(initial.course);
  const [season, setSeason] = useState<Season>(initial.season);
  const [weather, setWeather] = useState<Weather>(initial.weather);
  const circuit = CIRCUITS.find((c) => c.id === course) ?? CIRCUITS[0];
  const seasons = circuit ? SPORT_SEASONS[circuit.sport] : SEASONS;
  const shownSeason = seasons.includes(season) ? season : seasons[0]!;
  const seasonIndex = SEASONS.indexOf(shownSeason);
  const weathers = weathersIn(shownSeason);
  const shownWeather = weathers.includes(weather) ? weather : "clear";
  const weatherIndex = WEATHERS.indexOf(shownWeather);
  const practice = shownWeather !== "clear";
  // The time picked, if it is one of the season's named times (else drawn).
  const [timeSpec, setTimeSpec] = useState<{ season: number; time?: number }>({
    season: seasonIndex,
    time: initial.time,
  });
  const shownTime = timeSpec.season === seasonIndex ? timeSpec.time : undefined;
  const board = useQuery(boardQuery(course, seasonIndex));
  const [picked, setPicked] = useState<{ key: string; ids: string[] } | null>(null);
  const key = `${course}:${seasonIndex}:${board.data ? "in" : ""}`;
  const defaults = useMemo(() => {
    const b = board.data;
    if (!b) return [];
    return [...new Set([b.mine?.ghost, b.top[0]?.ghost].filter((g): g is string => g !== undefined))];
  }, [board.data]);
  const ids = picked?.key === key ? picked.ids : defaults;

  useEffect(() => {
    const b = board.data;
    const at = shownTime === undefined ? {} : { time: shownTime };
    onChange({
      course,
      sport: circuit?.sport ?? "jetski",
      season: seasonIndex,
      weather: weatherIndex,
      ...at,
      race: b
        ? {
            course,
            season: seasonIndex,
            weather: weatherIndex,
            ...at,
            // Practice races no ghosts.
            ghosts: practice ? [] : picksOf(b, ids),
            best: b.mine?.timeMs ?? null,
            record: b.top[0]?.timeMs ?? null,
          }
        : null,
    });
  }, [course, circuit?.sport, seasonIndex, weatherIndex, shownTime, practice, board.data, ids, onChange]);

  const toggle = (row: BoardRow) => {
    if (ids.includes(row.ghost)) setPicked({ key, ids: ids.filter((g) => g !== row.ghost) });
    else if (ids.length >= MAX_GHOSTS) toast(t.trial.tooMany(MAX_GHOSTS));
    else setPicked({ key, ids: [...ids, row.ghost] });
  };

  const rows = board.data ? [...board.data.top] : [];
  const mine = board.data?.mine;
  if (mine && !rows.some((r) => r.me)) rows.push(mine);

  return (
    <Panel className="mode-panel trial-panel" label={label}>
      <p className="mode-about small">{t.trial.about(MAX_GHOSTS)}</p>
      <Picker
        label={t.trial.circuit}
        options={CIRCUITS.map((c) => ({ value: c.id, label: circuitName(c.id, c.sport) }))}
        value={course}
        onChange={setCourse}
      />
      <Picker<Season>
        label={t.trial.season}
        options={seasons.map((s) => ({ value: s, label: t.seasons[s] }))}
        value={shownSeason}
        onChange={setSeason}
      />
      <Picker<Weather>
        label={t.room.weather}
        options={weathers.map((w) => ({
          value: w,
          label: w === "clear" ? t.weathers[w] : `${t.weathers[w]} · ${t.trial.practice}`,
        }))}
        value={shownWeather}
        onChange={setWeather}
      />
      <SpecPickers
        spec={{ course, season: seasonIndex, ...(shownTime === undefined ? {} : { time: shownTime }) }}
        fields={["time"]}
        onChange={(spec) => setTimeSpec({ season: seasonIndex, time: spec.time })}
      />
      {practice && <p className="mode-about small trial-practice">{t.trial.practiceNote}</p>}
      <div className="trial-board">
        <header>
          <span className="trial-best">
            <span className="label">{t.trial.yourBest}</span>
            {board.data && mine && (
              <>
                <b>{formatTime(mine.timeMs, 1000)}</b>
                <span className="muted">{t.trial.rank(mine.rank, board.data.total)}</span>
              </>
            )}
            {board.data && !mine && <span className="muted">{t.trial.noTime}</span>}
          </span>
          <span className="label">{t.trial.ghosts(ids.length, MAX_GHOSTS)}</span>
        </header>
        <div className="trial-rows" ref={edges}>
          {board.isPending && (
            <p className="trial-note">
              <Spinner />
            </p>
          )}
          {board.isError && (
            <div className="trial-note">
              <p className="muted">{t.trial.boardError}</p>
              <Button onClick={() => void board.refetch()}>{t.common.retry}</Button>
            </div>
          )}
          {board.data && rows.length === 0 && <p className="trial-note muted">{t.trial.empty}</p>}
          {rows.length > 0 && (
            <ol>
              {rows.map((r) => (
                <li key={r.ghost} className={r.me && r.rank > (board.data?.top.length ?? 0) ? "pinned" : undefined}>
                  <button
                    type="button"
                    data-nav=""
                    className={`trial-row${r.me ? " me" : ""}${ids.includes(r.ghost) ? " picked" : ""}`}
                    aria-pressed={ids.includes(r.ghost)}
                    onClick={() => toggle(r)}
                  >
                    <span className="num">{r.rank.toLocaleString(locale)}</span>
                    <Handle handle={r.handle} className="who" />
                    <span className="time">{formatTime(r.timeMs, 1000)}</span>
                    <span className="pick" aria-hidden="true" />
                  </button>
                </li>
              ))}
              {Array.from({ length: Math.max(0, BOARD_ROWS - rows.length) }, (_, i) => (
                <li key={`empty-${i}`} className="trial-row empty" aria-hidden="true">
                  <span className="num">{rows.length + i + 1}</span>
                  <span className="who">—</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Panel>
  );
}
