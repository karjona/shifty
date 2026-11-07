// The continuous sounds of a ride, synthesized live: the jetski's engine and
// hull on the water, the board on the snow, the wind. A full voice for your
// own rider; a cheap, positioned one for the riders around you. Every
// update glides params toward the frame's targets (see `Glide`).
import { biquad, clamp01, Glide, gain, grainBuffer, gustBuffer, loop, noiseBuffer, softClipCurve } from "./dsp.ts";

/** Buffers and shapes the voices share (one set per context). */
export interface Kit {
  noise: AudioBuffer;
  grain: AudioBuffer;
  gust: AudioBuffer;
  /** One engine revolution of a three-cylinder two-stroke: every third harmonic fires. */
  engine: PeriodicWave;
  clip: Float32Array<ArrayBuffer>;
}

export function makeKit(ctx: BaseAudioContext): Kit {
  const n = 40;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) imag[k] = (k % 3 === 0 ? 1 : 0.22) / k ** 0.85;
  return {
    noise: noiseBuffer(ctx, 4, 0xa11),
    grain: grainBuffer(ctx, 4, 0xb22),
    gust: gustBuffer(ctx, 16, 0xc33),
    engine: ctx.createPeriodicWave(real, imag),
    clip: softClipCurve(3),
  };
}

/** Engine revolutions per second at full revs; idle and the cut-out are fractions of it. */
export const REV_MAX = 118;
export const REV_IDLE = 0.19;
/** Unloaded (the pump out of the water), the engine overruns its full revs by this much. */
const REV_AIR = 1.12;
/** How hard the engine still sounds driven in the air (it flares, it doesn't fade). */
export const AIR_LOAD = 0.6;

/**
 * One step of an engine's revs (fraction of `REV_MAX`): throttle loads the
 * jet pump, which holds the revs to throttle and speed in the water; out of
 * it the pump spins free and the engine flares. A bail cuts it (the lanyard).
 */
export function stepRevs(
  revs: number,
  dt: number,
  throttle: number,
  speedN: number,
  air: boolean,
  bail: boolean,
): number {
  const t = Math.abs(throttle);
  let target: number;
  let rate: number;
  if (bail) {
    target = 0;
    rate = 2.5;
  } else if (air) {
    target = REV_IDLE + (REV_AIR - REV_IDLE) * Math.min(1, 0.3 + t);
    rate = 5;
  } else {
    target = REV_IDLE + (1 - REV_IDLE) * t * (0.78 + 0.22 * speedN) + 0.04 * speedN;
    rate = target > revs ? 2.2 + 1.5 * t : 3.5;
  }
  return revs + (target - revs) * (1 - Math.exp(-rate * dt));
}

/** Your jetski's engine: firing buzz through a drive stage, exhaust rasp, pump whine. */
export class JetEngine {
  readonly out: GainNode;
  private osc: OscillatorNode;
  private whine: OscillatorNode;
  private noise: AudioBufferSourceNode;
  private freq: Glide;
  private drive: Glide;
  private tone: Glide;
  private level: Glide;
  private raspTone: Glide;
  private raspLevel: Glide;
  private whineFreq: Glide;
  private whineLevel: Glide;
  revs = REV_IDLE;
  private load = 0;

  constructor(ctx: BaseAudioContext, kit: Kit) {
    this.out = gain(ctx, 0);
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(kit.engine);
    this.osc.frequency.value = REV_MAX * REV_IDLE;
    const pre = gain(ctx, 0.25);
    const shaper = ctx.createWaveShaper();
    shaper.curve = kit.clip;
    shaper.oversample = "2x";
    const lp = biquad(ctx, "lowpass", 600, 1.2);
    this.osc.connect(pre).connect(shaper).connect(lp).connect(this.out);
    // Exhaust rasp: noise gated by the firing pulses (ring-modulated by the engine's own wave).
    this.noise = loop(ctx, kit.noise, 0.13);
    const bp = biquad(ctx, "bandpass", 1500, 0.9);
    const am = gain(ctx, 0);
    const rasp = gain(ctx, 0);
    this.osc.connect(am.gain);
    this.noise.connect(bp).connect(am).connect(rasp).connect(this.out);
    // Jet pump whine.
    this.whine = ctx.createOscillator();
    this.whine.type = "triangle";
    const wg = gain(ctx, 0);
    this.whine.connect(wg).connect(this.out);
    const t = ctx.currentTime;
    this.osc.start(t);
    this.whine.start(t);
    this.freq = new Glide(this.osc.frequency, 0.03, 0.05);
    this.drive = new Glide(pre.gain, 0.05, 0.005);
    this.tone = new Glide(lp.frequency, 0.05, 5);
    this.level = new Glide(this.out.gain, 0.05, 0.002);
    this.raspTone = new Glide(bp.frequency, 0.05, 10);
    this.raspLevel = new Glide(rasp.gain, 0.05, 0.002);
    this.whineFreq = new Glide(this.whine.frequency, 0.03, 0.5);
    this.whineLevel = new Glide(wg.gain, 0.08, 0.001);
  }

  update(t: number, dt: number, throttle: number, speedN: number, air: boolean, bail: boolean): void {
    this.revs = stepRevs(this.revs, dt, throttle, speedN, air, bail);
    const load = bail ? 0 : air ? AIR_LOAD : Math.abs(throttle);
    this.load += (load - this.load) * (1 - Math.exp(-8 * dt));
    const r = this.revs;
    const l = this.load;
    // Below idle the engine is stopping (a bail): it fades with its revs.
    const running = clamp01(r / REV_IDLE);
    this.freq.to(REV_MAX * Math.max(r, 0.02), t);
    this.drive.to(0.25 + 0.75 * l, t);
    this.tone.to((380 + 2600 * (0.35 * r + 0.65 * l)) * (air ? 1.35 : 1), t);
    // The drive stage makes most of the difference between idle and full throttle.
    this.level.to((0.11 + 0.02 * r + 0.012 * l) * running, t, bail ? 0.15 : 0.05);
    this.raspTone.to(800 + 2400 * r, t);
    this.raspLevel.to(0.3 * l * r * running, t);
    this.whineFreq.to(REV_MAX * Math.max(r, 0.02) * 13.5, t);
    this.whineLevel.to((0.025 * r * r + (air ? 0.02 : 0)) * running, t);
  }

  stop(t: number): void {
    this.osc.stop(t);
    this.whine.stop(t);
    this.noise.stop(t);
  }
}

/** Your hull on the water: hiss, the bow's wash slapping through the chop, and spray in a carve. */
export class Hull {
  readonly out: GainNode;
  private sources: AudioBufferSourceNode[];
  private hissTone: Glide;
  private hiss: Glide;
  private washTone: Glide;
  private wash: Glide;
  private chop: Glide;
  private chopRate: Glide;
  private spray: Glide;

  constructor(ctx: BaseAudioContext, kit: Kit) {
    this.out = gain(ctx, 1);
    const noise = loop(ctx, kit.noise, 0.41);
    const hissBp = biquad(ctx, "bandpass", 2000, 0.8);
    const hissG = gain(ctx, 0);
    noise.connect(hissBp).connect(hissG).connect(this.out);
    const washLp = biquad(ctx, "lowpass", 400, 0.7);
    const washG = gain(ctx, 0);
    const chopAm = gain(ctx, 0.5);
    const grain = loop(ctx, kit.grain, 0.7, 0.3);
    const chopDepth = gain(ctx, 0);
    grain.connect(chopDepth).connect(chopAm.gain);
    noise.connect(washLp).connect(chopAm).connect(washG).connect(this.out);
    const sprayHp = biquad(ctx, "highpass", 3500, 0.7);
    const sprayG = gain(ctx, 0);
    noise.connect(sprayHp).connect(sprayG).connect(this.out);
    this.sources = [noise, grain];
    this.hissTone = new Glide(hissBp.frequency, 0.08, 20);
    this.hiss = new Glide(hissG.gain, 0.05, 0.002);
    this.washTone = new Glide(washLp.frequency, 0.08, 10);
    this.wash = new Glide(washG.gain, 0.05, 0.002);
    this.chop = new Glide(chopDepth.gain, 0.1, 0.01);
    this.chopRate = new Glide(grain.playbackRate, 0.2, 0.02);
    this.spray = new Glide(sprayG.gain, 0.04, 0.002);
  }

  /** `jolt` (0-1): how hard the hull is slamming through the chop this moment. */
  update(t: number, speedN: number, air: boolean, bail: boolean, steer: number, jolt: number): void {
    const wet = air ? 0 : 1;
    const s = bail ? speedN * 0.3 : speedN;
    this.hissTone.to(900 + 2000 * s, t);
    this.hiss.to(0.22 * s ** 1.3 * wet, t, air ? 0.02 : 0.05);
    this.washTone.to(250 + 700 * s + 400 * jolt, t);
    this.wash.to((0.35 * s ** 0.8 + 0.3 * jolt) * wet, t, air ? 0.02 : 0.05);
    this.chop.to(0.7 * clamp01(s * 1.5), t);
    this.chopRate.to(0.15 + 0.5 * s, t);
    this.spray.to((0.05 * Math.abs(steer) * s + 0.06 * jolt) * wet * (bail ? 0 : 1), t);
  }

  stop(t: number): void {
    for (const s of this.sources) s.stop(t);
  }
}

/** Wind past your ears: rises with speed, louder and brighter in the air, gusting. */
export class Wind {
  readonly out: GainNode;
  private sources: AudioBufferSourceNode[];
  private tone: Glide;
  private level: Glide;

  constructor(ctx: BaseAudioContext, kit: Kit) {
    this.out = gain(ctx, 0);
    const noise = loop(ctx, kit.noise, 0.77);
    const bp = biquad(ctx, "bandpass", 400, 0.5);
    const am = gain(ctx, 0.6);
    const gust = loop(ctx, kit.gust, Math.random());
    const depth = gain(ctx, 0.4);
    gust.connect(depth).connect(am.gain);
    noise.connect(bp).connect(am).connect(this.out);
    this.sources = [noise, gust];
    this.tone = new Glide(bp.frequency, 0.15, 10);
    this.level = new Glide(this.out.gain, 0.12, 0.002);
  }

  update(t: number, speedN: number, air: boolean): void {
    const s = clamp01(speedN);
    this.tone.to(280 + 900 * s + (air ? 250 : 0), t);
    this.level.to(0.16 * s * s * (air ? 1.8 : 1), t);
  }

  stop(t: number): void {
    for (const s of this.sources) s.stop(t);
  }
}

/** Your board on the snow: the base gliding, the edge carving, the tail skidding (and chattering). */
export class Board {
  readonly out: GainNode;
  private sources: AudioBufferSourceNode[];
  private glideTone: Glide;
  private glide: Glide;
  private carveTone: Glide;
  private carve: Glide;
  private skidTone: Glide;
  private skid: Glide;
  private grit: Glide;
  private gritRate: Glide;

  constructor(ctx: BaseAudioContext, kit: Kit) {
    this.out = gain(ctx, 1);
    const noise = loop(ctx, kit.noise, 0.29);
    const glideLp = biquad(ctx, "lowpass", 600, 0.4);
    const glideG = gain(ctx, 0);
    noise.connect(glideLp).connect(glideG).connect(this.out);
    const carveBp = biquad(ctx, "bandpass", 2500, 0.8);
    const carveG = gain(ctx, 0);
    noise.connect(carveBp).connect(carveG).connect(this.out);
    const skidBp = biquad(ctx, "bandpass", 1200, 0.6);
    const am = gain(ctx, 0.3);
    const grain = loop(ctx, kit.grain, 0.53, 0.8);
    const depth = gain(ctx, 0.9);
    grain.connect(depth).connect(am.gain);
    const skidG = gain(ctx, 0);
    noise.connect(skidBp).connect(am).connect(skidG).connect(this.out);
    this.sources = [noise, grain];
    this.glideTone = new Glide(glideLp.frequency, 0.08, 10);
    this.glide = new Glide(glideG.gain, 0.05, 0.002);
    this.carveTone = new Glide(carveBp.frequency, 0.08, 20);
    this.carve = new Glide(carveG.gain, 0.05, 0.002);
    this.skidTone = new Glide(skidBp.frequency, 0.08, 10);
    this.skid = new Glide(skidG.gain, 0.04, 0.002);
    this.grit = new Glide(depth.gain, 0.05, 0.01);
    this.gritRate = new Glide(grain.playbackRate, 0.1, 0.02);
  }

  /**
   * `edge` (0-1): how hard the board is on its edge; `skid` (0-1): how
   * sideways it is scraping (braking, or sliding out); `wobble` (0-1): a
   * sketchy landing's chatter.
   */
  update(t: number, speedN: number, edge: number, skid: number, air: boolean, wobble: number): void {
    const s = clamp01(speedN);
    const on = air ? 0 : 1;
    const tc = air ? 0.02 : 0.05;
    this.glideTone.to(300 + 1400 * s, t);
    this.glide.to(0.5 * s ** 1.2 * (1 - 0.4 * edge) * on, t, tc);
    this.carveTone.to(1400 + 1800 * s, t);
    this.carve.to(0.55 * edge * s ** 0.9 * (1 - skid) * on, t, tc);
    this.skidTone.to(600 + 1000 * s, t);
    this.skid.to((1.1 * skid + 0.35 * wobble) * Math.min(1, s * 2.5) * on, t, tc);
    this.grit.to(0.9 + 0.8 * wobble, t);
    this.gritRate.to(0.45 + 1.6 * s, t);
  }

  stop(t: number): void {
    for (const s of this.sources) s.stop(t);
  }
}

/** Where a far voice sits: distance (gain and air absorption) and pan. */
class Placement {
  readonly input: BiquadFilterNode;
  private air: Glide;
  private level: Glide;
  private side: Glide;

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.input = biquad(ctx, "lowpass", 8000, 0.5);
    const g = gain(ctx, 0);
    const pan = ctx.createStereoPanner();
    this.input.connect(g).connect(pan).connect(out);
    this.air = new Glide(this.input.frequency, 0.08, 30);
    this.level = new Glide(g.gain, 0.08, 0.001);
    this.side = new Glide(pan.pan, 0.06, 0.01);
  }

  place(t: number, level: number, pan: number, cutoff: number): void {
    this.air.to(cutoff, t);
    this.level.to(level, t);
    this.side.to(pan, t);
  }
}

/** Someone else's jetski: engine buzz and hull hiss, placed around you. */
export class FarJetski {
  private place: Placement;
  private osc: OscillatorNode;
  private noise: AudioBufferSourceNode;
  private freq: Glide;
  private tone: Glide;
  private engine: Glide;
  private hiss: Glide;

  constructor(ctx: BaseAudioContext, kit: Kit, out: AudioNode) {
    this.place = new Placement(ctx, out);
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(kit.engine);
    const pre = gain(ctx, 0.7);
    const shaper = ctx.createWaveShaper();
    shaper.curve = kit.clip;
    const lp = biquad(ctx, "lowpass", 1500, 1);
    const eg = gain(ctx, 0);
    this.osc.connect(pre).connect(shaper).connect(lp).connect(eg).connect(this.place.input);
    this.noise = loop(ctx, kit.noise, Math.random());
    const bp = biquad(ctx, "bandpass", 1800, 0.7);
    const hg = gain(ctx, 0);
    this.noise.connect(bp).connect(hg).connect(this.place.input);
    this.osc.start(ctx.currentTime);
    this.freq = new Glide(this.osc.frequency, 0.04, 0.1);
    this.tone = new Glide(lp.frequency, 0.08, 10);
    this.engine = new Glide(eg.gain, 0.06, 0.002);
    this.hiss = new Glide(hg.gain, 0.06, 0.002);
  }

  update(
    t: number,
    revs: number,
    load: number,
    speedN: number,
    air: boolean,
    doppler: number,
    level: number,
    pan: number,
    cutoff: number,
  ): void {
    const running = clamp01(revs / REV_IDLE);
    this.freq.to(REV_MAX * Math.max(revs, 0.02) * doppler, t);
    this.tone.to((500 + 2200 * (0.4 * revs + 0.6 * load)) * (air ? 1.3 : 1), t);
    this.engine.to((0.06 + 0.08 * revs + 0.06 * load) * running, t);
    this.hiss.to(air ? 0 : 0.1 * speedN ** 1.3, t);
    this.place.place(t, level, pan, cutoff);
  }

  stop(t: number): void {
    this.osc.stop(t);
    this.noise.stop(t);
  }
}

/** Someone else's board: one band of snow noise, carving or scraping, placed around you. */
export class FarBoard {
  private place: Placement;
  private sources: AudioBufferSourceNode[];
  private tone: Glide;
  private level: Glide;
  private grit: Glide;

  constructor(ctx: BaseAudioContext, kit: Kit, out: AudioNode) {
    this.place = new Placement(ctx, out);
    const noise = loop(ctx, kit.noise, Math.random());
    const bp = biquad(ctx, "bandpass", 2000, 0.7);
    const am = gain(ctx, 0.5);
    const grain = loop(ctx, kit.grain, Math.random(), 1.2);
    const depth = gain(ctx, 0);
    grain.connect(depth).connect(am.gain);
    const g = gain(ctx, 0);
    noise.connect(bp).connect(am).connect(g).connect(this.place.input);
    this.sources = [noise, grain];
    this.tone = new Glide(bp.frequency, 0.08, 20);
    this.level = new Glide(g.gain, 0.05, 0.002);
    this.grit = new Glide(depth.gain, 0.08, 0.01);
  }

  update(
    t: number,
    speedN: number,
    edge: number,
    skid: number,
    air: boolean,
    level: number,
    pan: number,
    cutoff: number,
  ): void {
    const s = clamp01(speedN);
    this.tone.to(800 + 1600 * s * (1 - 0.5 * skid) + 500 * edge, t);
    this.level.to(air ? 0 : (0.35 + 0.5 * edge + 0.75 * skid) * s, t, air ? 0.02 : 0.05);
    this.grit.to(0.2 + 1.2 * skid, t);
    this.place.place(t, level, pan, cutoff);
  }

  stop(t: number): void {
    for (const s of this.sources) s.stop(t);
  }
}
