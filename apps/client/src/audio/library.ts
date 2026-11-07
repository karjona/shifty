// The one-shot sounds, synthesized: each is a recipe of oscillators,
// filtered noise and envelopes, rendered once at load into an AudioBuffer
// (all of them in one OfflineAudioContext pass, side by side on its
// timeline, then cut apart and peak-normalized). Playing one is then a
// buffer source and a gain.
import { grainBuffer, noiseBuffer, rng } from "./dsp.ts";

export type SoundName =
  | "count"
  | "go"
  | "checkpoint"
  | "lap"
  | "finalLap"
  | "finish"
  | "buoy"
  | "buoyMiss"
  | "trick"
  | "wrongWay"
  | "splashSmall"
  | "splashBig"
  | "bailSplash"
  | "bump"
  | "landSnow"
  | "landSketchy"
  | "fall"
  | "hitPine"
  | "hitRock"
  | "hitTower"
  | "crouch"
  | "pop"
  | "uiMove"
  | "uiSelect"
  | "uiBack"
  | "uiTab";

/** Rendered sounds by name, each with its variants. */
export type Library = ReadonlyMap<SoundName, readonly AudioBuffer[]>;

interface Env {
  /** Start, from the sound's start (s). */
  at?: number;
  attack?: number;
  hold?: number;
  /** Time to fall about 40 dB after the hold (s). */
  decay: number;
  amp: number;
  /** Where it goes (default: the sound's output). */
  to?: AudioNode;
}

interface ToneSpec extends Env {
  type?: OscillatorType;
  f: number;
  /** Glides to this frequency over `glide` seconds. */
  f1?: number;
  glide?: number;
}

interface NoiseSpec extends Env {
  type: BiquadFilterType;
  f: number;
  f1?: number;
  sweep?: number;
  q?: number;
  /** Crunch: amplitude-modulates the noise with the grain texture at this rate. */
  grain?: number;
}

/** Recipes write into a builder, which places them at their spot on the shared timeline. */
export interface Builder {
  rand: () => number;
  /** The context time of a moment of the sound (s from its start), for automating a node by hand. */
  time(s: number): number;
  tone(s: ToneSpec): void;
  noise(s: NoiseSpec): void;
  /** Struck metal: sine partials (frequency ratios to `f`), higher ones dying faster. */
  bell(
    f: number,
    at: number,
    amp: number,
    decay: number,
    partials: readonly (readonly [number, number, number])[],
  ): void;
  filter(type: BiquadFilterType, f: number, q: number): BiquadFilterNode;
}

interface Recipe {
  name: SoundName;
  seconds: number;
  variants: number;
  /** Peak level after normalizing (dBFS). */
  peakDb: number;
  build: (b: Builder) => void;
}

/** A small chime (glockenspiel-like bar): ratio, amplitude, decay scale. */
const CHIME = [
  [1, 1, 1],
  [2.76, 0.32, 0.45],
  [5.4, 0.1, 0.25],
  [8.93, 0.04, 0.15],
] as const;

/** A hand bell. */
const BELL = [
  [0.5, 0.22, 1.3],
  [1, 1, 1],
  [1.19, 0.45, 0.8],
  [1.5, 0.3, 0.7],
  [2, 0.55, 0.6],
  [2.51, 0.22, 0.45],
  [2.66, 0.18, 0.4],
  [3.01, 0.12, 0.3],
  [4.17, 0.07, 0.2],
] as const;

/** A struck steel lattice (a lift tower). */
const STEEL = [
  [1, 1, 1],
  [2.31, 0.7, 0.75],
  [3.89, 0.5, 0.55],
  [5.94, 0.3, 0.38],
  [8.46, 0.2, 0.25],
] as const;

/** Water drops falling back after a splash. */
function droplets(b: Builder, n: number, from: number, to: number, amp: number): void {
  for (let i = 0; i < n; i++) {
    const at = from + (to - from) * b.rand() ** 1.4;
    b.noise({
      type: "bandpass",
      f: 2200 + 4200 * b.rand(),
      q: 5 + 6 * b.rand(),
      at,
      attack: 0.001,
      decay: 0.015 + 0.04 * b.rand(),
      amp: amp * (0.4 + 0.6 * b.rand()) * (1 - 0.6 * ((at - from) / (to - from))),
    });
  }
}

/** A body and board tumbling in the snow after a fall. */
function tumble(b: Builder, at: number, length: number, amp: number): void {
  b.noise({ type: "bandpass", f: 850, q: 0.5, grain: 0.35, at, attack: 0.02, hold: length * 0.4, decay: length, amp });
  b.noise({
    type: "bandpass",
    f: 3000,
    q: 0.7,
    at: at + 0.02,
    attack: 0.03,
    hold: length * 0.2,
    decay: length * 0.8,
    amp: amp * 0.2,
  });
}

const RECIPES: readonly Recipe[] = [
  {
    name: "uiMove",
    seconds: 0.08,
    variants: 1,
    peakDb: -25,
    build: (b) => {
      b.noise({ type: "highpass", f: 2600, decay: 0.006, amp: 0.5 });
      b.tone({ f: 2350, attack: 0.001, decay: 0.035, amp: 0.5 });
    },
  },
  {
    name: "uiSelect",
    seconds: 0.3,
    variants: 1,
    peakDb: -18,
    build: (b) => {
      b.noise({ type: "bandpass", f: 1500, q: 2, decay: 0.02, amp: 0.5 });
      b.tone({ f: 1175, attack: 0.002, decay: 0.09, amp: 0.9 });
      b.tone({ f: 1760, at: 0.045, attack: 0.002, decay: 0.15, amp: 0.85 });
    },
  },
  {
    name: "uiBack",
    seconds: 0.3,
    variants: 1,
    peakDb: -20,
    build: (b) => {
      b.noise({ type: "bandpass", f: 1300, q: 2, decay: 0.02, amp: 0.5 });
      b.tone({ f: 1319, attack: 0.002, decay: 0.08, amp: 0.9 });
      b.tone({ f: 988, at: 0.045, attack: 0.002, decay: 0.13, amp: 0.8 });
    },
  },
  {
    name: "uiTab",
    seconds: 0.2,
    variants: 1,
    peakDb: -21,
    build: (b) => {
      b.noise({ type: "bandpass", f: 1500, f1: 4500, sweep: 0.09, q: 0.8, attack: 0.025, decay: 0.08, amp: 1 });
      b.tone({ f: 2000, at: 0.05, attack: 0.001, decay: 0.03, amp: 0.25 });
    },
  },
  // The race.
  {
    name: "count",
    seconds: 0.45,
    variants: 1,
    peakDb: -9,
    build: (b) => {
      b.tone({ f: 880, attack: 0.004, hold: 0.1, decay: 0.24, amp: 1 });
      b.tone({ f: 1760, attack: 0.004, hold: 0.06, decay: 0.15, amp: 0.16 });
      b.tone({ type: "triangle", f: 880, attack: 0.004, hold: 0.1, decay: 0.2, amp: 0.12 });
    },
  },
  {
    name: "go",
    seconds: 1.1,
    variants: 1,
    peakDb: -7,
    build: (b) => {
      b.tone({ f: 1760, attack: 0.004, hold: 0.4, decay: 0.5, amp: 1 });
      b.tone({ f: 880, attack: 0.004, hold: 0.4, decay: 0.45, amp: 0.45 });
      b.tone({ type: "triangle", f: 1760, attack: 0.004, hold: 0.4, decay: 0.3, amp: 0.08 });
    },
  },
  {
    name: "checkpoint",
    seconds: 0.8,
    variants: 1,
    peakDb: -14,
    build: (b) => {
      b.bell(988, 0, 1, 0.5, CHIME);
      b.bell(1319, 0.075, 1, 0.6, CHIME);
    },
  },
  {
    name: "lap",
    seconds: 1.05,
    variants: 1,
    peakDb: -12,
    build: (b) => {
      b.bell(1319, 0, 1, 0.7, CHIME);
      b.bell(1661, 0.08, 1, 0.7, CHIME);
      b.bell(1976, 0.16, 1, 0.8, CHIME);
    },
  },
  {
    name: "finalLap",
    seconds: 1.9,
    variants: 1,
    peakDb: -10,
    build: (b) => {
      for (const [at, amp] of [
        [0, 1],
        [0.28, 0.85],
      ] as const) {
        b.noise({ type: "bandpass", f: 3200, q: 1.5, at, decay: 0.012, amp: 0.4 * amp });
        b.bell(880, at, amp, 1.2, BELL);
      }
    },
  },
  {
    name: "finish",
    seconds: 2,
    variants: 1,
    peakDb: -8,
    build: (b) => {
      // A warm brass-like chord (detuned saws through an opening lowpass) under a bell.
      const lp = b.filter("lowpass", 700, 0.7);
      lp.frequency.setValueAtTime(700, b.time(0));
      lp.frequency.exponentialRampToValueAtTime(3400, b.time(0.06));
      lp.frequency.exponentialRampToValueAtTime(1500, b.time(0.8));
      for (const f of [587.3, 740, 880, 1174.7]) {
        b.tone({ type: "sawtooth", f: f * 1.0035, attack: 0.02, hold: 0.45, decay: 1.1, amp: 0.3, to: lp });
        b.tone({ type: "sawtooth", f: f / 1.0035, attack: 0.02, hold: 0.45, decay: 1.1, amp: 0.3, to: lp });
      }
      b.tone({ type: "triangle", f: 293.7, attack: 0.02, hold: 0.45, decay: 1.1, amp: 0.5 });
      b.bell(1760, 0, 0.35, 1.2, CHIME);
    },
  },
  {
    name: "buoy",
    seconds: 0.35,
    variants: 1,
    peakDb: -16,
    build: (b) => {
      b.noise({ type: "highpass", f: 4000, decay: 0.01, amp: 0.15 });
      b.tone({ f: 1568, attack: 0.002, decay: 0.25, amp: 1 });
      b.tone({ f: 3136, attack: 0.002, decay: 0.12, amp: 0.15 });
    },
  },
  {
    name: "buoyMiss",
    seconds: 0.42,
    variants: 1,
    peakDb: -21,
    build: (b) => {
      const lp = b.filter("lowpass", 1400, 0.7);
      b.tone({ type: "triangle", f: 392, attack: 0.004, hold: 0.06, decay: 0.1, amp: 1, to: lp });
      b.tone({ type: "triangle", f: 311, at: 0.1, attack: 0.004, hold: 0.08, decay: 0.16, amp: 1, to: lp });
    },
  },
  {
    name: "trick",
    seconds: 0.55,
    variants: 1,
    peakDb: -17,
    build: (b) => {
      for (const [i, f] of [1568, 1976, 2349].entries()) {
        b.tone({ f, at: i * 0.05, attack: 0.002, decay: 0.3, amp: 1 });
        b.tone({ f: f * 2, at: i * 0.05, attack: 0.002, decay: 0.12, amp: 0.1 });
      }
    },
  },
  {
    name: "wrongWay",
    seconds: 0.42,
    variants: 1,
    peakDb: -21,
    build: (b) => {
      const lp = b.filter("lowpass", 900, 0.7);
      b.tone({ type: "square", f: 233, attack: 0.005, hold: 0.09, decay: 0.06, amp: 1, to: lp });
      b.tone({ type: "square", f: 233, at: 0.17, attack: 0.005, hold: 0.09, decay: 0.06, amp: 1, to: lp });
    },
  },
  // The jetski.
  {
    name: "splashSmall",
    seconds: 0.8,
    variants: 3,
    peakDb: -9,
    build: (b) => {
      b.tone({ f: 190 * (0.9 + 0.2 * b.rand()), f1: 85, glide: 0.06, attack: 0.002, decay: 0.12, amp: 0.45 });
      b.noise({ type: "bandpass", f: 2200, f1: 900, sweep: 0.35, q: 0.6, attack: 0.004, decay: 0.45, amp: 0.9 });
      b.noise({ type: "highpass", f: 5000, attack: 0.01, decay: 0.3, amp: 0.18 });
      droplets(b, 12, 0.04, 0.5, 0.35);
    },
  },
  {
    name: "splashBig",
    seconds: 1.3,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.tone({ f: 160 * (0.9 + 0.2 * b.rand()), f1: 70, glide: 0.1, attack: 0.002, decay: 0.2, amp: 0.55 });
      b.noise({ type: "lowpass", f: 900, q: 0.5, attack: 0.005, decay: 0.9, amp: 0.8 });
      b.noise({ type: "bandpass", f: 1500, f1: 700, sweep: 0.6, q: 0.5, attack: 0.004, decay: 0.7, amp: 0.9 });
      b.noise({ type: "highpass", f: 4500, attack: 0.03, decay: 0.7, amp: 0.25 });
      droplets(b, 28, 0.05, 0.95, 0.4);
    },
  },
  {
    name: "bailSplash",
    seconds: 1.8,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.tone({ f: 150 * (0.9 + 0.2 * b.rand()), f1: 65, glide: 0.12, attack: 0.002, decay: 0.25, amp: 0.55 });
      b.noise({ type: "bandpass", f: 1400, f1: 600, sweep: 0.5, q: 0.5, attack: 0.004, decay: 0.6, amp: 0.9 });
      b.noise({ type: "highpass", f: 4500, attack: 0.03, decay: 0.6, amp: 0.3 });
      // The ski hits a moment after the rider.
      b.tone({ f: 200, f1: 95, glide: 0.06, at: 0.2, attack: 0.002, decay: 0.12, amp: 0.35 });
      b.noise({ type: "bandpass", f: 1200, q: 0.7, at: 0.2, attack: 0.004, decay: 0.35, amp: 0.5 });
      // Under the surface: a bubbling gurgle.
      b.noise({ type: "lowpass", f: 520, q: 1.2, grain: 0.3, at: 0.12, attack: 0.05, hold: 0.2, decay: 1.1, amp: 0.7 });
      droplets(b, 30, 0.05, 1.4, 0.35);
    },
  },
  {
    name: "bump",
    seconds: 0.45,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.noise({ type: "highpass", f: 3000, decay: 0.008, amp: 0.4 });
      b.noise({ type: "bandpass", f: 650 * (0.9 + 0.2 * b.rand()), q: 2.5, decay: 0.07, amp: 1.4 });
      b.tone({ f: 240, f1: 180, glide: 0.08, attack: 0.001, decay: 0.12, amp: 0.5 });
      b.noise({ type: "bandpass", f: 1800, q: 0.7, at: 0.02, attack: 0.01, decay: 0.3, amp: 0.3 });
    },
  },
  // The snowboard.
  {
    name: "landSnow",
    seconds: 0.45,
    variants: 3,
    peakDb: -9,
    build: (b) => {
      b.noise({ type: "highpass", f: 2500, decay: 0.012, amp: 0.3 });
      b.tone({ f: 150 * (0.9 + 0.2 * b.rand()), f1: 75, glide: 0.08, attack: 0.002, decay: 0.14, amp: 0.55 });
      b.noise({ type: "lowpass", f: 1200, q: 0.7, attack: 0.004, decay: 0.18, amp: 1 });
      b.noise({ type: "bandpass", f: 1800, q: 0.8, grain: 1.2, attack: 0.004, decay: 0.22, amp: 1 });
    },
  },
  {
    name: "landSketchy",
    seconds: 0.8,
    variants: 2,
    peakDb: -8,
    build: (b) => {
      b.tone({ f: 140 * (0.9 + 0.2 * b.rand()), f1: 70, glide: 0.1, attack: 0.002, decay: 0.18, amp: 0.6 });
      b.noise({ type: "lowpass", f: 1100, q: 0.7, attack: 0.004, decay: 0.25, amp: 1 });
      b.noise({ type: "bandpass", f: 1200, q: 0.6, grain: 1.5, attack: 0.01, hold: 0.15, decay: 0.35, amp: 0.9 });
      b.noise({ type: "bandpass", f: 900, q: 3, at: 0.06, decay: 0.04, amp: 0.4 });
    },
  },
  {
    name: "fall",
    seconds: 1.4,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.tone({ f: 130 * (0.9 + 0.2 * b.rand()), f1: 65, glide: 0.12, attack: 0.002, decay: 0.25, amp: 0.6 });
      b.noise({ type: "lowpass", f: 1300, q: 0.6, attack: 0.004, decay: 0.3, amp: 1 });
      tumble(b, 0.05, 0.7, 0.8);
      b.tone({ f: 120, f1: 60, glide: 0.1, at: 0.33, attack: 0.002, decay: 0.18, amp: 0.4 });
      b.noise({ type: "lowpass", f: 900, q: 0.6, at: 0.33, attack: 0.004, decay: 0.15, amp: 0.5 });
    },
  },
  {
    name: "hitPine",
    seconds: 1.6,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.noise({ type: "highpass", f: 2500, decay: 0.01, amp: 0.4 });
      b.noise({ type: "bandpass", f: 340 * (0.9 + 0.2 * b.rand()), q: 5, decay: 0.09, amp: 1 });
      b.tone({ f: 190, f1: 150, glide: 0.1, attack: 0.001, decay: 0.16, amp: 0.8 });
      // Snow shaken off the branches.
      b.noise({ type: "bandpass", f: 2600, q: 0.6, at: 0.04, attack: 0.12, hold: 0.2, decay: 0.9, amp: 0.18 });
      for (let i = 0; i < 4; i++) {
        b.noise({ type: "lowpass", f: 600, q: 0.7, at: 0.2 + 0.7 * b.rand(), decay: 0.08, amp: 0.25 });
      }
      tumble(b, 0.06, 0.5, 0.55);
    },
  },
  {
    name: "hitRock",
    seconds: 1.3,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.noise({ type: "highpass", f: 2500, decay: 0.01, amp: 0.8 });
      b.noise({ type: "bandpass", f: 1100 * (0.9 + 0.2 * b.rand()), q: 3, decay: 0.06, amp: 0.9 });
      b.tone({ f: 120, f1: 65, glide: 0.1, attack: 0.001, decay: 0.18, amp: 0.6 });
      b.noise({ type: "bandpass", f: 2600, q: 2, grain: 1.5, at: 0.02, hold: 0.05, decay: 0.15, amp: 0.4 });
      tumble(b, 0.08, 0.5, 0.55);
    },
  },
  {
    name: "hitTower",
    seconds: 1.8,
    variants: 1,
    peakDb: -8,
    build: (b) => {
      b.tone({ f: 120, f1: 65, glide: 0.1, attack: 0.001, decay: 0.2, amp: 0.5 });
      b.bell(311, 0, 0.8, 1.3, STEEL);
      tumble(b, 0.1, 0.5, 0.5);
    },
  },
  {
    name: "crouch",
    seconds: 0.3,
    variants: 1,
    peakDb: -21,
    build: (b) => {
      b.noise({ type: "lowpass", f: 1400, q: 0.5, attack: 0.06, decay: 0.15, amp: 1 });
      b.noise({ type: "bandpass", f: 1800, q: 0.8, grain: 1.2, attack: 0.03, decay: 0.12, amp: 0.4 });
    },
  },
  {
    name: "pop",
    seconds: 0.45,
    variants: 2,
    peakDb: -6,
    build: (b) => {
      b.tone({ f: 170 * (0.92 + 0.16 * b.rand()), f1: 90, glide: 0.04, attack: 0.001, decay: 0.06, amp: 1 });
      b.noise({ type: "bandpass", f: 1800, q: 1.2, decay: 0.05, amp: 0.8 });
      b.noise({ type: "bandpass", f: 3000, f1: 1500, sweep: 0.2, q: 0.6, attack: 0.005, decay: 0.25, amp: 0.6 });
      b.noise({ type: "bandpass", f: 500, f1: 1400, sweep: 0.25, q: 1, attack: 0.04, decay: 0.2, amp: 0.4 });
    },
  },
];

/** Every sound's recipe, for the dev sound board. */
export const SOUND_NAMES: readonly SoundName[] = RECIPES.map((r) => r.name);

/** Gap between sounds on the shared timeline (s). */
const GAP = 0.05;
/** Fade at the end of each cut (s), so a tail never ends on a click. */
const FADE = 0.008;

function builder(
  ctx: BaseAudioContext,
  out: AudioNode,
  t0: number,
  rand: () => number,
  noise: AudioBuffer,
  grain: AudioBuffer,
): Builder {
  const env = (g: GainNode, s: Env): [number, number] => {
    const start = t0 + (s.at ?? 0);
    const attack = s.attack ?? 0.002;
    const top = start + attack + (s.hold ?? 0);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(s.amp, start + attack);
    g.gain.setValueAtTime(s.amp, top);
    g.gain.setTargetAtTime(0, top, s.decay / 4.6);
    return [start, top + s.decay * 1.6];
  };
  const b: Builder = {
    rand,
    time: (s) => t0 + s,
    filter(type, f, q) {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      n.connect(out);
      return n;
    },
    tone(s) {
      const o = ctx.createOscillator();
      o.type = s.type ?? "sine";
      const g = ctx.createGain();
      const [start, end] = env(g, s);
      o.frequency.setValueAtTime(s.f, start);
      if (s.f1 !== undefined) o.frequency.exponentialRampToValueAtTime(s.f1, start + (s.glide ?? 0.1));
      o.connect(g).connect(s.to ?? out);
      o.start(start);
      o.stop(end);
    },
    noise(s) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = s.type;
      f.Q.value = s.q ?? 0.7;
      const g = ctx.createGain();
      const [start, end] = env(g, s);
      f.frequency.setValueAtTime(s.f, start);
      if (s.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(s.f1, start + (s.sweep ?? 0.2));
      let tail: AudioNode = g;
      if (s.grain !== undefined) {
        // gain = grain texture (0..1, spiky) on top of a low floor.
        const am = ctx.createGain();
        am.gain.value = 0.15;
        const gs = ctx.createBufferSource();
        gs.buffer = grain;
        gs.loop = true;
        gs.playbackRate.value = s.grain;
        gs.connect(am.gain);
        gs.start(start, rand() * grain.duration);
        gs.stop(end);
        g.connect(am);
        tail = am;
      }
      src.connect(f).connect(g);
      tail.connect(s.to ?? out);
      src.start(start, rand() * noise.duration);
      src.stop(end);
    },
    bell(f, at, amp, decay, partials) {
      for (const [ratio, a, d] of partials) {
        if (f * ratio > ctx.sampleRate * 0.45) continue;
        b.tone({ f: f * ratio, at, attack: 0.001, decay: decay * d, amp: amp * a });
      }
    },
  };
  return b;
}

/** The menus' sounds (rendered first: they are needed first). */
export const isMenuSound = (name: SoundName): boolean => name.startsWith("ui");

/** Renders the sounds `which` picks at `sampleRate`. */
export async function renderLibrary(sampleRate: number, which: (name: SoundName) => boolean): Promise<Library> {
  const slots: { recipe: Recipe; start: number }[] = [];
  let length = 0;
  for (const recipe of RECIPES) {
    if (!which(recipe.name)) continue;
    for (let v = 0; v < recipe.variants; v++) {
      slots.push({ recipe, start: length });
      length += recipe.seconds + GAP;
    }
  }
  const ctx = new OfflineAudioContext(1, Math.ceil(length * sampleRate), sampleRate);
  const noise = noiseBuffer(ctx, 3, 0x5eed);
  const grain = grainBuffer(ctx, 3, 0x9a1);
  const variants = new Map<SoundName, number>();
  for (const { recipe, start } of slots) {
    const v = variants.get(recipe.name) ?? 0;
    variants.set(recipe.name, v + 1);
    recipe.build(builder(ctx, ctx.destination, start, rng(0x1000 + v * 7919 + recipe.name.length), noise, grain));
  }
  const all = (await ctx.startRendering()).getChannelData(0);
  const lib = new Map<SoundName, AudioBuffer[]>();
  for (const { recipe, start } of slots) {
    const from = Math.round(start * sampleRate);
    const n = Math.round(recipe.seconds * sampleRate);
    const cut = all.slice(from, from + n);
    let peak = 0;
    for (const s of cut) peak = Math.max(peak, Math.abs(s));
    const scale = peak > 0 ? 10 ** (recipe.peakDb / 20) / peak : 0;
    const fade = Math.round(FADE * sampleRate);
    for (let i = 0; i < n; i++) {
      const tail = n - i;
      cut[i] = cut[i]! * scale * (tail < fade ? tail / fade : 1);
    }
    const buf = new AudioBuffer({ length: n, sampleRate, numberOfChannels: 1 });
    buf.copyToChannel(cut, 0);
    const list = lib.get(recipe.name) ?? [];
    list.push(buf);
    lib.set(recipe.name, list);
  }
  return lib;
}
