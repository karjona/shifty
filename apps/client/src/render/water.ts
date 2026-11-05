// Layered water, in one material:
//
//  1. Swells  - physics. Same parameters and formula as crates/sim (uniforms
//               filled from WASM). The rider's height comes from these only.
//  2. Chop    - visual only. Many small waves on the GPU. They never touch
//               physics, so they can be as fancy as the GPU allows. Longer
//               chop moves the vertices; fine ripples only bend the
//               per-pixel normal, fading out with distance before they
//               would shimmer, and fleck the water near you with foam.
//     Surf foams along every shore, heaviest where a crest is hitting.
//  3. Wakes   - visual only. A world-locked texture that every rider's path
//               is stamped into each frame and that slowly fades; the water
//               turns it into foam. Built from rendered positions, which
//               every client has, so nothing extra goes over the network.
import * as THREE from "three/webgpu";
import type { LandData } from "./course.ts";
import { CEL } from "./cel/look.ts";
import { celWaterMaterial } from "./cel/water.ts";
import { MAX_WAVES, WaveUniforms, waterGrid } from "./waves.ts";
import {
  Fn,
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  max,
  min,
  mix,
  normalLocal,
  normalWorldGeometry,
  positionLocal,
  positionWorld,
  pow,
  reflector,
  screenUV,
  sin,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

const CHOP_WAVES = 10;
/** The reflection is rendered at this fraction of the screen resolution. */
const REFLECTION_SCALE = 0.5;
/** Most land pieces the shore foam knows about. */
const MAX_LAND = 16;
const RIPPLES = 12;
const MAX_WAKE_RIDERS = 8;
/** Wake texture covers this many metres, centred on the course. */
const WAKE_SPAN = 512;
const WAKE_RES = 1024;

export interface WakeSource {
  x: number;
  z: number;
  speed: number;
  grounded: boolean;
}

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
    const wavelength = 3 + rnd() * 6;
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

interface Ripple {
  kx: number;
  kz: number;
  amp: number;
  omega: number;
  phase: number;
  /** Fully faded out this far from the camera (m). */
  far: number;
  /** Under a metre long: these fleck the water with foam. */
  short: boolean;
}

/** Seeded fine ripples, 0.3 to 3 m long, in every direction. */
function rippleWaves(seed: number): Ripple[] {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const out: Ripple[] = [];
  for (let i = 0; i < RIPPLES; i++) {
    const wavelength = 0.3 * Math.pow(10, i / (RIPPLES - 1)) * (0.9 + rnd() * 0.2);
    const k = (2 * Math.PI) / wavelength;
    const angle = (i * 2.4 + rnd()) % (2 * Math.PI);
    out.push({
      kx: Math.cos(angle) * k,
      kz: Math.sin(angle) * k,
      amp: 0.055 / k,
      omega: Math.sqrt(9.81 * k),
      phase: rnd() * 6.283,
      far: 30 * wavelength + 6,
      short: wavelength < 1,
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

export class SeaWater {
  readonly mesh: THREE.Mesh;
  private wake = new WakeField();
  private time = uniform(0);
  private swells = new WaveUniforms(MAX_WAVES);
  private chop = new WaveUniforms(CHOP_WAVES);
  private origin = uniform(new THREE.Vector2());
  private swellDir = uniform(new THREE.Vector2(1, 0));
  /** Land capsules: segment (ax, az, bx, bz) and radius; unused ones sit far away. */
  private landSeg = uniformArray<"vec4">(
    Array.from({ length: MAX_LAND }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)),
    "vec4",
  );
  private landRadius = uniformArray<"float">(
    Array.from({ length: MAX_LAND }, () => 0),
    "float",
  );

  constructor(size: number, segments: number) {
    const t = this.time;
    const { swells, chop, origin, landSeg, landRadius } = this;
    const wakeTex = this.wake.output;

    const displaced = Fn(() => {
      const p = positionLocal.add(vec3(origin.x, 0, origin.y));
      const swell = swells.sum(p, t);
      const ripple = chop.sum(p, t);
      normalLocal.assign(vec3(swell.dx.add(ripple.dx).negate(), 1, swell.dz.add(ripple.dz).negate()).normalize());
      return positionLocal.add(vec3(0, swell.h.add(ripple.h), 0));
    });

    // Fine ripples at this pixel: slope (x, z) and height (y), faded by
    // distance; `w` is the height of the shortest ones alone (for flecks).
    const ripples = Fn(() => {
      const p = positionWorld.xz;
      const dist = cameraPosition.distance(positionWorld);
      let dx: THREE.Node<"float"> = float(0);
      let dz: THREE.Node<"float"> = float(0);
      let h: THREE.Node<"float"> = float(0);
      let short: THREE.Node<"float"> = float(0);
      for (const w of rippleWaves(7)) {
        const fade = smoothstep(w.far, w.far * 0.35, dist);
        const arg = p.x.mul(w.kx).add(p.y.mul(w.kz)).sub(t.mul(w.omega)).add(w.phase);
        const slope = cos(arg).mul(fade);
        dx = dx.add(slope.mul(w.amp * w.kx));
        dz = dz.add(slope.mul(w.amp * w.kz));
        const height = sin(arg).mul(fade).mul(w.amp);
        h = h.add(height);
        if (w.short) short = short.add(height);
      }
      return vec4(dx, h, dz, short);
    });
    const fine = ripples();
    const surfaceNormal = normalWorldGeometry.add(vec3(fine.x.negate(), 0, fine.z.negate())).normalize();

    // Distance from this pixel to the nearest shore (metres).
    const shoreAt = Fn(() => {
      const p = positionWorld.xz;
      let d: THREE.Node<"float"> = float(1e6);
      for (let i = 0; i < MAX_LAND; i++) {
        const seg = landSeg.element(i);
        const a = seg.xy;
        const ab = seg.zw.sub(a);
        const k = clamp(dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-4)), 0, 1);
        d = min(
          d,
          p
            .sub(a.add(ab.mul(k)))
            .length()
            .sub(landRadius.element(i)),
        );
      }
      return d;
    });

    const wakeAt = Fn(() => {
      const uvw = positionWorld.xz.div(WAKE_SPAN).add(0.5);
      return wakeTex.sample(vec2(uvw.x, uvw.y)).x;
    });

    const colour = Fn(() => {
      const deep = vec3(0.02, 0.24, 0.36);
      const shallow = vec3(0.1, 0.56, 0.62);
      const h = positionWorld.y;
      let c: THREE.Node<"vec3"> = mix(deep, shallow, smoothstep(-0.9, 1.3, h));
      // Crest foam where swell + chop pile up, and wake foam behind riders,
      // broken into streaks so it reads as churned water, not paint.
      const crest = smoothstep(1.15, 1.6, h).mul(0.4);
      const p = positionWorld.xz;
      const streaks = sin(p.x.mul(2.3).add(p.y.mul(0.7)).add(t.mul(1.3)))
        .mul(sin(p.y.mul(2.9).sub(p.x.mul(0.6)).sub(t.mul(0.9))))
        .mul(0.5)
        .add(0.5);
      const wake = smoothstep(0.04, 0.7, wakeAt()).mul(mix(float(0.55), float(1.0), streaks));
      // Flecks of foam where the fine ripples peak together, near you only.
      const near = smoothstep(45, 10, cameraPosition.distance(positionWorld));
      const flecks = smoothstep(0.011, 0.016, fine.w).mul(near).mul(0.5);
      // Surf: a white line where water meets land, bands of foam rolling
      // in, and more of both where a crest is hitting the shore.
      const shore = shoreAt();
      const hitting = smoothstep(-0.4, 1.1, h);
      const bands = sin(
        shore
          .mul(2.2)
          .add(t.mul(2.4))
          .add(sin(p.x.mul(0.31).add(p.y.mul(0.27))).mul(2)),
      )
        .mul(0.5)
        .add(0.5);
      const surf = smoothstep(1.4, 0.1, shore)
        .add(
          smoothstep(7, 1, shore)
            .mul(bands)
            .mul(mix(float(0.25), float(0.8), hitting)),
        )
        .mul(mix(float(0.6), float(1), hitting));
      const foam = clamp(crest.add(wake.mul(0.85)).add(flecks).add(surf), 0, 1);
      c = mix(c, vec3(0.93, 0.97, 1.0), foam);
      return vec4(c, foam);
    });

    // The world reflected (sky, land, riders, spray): mirrored about the
    // mean water level and bent by the waves, stronger at grazing angles
    // (Fresnel), none on foam.
    const mirror = reflector({ resolutionScale: REFLECTION_SCALE });
    mirror.target.rotateX(-Math.PI / 2);
    mirror.uvNode = screenUV.flipX().add(surfaceNormal.xz.mul(0.06));
    const surface = colour();
    const fresnel = Fn(() => {
      const v = cameraPosition.sub(positionWorld).normalize();
      const f = float(0.04).add(pow(float(1).sub(abs(dot(v, surfaceNormal))), 5).mul(0.62));
      return f.mul(float(1).sub(surface.w));
    })();

    const geo = waterGrid(size, segments);
    let mat: THREE.Material;
    if (CEL) {
      mat = celWaterMaterial({
        position: displaced(),
        surfaceNormal,
        fine,
        shore: shoreAt(),
        wake: wakeAt(),
        mirror,
        time: t,
        swellDir: this.swellDir,
      });
    } else {
      const standard = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0 });
      standard.positionNode = displaced();
      standard.colorNode = surface.xyz.mul(float(1).sub(fresnel));
      standard.emissiveNode = mirror.rgb.mul(fresnel);
      standard.normalNode = transformNormalToView(surfaceNormal);
      mat = standard;
    }
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // The mirror plane follows the grid (it only matters that it is level at y = 0).
    this.mesh.add(mirror.target);
  }

  /** Where the shores are, for the surf. */
  setLand(land: LandData[]): void {
    for (let i = 0; i < MAX_LAND; i++) {
      const l = land[i];
      this.landSeg.array[i] = l ? new THREE.Vector4(l.ax, l.az, l.bx, l.bz) : new THREE.Vector4(1e6, 1e6, 1e6, 1e6);
      this.landRadius.array[i] = l ? l.radius : 0;
    }
  }

  /** Move the grid's centre to world `(x, z)`. */
  follow(x: number, z: number): void {
    this.origin.value.set(x, z);
    this.mesh.position.set(x, 0, z);
  }

  setWaves(params: Float32Array, seed: number): void {
    this.swells.setFromSim(params);
    const mainDir = Math.atan2(params[1] ?? 0, params[0] ?? 1);
    this.swellDir.value.set(Math.cos(mainDir), Math.sin(mainDir));
    chopWaves(seed, mainDir).forEach((w, i) => this.chop.setSine(i, w.dx, w.dz, w.k, w.a, w.w, w.p));
  }

  update(renderer: THREE.WebGPURenderer, t: number, riders: Map<number, WakeSource>, dt: number): void {
    this.time.value = t;
    this.wake.update(renderer, riders, dt);
  }
}
