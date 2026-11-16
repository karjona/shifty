// What the page shows while the game gets ready, and how far along it is.
//
// Work someone may be waiting on reports here as it goes: downloads count
// their bytes (`download`), shader warm-ups the shaders done, and the rest
// (building a scene, the race server's answer) says when it starts and when
// it ends (`Wait.begin`). A wait gathers that work behind one cover: the
// boot screen (the first load), a season card (a course loading), or the
// loading sign (shorter waits, once they take long enough to notice). A wait has a plan, the steps it usually goes through,
// each weighed by how long it took in this browser last time (a first guess
// the first time). The bar is the weighed sum of the steps' progress:
// counted where there is something to count (bytes), timed against last
// time where there isn't. It never goes back, slows down rather than stops
// when a step runs long, and fills as its cover lifts.
//
// This module is part of the page's small entry (main.tsx): it imports
// nothing of the game's, and gets its words from whoever starts it.

/** What a wait goes through, in the order it usually does. */
export type Step = "code" | "connect" | "join" | "art" | "scene" | "shaders" | "settle";

/** What a step's line says, in the player's language. */
export type StepWords = Readonly<Record<Step, string>>;

/** Quick loads (shaders already compiled, art already here) don't flash the sign. */
const SIGN_AFTER_MS = 250;

/** How long each step takes the first time (ms), before this browser has been through it. */
const FIRST_GUESS: Record<Step, number> = {
  code: 2500,
  connect: 400,
  join: 400,
  art: 1500,
  scene: 900,
  shaders: 2500,
  settle: 1000,
};
/** Bytes a millisecond a download is guessed to go at, before one has been timed. */
const FIRST_RATE = 1500;
/** A download must be at least this big (bytes) to time the connection by. */
const RATE_MIN_BYTES = 64 * 1024;
/** How long the bar takes to close most of the way to where it should be (s). */
const BAR_EASE = 0.18;
/** How long a bar takes to fill once what it waited for is done (ms): its cover lifts meanwhile. */
const FILL_MS = 220;
/** How long background work waits after the boot screen goes (ms): the first screen's own loads come first. */
const AFTER_BOOT_MS = 1500;

const MEMORY_KEY = "shifty.loads";

/** How long steps took in this browser (ms, by `wait.step`, and `family:*.step` for any wait of a family, as
 * `course:*` for every course), and how fast downloads go. */
interface Memory {
  ms: Record<string, number>;
  rate: number | null;
}

function recall(): Memory {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null");
    if (typeof v === "object" && v !== null) {
      const ms: unknown = Reflect.get(v, "ms");
      const rate: unknown = Reflect.get(v, "rate");
      const out: Record<string, number> = {};
      if (typeof ms === "object" && ms !== null)
        for (const [k, n] of Object.entries(ms)) if (typeof n === "number" && n > 0 && n < 600_000) out[k] = n;
      return { ms: out, rate: typeof rate === "number" && rate > 0 ? rate : null };
    }
  } catch {
    // No storage, or bad JSON: first guesses.
  }
  return { ms: {}, rate: null };
}

const memory = recall();

function remember(): void {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // No storage: next time guesses again.
  }
}

/** Halfway between what was remembered and what happened this time. */
const blend = (old: number | undefined, took: number) => (old === undefined ? took : (old + took) / 2);

const now = () => performance.now();

/**
 * A step's progress after `x` of the time it usually takes: on pace, then,
 * past most of it, slowing down ever more without stopping (at twice its
 * usual time it is at 92%, at four times 95%, at ten times 98%).
 */
function timed(x: number): number {
  return x < 0.85 ? x : 1 - 0.15 / (1 + (x - 0.85) / 1.3);
}

/** A piece of work in a wait. */
export interface Work {
  /** Counted progress: `done` of `total` (bytes). */
  count(done: number, total: number): void;
  /** Over, done or failed (ending it again does nothing). */
  end(): void;
}

class Job implements Work {
  readonly start = now();
  ended: number | null = null;
  done = 0;
  total = 0;
  /** What it counts is bytes (a download), not pieces of work (shaders). */
  bytes = false;
  readonly waits = new Set<Wait>();
  readonly step: Step;

  constructor(step: Step) {
    this.step = step;
  }

  count(done: number, total: number): void {
    this.done = done;
    this.total = total;
  }

  end(): void {
    if (this.ended !== null) return;
    this.ended = now();
    for (const w of this.waits) w.check();
  }
}

/** Something that shows a wait: the boot screen, a season card, the sign. */
interface Cover {
  /** Its bar's fill, its line and its percentage. */
  fill: HTMLElement | null;
  line: HTMLElement | null;
  pct: HTMLElement | null;
  /** Where it says how far along it is to assistive tech. */
  meter: HTMLElement | null;
  /** Shows the bar only when there is something measured to show. */
  measuredOnly: boolean;
  /** What was last written (to touch the page only when it changes). */
  shown: { fill: number; line: string; pct: string; bar: boolean };
}

/** A wait the player sees, from its cover going up to it lifting. */
export class Wait {
  private jobs: Job[] = [];
  private holds = new Map<symbol, (() => string) | null>();
  private plan: Step[];
  private name: string;
  /** How far the bar has gone (0-1): only ever forward. */
  private shown = 0;
  private closedAt: number | null = null;
  /** Where the bar was when it closed (it fills from there). */
  private closedFrom = 0;
  private onIdle: (() => void) | null;
  /** What the line says, and since when (it changes at most every so often). */
  private saying: { step: Step | null; since: number } = { step: null, since: 0 };
  readonly opened = now();

  /** `name`: what this browser remembers it by; `plan`: its usual steps; `onIdle`: called once nothing holds it. */
  constructor(name: string, plan: Step[], onIdle: (() => void) | null = null) {
    this.name = name;
    this.plan = plan;
    this.onIdle = onIdle;
  }

  get closed(): boolean {
    return this.closedAt !== null;
  }

  /** Drops the steps it planned that haven't begun: someone else (a card) does them. */
  handOver(): void {
    this.plan = this.plan.filter((step) => this.jobs.some((j) => j.step === step));
  }

  /** Renames it (a course becomes known): the steps still to come are weighed as that one's. */
  rename(name: string): void {
    this.name = name;
  }

  /** Starts a piece of work in `step`; `bytes`: what it will count is bytes (a download). */
  begin(step: Step, bytes = false): Work {
    const job = new Job(step);
    job.bytes = bytes;
    if (!this.closed) this.adopt(job);
    ticking();
    return job;
  }

  /** Counts a piece of work already under way (begun for someone else) here too. */
  adopt(work: Work): void {
    if (!(work instanceof Job) || this.closed || this.jobs.includes(work)) return;
    this.jobs.push(work);
    work.waits.add(this);
    ticking();
  }

  /** Keeps it open (its cover up) until the returned function is called; `label` says what it waits for. */
  hold(label: (() => string) | null = null): () => void {
    const id = Symbol("hold");
    this.holds.set(id, label);
    ticking();
    return () => {
      if (this.holds.delete(id)) this.check();
    };
  }

  /** Runs `work` as a hold. */
  during<T>(work: Promise<T>): Promise<T> {
    const release = this.hold();
    return work.finally(release);
  }

  /** Something is still going on in it. */
  get busy(): boolean {
    return this.holds.size > 0 || this.jobs.some((j) => j.ended === null);
  }

  /** Called when a job ends or a hold is let go. */
  check(): void {
    if (!this.closed && !this.busy) this.onIdle?.();
  }

  /** The keys it remembers a step by: its own, and its family's (`course:*` for any course). */
  private keys(step: Step): [string, string] {
    return [`${this.name}.${step}`, `${this.name.split(":")[0]}:*.${step}`];
  }

  /** How long `step` is expected to take, all told (ms). */
  private weight(step: Step, jobs: Job[], t: number): number {
    const [own, family] = this.keys(step);
    const remembered = memory.ms[own] ?? memory.ms[family] ?? FIRST_GUESS[step];
    const counted = jobs.filter((j) => j.total > 0);
    if (counted.length === 0) return remembered;
    // Counted: what is left at the pace it goes (all told, once it is over).
    const first = Math.min(...jobs.map((j) => j.start));
    const total = counted.reduce((s, j) => s + j.total, 0);
    const done = counted.reduce((s, j) => s + Math.min(j.done, j.total), 0);
    const over = jobs.every((j) => j.ended !== null);
    const elapsed = (over ? Math.max(...jobs.map((j) => j.ended ?? t)) : t) - first;
    if (over) return Math.max(1, elapsed);
    if (counted.some((j) => j.bytes)) {
      const rate = done >= RATE_MIN_BYTES && elapsed > 50 ? done / elapsed : (memory.rate ?? FIRST_RATE);
      return Math.max(1, elapsed + (total - done) / rate);
    }
    // Pieces of work (shaders) go at their own pace: once a tenth is done, it tells.
    return done >= total * 0.1 && elapsed > 100 ? (elapsed * total) / done : remembered;
  }

  /** How far along `step` is (0-1). */
  private progress(jobs: Job[], weight: number, t: number): number {
    if (jobs.length === 0) return 0;
    const live = jobs.filter((j) => j.ended === null);
    if (live.length === 0) return 1;
    const counted = jobs.filter((j) => j.total > 0);
    if (counted.length > 0) {
      const total = counted.reduce((s, j) => s + j.total, 0);
      const done = counted.reduce((s, j) => s + Math.min(j.done, j.total), 0);
      return Math.min(0.99, done / total);
    }
    const first = Math.min(...jobs.map((j) => j.start));
    return Math.min(0.99, timed((t - first) / weight));
  }

  /** The steps it has or will go through, with each one's weight and progress. */
  private steps(t: number): { step: Step; weight: number; done: number; live: boolean }[] {
    const steps = [...this.plan];
    for (const j of this.jobs) if (!steps.includes(j.step)) steps.push(j.step);
    return steps.map((step) => {
      const jobs = this.jobs.filter((j) => j.step === step);
      const weight = this.weight(step, jobs, t);
      return { step, weight, done: this.progress(jobs, weight, t), live: jobs.some((j) => j.ended === null) };
    });
  }

  /** How far along it is (0-1), as the bar should show it now. */
  fraction(t = now()): number {
    if (this.closedAt !== null) return 1;
    const steps = this.steps(t);
    const total = steps.reduce((s, x) => s + x.weight, 0);
    return total > 0 ? Math.min(0.99, steps.reduce((s, x) => s + x.weight * x.done, 0) / total) : 0;
  }

  /** Moves the bar on toward `fraction` (eased, never back); returns where it is. */
  advance(dt: number, t = now()): number {
    const target = this.closedAt !== null ? 1 : this.fraction(t);
    if (this.closedAt !== null) {
      const k = Math.min(1, (t - this.closedAt) / FILL_MS);
      this.shown = this.closedFrom + (1 - this.closedFrom) * k * (2 - k);
    } else if (target > this.shown) this.shown += (target - this.shown) * (1 - Math.exp(-dt / BAR_EASE));
    return this.shown;
  }

  /** What the line says: a hold's own words, or the step with the most still to do (null: nothing yet). */
  saysWhat(t = now()): { text: string } | { step: Step } | null {
    if (this.closed) return this.saying.step ? { step: this.saying.step } : null;
    const label = [...this.holds.values()].findLast((l) => l !== null);
    if (label) return { text: label() };
    const steps = this.steps(t);
    const live = steps.filter((s) => s.live);
    // (Between steps: the next one it has planned.)
    const most =
      live.toSorted((a, b) => b.weight * (1 - b.done) - a.weight * (1 - a.done))[0]?.step ??
      steps.find((s) => s.done === 0 && !this.jobs.some((j) => j.step === s.step))?.step ??
      null;
    // Steps come and go quickly in places: the line keeps one a moment.
    const held = this.saying.step;
    if (most !== held && (held === null || t - this.saying.since > 600 || !live.some((s) => s.step === held)))
      this.saying = { step: most ?? held, since: t };
    return this.saying.step ? { step: this.saying.step } : null;
  }

  /** Dev: what it is waiting on, step by step (see `window.__loads`). */
  inspect(t = now()): unknown {
    return {
      name: this.name,
      shown: Math.round(this.shown * 1000) / 10,
      steps: this.steps(t).map((s) => ({
        step: s.step,
        live: s.live,
        weight: Math.round(s.weight),
        done: Math.round(s.done * 1000) / 10,
        jobs: this.jobs
          .filter((j) => j.step === s.step)
          .map(
            (j) =>
              `${j.ended === null ? "live" : "over"} ${j.done}/${j.total} ${Math.round((j.ended ?? t) - j.start)}ms`,
          ),
      })),
      holds: this.holds.size,
    };
  }

  /** It has progress to show: something counted, or (for a wait with a name of its own) steps timed before. */
  get measured(): boolean {
    return this.jobs.some(
      (j) => j.total > 0 || (this.name !== "sign" && memory.ms[this.keys(j.step)[0]] !== undefined),
    );
  }

  /** Done: the bar fills, and what it took is remembered for next time. */
  close(): void {
    if (this.closedAt !== null) return;
    const t = now();
    this.closedAt = t;
    this.closedFrom = this.shown;
    for (const step of new Set(this.jobs.map((j) => j.step))) {
      const jobs = this.jobs.filter((j) => j.step === step);
      if (jobs.some((j) => j.ended === null)) continue;
      const took = Math.max(...jobs.map((j) => j.ended ?? t)) - Math.min(...jobs.map((j) => j.start));
      for (const key of this.keys(step)) memory.ms[key] = blend(memory.ms[key], took);
    }
    const big = this.jobs.filter((j) => j.bytes && j.ended !== null && j.total >= RATE_MIN_BYTES && j.done >= j.total);
    if (big.length > 0) {
      const bytes = big.reduce((s, j) => s + j.total, 0);
      const span = Math.max(...big.map((j) => j.ended!)) - Math.min(...big.map((j) => j.start));
      // Cached files come in at once: only a real download times the connection.
      if (span > 30) memory.rate = blend(memory.rate ?? undefined, bytes / span);
    }
    remember();
    // What is still going on carries on in whatever wait comes next.
    const left = this.jobs.filter((j) => j.ended === null);
    for (const j of left) j.waits.delete(this);
    this.jobs = [];
    this.holds.clear();
    const next = left.length > 0 ? current() : null;
    if (next) for (const j of left) next.adopt(j);
    ticking();
  }
}

// --- Which wait work goes to ---

let words: () => StepWords = () => ({
  code: "",
  connect: "",
  join: "",
  art: "",
  scene: "",
  shaders: "",
  settle: "",
});
let loadingWord: () => string = () => "";

/** Where the lines' words come from (the player's language). */
export function setWords(steps: () => StepWords, loading: () => string): void {
  words = steps;
  loadingWord = loading;
  for (const c of covers.keys()) c.shown.line = "\u0000";
  ticking();
}

/** The first load: everything until the first screen is in and drawing smoothly. */
const bootWait = new Wait("boot", ["code", "art", "scene", "shaders", "settle"]);
let booting = true;
/** Season cards' waits (the latest on top). */
const cards: Wait[] = [];
/** The sign's wait, while something shorter loads. */
let signWait: Wait | null = null;
let quiet = 0;

// Dev: `window.__loads()` lists the waits that are open and what each waits on.
if (import.meta.env.DEV)
  Reflect.set(globalThis, "__loads", () =>
    [booting ? bootWait : null, ...cards, signWait].flatMap((w) => (w && !w.closed ? [w.inspect()] : [])),
  );

/** The wait work begun now goes to (null: background work, under `quietly`). */
export function waitNow(): Wait | null {
  return quiet > 0 ? null : current();
}

function current(): Wait | null {
  // (A card up under the boot screen, a race joined on a reload: its course counts on the card's bar.)
  const card = cards.findLast((w) => !w.closed);
  if (card) return card;
  if (booting) return bootWait;
  if (!signWait || signWait.closed) {
    const wait: Wait = new Wait("sign", [], () => {
      wait.close();
      if (signWait === wait) signWait = null;
    });
    signWait = wait;
  }
  return signWait;
}

/** Runs `start`; what it starts loading counts in no wait (work in the background, for later). */
export function quietly<T>(start: () => T): T {
  quiet++;
  try {
    return start();
  } finally {
    quiet--;
  }
}

/** Starts a piece of work in `step` in the wait of the moment (none under `quietly`). */
export function begin(step: Step, wait: Wait | null = waitNow()): Work {
  return wait?.begin(step) ?? new Job(step);
}

/** Counts `work` as a piece of `step` in the wait of the moment, until it settles. */
export function tracked<T>(step: Step, work: Promise<T>, wait: Wait | null = waitNow()): Promise<T> {
  const job = begin(step, wait);
  return work.finally(() => job.end());
}

/**
 * Keeps the loading sign up (at once, or once `after` ms have gone by)
 * until the returned function is called. `label` says what it waits for
 * ("Loading…" without one).
 */
export function holdLoading(label: (() => string) | null = null, after = 0): () => void {
  let release: (() => void) | null = null;
  const put = () => {
    release = current()?.hold(label) ?? null;
  };
  const wait = after > 0 ? setTimeout(put, after) : null;
  if (!wait) put();
  return () => {
    if (wait) clearTimeout(wait);
    release?.();
    release = null;
  };
}

/** Opens a season card's wait (`name`: the course's, to weigh its steps by). It closes with `close`. */
export function cardWait(name: string, plan: Step[], el: HTMLElement): Wait {
  const wait = new Wait(name, plan);
  cards.push(wait);
  // (Under the boot screen, a race being joined on a reload: the card has the course's load from here.)
  if (booting) bootWait.handOver();
  // What the sign was waiting on, the card waits on from here.
  const sign = signWait;
  if (sign && !sign.closed) {
    signWait = null;
    sign.close();
  }
  coverWith(wait, el, false);
  return wait;
}

/** Closes a season card's wait: its bar fills as the card goes. */
export function closeCard(wait: Wait): void {
  const i = cards.indexOf(wait);
  if (i >= 0) cards.splice(i, 1);
  wait.close();
}

// --- Downloads ---

/** Files on their way (and fetched ahead to be kept for whoever asks next), with the work that counts them. */
const downloads = new Map<string, { bytes: Promise<ArrayBuffer>; job: Job; keep: boolean }>();

/**
 * Downloads `url` (calls while it is on its way share it), counting its
 * bytes in `step` of `wait` (null: in the background). `size`: its size if
 * known ahead (the server may compress it on the way, hiding its length).
 * `keep`: fetched ahead for someone who will ask for it, who gets it
 * from here whenever they do.
 */
export function download(
  url: string,
  wait: Wait | null,
  step: Step = "art",
  size = 0,
  keep = false,
): Promise<ArrayBuffer> {
  const known = downloads.get(url);
  if (known) {
    if (wait && known.job.ended === null) wait.adopt(known.job);
    if (known.keep) known.keep = false;
    if (known.job.ended !== null) downloads.delete(url);
    return known.bytes;
  }
  const job = new Job(step);
  job.bytes = true;
  if (wait) wait.adopt(job);
  const entry: { bytes: Promise<ArrayBuffer>; job: Job; keep: boolean } = {
    bytes: Promise.resolve(new ArrayBuffer(0)),
    job,
    keep,
  };
  entry.bytes = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const length = res.headers.get("content-encoding") ? 0 : Number(res.headers.get("content-length") ?? 0);
    const total = size || length;
    const reader = res.body?.getReader();
    if (!reader) return res.arrayBuffer();
    const parts: Uint8Array[] = [];
    let done = 0;
    job.count(0, total);
    const pump = async (): Promise<void> => {
      const r = await reader.read();
      if (r.done) return;
      parts.push(r.value);
      done += r.value.byteLength;
      job.count(done, total > 0 ? Math.max(total, done) : 0);
      return pump();
    };
    await pump();
    const out = new Uint8Array(done);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out.buffer;
  })();
  entry.bytes.then(
    () => {
      job.end();
      const took = (job.ended ?? now()) - job.start;
      if (job.done >= RATE_MIN_BYTES && took > 30) lastRate = job.done / took;
      if (!entry.keep) downloads.delete(url);
    },
    () => {
      // A failed download is tried again by whoever asks next.
      job.end();
      downloads.delete(url);
    },
  );
  downloads.set(url, entry);
  ticking();
  return entry.bytes;
}

/** How fast downloads come in now (bytes a millisecond): as the ones under way go, or as this browser remembers. */
export function downloadRate(): number {
  const t = now();
  let done = 0;
  let span = 0;
  for (const { job } of downloads.values()) {
    if (job.ended !== null) continue;
    done += job.done;
    span = Math.max(span, t - job.start);
  }
  return done >= RATE_MIN_BYTES / 2 && span > 50 ? done / span : (lastRate ?? memory.rate ?? FIRST_RATE);
}

/** How fast the last download big enough to tell went (bytes a millisecond). */
let lastRate: number | null = null;

/** Counts `url` in `wait` too, if it is on its way. */
export function joinDownload(url: string, wait: Wait | null): void {
  const known = downloads.get(url);
  if (wait && known && known.job.ended === null) wait.adopt(known.job);
}

// --- The covers ---

const covers = new Map<Cover, Wait>();
const sign = { cover: null as Cover | null, since: 0 };

function coverOf(el: HTMLElement, measuredOnly: boolean): Cover {
  return {
    fill: el.querySelector<HTMLElement>(".load-fill"),
    line: el.querySelector<HTMLElement>(".load-what"),
    pct: el.querySelector<HTMLElement>(".load-pct"),
    meter: el.querySelector<HTMLElement>("[role=progressbar]"),
    measuredOnly,
    shown: { fill: -1, line: "\u0000", pct: "", bar: false },
  };
}

/** Shows `wait` on the cover in `el` (its `.load-fill`, `.load-what` and `.load-pct`) until it closes. */
function coverWith(wait: Wait, el: HTMLElement, measuredOnly: boolean): Cover {
  const cover = coverOf(el, measuredOnly);
  covers.set(cover, wait);
  ticking();
  return cover;
}

const percent = new Map<string, Intl.NumberFormat>();

function pctText(f: number): string {
  const lang = document.documentElement.lang || "en";
  let fmt = percent.get(lang);
  if (!fmt) {
    fmt = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 });
    percent.set(lang, fmt);
  }
  return fmt.format(Math.floor(f * 100) / 100);
}

function paint(cover: Cover, wait: Wait, f: number): void {
  const s = cover.shown;
  const bar = !cover.measuredOnly || wait.measured || wait.closed;
  if (bar !== s.bar) {
    s.bar = bar;
    cover.fill?.parentElement?.classList.toggle("off", !bar);
    cover.pct?.classList.toggle("off", !bar);
  }
  const fill = Math.round(f * 1000) / 1000;
  if (fill !== s.fill) {
    s.fill = fill;
    if (cover.fill) cover.fill.style.width = `${fill * 100}%`;
    cover.meter?.setAttribute("aria-valuenow", String(Math.floor(fill * 100)));
  }
  const pct = pctText(fill);
  if (pct !== s.pct) {
    s.pct = pct;
    if (cover.pct) cover.pct.textContent = pct;
  }
  const what = wait.saysWhat();
  const line = what === null ? loadingWord() : "text" in what ? what.text : words()[what.step] || loadingWord();
  if (line !== s.line) {
    s.line = line;
    if (cover.line) cover.line.textContent = line;
  }
}

let frame: number | null = null;
let last = now();

/** Keeps the covers' bars moving while there is anything to show. */
function ticking(): void {
  if (frame === null) {
    last = now();
    frame = requestAnimationFrame(tick);
  }
}

function tick(): void {
  frame = null;
  const t = now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  let more = updateSign(t);
  for (const [cover, wait] of covers) {
    const f = wait.advance(dt, t);
    paint(cover, wait, f);
    // Filled: the cover is done with it (it goes on its own time).
    if (wait.closed && f >= 1) covers.delete(cover);
    else more = true;
  }
  if (more) frame = requestAnimationFrame(tick);
}

/** The sign: up while a shorter wait goes on, once it has gone on long enough to notice. */
function updateSign(t: number): boolean {
  const el = document.querySelector<HTMLElement>("#loading");
  if (!el) return false;
  const cover = (sign.cover ??= coverOf(el, true));
  const wait = !booting && !cards.some((w) => !w.closed) ? signWait : null;
  const busy = wait !== null && !wait.closed && wait.busy;
  if (!busy) sign.since = 0;
  else if (sign.since === 0) sign.since = t;
  const on = busy && t - sign.since >= SIGN_AFTER_MS;
  if (el.classList.contains("on") !== on) el.classList.toggle("on", on);
  if (wait && on) covers.set(cover, wait);
  else covers.delete(cover);
  return busy;
}

/** What waits for the boot screen to go (background work that would compete with the first screen). */
const afterBoots: (() => void)[] = [];

/** Runs `then` once the boot screen has gone (and the first screen has had a moment to itself). */
export function afterBoot(then: () => void): void {
  if (booting) afterBoots.push(then);
  else setTimeout(then, 0);
}

/** Takes the boot screen away: its bar fills as it goes. */
export function booted(): void {
  if (booting) {
    booting = false;
    bootWait.close();
    setTimeout(() => {
      for (const f of afterBoots.splice(0)) quietly(f);
    }, AFTER_BOOT_MS);
  }
  const el = document.querySelector("#boot");
  if (!el || el.classList.contains("gone")) return;
  // Let the bar show full a moment before the screen fades.
  setTimeout(() => {
    el.classList.add("gone");
    setTimeout(() => el.remove(), 600);
  }, FILL_MS);
}

/** The boot screen's wait (main.tsx counts the game's download in it). */
export function bootLoad(): Wait {
  return bootWait;
}

/** Shows the boot screen's progress (once its elements are on the page). */
export function showBoot(): void {
  const el = document.querySelector<HTMLElement>("#boot");
  if (el && booting) coverWith(bootWait, el, false);
}
