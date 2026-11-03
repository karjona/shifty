// Rendering: Three.js WebGPURenderer (falls back to WebGL2 automatically)
// with TSL node materials.
import * as THREE from "three/webgpu";
import { CourseView, type CourseData } from "./course.ts";
import { RiderModel } from "./rider.ts";
import { buildScenery } from "./scenery.ts";
import { Spray } from "./spray.ts";
import { SeaWater, type WakeSource } from "./water.ts";
import { MAX_WAVES, WATER_SNAP, WAVE_FIELDS, WaveUniforms, waterGrid, waveHeight } from "./waves.ts";
import {
  Fn,
  fract,
  max,
  mix,
  normalLocal,
  positionLocal,
  positionWorld,
  smoothstep,
  step,
  uniform,
  vec3,
} from "three/tsl";

/** The water grid follows the camera and reaches across the whole bay. */
const WATER_SIZE = 1400;
const WATER_SEGMENTS = 300;
const DT = 1 / 60;
const BASE_FOV = 55;
/** Chase camera, in metres from the bottom of the hull. */
const CAM_BACK = 4.3;
const CAM_BACK_PER_SPEED = 0.02;
const CAM_UP = 2.35;
const CAM_LOOK_AHEAD = 8;
const CAM_LOOK_UP = 0.75;
/** How fast the camera swings round to the direction of travel (per second). */
const CAM_TURN = 5;
/** The camera stays at least this high above the swell under it. */
const CAM_CLEARANCE = 0.9;
/** Landing jolt: falls slower than this (m/s) don't move the camera. */
const JOLT_FROM = 3;
/** Downward speed (m/s) a full-impact landing kicks the camera with, and its spring. */
const DIP_KICK = 3.5;
const DIP_STIFFNESS = 70;
const DIP_DAMPING = 10;
/** Air pull-back starts with the hull this high above the water and is full this much higher. */
const CAM_AIR_FROM = 0.4;
const CAM_AIR_SPAN = 2;

export interface RiderView {
  slot: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  grounded: boolean;
  isMe: boolean;
  isBot: boolean;
  bailing: boolean;
  vx: number;
  vy: number;
  vz: number;
}

/** An angle wrapped to (-π, π]. */
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Smooth 0-1 ramp of `x` clamped to [0, 1]. */
const smoothstep01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export interface WorldOptions {
  /** "sea" = swells + GPU chop, ripples, foam and reflections (see water.ts); "basic" = swells only, cheap. */
  water: "basic" | "sea";
  /** The jetski's top speed (m/s), for speed-driven effects. */
  topSpeed: number;
}

export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.3, 4000);
  backend: "webgpu" | "webgl2" = "webgl2";
  renderScale = 1;

  private sun: THREE.DirectionalLight;
  private time = uniform(0);
  private swells = new WaveUniforms(MAX_WAVES);
  private waveParams = new Float32Array(MAX_WAVES * WAVE_FIELDS);
  private riders = new Map<number, { model: RiderModel; label: HTMLDivElement }>();
  private course: CourseView | null = null;
  private water: THREE.Mesh | null = null;
  /** World xz of the water grid's centre (it follows the camera). */
  private waterOrigin = uniform(new THREE.Vector2());
  private camLook = new THREE.Vector3();
  /** Smoothed chase state: heading followed, rider height, distance behind, airborne blend. */
  private camHeading = 0;
  private camHeight = 0;
  private camBack = CAM_BACK;
  private camAir = 0;
  /** Landing jolt: a dip on a spring (m, m/s) and a shake that dies away. */
  private camDip = 0;
  private camDipV = 0;
  private camShake = 0;
  private camWasGrounded = true;
  private camWasBailing = false;
  private camLastVy = 0;
  private labels: HTMLElement;

  /** The full water; `null` in basic mode (see `buildWater`). */
  private sea: SeaWater | null = null;
  private wakeSources = new Map<number, WakeSource>();
  private spray: Spray;
  private topSpeed: number;

  constructor(container: HTMLElement, labels: HTMLElement, opts: WorldOptions) {
    this.labels = labels;
    this.topSpeed = opts.topSpeed;
    this.spray = new Spray(opts.topSpeed);
    this.scene.add(this.spray.group);
    this.renderer = new THREE.WebGPURenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.append(this.renderer.domElement);

    const sky = new THREE.Color(0xa8d8f0);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 90, 480);
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2a6f8f, 1.2));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 160 });
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(buildScenery(sky));

    if (opts.water === "sea") {
      this.sea = new SeaWater(WATER_SIZE, WATER_SEGMENTS);
      this.scene.add(this.sea.mesh);
    } else {
      this.buildWater();
    }
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  async init(): Promise<void> {
    await this.renderer.init();
    // `isWebGPUBackend` is not in the type declarations yet.
    const backend: object = this.renderer.backend;
    this.backend = "isWebGPUBackend" in backend && backend.isWebGPUBackend === true ? "webgpu" : "webgl2";
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setPixelRatio(devicePixelRatio * this.renderScale);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.renderer.domElement.style.imageRendering = scale < 1 ? "pixelated" : "auto";
    this.resize();
  }

  setWaves(params: Float32Array): void {
    // Chop seed only needs to be stable per room: derive it from the swells.
    this.sea?.setWaves(params, Math.round(Math.abs(params[5] ?? 1) * 1e6));
    this.waveParams.set(params.subarray(0, MAX_WAVES * WAVE_FIELDS));
    this.swells.setFromSim(this.waveParams);
  }

  private buildWater(): void {
    const t = this.time;
    const swells = this.swells;
    const origin = this.waterOrigin;
    // Displace vertices with the sim's swell formula; analytic normals.
    const displaced = Fn(() => {
      const p = positionLocal;
      const w = swells.sum(p.add(vec3(origin.x, 0, origin.y)), t);
      normalLocal.assign(vec3(w.dx.negate(), 1, w.dz.negate()).normalize());
      return p.add(vec3(0, w.h, 0));
    });
    const colour = Fn(() => {
      const deep = vec3(0.04, 0.32, 0.45);
      const crest = vec3(0.18, 0.66, 0.72);
      const base = mix(deep, crest, smoothstep(-0.8, 1.2, positionWorld.y));
      // Faint 4 m grid so speed reads even on calm water.
      const gx = step(0.965, fract(positionWorld.x.div(4)));
      const gz = step(0.965, fract(positionWorld.z.div(4)));
      return mix(base, vec3(0.85, 0.95, 1.0), max(gx, gz).mul(0.12));
    });
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0.0 });
    mat.positionNode = displaced();
    mat.colorNode = colour();
    const water = new THREE.Mesh(waterGrid(WATER_SIZE, WATER_SEGMENTS), mat);
    water.receiveShadow = true;
    water.frustumCulled = false;
    this.scene.add(water);
    this.water = water;
  }

  /** Centre the water grid near what the camera looks at, in fixed steps. */
  private followWater(): void {
    const x = Math.round(this.camLook.x / WATER_SNAP) * WATER_SNAP;
    const z = Math.round(this.camLook.z / WATER_SNAP) * WATER_SNAP;
    this.waterOrigin.value.set(x, z);
    this.water?.position.set(x, 0, z);
    this.sea?.follow(x, z);
  }

  setCourse(data: CourseData): void {
    if (this.course) this.scene.remove(this.course.group);
    this.course = new CourseView(data);
    this.scene.add(this.course.group);
    this.sea?.setLand(data.land);
    this.spray.setShore(data.land);
  }

  private rider(slot: number): { model: RiderModel; label: HTMLDivElement } {
    let r = this.riders.get(slot);
    if (r) return r;
    const model = new RiderModel(slot);
    this.scene.add(model.mesh);
    const label = document.createElement("div");
    label.className = "label";
    this.labels.append(label);
    r = { model, label };
    this.riders.set(slot, r);
    return r;
  }

  /** Draw a frame. `tick` is the fractional sim tick the water should show. */
  render(riders: RiderView[], names: Map<number, string>, tick: number, dt: number, nextBuoy: number | null): void {
    const t = tick * DT;
    this.time.value = t;
    this.course?.update(this.waveParams, t, nextBuoy);

    const water = (x: number, z: number) => waveHeight(this.waveParams, x, z, t);
    const seen = new Set<number>();
    let me: RiderView | undefined;
    for (const r of riders) {
      seen.add(r.slot);
      const { model, label } = this.rider(r.slot);
      const mesh = model.mesh;
      mesh.visible = true;
      model.update(r, dt);
      mesh.updateMatrixWorld();
      this.spray.emit(r, mesh, water, dt);
      // Name tags for the other riders only.
      label.textContent = names.get(r.slot) ?? `#${r.slot + 1}`;
      const p = mesh.position
        .clone()
        .add(new THREE.Vector3(0, 2.2, 0))
        .project(this.camera);
      const visible = !r.isMe && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      label.style.display = visible ? "block" : "none";
      label.style.transform = `translate(-50%, -100%) translate(${((p.x + 1) / 2) * innerWidth}px, ${((1 - p.y) / 2) * innerHeight}px)`;
      if (r.isMe) me = r;
    }
    for (const [slot, r] of this.riders) {
      if (!seen.has(slot)) {
        r.model.mesh.visible = false;
        r.label.style.display = "none";
      }
    }

    if (me) this.followCamera(me, t, dt);
    this.spray.update(water, this.camera.position, dt);
    this.followWater();
    if (this.sea) {
      this.wakeSources.clear();
      for (const r of riders) this.wakeSources.set(r.slot, { x: r.x, z: r.z, speed: r.speed, grounded: r.grounded });
      this.sea.update(this.renderer, t, this.wakeSources, dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Chase camera, low and close behind the rider. It is placed relative to
   * the rider every frame; only its heading, height and distance are
   * smoothed. It follows the direction of travel, on the water and in the
   * air alike: spins don't spin it, and leaving the water mid-turn eases
   * the swing out smoothly (the hull points further into a turn than it
   * travels, so following the hull would jump at takeoff). Slow or
   * reversing, it follows the hull's heading. It pulls back as the rider
   * gets high above the water (skips off a crest don't move it). Height follows the rider closely, so the
   * rider stays framed and the horizon rides the swells; it never dips into
   * a swell, and the view widens with speed. Hard landings jolt it: a dip
   * and a short shake, harder for a bail.
   */
  private followCamera(me: RiderView, t: number, dt: number): void {
    this.jolt(me, dt);
    const above = me.y - waveHeight(this.waveParams, me.x, me.z, t);
    const air = me.grounded ? 0 : Math.min(1, Math.max(0, (above - CAM_AIR_FROM) / CAM_AIR_SPAN));
    this.camAir += (air - this.camAir) * (1 - Math.exp(-dt * (air > this.camAir ? 3 : 1.5)));
    const ahead = me.vx * Math.sin(me.yaw) + me.vz * Math.cos(me.yaw);
    // Reversing on the water: look along the hull, not back down the wake.
    const travel = Math.atan2(me.vx, me.vz) + (me.grounded && ahead < 0 ? Math.PI : 0);
    const w = smoothstep01((Math.hypot(me.vx, me.vz) - 2) / 4);
    const heading = me.yaw + w * wrapPi(travel - me.yaw);
    this.camHeading += wrapPi(heading - this.camHeading) * (1 - Math.exp(-dt * CAM_TURN));
    this.camHeight += (me.y - this.camHeight) * (1 - Math.exp(-dt * (me.grounded ? 7 : 6)));
    const back = CAM_BACK + me.speed * CAM_BACK_PER_SPEED + this.camAir * 2.5;
    this.camBack += (back - this.camBack) * (1 - Math.exp(-dt * 2.5));

    const fx = Math.sin(this.camHeading);
    const fz = Math.cos(this.camHeading);
    const x = me.x - fx * this.camBack;
    const z = me.z - fz * this.camBack;
    const up = CAM_UP + this.camAir * 1.2;
    const floor = waveHeight(this.waveParams, x, z, t) + CAM_CLEARANCE;
    const y = Math.max(this.camHeight + up + this.camDip, floor);
    // Shake: a few unrelated sines, fast enough to read as a jolt.
    const sx = this.camShake * Math.sin(t * 61) * Math.sin(t * 23);
    const sy = this.camShake * Math.sin(t * 53 + 1.3) * Math.sin(t * 29);
    this.camera.position.set(x + fz * sx, y + sy, z - fx * sx);
    this.camLook.set(me.x + fx * CAM_LOOK_AHEAD, (this.camHeight + me.y) / 2 + CAM_LOOK_UP, me.z + fz * CAM_LOOK_AHEAD);
    this.camera.lookAt(this.camLook);
    const fov = BASE_FOV + Math.min(1, me.speed / this.topSpeed) * 6 + this.camAir * 4;
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
    this.sun.position.set(me.x + 30, me.y + 60, me.z + 15);
    this.sun.target.position.set(me.x, me.y, me.z);
  }

  /** Kick the landing dip and shake on touchdown, and let them settle. */
  private jolt(me: RiderView, dt: number): void {
    const landed = me.grounded && !this.camWasGrounded;
    const bailed = me.bailing && !this.camWasBailing;
    if (landed || bailed) {
      const impact = Math.min(1, Math.max(0, (-this.camLastVy - JOLT_FROM) / 10));
      this.camDipV -= DIP_KICK * impact;
      this.camShake = Math.max(this.camShake, 0.12 * impact + (bailed ? 0.18 : 0));
    }
    this.camWasGrounded = me.grounded;
    this.camWasBailing = me.bailing;
    this.camLastVy = me.vy;
    this.camDipV += (-DIP_STIFFNESS * this.camDip - DIP_DAMPING * this.camDipV) * dt;
    this.camDip += this.camDipV * dt;
    this.camShake *= Math.exp(-dt * 7);
  }
}
