// The game's sound: one AudioContext, made (or woken) by the first key or
// click (browsers keep audio off until then), feeding
//
//   sfx bus ─────────────┐
//   music bus ── duck ───┴─ master ── limiter ── speakers
//
// Every sound effect is synthesized (see library.ts and voices.ts). Music
// is a player of its own that plugs into the music bus (`onAudioReady`);
// with no tracks, the bus just stays silent. The duck lowers the music under
// the countdown and the results.
import { isMenuSound, renderLibrary, type SoundName } from "./library.ts";
import { type AudioSettings, loadAudioSettings, saveAudioSettings, type VolumeKind, volumeGain } from "./settings.ts";
import { type Kit, makeKit } from "./voices.ts";

/** What a music player plugs into. */
export interface AudioOut {
  ctx: AudioContext;
  /** Sound effects go here. */
  sfx: GainNode;
  /** Music goes here: the music volume, then the duck. */
  music: GainNode;
}

/** One-shots playing at once, at most (the least important are dropped past it). */
const MAX_ONE_SHOTS = 14;
/** The same one-shot again within this long (s) is one sound. */
const MIN_REPEAT_S = 0.04;
/**
 * One-shots render ahead at this rate, before there is a context (that
 * waits for a gesture; rendering doesn't); a context at another rate
 * resamples them as they play.
 */
const LIBRARY_RATE = 48000;

class AudioSystem {
  ctx: AudioContext | null = null;
  kit: Kit | null = null;
  /** The one-shots rendered so far. */
  readonly library = new Map<SoundName, readonly AudioBuffer[]>();
  readonly settings: AudioSettings = loadAudioSettings();
  private out: AudioOut | null = null;
  private master: GainNode | null = null;
  private duckNode: GainNode | null = null;
  private duckLevel = 1;
  private waiting: ((out: AudioOut) => void)[] = [];
  private playing = 0;
  private lastPlayed = new Map<SoundName, number>();
  private installed = false;
  /** The page hid while sound ran: it resumes when the page shows. */
  private hiddenWhileRunning = false;

  /**
   * Renders the one-shots (the menus' first), listens for the gestures that
   * let sound start, and pauses it in hidden tabs.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    if (typeof OfflineAudioContext === "function") {
      const add = (lib: ReadonlyMap<SoundName, readonly AudioBuffer[]>) => {
        for (const [name, list] of lib) this.library.set(name, list);
      };
      renderLibrary(LIBRARY_RATE, isMenuSound)
        .then(add)
        .then(() => renderLibrary(LIBRARY_RATE, (name) => !isMenuSound(name)))
        .then(add)
        .catch((e: unknown) => console.error("sound effects failed to render", e));
    }
    const wake = () => this.wake();
    for (const type of ["pointerdown", "keydown", "touchend"]) {
      addEventListener(type, wake, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      const ctx = this.ctx;
      if (!ctx) return;
      if (document.hidden) {
        this.hiddenWhileRunning = ctx.state === "running";
        if (this.hiddenWhileRunning) void ctx.suspend();
      } else if (this.hiddenWhileRunning) {
        void ctx.resume();
      }
    });
  }

  /** Makes the context (or resumes it). Works from a user gesture; elsewhere the browser may keep it suspended. */
  wake(): void {
    if (!this.ctx) this.create();
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running" && !document.hidden) ctx.resume().catch(() => undefined);
  }

  private create(): void {
    if (typeof AudioContext !== "function") return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      return;
    }
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(limiter);
    const sfx = ctx.createGain();
    sfx.connect(master);
    const duck = ctx.createGain();
    duck.gain.value = this.duckLevel;
    duck.connect(master);
    const music = ctx.createGain();
    music.connect(duck);
    this.master = master;
    this.duckNode = duck;
    this.out = { ctx, sfx, music };
    this.applyVolumes();
    this.kit = makeKit(ctx);
    for (const cb of this.waiting.splice(0)) cb(this.out);
  }

  /** Calls `cb` with the buses once sound exists (at once if it does). */
  onAudioReady(cb: (out: AudioOut) => void): void {
    if (this.out) cb(this.out);
    else this.waiting.push(cb);
  }

  /** The sound effects bus (null until sound exists). */
  get sfx(): GainNode | null {
    return this.out?.sfx ?? null;
  }

  volume(kind: VolumeKind): number {
    return this.settings[kind];
  }

  setVolume(kind: VolumeKind, v: number): void {
    this.settings[kind] = Math.min(1, Math.max(0, v));
    saveAudioSettings(this.settings);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const out = this.out;
    if (!out || !this.master) return;
    const t = out.ctx.currentTime;
    this.master.gain.setTargetAtTime(volumeGain(this.settings.master), t, 0.03);
    out.sfx.gain.setTargetAtTime(volumeGain(this.settings.effects), t, 0.03);
    out.music.gain.setTargetAtTime(volumeGain(this.settings.music), t, 0.03);
  }

  /** Lowers the music to `level` (1 = not ducked). */
  setDuck(level: number): void {
    if (level === this.duckLevel) return;
    this.duckLevel = level;
    const ctx = this.ctx;
    if (ctx && this.duckNode) this.duckNode.gain.setTargetAtTime(level, ctx.currentTime, level < 1 ? 0.12 : 0.5);
  }

  /**
   * Plays a one-shot (a random variant of it) into `dest` (the sfx bus by
   * default). `important` ones always play; others are dropped when too
   * many are already playing. Returns whether it played.
   */
  play(name: SoundName, level = 1, pan = 0, rate = 1, important = true, dest?: AudioNode): boolean {
    const ctx = this.ctx;
    const variants = this.library.get(name);
    const out = dest ?? this.out?.sfx;
    if (!ctx || ctx.state !== "running" || !variants || !out || level <= 0.001) return false;
    if (!important && this.playing >= MAX_ONE_SHOTS) return false;
    if (ctx.currentTime - (this.lastPlayed.get(name) ?? -1) < MIN_REPEAT_S) return false;
    this.lastPlayed.set(name, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = variants[Math.floor(Math.random() * variants.length)] ?? null;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = level;
    let tail: AudioNode = g;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      tail = p;
    }
    src.connect(g);
    tail.connect(out);
    this.playing++;
    src.addEventListener("ended", () => {
      this.playing--;
      tail.disconnect();
    });
    src.start();
    return true;
  }
}

/** The game's sound (one per page). */
export const audio = new AudioSystem();
