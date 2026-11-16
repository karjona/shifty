// What comes after a race: a paper panel over the race, which runs on
// television behind it (or over a Tilt's podium). Your place, big; the race
// in its conditions, or the Tilt's final standings and its champion, or a
// time trial's run among the ghosts it raced; what it paid, as the lobby's
// ledger has it (it arrives a moment after the race ends), counting up into
// your credits; and what's next, the first of it focused. The same panel
// says what went wrong when joining or racing does.
import "../wrapup.css";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { playCue } from "../../audio/end.ts";
import type { Season } from "../../game/conditions.ts";
import type { RaceEnd, Trouble } from "../../game/race.ts";
import { useT } from "../../i18n/index.ts";
import { formatTime, ordinal } from "../../ui/hud.ts";
import { LAUREL_BOX, LAUREL_LEAVES, LEAF_PATH, laurelStems, leafTransform } from "../../ui/laurel.ts";
import { circuitTitle, conditionsLine } from "../../ui/results.ts";
import { type MatchPay, type Mode, fetchMatchPay, meQuery } from "../api.ts";
import { useAction, useAutoFocus, useDevice } from "../hooks.ts";
import { pointing } from "../nav.ts";
import { Button, Hints } from "../ui.tsx";
import type { GlyphAction } from "../glyphs.tsx";

/** How often (ms) the lobby is asked what the race paid, how long before it is late, and for how long after that, less often. */
const PAY_POLL_MS = 1500;
const PAY_WAIT_MS = 30_000;
const PAY_LATE_POLL_MS = 6000;
const PAY_GIVE_UP_MS = 180_000;
/** The count-up: a row comes in every so often, then the credits roll over this long. */
const ROW_MS = 320;
const ROLL_MS = 1100;

/** A time trial's run among the ghosts it raced. */
export interface TrialSummary {
  course: number;
  season: Season;
  /** Your time (ticks; 0: not finished) and the sim's rate. */
  ticks: number;
  hz: number;
  ghosts: { label: string; ticks: number }[];
  /** "New record", "New personal best", or null. */
  callout: string | null;
  /** What the run beat: 2 the record, 1 your best, 0 nothing. */
  beat: number;
  name: string;
}

export type Summary = { kind: "race"; end: RaceEnd } | { kind: "trial"; trial: TrialSummary };

/** An action at the end: its label, and the button that does it straight away (if any). */
export interface EndAction {
  label: string;
  run: () => void;
  glyph?: GlyphAction;
}

/** What a mode pays: the lobby's account of a match, or a line saying it pays nothing. */
type Pay =
  | { state: "none"; note: string }
  | { state: "waiting" }
  | { state: "late" }
  | { state: "paid"; rows: { label: string; delta: number }[]; before: number; after: number };

/** What the match paid you, from the lobby's ledger, as rows: place, style, the Tilt bonus. */
function payRows(
  pay: MatchPay,
  races: number,
  place: number,
  t: ReturnType<typeof useT>,
): { rows: { label: string; delta: number }[]; total: number } {
  const sum = (reason: string) => pay.paid.filter((p) => p.reason === reason).reduce((s, p) => s + p.delta, 0);
  const placeRaces = pay.paid.filter((p) => p.reason === "race").length;
  const rows: { label: string; delta: number }[] = [];
  if (placeRaces > 0)
    rows.push({
      label: races > 1 ? t.end.rows.places(placeRaces) : t.end.rows.place(ordinal(place)),
      delta: sum("race"),
    });
  if (sum("style") > 0) rows.push({ label: t.end.rows.style, delta: sum("style") });
  if (sum("grand_prix") > 0) rows.push({ label: t.end.rows.bonus, delta: sum("grand_prix") });
  return { rows, total: rows.reduce((s, r) => s + r.delta, 0) };
}

/**
 * What the race paid, polled from the lobby until its last race is in (or it
 * is late), and your best place on `course` before this match (null: none).
 */
function usePay(
  mode: Mode,
  match: string | null,
  races: number,
  place: number,
  course: number,
): { pay: Pay; bestBefore: number | null } {
  const t = useT();
  const queryClient = useQueryClient();
  const [bestBefore, setBestBefore] = useState<number | null>(null);
  const [pay, setPay] = useState<Pay>(() =>
    mode === "single"
      ? { state: "none", note: t.end.pays.single }
      : mode === "trial"
        ? { state: "none", note: t.end.pays.trial }
        : { state: "waiting" },
  );
  useEffect(() => {
    if ((mode !== "room" && mode !== "matchmaking") || !match) return undefined;
    let live = true;
    const since = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      const got = await fetchMatchPay(match, course).catch(() => null);
      if (!live) return;
      const complete = got !== null && got.reported.includes(races - 1);
      if (got && complete) {
        setBestBefore(got.bestBefore);
        const { rows, total } = payRows(got, races, place, t);
        queryClient.setQueryData(meQuery.queryKey, (m) =>
          m?.rider ? { ...m, rider: { ...m.rider, credits: got.credits } } : m,
        );
        setPay(
          rows.length === 0
            ? { state: "none", note: mode === "room" ? t.end.pays.alone : t.end.pays.nothing }
            : { state: "paid", rows, before: got.credits - total, after: got.credits },
        );
        return;
      }
      const waited = performance.now() - since;
      if (waited > PAY_GIVE_UP_MS) return;
      // Late: say so, and keep asking now and then: the rows come in if it does.
      if (waited > PAY_WAIT_MS) setPay((p) => (p.state === "waiting" ? { state: "late" } : p));
      timer = setTimeout(() => void ask(), waited > PAY_WAIT_MS ? PAY_LATE_POLL_MS : PAY_POLL_MS);
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [mode, match, races, place, course, queryClient, t]);
  return { pay, bestBefore };
}

/** Rows coming in one by one, then the credits rolling from `before` to `after`, with a tick and a chime. */
function useCountUp(pay: Pay): { shown: number; credits: number | null } {
  const [shown, setShown] = useState(0);
  const [credits, setCredits] = useState<number | null>(null);
  const [still] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (pay.state !== "paid" || still) return undefined;
    let frame = 0;
    const start = performance.now();
    let rows = 0;
    let lastTick = 0;
    const rollAt = pay.rows.length * ROW_MS + 200;
    const step = (now: number) => {
      const t = now - start;
      const due = Math.min(pay.rows.length, Math.floor(t / ROW_MS) + 1);
      if (due > rows) {
        rows = due;
        setShown(due);
        playCue("tally", 1, due - 1);
      }
      if (t >= rollAt) {
        const k = Math.min(1, (t - rollAt) / ROLL_MS);
        const eased = 1 - (1 - k) ** 3;
        setCredits(Math.round(pay.before + (pay.after - pay.before) * eased));
        if (k < 1 && now - lastTick > 70) {
          lastTick = now;
          playCue("roll", 1, k * 5);
        }
        if (k >= 1) {
          playCue("payout");
          return;
        }
      } else setCredits(pay.before);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [pay, still]);
  if (still && pay.state === "paid") return { shown: pay.rows.length, credits: pay.after };
  return { shown, credits };
}

/** A rider's name: a handle's tag (`#1234`) set apart. */
function Name({ name }: { name: string }) {
  const tagged = /^(.*)(#\d{4})$/u.exec(name);
  return (
    <span className="c-name">
      {tagged ? tagged[1] : name}
      {tagged && <i>{tagged[2]}</i>}
    </span>
  );
}

/** The panel's top: what it was (a kicker), its title, and your place beside it. */
function Head({
  kicker,
  title,
  sub,
  callout,
  hero,
  heroSub,
  rank = 0,
}: {
  kicker: string;
  title: string;
  sub?: string;
  /** What the run set ("New record!"), called out. */
  callout?: string | null;
  hero: string;
  heroSub?: string;
  /** 1 to 3: the place stands on the podium's base, the first crowned with laurel. */
  rank?: number;
}) {
  return (
    <header className="end-head">
      <div className="end-what">
        <span className="board-label">{kicker}</span>
        <b className="end-title">{title}</b>
        {sub && <span className="end-sub">{sub}</span>}
        {callout && <p className="board-callout">{callout}</p>}
      </div>
      <div className={`end-hero${rank >= 1 && rank <= 3 ? ` ranked rank-${rank}` : ""}`}>
        <b>
          {rank === 1 && <Laurel />}
          {hero}
        </b>
        {heroSub && <span>{heroSub}</span>}
      </div>
    </header>
  );
}

/** The laurel round a winner's place (see ui/laurel.ts). */
function Laurel() {
  return (
    <svg
      className="laurel"
      viewBox={`0 0 ${LAUREL_BOX.width} ${LAUREL_BOX.height}`}
      aria-hidden="true"
      fill="currentColor"
    >
      {laurelStems().map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="2.4" />
      ))}
      {LAUREL_LEAVES.map((l) => (
        <path key={leafTransform(l)} d={LEAF_PATH} transform={leafTransform(l)} />
      ))}
    </svg>
  );
}

/** The race (or the Tilt) as it ended for you. */
function RaceHead({ end }: { end: RaceEnd }) {
  const t = useT();
  const podium = end.podium;
  if (podium) {
    const i = podium.riders.findIndex((r) => r.me);
    const me = podium.riders[i];
    return (
      <Head
        kicker={t.podium.standings}
        title={t.end.tilt}
        hero={me ? ordinal(i + 1) : t.results.dnf}
        heroSub={me ? t.end.points(me.points) : undefined}
        rank={me ? i + 1 : 0}
      />
    );
  }
  return (
    <Head
      kicker={t.results.title}
      title={circuitTitle(end.course)}
      sub={conditionsLine(end.conditions)}
      hero={end.place > 0 && end.finishTicks > 0 ? ordinal(end.place) : t.results.dnf}
      heroSub={end.finishTicks > 0 ? formatTime(end.finishTicks, end.tickHz) : undefined}
      rank={end.finishTicks > 0 ? end.place : 0}
    />
  );
}

/** A Tilt's final standings (its champion stands on the podium behind): the top three, and you. */
function TiltStandings({ end }: { end: RaceEnd }) {
  const riders = end.podium?.riders ?? [];
  const shown = riders.map((r, i) => ({ r, i })).filter(({ r, i }) => i < 3 || r.me);
  return (
    <section className="end-block end-rows">
      {shown.map(({ r, i }) => (
        <div key={r.slot} className={`board-row${r.me ? " me" : ""}`}>
          <span className="c-place">{i + 1}</span>
          <Name name={r.name} />
          <span className="c-total">{r.points}</span>
        </div>
      ))}
    </section>
  );
}

/** A time trial's run among the ghosts it raced, by time. */
function TrialRows({ trial }: { trial: TrialSummary }) {
  const t = useT();
  const mine = trial.ticks > 0 ? trial.ticks : Infinity;
  const rows = [
    ...trial.ghosts.map((g) => ({ name: g.label, ticks: g.ticks, me: false })),
    { name: trial.name, ticks: mine, me: true },
  ].toSorted((a, b) => a.ticks - b.ticks || Number(a.me) - Number(b.me));
  const best = rows[0]?.ticks ?? 0;
  if (rows.length < 2) return null;
  return (
    <section className="end-block end-rows trial">
      {rows.map((r, i) => (
        <div
          key={r.me ? "\u0000me" : r.name}
          className={`board-row${r.me ? " me" : " ghost"}${Number.isFinite(r.ticks) ? "" : " out"}`}
        >
          <span className="c-place">{i + 1}</span>
          <Name name={r.name} />
          <span className="c-time">
            {!Number.isFinite(r.ticks)
              ? t.results.dnf
              : r.ticks === best
                ? formatTime(r.ticks, trial.hz)
                : `+${((r.ticks - best) / trial.hz).toFixed(2)}`}
          </span>
        </div>
      ))}
    </section>
  );
}

/** What it paid: rows counting up into your credits, or a quiet line. */
function Paid({ pay }: { pay: Pay }) {
  const t = useT();
  const { shown, credits } = useCountUp(pay);
  if (pay.state === "none") return <p className="end-note">{pay.note}</p>;
  if (pay.state === "late") return <p className="end-note">{t.end.late}</p>;
  return (
    <section className="end-block end-paid" aria-live="polite">
      <span className="board-label">{t.end.paid}</span>
      {pay.state === "waiting" ? (
        <p className="end-note waiting">{t.end.waiting}</p>
      ) : (
        <>
          <ol className="end-pay">
            {pay.rows.map((r, i) => (
              <li key={r.label} className={i < shown ? "in" : ""}>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                <span>{r.label}</span>
                <b>+{r.delta.toLocaleString()}</b>
              </li>
            ))}
          </ol>
          <p className="end-credits">
            <span className="board-label">{t.end.credits}</span>
            <b>{t.shop.amount(credits ?? pay.before)}</b>
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The actions, the first focused as they come up (one row filled with the
 * accent: the focused one); B and Y do theirs straight away.
 */
function Actions({ actions, back, busy }: { actions: EndAction[]; back: EndAction; busy: boolean }) {
  const play = actions.find((a) => a.glyph === "play");
  const ref = useRef<HTMLDivElement>(null);
  useAction("back", back.run, !busy);
  useAction("play", () => play?.run(), !busy && play !== undefined);
  useAutoFocus();
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-nav-autofocus]")?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className="end-actions">
      {actions.map((a, i) => (
        <Button key={a.label} glyph={a.glyph} className="wide" onClick={a.run} disabled={busy} autoFocus={i === 0}>
          {a.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * What the buttons do, at the panel's foot (the screen's corners are the
 * race's). A mouse or a finger has every action on the panel already.
 */
function EndHints({ actions, back }: { actions: EndAction[]; back: EndAction }) {
  const t = useT();
  const { device } = useDevice();
  const play = actions.find((a) => a.glyph === "play");
  if (pointing(device)) return null;
  return (
    <Hints
      items={[
        ["confirm", t.common.select],
        ...(play ? ([["play", play.label]] as [GlyphAction, string][]) : []),
        ["back", back.label],
      ]}
    />
  );
}

/** The end of a room's plan (or a time trial's run): over the race, or over the podium. */
export function WrapUp({
  summary,
  mode,
  match,
  actions,
  back,
  busy = false,
  error = null,
}: {
  summary: Summary;
  mode: Mode;
  /** The match's id, for what it paid (online modes). */
  match: string | null;
  actions: EndAction[];
  /** What B / Esc does. */
  back: EndAction;
  busy?: boolean;
  error?: string | null;
}) {
  const t = useT();
  const end = summary.kind === "race" ? summary.end : null;
  const races = end?.eventCount ?? 1;
  const { pay, bestBefore } = usePay(mode, match, races, end?.place ?? 0, end?.course ?? -1);
  const trial = summary.kind === "trial" ? summary.trial : null;
  const verdict = verdictOf(summary, bestBefore, t);
  const won = verdict?.win ?? false;
  useEffect(() => {
    if (won) playCue("win");
  }, [won]);
  return (
    <div className="end-layer" data-nav-scope="">
      <section className={`end-panel${end?.podium ? " tilt" : ""}`} aria-label={t.end.continue}>
        {verdict && <p className={`end-verdict${verdict.win ? " win" : ""}`}>{verdict.text}</p>}
        {end && <RaceHead end={end} />}
        {trial && (
          <Head
            kicker={t.trial.title}
            title={circuitTitle(trial.course)}
            sub={t.seasons[trial.season]}
            hero={trial.ticks > 0 ? formatTime(trial.ticks, trial.hz) : t.results.dnf}
            rank={trial.beat === 2 ? 1 : 0}
          />
        )}
        {end?.podium && <TiltStandings end={end} />}
        {trial && <TrialRows trial={trial} />}
        <Paid pay={pay} />
        {error && <p className="end-error">{error}</p>}
        <Actions actions={actions} back={back} busy={busy} />
        <EndHints actions={actions} back={back} />
      </section>
    </div>
  );
}

/**
 * The line a result is called out with: a race won or a podium place, the
 * Tilt won or its podium, a time trial's new record or best, your best
 * finish on a circuit (the lobby's records); null for an ordinary result.
 * `win`: it is a first place.
 */
function verdictOf(
  summary: Summary,
  bestBefore: number | null,
  t: ReturnType<typeof useT>,
): { text: string; win: boolean } | null {
  const v = t.end.verdicts;
  if (summary.kind === "trial") {
    const beat = summary.trial.beat;
    return beat === 2 ? { text: v.record, win: true } : beat === 1 ? { text: v.personalBest, win: false } : null;
  }
  const end = summary.end;
  if (end.podium) {
    const i = end.podium.riders.findIndex((r) => r.me);
    return i === 0 ? { text: v.tiltWin, win: true } : i > 0 && i < 3 ? { text: v.tiltPodium, win: false } : null;
  }
  if (end.finishTicks <= 0 || end.place <= 0) return null;
  if (end.place === 1) return { text: v.win, win: true };
  if (end.place <= 3) return { text: v.podium, win: false };
  if (bestBefore !== null && end.place < bestBefore) return { text: v.best(circuitTitle(end.course)), win: false };
  return null;
}

/** Something went wrong: what, in words, and the way out (focused). */
export function TroublePanel({
  title,
  body,
  actions,
  back,
}: {
  title: string;
  body: ReactNode;
  actions: EndAction[];
  back: EndAction;
}) {
  return (
    <div className="end-layer trouble" data-nav-scope="">
      <section className="end-panel" role="alertdialog" aria-label={title}>
        <header className="end-head">
          <div className="end-what">
            <b className="end-title small">{title}</b>
          </div>
        </header>
        <p className="end-body">{body}</p>
        <Actions actions={actions} back={back} busy={false} />
        <EndHints actions={actions} back={back} />
      </section>
    </div>
  );
}

/** The words for what went wrong. */
export function useTroubleText(trouble: Trouble): { title: string; body: string } {
  const t = useT();
  const m = t.race.trouble;
  switch (trouble.kind) {
    case "rejected":
      if (trouble.reason === "version") return { title: t.race.updated.title, body: t.race.updated.body };
      if (trouble.reason === "other") return m.token;
      return m[trouble.reason];
    case "unreachable":
      return m.unreachable;
    case "unsupported":
      return m.unsupported;
    case "lost":
    default:
      return m.lost;
  }
}
