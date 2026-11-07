// The end of a race on screen. Once you are through the finish, a compact
// tower of the standings at the side fills in as the others finish, and
// leaves the view to the race behind it. On the results, the scoreboard:
// the race, and in a Tilt the points it gave and the standings so far
// (who moved up or down). Plain DOM like the rest of the HUD, rebuilt only
// when what it shows changes. Its accent follows the course's season.
import "./results.css";
import { messages } from "../i18n/index.ts";
import { seasonOf } from "../game/season-change.ts";
import { PALETTE, setAccent } from "../game/seasons.ts";
import { type GrandPrixView, type RaceView, type StandingView, formatTime, ordinal } from "./hud.ts";

/** Tilt points by finishing place. Riders who haven't finished get last place's. */
export const TILT_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

const RACING = 2;
const RESULTS = 3;

/** The tower comes in this long (s) after you finish (the finish and your split have their moment first). */
const TOWER_DELAY = 3.5;
/** The tower is rebuilt at most this often (ms): unfinished riders swap places all the time. */
const TOWER_MS = 250;

/** A rider's name as the roster has it. */
export interface RosterName {
  name: string;
  bot: boolean;
}

export interface BoardRace extends RaceView {
  course: number;
  eventIndex: number;
  eventCount: number;
}

export interface BoardInput {
  race: BoardRace;
  /** My seat (-1: none yet). */
  mySlot: number;
  standings: () => StandingView[];
  riders: Map<number, RosterName>;
  gp: GrandPrixView | null;
  /** A time trial: the results stay up until a retry (no countdown). */
  trial?: boolean;
}

/** A rider's line in the Tilt standings. */
export interface TiltRow {
  slot: number;
  /** Points so far. */
  total: number;
  /** Points from this race (on its results). */
  won: number;
  /** Places gained (+) or lost (-) since the last results; null when there is nothing to compare. */
  move: number | null;
}

/** The Tilt points a place earns: riders who didn't finish get last place's, out of `riders`. */
export function tiltPoints(s: StandingView, riders: number): number {
  const last = TILT_POINTS[Math.min(Math.max(riders, 1), TILT_POINTS.length) - 1]!;
  if (s.finishTicks <= 0) return last;
  return TILT_POINTS[Math.min(s.place, TILT_POINTS.length) - 1] ?? last;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A rider's name cell: a handle's tag (`#1234`) set apart; bots in a lighter hand than people. */
function nameCell(slot: number, riders: Map<number, RosterName>): string {
  const r = riders.get(slot);
  const tagged = r ? /^(.*)(#\d{4})$/u.exec(r.name) : null;
  const name = !r ? `#${slot + 1}` : tagged ? `${escapeHtml(tagged[1]!)}<i>${tagged[2]!}</i>` : escapeHtml(r.name);
  return `<span class="c-name${r?.bot ? " bot" : ""}">${name}</span>`;
}

/** A column of the scoreboard: its heading, and a rider's value. */
type Column = [string, (s: StandingView) => string];

/** `+1.23`, or `+1:02.34` past a minute. */
function gapText(ticks: number, hz: number): string {
  return ticks >= 60 * hz ? `+${formatTime(ticks, hz)}` : `+${(ticks / hz).toFixed(2)}`;
}

/** The best finishing time in a race so far (ticks; 0 if nobody is in). */
function bestTime(list: StandingView[]): number {
  let best = 0;
  for (const s of list) if (s.finishTicks > 0 && (best === 0 || s.finishTicks < best)) best = s.finishTicks;
  return best;
}

export class Scoreboard {
  private root: HTMLDivElement;
  private tower: HTMLElement;
  private board: HTMLElement;
  private towerKey = "";
  private towerAt = 0;
  private boardKey = "";
  private countdown: HTMLElement | null = null;
  private course = -1;
  /** Riders the tower last showed finished (their row flashes as they come in). */
  private finished = new Set<number>();
  /** The Tilt's points as they stood before this race's results. */
  private before: Map<number, number> | null = null;
  private wasResults = false;
  /** The Tilt order as the last results showed it, and the one showing now. */
  private lastOrder: number[] | null = null;
  private order: number[] = [];
  /** The final Tilt standings, kept as they first came in (riders leaving afterwards don't change them). */
  private finalRows: TiltRow[] | null = null;
  /** The race on screen is the last of a Tilt. */
  private lastRace = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "board";
    this.tower = document.createElement("section");
    this.tower.className = "board-tower";
    this.tower.hidden = true;
    this.board = document.createElement("div");
    this.board.className = "board-results";
    this.board.hidden = true;
    this.root.append(this.tower, this.board);
    parent.append(this.root);
  }

  update(input: BoardInput): void {
    const { race, gp } = input;
    if (race.course !== this.course) {
      this.course = race.course;
      setAccent(PALETTE[seasonOf(race.course)].accent);
    }
    this.lastRace = race.eventCount > 1 && race.eventIndex >= race.eventCount - 1;
    const results = race.phase === RESULTS;
    if (!results) {
      if (this.wasResults && this.order.length > 0) this.lastOrder = this.order;
      this.before = gp?.points ?? null;
    }
    this.wasResults = results;

    const hz = race.tickHz;
    const sinceFinish = race.finishTicks > 0 ? race.phaseTicks - race.finishTicks : 0;
    const watching =
      race.phase === RACING && (race.racing ? race.finishTicks > 0 && sinceFinish >= TOWER_DELAY * hz : true);
    this.tower.hidden = !watching;
    if (watching) {
      const now = performance.now();
      if (now - this.towerAt >= TOWER_MS) {
        this.towerAt = now;
        this.renderTower(input, input.standings());
      }
    } else {
      this.finished.clear();
      this.towerKey = "";
    }

    this.board.hidden = !results;
    if (results) {
      const list = input.standings();
      const tilt = gp ? this.tiltRows(list, gp, race) : null;
      this.renderBoard(input, list, tilt);
      const left = Math.max(0, Math.ceil((race.phaseLength - race.phaseTicks) / hz));
      if (this.countdown && this.countdown.textContent !== String(left)) this.countdown.textContent = String(left);
    } else {
      this.boardKey = "";
    }
  }

  /**
   * The Tilt's final standings, best first, once the last race's points are
   * in (null otherwise). `points` is the latest Tilt table: if the results
   * went by unseen (a page that drew no frames meanwhile), the standings
   * come from it alone.
   */
  final(points: Map<number, number>): TiltRow[] | null {
    if (this.finalRows || !this.lastRace || points === this.before) return this.finalRows;
    return [...points]
      .map(([slot, total]): TiltRow => ({ slot, total, won: 0, move: null }))
      .toSorted((a, b) => b.total - a.total || a.slot - b.slot);
  }

  /** Everyone's Tilt points with this race's, best first (the last race breaks ties). */
  private tiltRows(list: StandingView[], gp: GrandPrixView, race: BoardRace): TiltRow[] {
    if (this.finalRows) return this.finalRows;
    const won = new Map(list.map((s) => [s.slot, tiltPoints(s, list.length)]));
    const place = new Map(list.map((s) => [s.slot, s.place]));
    // The race server's table comes in a moment after the results begin: until then, add this race's points.
    const updated = this.before === null || gp.points !== this.before;
    const slots = new Set([...gp.points.keys(), ...list.map((s) => s.slot)]);
    const rows = [...slots].map((slot): TiltRow => {
      const w = won.get(slot) ?? 0;
      const total = updated ? (gp.points.get(slot) ?? w) : (this.before?.get(slot) ?? 0) + w;
      return { slot, total, won: w, move: null };
    });
    rows.sort((a, b) => b.total - a.total || (place.get(a.slot) ?? 99) - (place.get(b.slot) ?? 99) || a.slot - b.slot);
    const last = this.lastOrder;
    if (last && race.eventIndex > 0)
      rows.forEach((r, i) => {
        const was = last.indexOf(r.slot);
        r.move = was < 0 ? null : was - i;
      });
    this.order = rows.map((r) => r.slot);
    if (updated && race.eventIndex >= race.eventCount - 1) this.finalRows = rows;
    return rows;
  }

  private renderTower(input: BoardInput, list: StandingView[]): void {
    const { race, mySlot, riders } = input;
    const m = messages().results;
    const hz = race.tickHz;
    const best = bestTime(list);
    const style = !race.looped || list.some((s) => s.points > 0);
    const done = list.filter((s) => s.finishTicks > 0);
    const key = JSON.stringify([
      list.map((s) => [s.slot, s.place, s.finishTicks, s.lap, style ? s.points : 0]),
      mySlot,
      m.racing,
    ]);
    if (key === this.towerKey) return;
    const first = this.towerKey === "";
    this.towerKey = key;
    const rows = list
      .map((s) => {
        const fin = s.finishTicks > 0;
        const fresh = fin && !first && !this.finished.has(s.slot);
        const time = !fin
          ? `<span class="still">${race.looped ? m.lap(Math.max(1, s.lap), race.laps) : m.racing}</span>`
          : s.finishTicks === best
            ? formatTime(s.finishTicks, hz)
            : gapText(s.finishTicks - best, hz);
        const cls = ["board-row", s.slot === mySlot ? "me" : "", fin ? "" : "out", fresh ? "fresh" : ""].join(" ");
        return (
          `<div class="${cls}"><span class="c-place">${s.place}</span>` +
          nameCell(s.slot, riders) +
          `<span class="c-time">${time}</span>` +
          (style ? `<span class="c-num">${fin || !race.looped ? s.points : ""}</span>` : "") +
          `</div>`
        );
      })
      .join("");
    this.finished = new Set(done.map((s) => s.slot));
    this.tower.classList.toggle("styled", style);
    this.tower.innerHTML =
      `<header><span class="board-label">${m.standings}</span>` +
      `<span class="board-label">${m.finished} <b class="board-count">${done.length}/${list.length}</b></span></header>` +
      `<div class="board-cols"><span></span><span></span><span>${m.cols.time}</span>` +
      (style ? `<span>${m.cols.style}</span>` : "") +
      `</div>${rows}`;
  }

  private renderBoard(input: BoardInput, list: StandingView[], tilt: TiltRow[] | null): void {
    const { race, mySlot, riders } = input;
    const key = JSON.stringify([list, tilt, mySlot, race.eventIndex, messages().results.title]);
    if (key === this.boardKey) return;
    this.boardKey = key;
    const m = messages().results;
    const hz = race.tickHz;
    const best = bestTime(list);
    const last = race.eventIndex >= race.eventCount - 1;
    const season = messages().seasons[seasonOf(race.course)];
    const won = new Map(tilt?.map((r) => [r.slot, r.won]) ?? []);
    const style = !race.looped || list.some((s) => s.points > 0);
    // Summer: buoys missed, tricks (and style, once tricks score); winter: tricks and style.
    const cols: Column[] = [];
    if (race.looped) cols.push([m.cols.missed, (s) => String(s.misses)]);
    cols.push([m.cols.tricks, (s) => String(s.tricks)]);
    if (style) cols.push([m.cols.style, (s) => String(s.points)]);
    if (tilt) cols.push([m.cols.tilt, (s) => `+${won.get(s.slot) ?? 0}`]);
    const rows = list
      .map((s) => {
        const time =
          s.finishTicks <= 0
            ? m.dnf
            : s.finishTicks === best
              ? formatTime(s.finishTicks, hz)
              : gapText(s.finishTicks - best, hz);
        const cls = ["board-row", s.slot === mySlot ? "me" : "", s.finishTicks > 0 ? "" : "out"].join(" ");
        return (
          `<div class="${cls}"><span class="c-place">${s.place}</span>` +
          nameCell(s.slot, riders) +
          `<span class="c-time">${time}</span>` +
          cols
            .map(
              ([, value], i) =>
                `<span class="c-num${i === cols.length - 1 && tilt ? " c-won" : ""}">${value(s)}</span>`,
            )
            .join("") +
          `</div>`
        );
      })
      .join("");
    const mine = list.find((s) => s.slot === mySlot);
    const hero = mine
      ? `<div class="board-mine"><b>${mine.finishTicks > 0 ? ordinal(mine.place) : m.dnf}</b>` +
        `<span>${mine.finishTicks > 0 ? formatTime(mine.finishTicks, hz) : ""}</span></div>`
      : "";
    const raceLabel = race.eventCount > 1 ? `${m.title} · ${m.race(race.eventIndex + 1, race.eventCount)}` : m.title;
    const next = race.eventCount <= 1 ? m.back : last ? m.podium : m.next;
    const racePanel =
      `<section class="board-panel board-race" style="--n: ${cols.length}">` +
      `<header class="board-head"><div><span class="board-label">${raceLabel}</span>` +
      `<b class="board-title">${season}</b></div>${hero}</header>` +
      `<div class="board-cols"><span></span><span></span><span>${m.cols.time}</span>` +
      cols.map(([label]) => `<span>${label}</span>`).join("") +
      `</div>${rows}` +
      (tilt || input.trial
        ? ""
        : `<footer class="board-foot"><span>${next}</span><b class="board-left"></b></footer>`) +
      `</section>`;
    // Moves once there are earlier results to compare with.
    const moves = tilt?.some((r) => r.move !== null) ?? false;
    const tiltPanel = tilt
      ? `<section class="board-panel board-tilt${moves ? "" : " still"}">` +
        `<header class="board-head"><div><span class="board-label">${m.tilt} · ${last ? m.final : m.after(race.eventIndex + 1, race.eventCount)}</span>` +
        `<b class="board-title">${m.standings}</b></div></header>` +
        `<div class="board-cols"><span></span>${moves ? "<span></span>" : ""}<span></span><span>${m.cols.points}</span></div>` +
        tilt
          .map((r, i) => {
            const move = !moves
              ? ""
              : r.move === null || r.move === 0
                ? `<span class="c-move">–</span>`
                : `<span class="c-move ${r.move > 0 ? "up" : "down"}">${r.move > 0 ? "▲" : "▼"}${Math.abs(r.move)}</span>`;
            return (
              `<div class="board-row${r.slot === mySlot ? " me" : ""}"><span class="c-place">${i + 1}</span>${move}` +
              nameCell(r.slot, riders) +
              `<span class="c-total">${r.total}</span></div>`
            );
          })
          .join("") +
        `<footer class="board-foot"><span>${next}</span><b class="board-left"></b></footer></section>`
      : "";
    this.board.innerHTML = racePanel + tiltPanel;
    this.countdown = this.board.querySelector(".board-left");
  }
}
