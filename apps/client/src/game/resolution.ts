// Automatic render resolution: drawing fewer pixels when frames come too
// slowly, and trying more again once they keep up. Frame times are all a
// browser tells us (not the GPU's own), so every change is a trial: one
// that doesn't help (the machine is short of CPU, or the display runs
// slower than 60 Hz) is undone, and not tried again for a while.

/** Frames should come at least this often (ms): 60 a second, with a little slack. */
const TARGET_MS = 1000 / 59;
/** A gap longer than this (ms) is a stall (loading, a hidden tab), not a slow frame. */
const STALL_MS = 250;
/** Frames looked at before each decision. */
const WINDOW = 40;
/** Each step changes the pixel ratio by this factor (about a quarter of the pixels). */
const STEP = 0.86;
/** A step down must make frames this much faster, or fast enough, to stay. */
const HELPS = 0.94;
/** Waits before trying more pixels again after a try failed (s), doubling each time. */
const BACKOFF_FROM = 4;
const BACKOFF_MAX = 120;

export class AutoResolution {
  /** Fraction of the device pixel ratio drawn, between `floor` and `ceil`. */
  scale = 1;
  private floor = 0.5;
  private ceil = 1;
  private gaps: number[] = [];
  /** What the last step was, and the frame time (mean gap, ms) before it. */
  private trial: { kind: "down" | "up"; from: number; before: number } | null = null;
  private backoff = BACKOFF_FROM;
  /** When (ms) more pixels may be tried again; when lowering may be tried again. */
  private upAt = 0;
  private downAt = 0;

  /** Sets the range for the window's size: at most `maxPixels`, at least `minHeight` pixels tall. */
  bounds(width: number, height: number, ratio: number, maxPixels: number, minHeight: number): void {
    const full = width * height * ratio * ratio;
    this.ceil = Math.min(1, Math.sqrt(maxPixels / Math.max(1, full)));
    this.floor = Math.min(this.ceil, minHeight / Math.max(1, height * ratio));
    this.scale = Math.min(this.ceil, Math.max(this.floor, this.scale));
  }

  /** Starts over at the most pixels (a new screen, or a new window size). */
  reset(): void {
    this.scale = this.ceil;
    this.gaps = [];
    this.trial = null;
    this.backoff = BACKOFF_FROM;
    this.upAt = 0;
    this.downAt = 0;
  }

  /** Forgets the frames so far (they were drawn under a cover, or loading). */
  forget(): void {
    this.gaps = [];
  }

  /**
   * One frame came `gap` ms after the last. Returns a new scale when it
   * should change, else null.
   */
  frame(gap: number, now: number): number | null {
    if (gap > STALL_MS) {
      this.gaps = [];
      return null;
    }
    this.gaps.push(gap);
    if (this.gaps.length < WINDOW) return null;
    // The mean, not the median: one frame in three running late is not smooth either.
    const mean = this.gaps.reduce((a, b) => a + b, 0) / this.gaps.length;
    this.gaps = [];
    const slow = mean > TARGET_MS;
    const trial = this.trial;
    this.trial = null;
    if (trial?.kind === "up") {
      if (slow) {
        // More pixels were too many: back down, and wait longer before trying again.
        this.upAt = now + this.backoff * 1000;
        this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
        return this.set(trial.from);
      }
      this.backoff = BACKOFF_FROM;
    } else if (trial?.kind === "down" && slow && mean > trial.before * HELPS) {
      // Fewer pixels didn't help: frames are slow for another reason. Undo, and leave it.
      this.downAt = now + BACKOFF_MAX * 1000;
      return this.set(trial.from);
    }
    if (slow && this.scale > this.floor * 1.02 && now >= this.downAt) {
      this.trial = { kind: "down", from: this.scale, before: mean };
      this.upAt = Math.max(this.upAt, now + this.backoff * 1000);
      return this.set(Math.max(this.floor, this.scale * STEP));
    }
    if (!slow && this.scale < this.ceil * 0.98 && now >= this.upAt) {
      this.trial = { kind: "up", from: this.scale, before: mean };
      return this.set(Math.min(this.ceil, this.scale / STEP));
    }
    return null;
  }

  private set(scale: number): number | null {
    if (Math.abs(scale - this.scale) < 1e-3) return null;
    this.scale = scale;
    return scale;
  }
}
