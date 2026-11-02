// Rendering: Three.js WebGPURenderer (falls back to WebGL2 automatically)
// with TSL node materials. Riders are drawn as boxes.
import * as THREE from "three/webgpu";
import { LabWater, type WakeSource } from "./water.ts";
import {
  Fn,
  cos,
  float,
  fract,
  max,
  mix,
  normalLocal,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  vec3,
} from "three/tsl";

export const MAX_WAVES = 8;
const WAVE_FIELDS = 6; // dir_x, dir_z, k, amplitude, omega, phase
const ARENA_HALF = 120;
const DT = 1 / 60;

const vec4Uniform = () => uniform(new THREE.Vector4());
const vec2Uniform = () => uniform(new THREE.Vector2());

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
}

/** The same swell formula as `crates/sim/src/surface.rs`, for render-only use. */
export function waveHeight(params: Float32Array, x: number, z: number, t: number): number {
  let h = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    const o = i * WAVE_FIELDS;
    const amp = params[o + 3] ?? 0;
    if (amp === 0) continue;
    h +=
      amp *
      Math.sin(
        (params[o + 2] ?? 0) * ((params[o] ?? 0) * x + (params[o + 1] ?? 0) * z) -
          (params[o + 4] ?? 0) * t +
          (params[o + 5] ?? 0),
      );
  }
  return h;
}

export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);
  backend: "webgpu" | "webgl2" = "webgl2";
  renderScale = 1;

  private sun: THREE.DirectionalLight;
  private time = uniform(0);
  private waveA: ReturnType<typeof vec4Uniform>[] = [];
  private waveB: ReturnType<typeof vec2Uniform>[] = [];
  private waveParams = new Float32Array(MAX_WAVES * WAVE_FIELDS);
  private riders = new Map<number, { mesh: THREE.Group; label: HTMLDivElement }>();
  private buoys: THREE.Mesh[] = [];
  private camPos = new THREE.Vector3(0, 8, -14);
  private camLook = new THREE.Vector3();
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
    this.scene.fog = new THREE.Fog(sky, 60, 320);
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2a6f8f, 1.2));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 160 });
    this.scene.add(this.sun, this.sun.target);

    if (water === "lab") {
      this.lab = new LabWater(ARENA_HALF * 2 + 400, 400, sky);
      this.scene.add(this.lab.mesh);
    } else {
      this.buildWater();
    }
    this.buildBuoys();
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
    for (let i = 0; i < MAX_WAVES; i++) {
      const o = i * WAVE_FIELDS;
      const p = (j: number) => this.waveParams[o + j] ?? 0;
      this.waveA[i]?.value.set(p(0), p(1), p(2), p(3));
      this.waveB[i]?.value.set(p(4), p(5));
    }
  }

  private buildWater(): void {
    for (let i = 0; i < MAX_WAVES; i++) {
      this.waveA.push(vec4Uniform());
      this.waveB.push(vec2Uniform());
    }
    const t = this.time;
    const waveA = this.waveA;
    const waveB = this.waveB;
    // Displace vertices with the sim's swell formula; analytic normals.
    const displaced = Fn(() => {
      const p = positionLocal;
      let h: THREE.Node<"float"> = float(0);
      let dx: THREE.Node<"float"> = float(0);
      let dz: THREE.Node<"float"> = float(0);
      for (let i = 0; i < MAX_WAVES; i++) {
        const a = waveA[i]!;
        const b = waveB[i]!;
        const arg = a.z
          .mul(a.x.mul(p.x).add(a.y.mul(p.z)))
          .sub(b.x.mul(t))
          .add(b.y);
        h = h.add(a.w.mul(sin(arg)));
        const c = a.w.mul(a.z).mul(cos(arg));
        dx = dx.add(c.mul(a.x));
        dz = dz.add(c.mul(a.y));
      }
      normalLocal.assign(vec3(dx.negate(), 1, dz.negate()).normalize());
      return p.add(vec3(0, h, 0));
    });
    const colour = Fn(() => {
      const deep = vec3(0.04, 0.32, 0.45);
      const crest = vec3(0.18, 0.66, 0.72);
      const base = mix(deep, crest, smoothstep(-0.45, 0.55, positionWorld.y));
      // Faint 4 m grid so speed reads even on calm water.
      const gx = step(0.965, fract(positionWorld.x.div(4)));
      const gz = step(0.965, fract(positionWorld.z.div(4)));
      return mix(base, vec3(0.85, 0.95, 1.0), max(gx, gz).mul(0.12));
    });
    const geo = new THREE.PlaneGeometry(ARENA_HALF * 2 + 400, ARENA_HALF * 2 + 400, 320, 320);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0.0 });
    mat.positionNode = displaced();
    mat.colorNode = colour();
    const water = new THREE.Mesh(geo, mat);
    water.receiveShadow = true;
    this.scene.add(water);
  }

  private buildBuoys(): void {
    const geo = new THREE.CylinderGeometry(0.35, 0.45, 1.2, 10);
    const edge = new THREE.MeshStandardNodeMaterial({ color: 0xff7a1a, roughness: 0.6 });
    const inner = new THREE.MeshStandardNodeMaterial({ color: 0xf5f5f0, roughness: 0.6 });
    const add = (x: number, z: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, 0, z);
      m.castShadow = true;
      this.scene.add(m);
      this.buoys.push(m);
    };
    for (let s = -ARENA_HALF; s <= ARENA_HALF; s += 12) {
      add(s, -ARENA_HALF, edge);
      add(s, ARENA_HALF, edge);
      add(-ARENA_HALF, s, edge);
      add(ARENA_HALF, s, edge);
    }
    for (let x = -90; x <= 90; x += 30) for (let z = -90; z <= 90; z += 30) if (x !== 0 || z !== 0) add(x, z, inner);
  }

  private riderMesh(slot: number): { mesh: THREE.Group; label: HTMLDivElement } {
    let r = this.riders.get(slot);
    if (r) return r;
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.8, 2.2),
      new THREE.MeshStandardNodeMaterial({ color: SLOT_COLORS[slot % SLOT_COLORS.length], roughness: 0.5 }),
    );
    body.position.y = 0.4;
    body.castShadow = true;
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.3, 0.4),
      new THREE.MeshStandardNodeMaterial({ color: 0xffffff }),
    );
    nose.position.set(0, 0.85, 0.85);
    nose.castShadow = true;
    mesh.add(body, nose);
    mesh.rotation.order = "YXZ";
    this.scene.add(mesh);
    const label = document.createElement("div");
    label.className = "label";
    this.labels.append(label);
    r = { mesh, label };
    this.riders.set(slot, r);
    return r;
  }

  /** Draw a frame. `tick` is the fractional sim tick the water should show. */
  render(riders: RiderView[], names: Map<number, string>, tick: number, dt: number): void {
    const t = tick * DT;
    this.time.value = t;
    for (const b of this.buoys) {
      b.position.y = waveHeight(this.waveParams, b.position.x, b.position.z, t) + 0.15;
    }

    const seen = new Set<number>();
    let me: RiderView | undefined;
    for (const r of riders) {
      seen.add(r.slot);
      const { mesh, label } = this.riderMesh(r.slot);
      mesh.visible = true;
      mesh.position.set(r.x, r.y, r.z);
      mesh.rotation.set(-r.pitch, r.yaw, r.roll);
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
    if (this.lab) {
      this.wakeSources.clear();
      for (const r of riders) this.wakeSources.set(r.slot, { x: r.x, z: r.z, speed: r.speed, grounded: r.grounded });
      this.lab.update(this.renderer, t, this.wakeSources, dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private followCamera(me: RiderView, dt: number): void {
    const fx = Math.sin(me.yaw);
    const fz = Math.cos(me.yaw);
    const back = 9 + me.speed * 0.12;
    const target = new THREE.Vector3(me.x - fx * back, me.y + 3.6 + me.speed * 0.03, me.z - fz * back);
    const k = 1 - Math.exp(-dt * 5);
    this.camPos.lerp(target, k);
    this.camLook.lerp(new THREE.Vector3(me.x + fx * 4, me.y + 1, me.z + fz * 4), 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.sun.position.set(me.x + 30, me.y + 60, me.z + 15);
    this.sun.target.position.set(me.x, me.y, me.z);
  }
}
