// Rendering: Three.js WebGPURenderer (falls back to WebGL2 automatically)
// with TSL node materials. Riders are drawn as boxes.
import * as THREE from "three/webgpu";
import { CourseView, type CourseData } from "./course.ts";
import { LabWater, type WakeSource } from "./water.ts";
import { MAX_WAVES, WATER_SNAP, WAVE_FIELDS, WaveUniforms, waterGrid } from "./waves.ts";
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
const BASE_FOV = 62;

const SLOT_COLORS = [0xff5a36, 0x2bb3ff, 0xffd23f, 0x7ae582, 0xc77dff, 0xff8fab, 0xf4a261, 0xe9edf2];

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

export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);
  backend: "webgpu" | "webgl2" = "webgl2";
  renderScale = 1;

  private sun: THREE.DirectionalLight;
  private time = uniform(0);
  private swells = new WaveUniforms(MAX_WAVES);
  private waveParams = new Float32Array(MAX_WAVES * WAVE_FIELDS);
  private riders = new Map<number, { mesh: THREE.Group; body: THREE.Group; label: HTMLDivElement }>();
  private course: CourseView | null = null;
  private water: THREE.Mesh | null = null;
  /** World xz of the water grid's centre (it follows the camera). */
  private waterOrigin = uniform(new THREE.Vector2());
  private camPos = new THREE.Vector3(0, 8, -14);
  private camLook = new THREE.Vector3();
  /** Smoothed chase state: heading followed, rider height, airborne blend. */
  private camHeading = 0;
  private camHeight = 0;
  private camAir = 0;
  private labels: HTMLElement;

  /** "lab" = swells + GPU chop + wake foam (see water.ts); "basic" = swells only. */
  private lab: LabWater | null = null;
  private wakeSources = new Map<number, WakeSource>();

  constructor(container: HTMLElement, labels: HTMLElement, water: "basic" | "lab" = "basic") {
    this.labels = labels;
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

    if (water === "lab") {
      this.lab = new LabWater(WATER_SIZE, WATER_SEGMENTS, sky);
      this.scene.add(this.lab.mesh);
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
    this.lab?.setWaves(params, Math.round(Math.abs(params[5] ?? 1) * 1e6));
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
    this.lab?.follow(x, z);
  }

  setCourse(data: CourseData): void {
    if (this.course) this.scene.remove(this.course.group);
    this.course = new CourseView(data);
    this.scene.add(this.course.group);
  }

  private riderMesh(slot: number): { mesh: THREE.Group; body: THREE.Group; label: HTMLDivElement } {
    let r = this.riders.get(slot);
    if (r) return r;
    const mesh = new THREE.Group();
    const colour = SLOT_COLORS[slot % SLOT_COLORS.length];
    const paint = new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.45 });
    const white = new THREE.MeshStandardNodeMaterial({ color: 0xf4f4f0, roughness: 0.6 });
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x23262b, roughness: 0.7 });
    const body = new THREE.Group();
    const part = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent: THREE.Group = mesh,
    ) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    // Hull (the rider position is the bottom of the hull), nose, seat.
    part(new THREE.BoxGeometry(1.1, 0.5, 2.5), paint, 0, 0.25, -0.1);
    const nose = part(new THREE.BoxGeometry(0.9, 0.42, 0.7), white, 0, 0.3, 1.25);
    nose.rotation.x = 0.35;
    part(new THREE.BoxGeometry(0.5, 0.2, 1.0), dark, 0, 0.6, -0.3);
    // Rider: legs, torso, head, standing slightly back. A group of its
    // own, so it can fall off.
    part(new THREE.BoxGeometry(0.42, 0.55, 0.3), dark, 0, 0.95, -0.35, body);
    part(new THREE.BoxGeometry(0.5, 0.6, 0.32), paint, 0, 1.5, -0.25, body);
    part(new THREE.SphereGeometry(0.2, 10, 8), white, 0, 1.95, -0.22, body);
    mesh.add(body);
    mesh.rotation.order = "YXZ";
    this.scene.add(mesh);
    const label = document.createElement("div");
    label.className = "label";
    this.labels.append(label);
    r = { mesh, body, label };
    this.riders.set(slot, r);
    return r;
  }

  /** Draw a frame. `tick` is the fractional sim tick the water should show. */
  render(riders: RiderView[], names: Map<number, string>, tick: number, dt: number, nextBuoy: number | null): void {
    const t = tick * DT;
    this.time.value = t;
    this.course?.update(this.waveParams, t, nextBuoy);

    const seen = new Set<number>();
    let me: RiderView | undefined;
    for (const r of riders) {
      seen.add(r.slot);
      const { mesh, body, label } = this.riderMesh(r.slot);
      mesh.visible = true;
      mesh.position.set(r.x, r.y, r.z);
      mesh.rotation.set(-r.pitch, r.yaw, r.roll);
      // Bailed: the rider lies in the water beside the ski.
      if (r.bailing) {
        body.position.set(1.3, -1.1, -0.4);
        body.rotation.set(0.3, 0, 1.45);
      } else {
        body.position.set(0, 0, 0);
        body.rotation.set(0, 0, 0);
      }
      label.textContent = names.get(r.slot) ?? `#${r.slot + 1}`;
      label.classList.toggle("me", r.isMe);
      const p = mesh.position
        .clone()
        .add(new THREE.Vector3(0, 2.2, 0))
        .project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      label.style.display = visible ? "block" : "none";
      label.style.transform = `translate(-50%, -100%) translate(${((p.x + 1) / 2) * innerWidth}px, ${((1 - p.y) / 2) * innerHeight}px)`;
      if (r.isMe) me = r;
    }
    for (const [slot, r] of this.riders) {
      if (!seen.has(slot)) {
        r.mesh.visible = false;
        r.label.style.display = "none";
      }
    }

    if (me) this.followCamera(me, dt);
    this.followWater();
    if (this.lab) {
      this.wakeSources.clear();
      for (const r of riders) this.wakeSources.set(r.slot, { x: r.x, z: r.z, speed: r.speed, grounded: r.grounded });
      this.lab.update(this.renderer, t, this.wakeSources, dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Chase camera. On the water it follows the hull's heading; in the air it
   * follows the flight path instead (so spins don't spin the camera) and
   * pulls back to show the jump. Height is smoothed so swells roll under
   * the camera instead of shaking it, and the view widens with speed.
   */
  private followCamera(me: RiderView, dt: number): void {
    const air = me.grounded ? 0 : 1;
    this.camAir += (air - this.camAir) * (1 - Math.exp(-dt * (air ? 3 : 1.5)));
    const flying = Math.hypot(me.vx, me.vz) > 3;
    const heading = !me.grounded && flying ? Math.atan2(me.vx, me.vz) : me.yaw;
    let d = heading - this.camHeading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.camHeading += d * (1 - Math.exp(-dt * 4));
    this.camHeight += (me.y - this.camHeight) * (1 - Math.exp(-dt * (me.grounded ? 3 : 6)));

    const fx = Math.sin(this.camHeading);
    const fz = Math.cos(this.camHeading);
    const back = 8.5 + me.speed * 0.13 + this.camAir * 3;
    const up = 3.2 + me.speed * 0.03 + this.camAir * 1.6;
    const target = new THREE.Vector3(me.x - fx * back, this.camHeight + up, me.z - fz * back);
    this.camPos.lerp(target, 1 - Math.exp(-dt * 6));
    const look = new THREE.Vector3(me.x + fx * 5, (this.camHeight + me.y) / 2 + 1, me.z + fz * 5);
    this.camLook.lerp(look, 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    const fov = BASE_FOV + Math.min(1, me.speed / 23) * 10 + this.camAir * 4;
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
    this.sun.position.set(me.x + 30, me.y + 60, me.z + 15);
    this.sun.target.position.set(me.x, me.y, me.z);
  }
}
