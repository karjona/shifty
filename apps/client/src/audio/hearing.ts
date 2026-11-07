// Hearing from the camera: how loud, which side, how muffled and how
// Doppler-shifted a sound is from where it is and how it moves.
import { clamp01 } from "./dsp.ts";

/** Sounds further than this (m) from the camera are not heard. */
export const HEAR_M = 160;
/** Full level within this distance (m); beyond it, level falls with distance. */
const REF_M = 8;
const SPEED_OF_SOUND = 343;
/** A camera moving faster than this (m/s) has cut, not moved. */
const CUT_SPEED = 80;

export interface Heard {
  level: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  /** Lowpass cutoff (Hz): air absorbs the highs with distance, the head shades sounds behind. */
  cutoff: number;
  /** Frequency ratio. */
  doppler: number;
}

export class Hearing {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  /** The camera's right and forward. */
  rx = 1;
  ry = 0;
  rz = 0;
  fx = 0;
  fy = 0;
  fz = -1;
  private known = false;

  /** Follows the camera (its world matrix's elements), once a frame. */
  follow(e: ArrayLike<number>, dt: number): void {
    const x = e[12] ?? 0;
    const y = e[13] ?? 0;
    const z = e[14] ?? 0;
    if (this.known && dt > 0) {
      const vx = (x - this.x) / dt;
      const vy = (y - this.y) / dt;
      const vz = (z - this.z) / dt;
      const cut = Math.hypot(vx, vy, vz) > CUT_SPEED;
      const k = 1 - Math.exp(-10 * dt);
      this.vx += ((cut ? 0 : vx) - this.vx) * k;
      this.vy += ((cut ? 0 : vy) - this.vy) * k;
      this.vz += ((cut ? 0 : vz) - this.vz) * k;
    }
    this.x = x;
    this.y = y;
    this.z = z;
    this.known = true;
    this.rx = e[0] ?? 1;
    this.ry = e[1] ?? 0;
    this.rz = e[2] ?? 0;
    this.fx = -(e[8] ?? 0);
    this.fy = -(e[9] ?? 0);
    this.fz = -(e[10] ?? 1);
  }

  /** How a sound at (x, y, z) moving at (vx, vy, vz) is heard, into `out`; returns its distance. */
  hear(x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Heard): number {
    const dx = x - this.x;
    const dy = y - this.y;
    const dz = z - this.z;
    const d = Math.max(0.1, Math.hypot(dx, dy, dz));
    out.level = d >= HEAR_M ? 0 : (REF_M / Math.max(REF_M, d)) * clamp01((HEAR_M - d) / 30);
    const side = (dx * this.rx + dy * this.ry + dz * this.rz) / Math.max(d, 1);
    out.pan = Math.max(-1, Math.min(1, side)) * 0.8;
    const front = (dx * this.fx + dy * this.fy + dz * this.fz) / d;
    out.cutoff = Math.max(700, 14000 / (1 + d / 25)) * (front < 0 ? 0.65 : 1);
    // Positive: moving apart.
    const away = ((vx - this.vx) * dx + (vy - this.vy) * dy + (vz - this.vz) * dz) / d;
    out.doppler = Math.max(0.8, Math.min(1.25, SPEED_OF_SOUND / (SPEED_OF_SOUND + away)));
    return d;
  }
}
