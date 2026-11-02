// Race HUD: phase banner (warm-up, countdown, results), lap / position /
// time, the speed meter, and short popups for buoys, laps and the finish.
// Plain DOM: the state comes from the predicted world every frame.

export interface RaceView {
  phase: number;
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
}

export interface RaceEvent {
  tick: number;
  slot: number;
  kind: "buoy" | "lap" | "finish";
  buoy?: number;
  ok?: boolean;
  meter?: number;
  lap?: number;
  ticks?: number;
}

export interface StandingView {
  slot: number;
  place: number;
  lap: number;
  finishTicks: number;
  misses: number;
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

export function formatTime(ticks: number, hz: number): string {
  const total = ticks / hz;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

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

  /** Popups for my own race events. */
  events(events: RaceEvent[], mySlot: number, race: RaceView): void {
    for (const e of events) {
      if (e.slot !== mySlot) continue;
      if (e.kind === "buoy") {
        if (e.ok) this.popup(e.meter === race.meterMax ? "✓ MAX POWER" : "✓", "good");
        else this.popup("MISSED BUOY", "bad");
      } else if (e.kind === "lap") {
        if ((e.lap ?? 0) > 1) this.popup((e.lap ?? 0) === race.laps ? "FINAL LAP" : `LAP ${e.lap}`, "big");
      } else if (e.kind === "finish") {
        this.popup(`FINISH! ${ordinal(race.place)}`, "big");
      }
    }
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
    this.banner.textContent = banner;
    this.banner.className = race.phase === COUNTDOWN || (race.phase === RACING && race.phaseTicks < hz) ? "count" : "";

    if (race.racing && (race.phase === RACING || race.phase === COUNTDOWN)) {
      const time = race.finishTicks > 0 ? race.finishTicks : race.phase === RACING ? race.phaseTicks : 0;
      const lap = Math.min(Math.max(race.lap, 1), race.laps);
      this.info.innerHTML =
        `<div><span>LAP</span> ${race.finishTicks > 0 ? "✓" : `${lap}/${race.laps}`}</div>` +
        `<div><span>POS</span> ${race.place}/${race.racers}</div>` +
        `<div><span>TIME</span> ${formatTime(time, hz)}</div>`;
    } else {
      this.info.innerHTML = "";
    }

    this.speed.textContent = `${Math.round(speedKmh)} km/h${airborne ? " ✈" : ""}`;
    let pips = "";
    for (let i = 0; i < race.meterMax; i++) pips += `<i class="${i < race.meter ? "on" : ""}"></i>`;
    this.meter.innerHTML = `<span>POWER</span>${pips}`;

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
            return `<tr><td>${ordinal(s.place)}</td><td>${escapeHtml(name)}</td><td>${time}</td><td>${s.misses}</td></tr>`;
          })
          .join("");
        this.results.innerHTML = `<h2>Results</h2><table><tr><th></th><th></th><th>time</th><th>missed</th></tr>${rows}</table>`;
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
