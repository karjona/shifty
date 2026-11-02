// The swell formula from `crates/sim/src/surface.rs`, for the GPU (TSL) and
// for render-only CPU use (placing buoys). Must match the sim: the water you
// see is the water the physics rides.
import * as THREE from "three/webgpu";
import { cos, float, max, pow, sin, uniform } from "three/tsl";

export const MAX_WAVES = 8;
/** Floats per wave from WASM: dir_x, dir_z, k, amplitude, omega, phase, sharpness, 0. */
export const WAVE_FIELDS = 8;

/** Mean of `((1 + sin a) / 2)^p` for integer `p`: C(2p, p) / 4^p. */
function shapeMean(p: number): number {
  if (p >= 3) return 0.3125;
  if (p >= 2) return 0.375;
  return 0.5;
}

/** Height of the swells at `(x, z)` at time `t` (seconds). */
export function waveHeight(params: Float32Array, x: number, z: number, t: number): number {
  let h = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    const o = i * WAVE_FIELDS;
    const amp = params[o + 3] ?? 0;
    if (amp === 0) continue;
    const a =
      (params[o + 2] ?? 0) * ((params[o] ?? 0) * x + (params[o + 1] ?? 0) * z) -
      (params[o + 4] ?? 0) * t +
      (params[o + 5] ?? 0);
    const p = Math.max(1, Math.round(params[o + 6] ?? 1));
    const u = (1 + Math.sin(a)) / 2;
    h += 2 * amp * (u ** p - shapeMean(p));
  }
  return h;
}

/** A bank of waves as shader uniforms: `a = (dir_x, dir_z, k, amplitude)`, `b = (omega, phase, sharpness, mean)`. */
const vec4Uniform = (x = 0, y = 0, z = 0, w = 0) => uniform(new THREE.Vector4(x, y, z, w));
type Vec4Uniform = ReturnType<typeof vec4Uniform>;

export class WaveUniforms {
  readonly count: number;
  readonly a: Vec4Uniform[];
  readonly b: Vec4Uniform[];

  constructor(count: number) {
    this.count = count;
    this.a = Array.from({ length: count }, () => vec4Uniform());
    this.b = Array.from({ length: count }, () => vec4Uniform(0, 0, 1, 0.5));
  }

  /** Load sim wave parameters (see `WAVE_FIELDS`). */
  setFromSim(params: Float32Array): void {
    for (let i = 0; i < this.count; i++) {
      const o = i * WAVE_FIELDS;
      const p = (j: number) => params[o + j] ?? 0;
      const sharp = Math.max(1, Math.round(p(6)));
      this.a[i]!.value.set(p(0), p(1), p(2), p(3));
      this.b[i]!.value.set(p(4), p(5), sharp, shapeMean(sharp));
    }
  }

  /** Plain sines (visual chop). */
  setSine(i: number, dirX: number, dirZ: number, k: number, amp: number, omega: number, phase: number): void {
    this.a[i]!.value.set(dirX, dirZ, k, amp);
    this.b[i]!.value.set(omega, phase, 1, 0.5);
  }

  /** Height and slope of the summed waves at `p` (xz) and time `t`. */
  sum(p: THREE.Node<"vec3">, t: THREE.Node<"float">) {
    let h: THREE.Node<"float"> = float(0);
    let dx: THREE.Node<"float"> = float(0);
    let dz: THREE.Node<"float"> = float(0);
    for (let i = 0; i < this.count; i++) {
      const A = this.a[i]!;
      const B = this.b[i]!;
      const arg = A.z
        .mul(A.x.mul(p.x).add(A.y.mul(p.z)))
        .sub(B.x.mul(t))
        .add(B.y);
      const u = sin(arg).add(1).mul(0.5);
      h = h.add(A.w.mul(2).mul(pow(u, B.z).sub(B.w)));
      // d/d(arg) = A p u^(p-1) cos(arg)
      const c = A.w
        .mul(B.z)
        .mul(pow(max(u, 1e-4), B.z.sub(1)))
        .mul(cos(arg));
      dx = dx.add(c.mul(A.z).mul(A.x));
      dz = dz.add(c.mul(A.z).mul(A.y));
    }
    return { h, dx, dz };
  }
}
