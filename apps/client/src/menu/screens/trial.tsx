// The time trial, on the mode select: pick a circuit and a season it rides,
// see your best and the board, and pick the ghosts to race (your best and
// the record unless you choose others). The circuits come from the sim.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type Season } from "../../game/season-change.ts";
import { SEASONS } from "../../game/seasons.ts";
import { useT } from "../../i18n/index.ts";
import { formatTime } from "../../ui/hud.ts";
import { circuitsJson } from "../../wasm/sim.js";
import { type Board, type BoardRow, type GhostPick, type TrialRace, boardQuery } from "../api.ts";
import { useEngine } from "../hooks.ts";
import { toast } from "../toast.tsx";
import { Panel, Picker, Spinner } from "../ui.tsx";

/** Most ghosts in one run. */
export const MAX_GHOSTS = 3;

export interface Circuit {
  course: number;
  sport: "jetski" | "snow";
}

/** The seasons a sport rides (no snow in summer). */
export function seasonsOf(sport: Circuit["sport"]): Season[] {
  return sport === "snow" ? SEASONS.filter((s) => s !== "summer") : SEASONS;
}

/** Every circuit, from the sim. */
export function useCircuits(): Circuit[] {
  const engine = useEngine();
  return useMemo(() => {
    if (!engine) return [];
    const data: unknown = JSON.parse(circuitsJson());
    if (!Array.isArray(data)) return [];
    return (data as unknown[]).flatMap((c): Circuit[] => {
      if (typeof c !== "object" || c === null) return [];
      const course: unknown = Reflect.get(c, "course");
      const sport: unknown = Reflect.get(c, "sport");
      return typeof course === "number" && (sport === "jetski" || sport === "snow") ? [{ course, sport }] : [];
    });
  }, [engine]);
}

/** A circuit's name. */
export function useCircuitName(): (c: Circuit) => string {
  const t = useT();
  return (c) => {
    if (c.course === 0) return t.intro.courses.bay;
    if (c.course === 1) return t.intro.courses.mountain;
    return `${t.intro.sports[c.sport]} ${c.course + 1}`;
  };
}

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
  /** Null until the board is in. */
  race: TrialRace | null;
}

export function TrialPanel({ title, onChange }: { title: string; onChange: (c: TrialChoice) => void }) {
  const t = useT();
  const circuits = useCircuits();
  const name = useCircuitName();
  const [course, setCourse] = useState(0);
  const [season, setSeason] = useState<Season>("summer");
  const circuit = circuits.find((c) => c.course === course) ?? circuits[0];
  const seasons = circuit ? seasonsOf(circuit.sport) : SEASONS;
  const shownSeason = seasons.includes(season) ? season : seasons[0]!;
  const seasonIndex = SEASONS.indexOf(shownSeason);
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
    onChange({
      course,
      sport: circuit?.sport ?? "jetski",
      season: seasonIndex,
      race: b
        ? {
            course,
            season: seasonIndex,
            ghosts: picksOf(b, ids),
            best: b.mine?.timeMs ?? null,
            record: b.top[0]?.timeMs ?? null,
          }
        : null,
    });
  }, [course, circuit?.sport, seasonIndex, board.data, ids, onChange]);

  const toggle = (row: BoardRow) => {
    if (ids.includes(row.ghost)) setPicked({ key, ids: ids.filter((g) => g !== row.ghost) });
    else if (ids.length >= MAX_GHOSTS) toast(t.trial.tooMany(MAX_GHOSTS));
    else setPicked({ key, ids: [...ids, row.ghost] });
  };

  const rows = board.data ? [...board.data.top] : [];
  const mine = board.data?.mine;
  if (mine && !rows.some((r) => r.me)) rows.push(mine);

  return (
    <Panel className="mode-panel trial-panel" title={title}>
      <p>{t.trial.about}</p>
      {circuits.length > 0 && (
        <Picker
          label={t.trial.circuit}
          options={circuits.map((c) => ({ value: c.course, label: name(c) }))}
          value={course}
          onChange={setCourse}
        />
      )}
      <Picker<Season>
        label={t.trial.season}
        options={seasons.map((s) => ({ value: s, label: t.seasons[s] }))}
        value={shownSeason}
        onChange={setSeason}
      />
      <div className="trial-best">
        <span className="label">{t.trial.yourBest}</span>
        {mine ? (
          <>
            <b>{formatTime(mine.timeMs, 1000)}</b>
            <span className="muted">{t.trial.rank(mine.rank, board.data?.total ?? 0)}</span>
          </>
        ) : (
          <span className="muted">{t.trial.noTime}</span>
        )}
      </div>
      <div className="trial-board">
        <header>
          <span className="label">{t.trial.board}</span>
          <span className="label">{t.trial.ghosts(ids.length, MAX_GHOSTS)}</span>
        </header>
        {board.isPending && <Spinner />}
        {board.isError && <p className="muted">{t.common.error}</p>}
        {board.data && rows.length === 0 && <p className="muted">{t.trial.empty}</p>}
        <ol>
          {rows.map((r) => (
            <li key={r.ghost}>
              <button
                type="button"
                data-nav=""
                className={`trial-row${r.me ? " me" : ""}${ids.includes(r.ghost) ? " picked" : ""}`}
                aria-pressed={ids.includes(r.ghost)}
                onClick={() => toggle(r)}
              >
                <span className="num">{r.rank}</span>
                <span className="who">{r.handle}</span>
                <span className="time">{formatTime(r.timeMs, 1000)}</span>
                <span className="pick" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        <p className="muted small">{t.trial.ghostHint}</p>
      </div>
    </Panel>
  );
}
