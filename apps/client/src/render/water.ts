// "Water lab": the three water layers from our design, in one material.
//
//  1. Swells  - physics. Same parameters and formula as crates/sim (uniforms
//               filled from WASM). The rider's height comes from these only.
//  2. Chop    - visual only. Many small waves on the GPU. They never touch
//               physics, so they can be as fancy as the GPU allows.
//  3. Wakes   - visual only. A world-locked texture that every rider's path
//               is stamped into each frame and that slowly fades; the water
//               turns it into foam. Built from rendered positions, which
//               every client has, so nothing extra goes over the network.
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  max,
  mix,
  normalLocal,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

export const MAX_WAVES = 8;
const WAVE_FIELDS = 6;
const CHOP_WAVES = 14;
const MAX_WAKE_RIDERS = 8;
/** Wake texture covers this many metres, centred on the arena. */
const WAKE_SPAN = 256;
const WAKE_RES = 512;

export interface WakeSource {
  x: number;
  z: number;
  speed: number;
  grounded: boolean;
}

const vec4Uniform = () => uniform(new THREE.Vector4());
const vec2Uniform = () => uniform(new THREE.Vector2());

/** Seeded visual chop: short waves spread around the swell direction. */
function chopWaves(
  seed: number,
  mainDir: number,
): { dx: number; dz: number; k: number; a: number; w: number; p: number }[] {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < CHOP_WAVES; i++) {
    const angle = mainDir + (rnd() - 0.5) * 2.2;
    const wavelength = 1.2 + rnd() * 7;
    const k = (2 * Math.PI) / wavelength;
    out.push({
      dx: Math.cos(angle),
      dz: Math.sin(angle),
      k,
      a: (0.012 + rnd() * 0.018) / k,
      w: Math.sqrt(9.81 * k),
      p: rnd() * 6.283,
    });
  }
  return out;
}

class WakeField {
  private targets: [THREE.RenderTarget, THREE.RenderTarget];
  private quad: THREE.QuadMesh;
  // Texture nodes start on a placeholder; `update` points them at the
  // ping-pong targets each frame.
  private prevTex = texture(new THREE.Texture());
  readonly output = texture(new THREE.Texture());
  private segments = uniformArray<"vec4">(
    Array.from({ length: MAX_WAKE_RIDERS }, () => new THREE.Vector4()),
    "vec4",
  );
  private strength = uniformArray<"float">(
    Array.from({ length: MAX_WAKE_RIDERS }, () => 0),
    "float",
  );
  private fade = uniform(0.99);
  private last = new Map<number, { x: number; z: number }>();

  constructor() {
    const mk = () =>
      new THREE.RenderTarget(WAKE_RES, WAKE_RES, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        magFilter: THREE.LinearFilter,
      });
    this.targets = [mk(), mk()];
    this.prevTex.value = this.targets[0].texture;
    this.output.value = this.targets[1].texture;
    const segments = this.segments;
    const strength = this.strength;
    const fade = this.fade;
    const prev = this.prevTex;
    const texel = 1 / WAKE_RES;
    const stamp = Fn(() => {
      const world = uv().sub(0.5).mul(WAKE_SPAN); // texel -> world xz
      // Fade and diffuse last frame's wake: old wake spreads out and thins,
      // like real turbulence settling.
      const c = prev.sample(uv()).x;
      const n = prev
        .sample(uv().add(vec2(texel, 0)))
        .x.add(prev.sample(uv().sub(vec2(texel, 0))).x)
        .add(prev.sample(uv().add(vec2(0, texel))).x)
        .add(prev.sample(uv().sub(vec2(0, texel))).x)
        .mul(0.25);
      let w: THREE.Node<"float"> = mix(c, n, 0.35).mul(fade);
      for (let i = 0; i < MAX_WAKE_RIDERS; i++) {
        const seg = segments.element(i);
        const a = seg.xy;
        const b = seg.zw;
        // Distance from this texel to the rider's path segment this frame.
        const ab = b.sub(a);
        const t = clamp(dot(world.sub(a), ab).div(max(dot(ab, ab), 1e-4)), 0, 1);
        const d = world.sub(a.add(ab.mul(t))).length();
        // Narrow turbulent core plus a fainter shoulder.
        const core = smoothstep(0.9, 0.0, d);
        const shoulder = smoothstep(1.8, 0.8, d).mul(0.3);
        w = w.add(core.add(shoulder).mul(strength.element(i)));
      }
      return vec4(clamp(w, 0, 1), 0, 0, 1);
    });
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = stamp();
    this.quad = new THREE.QuadMesh(mat);
  }

  update(renderer: THREE.WebGPURenderer, riders: Map<number, WakeSource>, dt: number): void {
    // Fade so a wake lasts a few seconds.
    this.fade.value = Math.pow(0.7, dt);
    let i = 0;
    for (const [slot, r] of riders) {
      if (i >= MAX_WAKE_RIDERS) break;
      const prev = this.last.get(slot) ?? { x: r.x, z: r.z };
      const jump = Math.hypot(r.x - prev.x, r.z - prev.z) > 6; // teleport/respawn: no streak
      this.segments.array[i] = new THREE.Vector4(jump ? r.x : prev.x, jump ? r.z : prev.z, r.x, r.z);
      // Normalise by distance travelled this frame (core is ~1.8 m wide), so
      // each spot of water is painted about once however high the frame rate.
      const travelled = jump ? 0 : Math.hypot(r.x - prev.x, r.z - prev.z);
      const intensity = Math.min(1, Math.max(0, (r.speed - 2) / 14)) * 0.85;
      this.strength.array[i] = r.grounded ? intensity * Math.min(1, travelled / 1.8) : 0;
      this.last.set(slot, { x: r.x, z: r.z });
      i++;
    }
    for (; i < MAX_WAKE_RIDERS; i++) this.strength.array[i] = 0;
    // Ping-pong: read last frame, write this frame.
    const [read, write] = this.targets;
    this.prevTex.value = read.texture;
    renderer.setRenderTarget(write);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
    this.output.value = write.texture;
    this.targets = [write, read];
  }
}

export class LabWater {
  readonly mesh: THREE.Mesh;
  private wake = new WakeField();
  private time = uniform(0);
  private waveA = Array.from({ length: MAX_WAVES }, vec4Uniform);
  private waveB = Array.from({ length: MAX_WAVES }, vec2Uniform);
  private chopA = Array.from({ length: CHOP_WAVES }, vec4Uniform);
  private chopB = Array.from({ length: CHOP_WAVES }, vec2Uniform);

  constructor(size: number, segments: number, sky: THREE.Color) {
    const t = this.time;
    const { waveA, waveB, chopA, chopB } = this;
    const wakeTex = this.wake.output;

    const sumWaves = (p: THREE.Node<"vec3">, a: typeof waveA, b: typeof waveB) => {
      let h: THREE.Node<"float"> = float(0);
      let dx: THREE.Node<"float"> = float(0);
      let dz: THREE.Node<"float"> = float(0);
      for (let i = 0; i < a.length; i++) {
        const A = a[i]!;
        const B = b[i]!;
        const arg = A.z
          .mul(A.x.mul(p.x).add(A.y.mul(p.z)))
          .sub(B.x.mul(t))
          .add(B.y);
        h = h.add(A.w.mul(sin(arg)));
        const c = A.w.mul(A.z).mul(cos(arg));
        dx = dx.add(c.mul(A.x));
        dz = dz.add(c.mul(A.y));
      }
      return { h, dx, dz };
    };

    const displaced = Fn(() => {
      const p = positionLocal;
      const swell = sumWaves(p, waveA, waveB);
      const chop = sumWaves(p, chopA, chopB);
      normalLocal.assign(vec3(swell.dx.add(chop.dx).negate(), 1, swell.dz.add(chop.dz).negate()).normalize());
      return p.add(vec3(0, swell.h.add(chop.h), 0));
    });

    const wakeAt = Fn(() => {
      const uvw = positionWorld.xz.div(WAKE_SPAN).add(0.5);
      return wakeTex.sample(vec2(uvw.x, uvw.y)).x;
    });

    const colour = Fn(() => {
      const deep = vec3(0.02, 0.24, 0.36);
      const shallow = vec3(0.1, 0.56, 0.62);
      const h = positionWorld.y;
      let c: THREE.Node<"vec3"> = mix(deep, shallow, smoothstep(-0.5, 0.6, h));
      // Crest foam where swell + chop pile up, and wake foam behind riders,
      // broken into streaks so it reads as churned water, not paint.
      const crest = smoothstep(0.42, 0.62, h).mul(0.45);
      const p = positionWorld.xz;
      const streaks = sin(p.x.mul(2.3).add(p.y.mul(0.7)).add(t.mul(1.3)))
        .mul(sin(p.y.mul(2.9).sub(p.x.mul(0.6)).sub(t.mul(0.9))))
        .mul(0.5)
        .add(0.5);
      const wake = smoothstep(0.04, 0.7, wakeAt()).mul(mix(float(0.55), float(1.0), streaks));
      const foam = clamp(crest.add(wake.mul(0.85)), 0, 1);
      c = mix(c, vec3(0.93, 0.97, 1.0), foam);
      return c;
    });

    // Sky reflection, stronger at grazing angles (Fresnel).
    const skyColour = vec3(sky.r, sky.g, sky.b);
    const reflection = Fn(() => {
      const v = cameraPosition.sub(positionWorld).normalize();
      const fres = pow(float(1).sub(abs(v.y)), 4).mul(0.55);
      return skyColour.mul(fres);
    });

    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0 });
    mat.positionNode = displaced();
    mat.colorNode = colour();
    mat.emissiveNode = reflection();
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
  }

  setWaves(params: Float32Array, seed: number): void {
    for (let i = 0; i < MAX_WAVES; i++) {
      const o = i * WAVE_FIELDS;
      const p = (j: number) => params[o + j] ?? 0;
      this.waveA[i]!.value.set(p(0), p(1), p(2), p(3));
      this.waveB[i]!.value.set(p(4), p(5));
    }
    const mainDir = Math.atan2(params[1] ?? 0, params[0] ?? 1);
    chopWaves(seed, mainDir).forEach((w, i) => {
      this.chopA[i]!.value.set(w.dx, w.dz, w.k, w.a);
      this.chopB[i]!.value.set(w.w, w.p);
    });
  }

  update(renderer: THREE.WebGPURenderer, t: number, riders: Map<number, WakeSource>, dt: number): void {
    this.time.value = t;
    this.wake.update(renderer, riders, dt);
  }
}
