// Building blocks for synthesized sound: seeded noise, modulation textures
// rendered into looping buffers, a soft-clip curve, and a glide that moves
// an AudioParam toward per-frame targets without flooding its timeline.

/** Seeded PRNG (mulberry32): the same sounds on every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dbToGain = (db: number): number => 10 ** (db / 20);

/** White noise in [-1, 1], to loop. */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.round(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = rng(seed);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return buf;
}

/**
 * One-pole lowpass over `d` in place, run twice round the buffer so its
 * end flows into its start (the buffer loops without a seam).
 */
function loopLowpass(d: Float32Array, cutoff: number, rate: number): void {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
  let y = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < d.length; i++) {
      y += k * (d[i]! - y);
      if (pass === 1) d[i] = y;
    }
  }
}

/** Normalizes `d` to the range [0, 1]. */
function unit(d: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of d) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const span = hi - lo || 1;
  for (let i = 0; i < d.length; i++) d[i] = (d[i]! - lo) / span;
}

/** Sample rates of the modulation textures: they change slowly, so they need few samples (and build fast). */
const GRAIN_RATE = 8000;
const GUST_RATE = 3000;

/**
 * Crunch: a spiky, irregular envelope in [0, 1] (mean about 0.2), for
 * amplitude-modulating noise into grit (snow under an edge, chop on a hull).
 * At playback rate 1 its bumps come about 150 times a second.
 */
export function grainBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const rate = GRAIN_RATE;
  const buf = ctx.createBuffer(1, Math.round(seconds * rate), rate);
  const d = buf.getChannelData(0);
  const r = rng(seed);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  loopLowpass(d, 260, rate);
  for (let i = 0; i < d.length; i++) d[i] = Math.abs(d[i]!) ** 1.6;
  loopLowpass(d, 900, rate);
  unit(d);
  return buf;
}

/** Gusts: a slow random swell in [0, 1] that loops (wind). */
export function gustBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const rate = GUST_RATE;
  const buf = ctx.createBuffer(1, Math.round(seconds * rate), rate);
  const d = buf.getChannelData(0);
  const r = rng(seed);
  // Whole cycles per loop, so the loop is seamless.
  const waves = [1, 2, 5, 9, 17, 29].map((cycles, i) => ({
    w: (2 * Math.PI * cycles) / seconds,
    a: 1 / (1 + i * 0.7),
    p: r() * 2 * Math.PI,
  }));
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    let v = 0;
    for (const s of waves) v += s.a * Math.sin(s.w * t + s.p);
    d[i] = v;
  }
  unit(d);
  return buf;
}

/** tanh soft clip: `drive` sets how hard the curve bends at full scale. */
export function softClipCurve(drive = 1, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

/**
 * Moves an AudioParam toward a target each frame with `setTargetAtTime`,
 * skipping targets within `eps` of the last one so a steady value adds
 * nothing to the param's timeline.
 */
export class Glide {
  private readonly param: AudioParam;
  private readonly tc: number;
  private readonly eps: number;
  private last = Number.NaN;

  constructor(param: AudioParam, tc: number, eps: number) {
    this.param = param;
    this.tc = tc;
    this.eps = eps;
  }

  to(v: number, t: number, tc = this.tc): void {
    if (Math.abs(v - this.last) <= this.eps) return;
    this.last = v;
    this.param.setTargetAtTime(v, t, tc);
  }

  /** Jumps straight to `v`. */
  set(v: number, t: number): void {
    this.last = v;
    this.param.cancelScheduledValues(t);
    this.param.setValueAtTime(v, t);
  }
}

/** A looping buffer source, started at a random point of the buffer. */
export function loop(ctx: BaseAudioContext, buffer: AudioBuffer, offset: number, rate = 1): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(ctx.currentTime, offset * buffer.duration);
  return src;
}

export function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export function gain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
