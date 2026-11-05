// Spray thrown up by the jetskis, in two layers:
//
//  - Droplets: a rooster tail from the jet, a wash off both sides of the
//    hull (heavier on the outside of a slide), and bursts when the bow digs
//    into a swell or the hull lands.
//  - Mist: big, faint puffs from the same places that hang behind the ski
//    and drift past the camera, so riding fast, carving hard or landing
//    veils the screen in white.
//  - Shore splashes: where a swell crest hits the quay, the island or a
//    rock, water bursts up the wall.
//
// Render-only: driven by the drawn rider state, simulated on the CPU, each
// layer drawn as one batch of camera-facing sprites.
import * as THREE from "three/webgpu";
import { CEL } from "./cel/look.ts";
import { inkNode, inkOnlyInPass } from "./cel/material.ts";
import {
  cameraPosition,
  float,
  hash,
  instanceIndex,
  instancedDynamicBufferAttribute,
  mix,
  smoothstep,
  uv,
  vec3,
} from "three/tsl";
import type { LandData } from "./course.ts";
import type { RiderView } from "./world.ts";

/** Hull points in hull space (x = left, y = up, z = forward), from the bottom of the hull. */
const JET = new THREE.Vector3(0, 0.15, -1.3);
const BOW = new THREE.Vector3(0, 0.15, 1.2);
const SIDE_X = 0.6;
const SIDE_Z = -0.1;

/** Shore splash points: spacing along the shore (m), how high and rising the swell must be, range from the camera. */
const SHORE_STEP = 4;
const SPLASH_HEIGHT = 0.45;
const SPLASH_RANGE = 140;

export interface PoolLook {
  max: number;
  /** Particle colour (linear RGB); spray white by default. */
  color?: [number, number, number];
  /** Downward pull (m/s²) and air drag (per second). */
  gravity: number;
  drag: number;
  /** Where the disc starts to fade toward its rim (0.5 = hard edge, 0 = all soft). */
  rim: number;
  /** Fully gone this close to the camera, fully shown from `lensTo`. */
  lensFrom: number;
  lensTo: number;
  /** Peak opacity, and how fast it is reached (per unit of life). */
  peak: number;
  fadeIn: number;
}

/** A batch of particles: CPU-simulated, drawn as camera-facing discs. */
export class ParticlePool {
  readonly sprite: THREE.Sprite;
  private look: PoolLook;
  /** Per particle, drawn: position + size, and alpha. */
  private ps: Float32Array;
  private alpha: Float32Array;
  private posSizeAttr: THREE.InstancedBufferAttribute;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private next = 0;

  constructor(look: PoolLook) {
    this.look = look;
    const n = look.max;
    this.ps = new Float32Array(n * 4);
    this.alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.posSizeAttr = new THREE.InstancedBufferAttribute(this.ps, 4);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alpha, 1);
    this.posSizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);

    const ps = instancedDynamicBufferAttribute<"vec4">(this.posSizeAttr, "vec4");
    const a = instancedDynamicBufferAttribute<"float">(this.alphaAttr, "float");
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.positionNode = ps.xyz;
    mat.scaleNode = ps.w;
    // A disc, a touch shaded toward its bottom and varied per particle so
    // a plume has body.
    const r = uv().sub(0.5).length();
    const shade = float(0.9).add(uv().y.mul(0.06)).add(hash(instanceIndex).mul(0.06));
    const [cr, cg, cb] = look.color ?? [0.9, 0.95, 0.98];
    mat.colorNode = vec3(cr, cg, cb).mul(shade);
    const lens = smoothstep(look.lensFrom, look.lensTo, ps.xyz.distance(cameraPosition));
    mat.opacityNode = smoothstep(0.5, look.rim, r).mul(a).mul(lens);
    if (CEL) {
      // Cut-out splashes: solid white puffs with a pale blue underside, shrinking as they fade.
      mat.transparent = false;
      mat.depthWrite = true;
      mat.opacityNode = null;
      // Droplets, not mist: smaller, and only while the particle is still dense.
      mat.scaleNode = ps.w.mul(0.55);
      mat.maskNode = r.lessThan(a.mul(lens).sub(0.15).max(0).mul(0.55));
      mat.colorNode = mix(vec3(0.74, 0.88, 0.97), vec3(1), smoothstep(0.45, 0.6, uv().y));
      inkOnlyInPass(mat, inkNode(1, 0, 0.77, 0.25));
    }
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = n;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 1;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
  ): void {
    const i = this.next;
    this.next = (i + 1) % this.look.max;
    this.ps[i * 4] = x;
    this.ps[i * 4 + 1] = y;
    this.ps[i * 4 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
  }

  /** Move every particle; ones that fall back into the water (or snow) are gone. */
  update(water: (x: number, z: number) => number, dt: number, wind?: { x: number; z: number }): void {
    const { ps, alpha, look } = this;
    const drag = Math.exp(-look.drag * dt);
    for (let i = 0; i < look.max; i++) {
      const life = this.life[i]!;
      if (life <= 0) continue;
      const age = this.age[i]! + dt;
      const o = i * 4;
      const v = i * 3;
      let vy = this.vel[v + 1]! - look.gravity * dt;
      const vx = this.vel[v]! * drag + (wind ? wind.x * (1 - drag) : 0);
      const vz = this.vel[v + 2]! * drag + (wind ? wind.z * (1 - drag) : 0);
      vy *= drag;
      this.vel[v] = vx;
      this.vel[v + 1] = vy;
      this.vel[v + 2] = vz;
      ps[o]! += vx * dt;
      ps[o + 1]! += vy * dt;
      ps[o + 2]! += vz * dt;
      const t = age / life;
      if (t >= 1 || (vy < 0 && ps[o + 1]! < water(ps[o]!, ps[o + 2]!) - 0.1)) {
        this.life[i] = 0;
        alpha[i] = 0;
        ps[o + 3] = 0;
        continue;
      }
      this.age[i] = age;
      ps[o + 3] = this.size0[i]! + (this.size1[i]! - this.size0[i]!) * Math.sqrt(t);
      alpha[i] = look.peak * (1 - t) * Math.min(1, t * look.fadeIn);
    }
    this.posSizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}

interface Emitter {
  /** Fractional particles carried to the next frame, per stream. */
  jet: number;
  wash: number;
  mist: number;
  carve: number;
  grounded: boolean;
  vy: number;
}

export class Spray {
  readonly group = new THREE.Group();
  private topSpeed: number;
  private drops = new ParticlePool({
    max: 4096,
    gravity: 9.8,
    drag: 1.4,
    rim: 0.12,
    // Droplets right at the lens would smear across the screen.
    lensFrom: 0.7,
    lensTo: 2.2,
    peak: 0.85,
    fadeIn: 12,
  });
  private mist = new ParticlePool({
    max: 768,
    gravity: 1.2,
    drag: 1.1,
    rim: 0,
    lensFrom: 0.2,
    lensTo: 0.9,
    peak: 0.3,
    fadeIn: 5,
  });
  private emitters = new Map<number, Emitter>();
  /** Shore splash points: x, z, outward normal x, z; last swell height; cooldown. */
  private shore: Float32Array = new Float32Array(0);
  private shoreLast: Float32Array = new Float32Array(0);
  private shoreWait: Float32Array = new Float32Array(0);
  private tmp = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private left = new THREE.Vector3();

  constructor(topSpeed: number) {
    this.topSpeed = topSpeed;
    this.group.add(this.drops.sprite, this.mist.sprite);
  }

  /** Emit for one rider; `hull` is its drawn hull (world matrix up to date). */
  emit(r: RiderView, hull: THREE.Object3D, water: (x: number, z: number) => number, dt: number): void {
    let e = this.emitters.get(r.slot);
    if (!e) {
      e = { jet: 0, wash: 0, mist: 0, carve: 0, grounded: r.grounded, vy: r.vy };
      this.emitters.set(r.slot, e);
    }
    const pace = Math.min(1, r.speed / this.topSpeed);
    this.fwd.set(Math.sin(r.yaw), 0, Math.cos(r.yaw));
    this.left.set(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
    const { fwd, left } = this;
    const vx = r.vx;
    const vz = r.vz;
    const slide = vx * left.x + vz * left.z;
    const rnd = Math.random;

    if (r.grounded && !r.bailing && r.speed > 3) {
      // Rooster tail: thrown up and back from the jet, left behind by the ski.
      const jet = hull.localToWorld(this.tmp.copy(JET));
      const jetWater = water(jet.x, jet.z);
      if (jet.y < jetWater + 0.35) {
        jet.y = Math.max(jet.y, jetWater + 0.05);
        for (e.jet += dt * 240 * pace; e.jet >= 1; e.jet--) {
          const back = 3 + 5 * rnd();
          const side = (rnd() - 0.5) * 1.8;
          this.drops.spawn(
            jet.x,
            jet.y,
            jet.z,
            vx - fwd.x * back + left.x * side,
            1.8 + 3.6 * pace * rnd(),
            vz - fwd.z * back + left.z * side,
            0.45 + 0.35 * rnd(),
            0.1 + 0.08 * rnd(),
            0.3 + 0.3 * pace * rnd(),
          );
        }
        // Its mist hangs in the air behind the ski, where the camera rides.
        for (e.mist += dt * 80 * pace * pace; e.mist >= 1; e.mist--) {
          const side = (rnd() - 0.5) * 2.4;
          this.mist.spawn(
            jet.x + left.x * side * 0.3,
            jet.y + 0.3,
            jet.z + left.z * side * 0.3,
            vx * 0.9 + left.x * side,
            0.8 + rnd(),
            vz * 0.9 + left.z * side,
            0.9 + 0.5 * rnd(),
            0.8 + 0.4 * rnd(),
            2.8 + 1.8 * pace * rnd(),
          );
        }
      }
      // Side wash: a sheet off each chine, heavier on the side the hull slides toward.
      for (e.wash += dt * 280 * pace; e.wash >= 1; e.wash--) {
        const s = rnd() < 0.5 - Math.max(-0.4, Math.min(0.4, slide * 0.08)) ? -1 : 1;
        const p = hull.localToWorld(this.tmp.set(SIDE_X * s, 0.1, SIDE_Z + (rnd() - 0.5) * 1.8));
        // Water leaves the hull at the waterline, not from under it.
        p.y = Math.max(p.y, water(p.x, p.z) + 0.05);
        const out = 1.2 + 2.2 * rnd() + Math.max(0, slide * s) * 0.6;
        this.drops.spawn(
          p.x,
          p.y,
          p.z,
          vx * 0.88 + left.x * out * s,
          0.6 + 1.8 * rnd() * pace,
          vz * 0.88 + left.z * out * s,
          0.3 + 0.25 * rnd(),
          0.08 + 0.06 * rnd(),
          0.22 + 0.2 * pace * rnd(),
        );
      }
      // Carving: the outside of the slide throws up a wall of spray.
      const s = Math.sign(slide);
      for (e.carve += dt * 130 * Math.min(1, Math.abs(slide) / 4) * pace; e.carve >= 1; e.carve--) {
        const p = hull.localToWorld(this.tmp.set(SIDE_X * s, 0.3, SIDE_Z + (rnd() - 0.5) * 1.6));
        p.y = Math.max(p.y, water(p.x, p.z) + 0.2);
        const out = 2 + 2.5 * rnd();
        this.mist.spawn(
          p.x,
          p.y,
          p.z,
          vx * 0.85 + left.x * out * s,
          1 + 1.5 * rnd(),
          vz * 0.85 + left.z * out * s,
          0.8 + 0.5 * rnd(),
          0.9 + 0.5 * rnd(),
          3.2 + 1.8 * rnd(),
        );
        const out2 = 1.5 + 3 * rnd();
        this.drops.spawn(
          p.x,
          p.y,
          p.z,
          vx * 0.85 + left.x * out2 * s,
          1.5 + 2.5 * rnd(),
          vz * 0.85 + left.z * out2 * s,
          0.4 + 0.3 * rnd(),
          0.1 + 0.08 * rnd(),
          0.3 + 0.2 * rnd(),
        );
      }
      // Bow digging into a swell: water piles up and bursts out ahead.
      const bow = hull.localToWorld(this.tmp.copy(BOW));
      const bowWater = water(bow.x, bow.z);
      const dig = bowWater - bow.y - 0.45;
      bow.y = Math.max(bow.y, bowWater + 0.05);
      if (dig > 0) this.burst(bow, vx, vz, Math.min(1, dig * 2) * pace * 500 * dt, 3.5, 0.04);
    }
    // Landing: a ring of spray, sized by how hard the hull came down.
    if (r.grounded && !e.grounded && e.vy < -2) {
      const at = hull.localToWorld(this.tmp.set(0, 0.2, 0));
      at.y = Math.max(at.y, water(at.x, at.z) + 0.05);
      this.burst(at, vx, vz, Math.min(160, -e.vy * 16), 1.5 + Math.min(5, -e.vy * 0.5), 0.1);
    }
    e.grounded = r.grounded;
    e.vy = r.vy;
  }

  /**
   * A burst of droplets, plus `mistShare` as many mist puffs. `count` may be
   * fractional: the remainder is a chance of one more.
   */
  private burst(at: THREE.Vector3, vx: number, vz: number, count: number, power: number, mistShare: number): void {
    const rnd = Math.random;
    const n = Math.floor(count + rnd());
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const out = power * (0.4 + 0.6 * rnd());
      this.drops.spawn(
        at.x,
        at.y,
        at.z,
        vx * 0.8 + Math.cos(a) * out,
        power * (0.5 + 0.7 * rnd()),
        vz * 0.8 + Math.sin(a) * out,
        0.6 + 0.5 * rnd(),
        0.1 + 0.08 * rnd(),
        0.22 + 0.22 * rnd(),
      );
    }
    const puffs = Math.floor(count * mistShare + rnd());
    for (let i = 0; i < puffs; i++) {
      const a = rnd() * Math.PI * 2;
      const out = power * 0.5 * (0.4 + 0.6 * rnd());
      this.mist.spawn(
        at.x,
        at.y + 0.3,
        at.z,
        vx * 0.8 + Math.cos(a) * out,
        power * 0.4 * (0.5 + 0.5 * rnd()),
        vz * 0.8 + Math.sin(a) * out,
        1 + 0.6 * rnd(),
        1.2 + 0.6 * rnd(),
        3.5 + 1.5 * rnd(),
      );
    }
  }

  /** Splash points every few metres along every shore. */
  setShore(land: LandData[]): void {
    const pts: number[] = [];
    for (const l of land) {
      const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
      const ux = len > 1e-3 ? (l.bx - l.ax) / len : 1;
      const uz = len > 1e-3 ? (l.bz - l.az) / len : 0;
      const r = l.radius + 0.3;
      // The two straight sides, then the round ends.
      for (const side of [-1, 1]) {
        for (let a = 0; a <= len; a += SHORE_STEP) {
          const nx = -uz * side;
          const nz = ux * side;
          pts.push(l.ax + ux * a + nx * r, l.az + uz * a + nz * r, nx, nz);
        }
      }
      const arc = Math.max(1, Math.round((Math.PI * r) / SHORE_STEP));
      for (const [cx, cz, from] of [
        [l.bx, l.bz, Math.atan2(uz, ux) - Math.PI / 2],
        [l.ax, l.az, Math.atan2(uz, ux) + Math.PI / 2],
      ] as const) {
        for (let i = 0; i <= arc; i++) {
          const a = from + (i / arc) * Math.PI;
          pts.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r, Math.cos(a), Math.sin(a));
        }
      }
    }
    this.shore = new Float32Array(pts);
    const n = pts.length / 4;
    this.shoreLast = new Float32Array(n);
    this.shoreWait = new Float32Array(n);
  }

  /** Swell crests hitting a shore near the camera burst up the wall. */
  private splashShores(water: (x: number, z: number) => number, eye: THREE.Vector3, dt: number): void {
    const rnd = Math.random;
    const n = this.shoreLast.length;
    for (let i = 0; i < n; i++) {
      const x = this.shore[i * 4]!;
      const z = this.shore[i * 4 + 1]!;
      const dx = x - eye.x;
      const dz = z - eye.z;
      if (dx * dx + dz * dz > SPLASH_RANGE * SPLASH_RANGE) continue;
      const h = water(x, z);
      const rising = h > this.shoreLast[i]!;
      this.shoreLast[i] = h;
      this.shoreWait[i] = this.shoreWait[i]! - dt;
      if (!rising || h < SPLASH_HEIGHT || this.shoreWait[i]! > 0) continue;
      this.shoreWait[i] = 1.4 + rnd();
      const nx = this.shore[i * 4 + 2]!;
      const nz = this.shore[i * 4 + 3]!;
      const power = Math.min(1.6, 0.6 + (h - SPLASH_HEIGHT));
      for (let k = 0; k < 14; k++) {
        const along = (rnd() - 0.5) * SHORE_STEP;
        const out = 0.5 + 2 * rnd();
        this.drops.spawn(
          x - nz * along,
          h,
          z + nx * along,
          nx * out + (rnd() - 0.5),
          (4 + 4 * rnd()) * power,
          nz * out + (rnd() - 0.5),
          0.8 + 0.6 * rnd(),
          0.12 + 0.1 * rnd(),
          0.4 + 0.3 * rnd(),
        );
      }
      for (let k = 0; k < 2; k++) {
        this.mist.spawn(
          x,
          h + 1,
          z,
          nx * 1.2,
          (2 + 2 * rnd()) * power,
          nz * 1.2,
          1.2 + 0.6 * rnd(),
          1.5,
          4 + 2 * rnd(),
        );
      }
    }
  }

  /** Move everything; `eye` is the camera (shores splash near it). */
  update(water: (x: number, z: number) => number, eye: THREE.Vector3, dt: number): void {
    this.splashShores(water, eye, dt);
    this.drops.update(water, dt);
    this.mist.update(water, dt);
  }
}
