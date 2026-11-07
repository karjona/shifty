// Race HUD: phase banner (countdown), lap / position / time, trick score,
// the speed meter (summer), split times at checkpoints and the finish
// (against the first rider through; in a time trial, at laps too, against
// the leading ghost), and short popups for buoys,
// checkpoints, laps, tricks and the finish. Plain DOM: the state comes from
// the predicted world every frame. The standings and the results are the
// scoreboard's (results.ts).

import { messages } from "../i18n/index.ts";
import { NameTags } from "./tags.ts";
import { trickName } from "./tricks.ts";

export interface RaceView {
  phase: number;
  /** World tick the phase began at. */
  phaseStart: number;
  phaseTicks: number;
  phaseLength: number;
  laps: number;
  racing: boolean;
  lap: number;
  meter: number;
  meterMax: number;
  nextGate: number;
  finishTicks: number;
  place: number;
  racers: number;
  misses: number;
  tickHz: number;
  wrongWay: boolean;
  /** Trick points this race. */
  points: number;
  /** Gates on the course (start, buoys or checkpoints, finish). */
  gates: number;
  /** Raced for laps (or one run down). */
  looped: boolean;
  /** Your rider rides on autopilot: through the finish, joined midway, or on the results. */
  autopilot: boolean;
}

export interface RaceEvent {
  tick: number;
  slot: number;
  kind: "buoy" | "checkpoint" | "lap" | "finish" | "trick" | "sketchy" | "bail";
  buoy?: number;
  ok?: boolean;
  meter?: number;
  lap?: number;
  ticks?: number;
  /** Half turns. */
  spin?: number;
  flip?: number;
  roll?: number;
  grab?: number;
  stunt?: number;
  grabTicks?: number;
  points?: number;
  /** A trick landed badly (half points). */
  sketchy?: boolean;
  index?: number;
}

/** A Tilt: which race of how many, and the points so far by seat. */
export interface GrandPrixView {
  index: number;
  count: number;
  points: Map<number, number>;
}

export interface StandingView {
  slot: number;
  place: number;
  lap: number;
  finishTicks: number;
  misses: number;
  tricks: number;
  points: number;
}

const COUNTDOWN = 1;
const RACING = 2;

/** 1st, 1.º, 1r: in the player's language. */
export function ordinal(n: number): string {
  return messages().hud.ordinal(n);
}

export function formatTime(ticks: number, hz: number): string {
  const total = ticks / hz;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** How long a split time stays up (ms). */
const SPLIT_MS = 4000;

/** A time trial's ghost, as the splits read against it. */
export interface GhostSplits {
  label: string;
  /** Race ticks at each split (checkpoints, laps), the finish last. */
  splits: number[];
}

/** `-0.42` / `+1.07` (s), or past a minute `+1:02.34`. */
function signedGap(ticks: number, hz: number): string {
  const sign = ticks < 0 ? "−" : "+";
  const a = Math.abs(ticks);
  return a >= 60 * hz ? `${sign}${formatTime(a, hz)}` : `${sign}${(a / hz).toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, id: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.id = id;
  parent.append(e);
  return e;
}

export class Hud {
  /** The other riders' name tags (set `tags.hidden` to take them off). */
  readonly tags: NameTags;
  private banner: HTMLDivElement;
  private info: HTMLDivElement;
  private speed: HTMLDivElement;
  private meter: HTMLDivElement;
  private gauges: HTMLDivElement;
  private popups: HTMLDivElement;
  /** Who passed each checkpoint (and the finish) in this race, and when (race ticks). */
  private passes = new Map<string, { slot: number; ticks: number }[]>();
  private passesRace = -1;
  private split: { html: string; until: number } | null = null;
  /** Time trial: the ghosts the splits read against (none yet: your time alone). Null outside a time trial. */
  trial: GhostSplits[] | null = null;
  /** Time trial: splits passed in this run, and the run (its start tick). */
  private trialSplits = 0;
  private trialRun = -1;

  constructor(root: HTMLElement) {
    this.tags = new NameTags(root);
    this.banner = el("div", "banner", root);
    this.info = el("div", "race-info", root);
    const bottom = el("div", "hud", root);
    this.gauges = bottom;
    this.speed = el("div", "speed", bottom);
    this.meter = el("div", "meter", bottom);
    this.popups = el("div", "popups", root);
  }

  /** Show a short message in the middle of the screen. */
  popup(text: string, tone: "good" | "bad" | "big" = "good"): void {
    const p = document.createElement("div");
    p.className = `popup ${tone}`;
    p.textContent = text;
    this.popups.append(p);
    setTimeout(() => p.remove(), tone === "big" ? 2200 : 1300);
    while (this.popups.childElementCount > 4) this.popups.firstElementChild?.remove();
  }

  /** The speed and the meter (off while the race is on television). */
  showGauges(on: boolean): void {
    const display = on ? "" : "none";
    if (this.gauges.style.display !== display) this.gauges.style.display = display;
  }

  /** Popups for my own race events (none on autopilot, where nothing counts), and split times from everyone's. */
  events(events: RaceEvent[], mySlot: number, race: RaceView): void {
    const m = messages().hud;
    for (const e of events) {
      if (this.trial) {
        const split = e.kind === "checkpoint" || e.kind === "finish" || (e.kind === "lap" && (e.lap ?? 0) > 1);
        if (split && e.slot === mySlot && race.racing && race.phase === RACING) this.ghostSplit(e, race, this.trial);
      } else if ((e.kind === "checkpoint" || e.kind === "finish") && race.phase === RACING) this.pass(e, mySlot, race);
      if (e.slot !== mySlot || (race.autopilot && e.kind !== "finish")) continue;
      if (e.kind === "buoy") {
        if (e.ok) this.popup(e.meter === race.meterMax ? m.maxPower : "✓", "good");
        else this.popup(m.missedBuoy, "bad");
      } else if (e.kind === "checkpoint") {
        if (race.racing && race.phase === RACING) {
          this.popup(m.checkpoint((e.index ?? 0) + 1, Math.max(0, race.gates - 2)), "good");
        }
      } else if (e.kind === "lap") {
        if ((e.lap ?? 0) > 1) this.popup((e.lap ?? 0) === race.laps ? m.finalLap : m.lap(e.lap ?? 0), "big");
      } else if (e.kind === "finish") {
        this.popup(this.trial ? messages().trial.finish : m.finish(ordinal(race.place)), "big");
      } else if (e.kind === "trick") {
        const name = trickName({
          spin: e.spin ?? 0,
          flip: e.flip ?? 0,
          roll: e.roll ?? 0,
          grab: e.grab ?? 0,
          stunt: e.stunt ?? 0,
        });
        this.popup(`${name}  +${e.points ?? 0}`, "big");
        if (e.sketchy) this.popup(m.sketchy, "bad");
      } else if (e.kind === "sketchy") {
        this.popup(`${m.sketchy}!`, "bad");
      } else if (e.kind === "bail") {
        this.popup(m.bail, "bad");
      }
    }
  }

  /** Notes a rider through a checkpoint or the finish; for mine, shows the split against the first one through. */
  private pass(e: RaceEvent, mySlot: number, race: RaceView): void {
    if (race.phaseStart !== this.passesRace) {
      this.passes.clear();
      this.passesRace = race.phaseStart;
    }
    const key = e.kind === "finish" ? "finish" : `cp${e.index ?? 0}`;
    const ticks = e.kind === "finish" ? (e.ticks ?? 0) : e.tick - race.phaseStart;
    const list = this.passes.get(key) ?? [];
    this.passes.set(key, list);
    if (list.some((p) => p.slot === e.slot)) return;
    list.push({ slot: e.slot, ticks });
    if (e.slot !== mySlot || !race.racing) return;
    const m = messages().hud;
    const ahead = list.filter((p) => p.slot !== mySlot && p.ticks < ticks);
    const hz = race.tickHz;
    let html: string;
    if (ahead.length === 0) {
      html = `<div class="split ahead"><span>${m.labels.split}</span> ${formatTime(ticks, hz)} · ${ordinal(1)}</div>`;
    } else {
      const best = Math.min(...ahead.map((p) => p.ticks));
      const gap = ((ticks - best) / hz).toFixed(2);
      html = `<div class="split behind"><span>${m.labels.split}</span> +${gap} · ${ordinal(ahead.length + 1)}</div>`;
    }
    this.split = { html, until: performance.now() + SPLIT_MS };
  }

  /** Time trial: my split against the ghost that was quickest through it. */
  private ghostSplit(e: RaceEvent, race: RaceView, ghosts: GhostSplits[]): void {
    if (race.phaseStart !== this.trialRun) {
      this.trialRun = race.phaseStart;
      this.trialSplits = 0;
    }
    const finish = e.kind === "finish";
    const k = this.trialSplits++;
    const ticks = finish ? (e.ticks ?? 0) : e.tick - race.phaseStart;
    let lead: { label: string; ticks: number } | null = null;
    for (const g of ghosts) {
      const t = finish ? g.splits.at(-1) : k < g.splits.length - 1 ? g.splits[k] : undefined;
      if (t !== undefined && (!lead || t < lead.ticks)) lead = { label: g.label, ticks: t };
    }
    const m = messages().hud;
    const hz = race.tickHz;
    const html = lead
      ? `<div class="split ${ticks <= lead.ticks ? "ahead" : "behind"}"><span>${m.labels.split}</span> ${signedGap(ticks - lead.ticks, hz)} · ${escapeHtml(lead.label)}</div>`
      : `<div class="split ahead"><span>${m.labels.split}</span> ${formatTime(ticks, hz)}</div>`;
    this.split = { html, until: performance.now() + SPLIT_MS };
  }

  update(race: RaceView, speedKmh: number, airborne: boolean, gp: GrandPrixView | null = null): void {
    const m = messages().hud;
    const hz = race.tickHz;
    const left = Math.max(0, race.phaseLength - race.phaseTicks);
    let banner = "";
    if (race.phase === COUNTDOWN) {
      const n = Math.ceil(left / hz);
      banner = n > 3 ? m.getReady : String(n);
    } else if (race.phase === RACING && race.phaseTicks < hz) banner = m.go;
    else if (race.phase === RACING && !race.racing) banner = m.spectating;
    if (race.wrongWay && race.phase !== COUNTDOWN) banner = m.wrongWay;
    if (banner !== this.banner.textContent) {
      this.banner.textContent = banner;
      // Each number of the countdown lands on its own.
      this.banner.style.animation = "none";
      void this.banner.offsetWidth;
      this.banner.style.animation = "";
    }
    this.banner.className = race.wrongWay
      ? "wrong"
      : race.phase === COUNTDOWN || (race.phase === RACING && race.phaseTicks < hz)
        ? "count"
        : "";

    if (race.racing && (race.phase === RACING || race.phase === COUNTDOWN)) {
      const time = race.finishTicks > 0 ? race.finishTicks : race.phase === RACING ? race.phaseTicks : 0;
      const lap = Math.min(Math.max(race.lap, 1), race.laps);
      const score = `<div><span>${m.labels.score}</span> ${race.points}</div>`;
      const first = race.looped
        ? `<div><span>${m.labels.lap}</span> ${race.finishTicks > 0 ? "✓" : `${lap}/${race.laps}`}</div>${score}`
        : score;
      const split = this.split && performance.now() < this.split.until ? this.split.html : "";
      const event = gp ? `<div><span>${m.labels.race}</span> ${gp.index + 1}/${gp.count}</div>` : "";
      this.info.innerHTML =
        event +
        first +
        `<div><span>${m.labels.pos}</span> ${race.place}/${race.racers}</div>` +
        `<div><span>${m.labels.time}</span> ${formatTime(time, hz)}</div>` +
        split;
    } else {
      this.info.innerHTML = "";
    }

    this.speed.innerHTML = `${Math.round(speedKmh)}<small>km/h${airborne ? " ✈" : ""}</small>`;
    if (race.looped) {
      let pips = "";
      for (let i = 0; i < race.meterMax; i++) pips += `<i class="${i < race.meter ? "on" : ""}"></i>`;
      this.meter.innerHTML = `<span>${m.labels.power}</span>${pips}`;
    } else {
      this.meter.innerHTML = "";
    }
  }
}
