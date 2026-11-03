// Race HUD: phase banner (warm-up, countdown, results), lap / position /
// time, the speed meter (summer) or trick score (winter), split times at
// checkpoints and the finish (against the first rider through), and short
// popups for buoys, checkpoints, laps, tricks and the finish. Plain DOM: the
// state comes from the predicted world every frame.

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
  /** Trick points this race (winter). */
  points: number;
  /** Gates on the course (start, buoys or checkpoints, finish). */
  gates: number;
  /** Raced for laps (or one run down). */
  looped: boolean;
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
  grabTicks?: number;
  points?: number;
  /** A trick landed badly (half points). */
  sketchy?: boolean;
  index?: number;
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

const WARMUP = 0;
const COUNTDOWN = 1;
const RACING = 2;
const RESULTS = 3;

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

const TIMES = ["", "", "Double ", "Triple ", "Quad "];
const times = (k: number) => TIMES[Math.min(Math.abs(k), 4)] ?? "";

const GRABS = ["", "Indy", "Nose grab", "Tail grab", "Melon", "Method"];

/** "Backflip 360", "540 Melon", "Double barrel roll"... from signed rotation counts (spin in half turns) and a grab. */
export function trickName(spin: number, flip: number, roll: number, grab = 0): string {
  const parts: string[] = [];
  if (flip !== 0) parts.push(`${times(flip)}${flip > 0 ? "backflip" : "frontflip"}`);
  if (roll !== 0) parts.push(`${times(roll)}barrel roll`);
  if (spin !== 0) parts.push(String(Math.abs(spin) * 180));
  if (grab > 0) parts.push(GRABS[grab] ?? "Grab");
  const name = parts.join(" ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function formatTime(ticks: number, hz: number): string {
  const total = ticks / hz;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** How long a split time stays up (ms). */
const SPLIT_MS = 4000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, id: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.id = id;
  parent.append(e);
  return e;
}

export class Hud {
  private banner: HTMLDivElement;
  private info: HTMLDivElement;
  private speed: HTMLDivElement;
  private meter: HTMLDivElement;
  private popups: HTMLDivElement;
  private results: HTMLDivElement;
  private lastResultsKey = "";
  /** Who passed each checkpoint (and the finish) in this race, and when (race ticks). */
  private passes = new Map<string, { slot: number; ticks: number }[]>();
  private passesRace = -1;
  private split: { html: string; until: number } | null = null;

  constructor(root: HTMLElement) {
    this.banner = el("div", "banner", root);
    this.info = el("div", "race-info", root);
    const bottom = el("div", "hud", root);
    this.speed = el("div", "speed", bottom);
    this.meter = el("div", "meter", bottom);
    this.popups = el("div", "popups", root);
    this.results = el("div", "results", root);
    this.results.hidden = true;
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

  /** Popups for my own race events, and split times from everyone's. */
  events(events: RaceEvent[], mySlot: number, race: RaceView): void {
    for (const e of events) {
      if ((e.kind === "checkpoint" || e.kind === "finish") && race.phase === RACING) this.pass(e, mySlot, race);
      if (e.slot !== mySlot) continue;
      if (e.kind === "buoy") {
        if (e.ok) this.popup(e.meter === race.meterMax ? "✓ MAX POWER" : "✓", "good");
        else this.popup("MISSED BUOY", "bad");
      } else if (e.kind === "checkpoint") {
        if (race.racing && race.phase === RACING) {
          this.popup(`CHECKPOINT ${(e.index ?? 0) + 1}/${Math.max(0, race.gates - 2)}`, "good");
        }
      } else if (e.kind === "lap") {
        if ((e.lap ?? 0) > 1) this.popup((e.lap ?? 0) === race.laps ? "FINAL LAP" : `LAP ${e.lap}`, "big");
      } else if (e.kind === "finish") {
        this.popup(`FINISH! ${ordinal(race.place)}`, "big");
      } else if (e.kind === "trick") {
        const name = trickName(e.spin ?? 0, e.flip ?? 0, e.roll ?? 0, e.grab ?? 0);
        this.popup(race.looped ? `${name}!` : `${name}  +${e.points ?? 0}`, "big");
        if (e.sketchy) this.popup("SKETCHY", "bad");
      } else if (e.kind === "sketchy") {
        this.popup("SKETCHY!", "bad");
      } else if (e.kind === "bail") {
        this.popup("BAIL!", "bad");
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
    const ahead = list.filter((p) => p.slot !== mySlot && p.ticks < ticks);
    const hz = race.tickHz;
    let html: string;
    if (ahead.length === 0) {
      html = `<div class="split ahead"><span>SPLIT</span> ${formatTime(ticks, hz)} · 1st</div>`;
    } else {
      const best = Math.min(...ahead.map((p) => p.ticks));
      const gap = ((ticks - best) / hz).toFixed(2);
      html = `<div class="split behind"><span>SPLIT</span> +${gap} · ${ordinal(ahead.length + 1)}</div>`;
    }
    this.split = { html, until: performance.now() + SPLIT_MS };
  }

  update(
    race: RaceView,
    speedKmh: number,
    airborne: boolean,
    standings: () => StandingView[],
    names: Map<number, string>,
  ): void {
    const hz = race.tickHz;
    const left = Math.max(0, race.phaseLength - race.phaseTicks);
    let banner = "";
    if (race.phase === WARMUP) banner = `WARM-UP · race in ${Math.ceil(left / hz)}`;
    else if (race.phase === COUNTDOWN) {
      const n = Math.ceil(left / hz);
      banner = n > 3 ? "GET READY" : String(n);
    } else if (race.phase === RACING && race.phaseTicks < hz) banner = "GO!";
    else if (race.phase === RACING && !race.racing) banner = "Free ride · next race soon";
    else if (race.phase === RESULTS) banner = `RESULTS · next race in ${Math.ceil(left / hz)}`;
    if (race.wrongWay && race.phase !== COUNTDOWN) banner = "WRONG WAY";
    this.banner.textContent = banner;
    this.banner.className = race.wrongWay
      ? "wrong"
      : race.phase === COUNTDOWN || (race.phase === RACING && race.phaseTicks < hz)
        ? "count"
        : "";

    if (race.racing && (race.phase === RACING || race.phase === COUNTDOWN)) {
      const time = race.finishTicks > 0 ? race.finishTicks : race.phase === RACING ? race.phaseTicks : 0;
      const lap = Math.min(Math.max(race.lap, 1), race.laps);
      const first = race.looped
        ? `<div><span>LAP</span> ${race.finishTicks > 0 ? "✓" : `${lap}/${race.laps}`}</div>`
        : `<div><span>SCORE</span> ${race.points}</div>`;
      const split = this.split && performance.now() < this.split.until ? this.split.html : "";
      this.info.innerHTML =
        first +
        `<div><span>POS</span> ${race.place}/${race.racers}</div>` +
        `<div><span>TIME</span> ${formatTime(time, hz)}</div>` +
        split;
    } else {
      this.info.innerHTML = "";
    }

    this.speed.textContent = `${Math.round(speedKmh)} km/h${airborne ? " ✈" : ""}`;
    if (race.looped) {
      let pips = "";
      for (let i = 0; i < race.meterMax; i++) pips += `<i class="${i < race.meter ? "on" : ""}"></i>`;
      this.meter.innerHTML = `<span>POWER</span>${pips}`;
    } else {
      this.meter.innerHTML = "";
    }

    this.results.hidden = race.phase !== RESULTS;
    if (race.phase === RESULTS) {
      const list = standings();
      const key = JSON.stringify(list);
      if (key !== this.lastResultsKey) {
        this.lastResultsKey = key;
        const rows = list
          .map((s) => {
            const name = names.get(s.slot) ?? `#${s.slot + 1}`;
            const time = s.finishTicks > 0 ? formatTime(s.finishTicks, hz) : "DNF";
            const extra = race.looped
              ? `<td>${s.misses}</td><td>${s.tricks}</td>`
              : `<td>${s.tricks}</td><td>${s.points}</td>`;
            return `<tr><td>${ordinal(s.place)}</td><td>${escapeHtml(name)}</td><td>${time}</td>${extra}</tr>`;
          })
          .join("");
        const heads = race.looped ? "<th>missed</th><th>tricks</th>" : "<th>tricks</th><th>points</th>";
        this.results.innerHTML = `<h2>Results</h2><table><tr><th></th><th></th><th>time</th>${heads}</tr>${rows}</table>`;
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
