// Rendering: Three.js WebGPURenderer (falls back to WebGL2 automatically)
// with TSL node materials. The world is the renderer, the chase camera and
// the riders; what surrounds them (the bay in summer, the mountain in
// winter) is an environment, set once the course is known.
import * as THREE from "three/webgpu";
import type { Appearance } from "@shifty/rider";
import { devParams } from "../dev-params.ts";
import { SUN_DIR, SUN_STRENGTH, UNREFLECTED } from "./cel/material.ts";
import { CelPost } from "./cel/post.ts";
import { PIXEL_AT_1M } from "./cel/rider.ts";

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
  /** Snowboard: how loaded the jump is (0-1). */
  charge: number;
  /** Snowboard: the grab being held (0 = none). */
  grab: number;
  /** The stick: lean (+ = forward/tuck, - = back) and steer. */
  lean: number;
  steer: number;
  /** Snowboard: what is left of a sketchy landing's wobble (1 = just landed, 0 = steady). */
  wobble: number;
}

/** A rider as drawn: a jetski, or a snowboarder. */
export interface RiderModel {
  readonly mesh: THREE.Group;
  /** Resolves once the rider's art is in and on. */
  readonly ready: Promise<void>;
  update(r: RiderView, dt: number): void;
  /** Frees what the model made for itself, once it is no longer drawn. */
  dispose?(): void;
}

/** How the chase camera sits behind a rider, per sport. Distances in metres. */
export interface CameraTuning {
  fov: number;
  /** Extra field of view at top speed, and high in the air (degrees). */
  fovSpeed: number;
  fovAir: number;
  back: number;
  backPerSpeed: number;
  up: number;
  /** Look this far ahead of the rider, this high above `lookFrom`. */
  lookAhead: number;
  lookUp: number;
  /**
   * What the look height is measured from: "rider" (halfway between the
   * rider and the camera's smoothed height) or "ground" (the ground that
   * far ahead, so the view tips down a slope).
   */
  lookFrom: "rider" | "ground";
  /** How fast the camera swings round to the direction of travel (per second). */
  turn: number;
  /** Going backwards, look along the rider's heading (a reversing jetski), not back the way it goes. */
  reverseLooksAhead: boolean;
  /** How fast its height follows the rider on the ground, rising in the air, and falling (per second). */
  heightOnGround: number;
  heightRising: number;
  heightInAir: number;
  /** The camera stays at least this high above the ground under it. */
  clearance: number;
  /** If set, that floor follows the ground smoothly (per second), so bumps don't bob the camera. */
  floorFollow?: number;
  /** Air pull-back starts with the rider this high above the ground, full this much higher. */
  airFrom: number;
  airSpan: number;
  airBack: number;
  airUp: number;
  /** How much the horizon tilts with the ground's cross slope (0 = level). */
  tilt: number;
}

/** What surrounds the riders: sky, light, ground or water, scenery and effects. */
export interface Environment {
  readonly group: THREE.Group;
  readonly camera: CameraTuning;
  /** Top speed (m/s), for speed-driven effects. */
  readonly topSpeed: number;
  /** Something in it reflects the world (the sea). */
  readonly reflects?: boolean;
  /** Colours the sky, the fog and the lights. */
  light(scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void;
  /** Height of the ground (or water) under `(x, z)` at time `t` (s). */
  ground(x: number, z: number, t: number): number;
  /** A rider's model; `appearance` is what they look like and wear (null: made up for the seat). */
  makeRider(slot: number, appearance: Appearance | null): RiderModel;
  /** Per frame, once the riders are placed. */
  update(frame: Frame): void;
}

export interface Frame {
  riders: RiderView[];
  models: Map<number, RiderModel>;
  /** The camera, and the point it looks at. */
  eye: THREE.Vector3;
  look: THREE.Vector3;
  /** Sim time (s) and frame time. */
  t: number;
  dt: number;
  renderer: THREE.WebGPURenderer;
  /** Summer: the buoy to pass next (index), if any. */
  nextBuoy: number | null;
}

const DT = 1 / 60;
/** Landing jolt: falls slower than this (m/s) don't move the camera. */
const JOLT_FROM = 3;
/** Downward speed (m/s) a full-impact landing kicks the camera with, and its spring. */
const DIP_KICK = 3.5;
const DIP_STIFFNESS = 70;
const DIP_DAMPING = 10;
const DEFAULT_SKY = 0xa8d8f0;
/** A rider and their shadow fit in a sphere this big around them (m). */
const RIDER_REACH = 4.5;
/** Riders further from the camera than this (m) are drawn without their outline. */
const OUTLINE_FAR = 45;
/** Riders further from the camera than this (m) are left out of reflections. */
const REFLECT_FAR = 30;
/** Riders further than this (m) from the camera's rider are outside the sun's shadow box. */
const SHADOW_REACH = 45;

/** Shows or hides an element, touching the page only when that changes. */
function setDisplay(el: HTMLElement, on: boolean): void {
  const display = on ? "block" : "none";
  if (el.style.display !== display) el.style.display = display;
}

/** An angle wrapped to (-π, π]. */
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Smooth 0-1 ramp of `x` clamped to [0, 1]. */
const smoothstep01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 4000);
  backend: "webgpu" | "webgl2" = "webgl2";
  renderScale = 1;

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private env: Environment | null = null;
  private riders = new Map<number, { model: RiderModel; label: HTMLDivElement }>();
  private models = new Map<number, RiderModel>();
  private camLook = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private viewProjection = new THREE.Matrix4();
  /** Around a rider: the figure, and the shadow it throws. */
  private bounds = new THREE.Sphere(new THREE.Vector3(), RIDER_REACH);
  private tag = new THREE.Vector3();
  private seen = new Set<number>();
  /** Smoothed chase state: heading followed, rider height, distance behind, airborne blend, horizon tilt. */
  private camHeading = 0;
  private camHeight = 0;
  private camBack = 0;
  private camAir = 0;
  private camTilt = 0;
  private camLookY = 0;
  private camFloor = 0;
  /** Landing jolt: a dip on a spring (m, m/s) and a shake that dies away. */
  private camDip = 0;
  private camDipV = 0;
  private camShake = 0;
  private camWasGrounded = true;
  private camWasBailing = false;
  private camLastVy = 0;
  private camReady = false;
  private labels: HTMLElement;
  /** The frame: the scene, inked. */
  readonly cel: CelPost;
  /** What each seat's rider looks like, as told by the race server. */
  private appearances = new Map<number, Appearance | null>();

  constructor(container: HTMLElement, labels: HTMLElement) {
    this.labels = labels;
    // Dev: `?webgl` forces the WebGL2 fallback (browsers without WebGPU).
    const webgl = import.meta.env.DEV && devParams.has("webgl");
    // No multisampling: the frame is drawn into the ink pass's targets, and FXAA smooths it.
    this.renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: webgl });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.append(this.renderer.domElement);
    this.camera.layers.enable(UNREFLECTED);

    this.scene.background = new THREE.Color(DEFAULT_SKY);
    this.hemi = new THREE.HemisphereLight(0xfff4e0, 0x2a6f8f, 1.2);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 160 });
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.cel = new CelPost(this.renderer, this.scene, this.camera);
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

  /** Draws `scale` of the screen's pixels (0-1), upscaled sharp (`pixelated`) or smooth. */
  setRenderScale(scale: number, pixelated = scale < 1): void {
    this.renderScale = scale;
    this.renderer.domElement.style.imageRendering = pixelated ? "pixelated" : "auto";
    this.resize();
  }

  /** Draws the scene, inked. */
  draw(): void {
    SUN_STRENGTH.value = (this.sun.color.r + this.sun.color.g + this.sun.color.b) * this.sun.intensity;
    SUN_DIR.value.copy(this.sun.position).sub(this.sun.target.position).normalize();
    // Line widths are in pixels of a 1080p frame, whatever the resolution.
    PIXEL_AT_1M.value = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / 1080;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.cel.width.value = 1.6 * (size.y / 1080);
    this.cel.render();
  }

  /** Compiles what the scene (or `root`, about to join it) needs to be drawn (see `CelPost.compile`). */
  compile(root: THREE.Object3D = this.scene): Promise<void> {
    return this.cel.compile(root, this.env?.reflects ?? false);
  }

  /** The sun, for stages that light their own shots. */
  get sunLight(): THREE.DirectionalLight {
    return this.sun;
  }

  /** Sets what a seat's rider looks like; their model is rebuilt if it changed. */
  setAppearance(slot: number, appearance: Appearance | null): void {
    if (JSON.stringify(this.appearances.get(slot) ?? null) === JSON.stringify(appearance)) return;
    this.appearances.set(slot, appearance);
    const r = this.riders.get(slot);
    if (r) {
      this.scene.remove(r.model.mesh);
      r.model.dispose?.();
      r.label.remove();
      this.riders.delete(slot);
      this.models.delete(slot);
    }
  }

  /** Sets what surrounds the riders (once, when the course is known). */
  setEnvironment(env: Environment): void {
    if (this.env) this.scene.remove(this.env.group);
    this.env = env;
    this.scene.add(env.group);
    env.light(this.scene, this.sun, this.hemi);
    this.camera.fov = env.camera.fov;
    this.camera.updateProjectionMatrix();
    for (const r of this.riders.values()) {
      this.scene.remove(r.model.mesh);
      r.model.dispose?.();
      r.label.remove();
    }
    this.riders.clear();
    this.models.clear();
    this.camReady = false;
  }

  /** Takes the surroundings away (the caller disposes them). */
  clearEnvironment(): void {
    if (this.env) this.scene.remove(this.env.group);
    this.env = null;
    for (const r of this.riders.values()) {
      this.scene.remove(r.model.mesh);
      r.model.dispose?.();
      r.label.remove();
    }
    this.riders.clear();
    this.models.clear();
    this.camReady = false;
  }

  get environment(): Environment | null {
    return this.env;
  }

  /**
   * Draws the surroundings from a set viewpoint, without the chase camera
   * (menus, the season change). `riders` are drawn by their own models,
   * placed by the caller.
   */
  renderFrom(eye: THREE.Vector3, look: THREE.Vector3, t: number, dt: number, fov = 50): void {
    this.camera.position.copy(eye);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
    this.camLook.copy(look);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.sun.target.position.copy(look);
    this.sun.position.copy(look).add(this.sunOffset);
    this.env?.update({
      riders: [],
      models: this.models,
      eye: this.camera.position,
      look,
      t,
      dt,
      renderer: this.renderer,
      nextBuoy: null,
    });
    this.draw();
    this.camReady = false;
  }

  /** Puts these seats' riders in the scene ahead of drawing them (so they warm up with the course). */
  addRiders(slots: number[]): RiderModel[] {
    const env = this.env;
    return env ? slots.map((slot) => this.rider(env, slot).model) : [];
  }

  private rider(env: Environment, slot: number): { model: RiderModel; label: HTMLDivElement } {
    let r = this.riders.get(slot);
    if (r) return r;
    const model = env.makeRider(slot, this.appearances.get(slot) ?? null);
    this.scene.add(model.mesh);
    const label = document.createElement("div");
    label.className = "label";
    label.style.display = "none";
    this.labels.append(label);
    r = { model, label };
    this.riders.set(slot, r);
    this.models.set(slot, model);
    return r;
  }

  /** Draw a frame. `tick` is the fractional sim tick to show (water, snowfall). */
  render(riders: RiderView[], names: Map<number, string>, tick: number, dt: number, nextBuoy: number | null): void {
    const env = this.env;
    if (!env) {
      this.draw();
      return;
    }
    const t = tick * DT;
    const me = riders.find((r) => r.isMe);
    if (me) this.followCamera(env, me, t, dt);
    this.camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(
      this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    this.seen.clear();
    for (const r of riders) {
      this.seen.add(r.slot);
      const { model, label } = this.rider(env, r.slot);
      model.update(r, dt);
      const shown = r.isMe || this.inView(model.mesh.position);
      model.mesh.visible = shown;
      if (shown) {
        this.detail(model.mesh, r, me);
        model.mesh.updateMatrixWorld();
      }
      // Name tags for the other riders only.
      const name = names.get(r.slot) ?? `#${r.slot + 1}`;
      if (label.textContent !== name) label.textContent = name;
      const p = this.tag.copy(model.mesh.position);
      p.y += 2.2;
      p.project(this.camera);
      const visible = shown && !r.isMe && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      setDisplay(label, visible);
      if (visible) {
        label.style.transform = `translate(-50%, -100%) translate(${((p.x + 1) / 2) * innerWidth}px, ${((1 - p.y) / 2) * innerHeight}px)`;
      }
    }
    for (const [slot, r] of this.riders) {
      if (!this.seen.has(slot)) {
        r.model.mesh.visible = false;
        setDisplay(r.label, false);
      }
    }

    env.update({
      riders,
      models: this.models,
      eye: this.camera.position,
      look: this.camLook,
      t,
      dt,
      renderer: this.renderer,
      nextBuoy,
    });
    this.draw();
  }

  /** Whether a rider at `p` (or the shadow it casts) can be in the picture. */
  private inView(p: THREE.Vector3): boolean {
    this.bounds.center.copy(p);
    this.bounds.center.y += 1;
    return this.frustum.intersectsSphere(this.bounds);
  }

  /**
   * How much of a rider is drawn: the outline only close enough to show
   * (the ink pass draws the silhouette further away), a reflection only
   * close by, and a shadow only inside the sun's shadow box around the
   * camera's rider.
   */
  private detail(mesh: THREE.Object3D, r: RiderView, me: RiderView | undefined): void {
    const distance = this.camera.position.distanceTo(mesh.position);
    const far = distance > OUTLINE_FAR;
    const reflected = distance < REFLECT_FAR;
    const focus = me ?? r;
    const shadow = Math.hypot(r.x - focus.x, r.z - focus.z) < SHADOW_REACH;
    mesh.traverse((o) => {
      const data = o.userData as { outline?: boolean; castsShadow?: boolean };
      if (data.outline) o.visible = !far;
      else if (o instanceof THREE.Mesh) {
        data.castsShadow ??= o.castShadow;
        o.castShadow = data.castsShadow && shadow;
        o.layers.set(UNREFLECTED);
        if (reflected) o.layers.enable(0);
      }
    });
  }

  /**
   * Chase camera, low and close behind the rider. It is placed relative to
   * the rider every frame; only its heading, height, distance and tilt are
   * smoothed. It follows the direction of travel, on the ground and in the
   * air alike: spins don't spin it, and leaving the ground mid-turn eases
   * the swing out smoothly. Slow or reversing, it follows the rider's
   * heading. It pulls back as the rider gets high above the ground (small
   * hops don't move it). Its height follows the rider, so the rider stays
   * framed; it never dips into the ground, and the view widens with speed.
   * Hard landings jolt it: a dip and a short shake, harder for a bail.
   */
  private followCamera(env: Environment, me: RiderView, t: number, dt: number): void {
    const c = env.camera;
    if (!this.camReady) {
      this.camHeading = Math.atan2(me.vx, me.vz);
      if (Math.hypot(me.vx, me.vz) < 2) this.camHeading = me.yaw;
      this.camHeight = me.y;
      this.camBack = c.back;
      this.camLookY = me.y;
      this.camFloor = env.ground(me.x, me.z, t) + c.clearance;
      this.camReady = true;
    }
    this.jolt(me, dt);
    const above = me.y - env.ground(me.x, me.z, t);
    const air = me.grounded ? 0 : Math.min(1, Math.max(0, (above - c.airFrom) / c.airSpan));
    this.camAir += (air - this.camAir) * (1 - Math.exp(-dt * (air > this.camAir ? 3 : 1.5)));
    const ahead = me.vx * Math.sin(me.yaw) + me.vz * Math.cos(me.yaw);
    // Reversing on the water: look along the hull, not back down the wake.
    const travel = Math.atan2(me.vx, me.vz) + (me.grounded && ahead < 0 && c.reverseLooksAhead ? Math.PI : 0);
    const w = smoothstep01((Math.hypot(me.vx, me.vz) - 2) / 4);
    const heading = me.yaw + w * wrapPi(travel - me.yaw);
    this.camHeading += wrapPi(heading - this.camHeading) * (1 - Math.exp(-dt * c.turn));
    const follow = me.grounded ? c.heightOnGround : me.y > this.camHeight ? c.heightRising : c.heightInAir;
    this.camHeight += (me.y - this.camHeight) * (1 - Math.exp(-dt * follow));
    const back = c.back + me.speed * c.backPerSpeed + this.camAir * c.airBack;
    this.camBack += (back - this.camBack) * (1 - Math.exp(-dt * 2.5));

    const fx = Math.sin(this.camHeading);
    const fz = Math.cos(this.camHeading);
    const x = me.x - fx * this.camBack;
    const z = me.z - fz * this.camBack;
    const up = c.up + this.camAir * c.airUp;
    let floor = env.ground(x, z, t) + c.clearance;
    if (c.floorFollow !== undefined) {
      this.camFloor += (floor - this.camFloor) * (1 - Math.exp(-dt * c.floorFollow));
      floor = this.camFloor;
    }
    const y = Math.max(this.camHeight + up, floor) + this.camDip;
    // Shake: a few unrelated sines, fast enough to read as a jolt.
    const sx = this.camShake * Math.sin(t * 61) * Math.sin(t * 23);
    const sy = this.camShake * Math.sin(t * 53 + 1.3) * Math.sin(t * 29);
    this.camera.position.set(x + fz * sx, y + sy, z - fx * sx);
    const lx = me.x + fx * c.lookAhead;
    const lz = me.z + fz * c.lookAhead;
    let ly: number;
    if (c.lookFrom === "ground") {
      // Down a slope the view tips down with it (smoothed, so bumps don't
      // nod it); high in the air it keeps the rider in view instead.
      const g = Math.min(env.ground(lx, lz, t), me.y);
      this.camLookY += (g - this.camLookY) * (1 - Math.exp(-dt * 8));
      const onGround = Math.max(this.camLookY, this.camHeight - c.lookAhead) + c.lookUp;
      const lift = me.grounded ? 0 : smoothstep01((above - 0.3) / 1.5);
      ly = onGround + (me.y - 0.4 - onGround) * Math.max(lift, this.camAir);
    } else {
      ly = (this.camHeight + me.y) / 2 + c.lookUp;
    }
    this.camLook.set(lx, ly, lz);
    this.camera.up.set(0, 1, 0);
    if (c.tilt > 0) {
      // The horizon leans with the ground across the direction of view.
      const s = 1.5;
      const cross =
        (env.ground(me.x - fz * s, me.z + fx * s, t) - env.ground(me.x + fz * s, me.z - fx * s, t)) / (2 * s);
      const target = me.grounded ? Math.atan(cross) * c.tilt : 0;
      this.camTilt += (target - this.camTilt) * (1 - Math.exp(-dt * 3));
      this.camera.up.set(
        Math.cos(this.camHeading) * Math.sin(this.camTilt),
        Math.cos(this.camTilt),
        -fx * Math.sin(this.camTilt),
      );
    }
    this.camera.lookAt(this.camLook);
    const fov = c.fov + Math.min(1, me.speed / env.topSpeed) * c.fovSpeed + this.camAir * c.fovAir;
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
    this.sun.target.position.set(me.x, me.y, me.z);
    this.sun.position.copy(this.sun.target.position).add(this.sunOffset);
  }

  private sunOffset = new THREE.Vector3(30, 60, 15);

  /** Where the sun shines from, relative to the rider it follows (and casts shadows around). */
  setSunOffset(x: number, y: number, z: number): void {
    this.sunOffset.set(x, y, z);
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
