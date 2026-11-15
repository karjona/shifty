// The Tilt's podium, on the town's promenade: three blocks on a base in the
// seasons' colours, an arch behind them with a banner hanging either side
// of each pylon, a carpet, flowers, lamp posts, and a pen of spectators each
// side who clap, cheer and take pictures. Its art is modelled in
// art/env/podium.py (public/env/podium.glb) and drawn in a handful of
// batches; confetti and paper streamers fall on the GPU (no work on the CPU
// per frame), the crowd swaps between two poses on twos, and the
// photographers' flashes pop for a beat.
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cos, float, mod, positionLocal, sin, uniform, vec3 } from "three/tsl";
import { CelMaterial, UNREFLECTED, inkNode, inkOnlyInPass, inklessBasic } from "./cel/material.ts";
import { EnvLook } from "./env/materials.ts";
import { type EnvModel, loadEnv } from "./env/model.ts";
import { signs } from "./env/signs.ts";
import { warmUp } from "./warm.ts";

/** The podium's blocks, in the order of the places they stand for (1st, 2nd, 3rd): across (m, + = the riders' left),
 * and height (m). The riders face +z. (The art's blocks are these: art/env/podium.py.) */
export const STEPS = [
  { x: 0, height: 1.1 },
  { x: -1.56, height: 0.8 },
  { x: 1.56, height: 0.56 },
] as const;

/** Beats a second: the crowd's poses and the flashes are held on twos, like the riders. */
const BEATS = 12;
/** How many beats each group of the crowd holds a pose: clapping, cheering and waving; taking pictures. */
const HOLDS = [3, 26];
/** The chance a photographer's flash pops on a beat. */
const FLASH_CHANCE = 0.06;

/** A number in [0, 1) from two whole numbers. */
function chance(a: number, b: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A four-pointed star, a metre across, facing +z. */
function star(): THREE.BufferGeometry {
  const pts: number[] = [];
  const spikes = 4;
  for (let i = 0; i < spikes * 2; i++) {
    const a0 = (i / (spikes * 2)) * Math.PI * 2;
    const a1 = ((i + 1) / (spikes * 2)) * Math.PI * 2;
    const r0 = i % 2 === 0 ? 0.5 : 0.13;
    const r1 = i % 2 === 0 ? 0.13 : 0.5;
    pts.push(0, 0, 0, Math.cos(a0) * r0, Math.sin(a0) * r0, 0, Math.cos(a1) * r1, Math.sin(a1) * r1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** The podium and everything round it, standing on y = 0, the riders facing +z. */
export class PodiumScene {
  readonly group = new THREE.Group();
  /** Resolves once the art is in (and its shaders compiled). */
  readonly ready: Promise<void>;
  private look = new EnvLook();
  private confetti: Confetti;
  private streamers: Streamers;
  /** The crowd's groups: the arms of each of their two poses. */
  private crowd: { a: THREE.Object3D; b: THREE.Object3D; hold: number }[] = [];
  private flashes: THREE.Mesh[] = [];
  private own: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private gone = false;

  /** `colours` are the seasons' (the confetti's and the streamers'); `accent` the season the Tilt ended in. */
  constructor(colours: readonly number[], accent: number) {
    this.confetti = new Confetti([...colours, 0xf6f1e7, 0xf2c14e]);
    this.streamers = new Streamers([...colours, 0xf2c14e]);
    this.group.add(this.confetti.mesh, this.streamers.mesh);
    this.ready = loadEnv("podium")
      .then(async (model) => {
        const art = await this.assemble(model, accent);
        await warmUp(art);
        if (this.gone) return;
        this.group.add(art);
      })
      .catch((e: unknown) => console.error(e));
  }

  private async assemble(model: EnvModel, accent: number): Promise<THREE.Group> {
    const g = new THREE.Group();
    const look = this.look;
    look.setBreeze(model.anchors.get("wind")?.[0]?.data.dir);
    for (const mesh of look.meshes(model.parts)) {
      // Only the stonework's shadows show: the banners' and the palm's fall behind, off the quay.
      mesh.castShadow = mesh.name === "env.solid";
      g.add(mesh);
    }
    for (const a of model.anims) {
      const match = /^crowd(\d)\.([ab])$/u.exec(a.name);
      if (!match) continue;
      const group = new THREE.Group();
      group.applyMatrix4(a.matrix);
      for (const mesh of look.meshes(a.parts)) {
        mesh.castShadow = false;
        group.add(mesh);
      }
      g.add(group);
      const k = Number(match[1]);
      const entry = (this.crowd[k] ??= { a: group, b: group, hold: HOLDS[k] ?? 4 });
      if (match[2] === "a") entry.a = group;
      else entry.b = group;
      // Both poses are compiled shown (see `World.compile`).
      group.userData.weather = true;
    }
    const lettering = await signs(model.anchors.get("sign"), { accent });
    if (lettering) {
      g.add(lettering);
      if (lettering.material instanceof CelMaterial) {
        this.own.push(lettering.material, lettering.geometry);
        if (lettering.material.map) this.own.push(lettering.material.map);
      }
    }
    const flashes = model.anchors.get("flash") ?? [];
    if (flashes.length > 0) {
      const geometry = star();
      const material = inklessBasic({ color: 0xfffbe6, side: THREE.DoubleSide });
      this.own.push(geometry, material);
      for (const f of flashes) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.setFromMatrixPosition(f.matrix);
        mesh.visible = false;
        mesh.userData.weather = true;
        g.add(mesh);
        this.flashes.push(mesh);
      }
    }
    // Nothing here shows in the sea's mirror image: it is left out of it. (The art's geometry is shared and stays;
    // the materials are this scene's.)
    const materials = new Set<THREE.Material>();
    g.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.layers.set(UNREFLECTED);
      if (o.material instanceof THREE.Material) materials.add(o.material);
    });
    for (const m of materials) if (!this.own.includes(m)) this.own.push(m);
    return g;
  }

  /** The scene at time `t` (s). */
  update(t: number): void {
    this.confetti.update(t);
    this.streamers.update(t);
    const beat = Math.floor(t * BEATS);
    this.crowd.forEach((c, k) => {
      const first = Math.floor((beat + k * 3) / c.hold) % 2 === 0;
      c.a.visible = first;
      c.b.visible = !first;
    });
    // Flashes pop while the photographers have their cameras up, each for a beat, a little bigger or smaller.
    const cameras = this.crowd[1];
    const up = cameras ? cameras.a.visible : true;
    this.flashes.forEach((f, i) => {
      f.visible = up && chance(beat, i) < FLASH_CHANCE;
      if (f.visible) f.scale.setScalar(0.5 + chance(beat, i + 31) * 0.5);
    });
  }

  dispose(): void {
    this.gone = true;
    this.group.removeFromParent();
    this.confetti.dispose();
    this.streamers.dispose();
    for (const o of this.own) o.dispose();
  }
}

/** A seeded random number generator in [0, 1). */
function rng(seed: number): () => number {
  let r = seed;
  return () => {
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    return (r >>> 0) / 4294967296;
  };
}

/** Where the confetti falls, round the podium (m). */
const AREA = { width: 11, depth: 6, top: 6.8, height: 7.6, forward: 1 };

/** Confetti falling over the podium, fluttering, without end. */
export class Confetti {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicNodeMaterial;
  private time = uniform(0);

  constructor(colours: readonly number[], count = 460) {
    const corners = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ] as const;
    const position = new Float32Array(count * 18);
    const seed = new Float32Array(count * 24);
    const colour = new Float32Array(count * 18);
    const c = new THREE.Color();
    const rand = rng(0x9e3779b9);
    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * AREA.width;
      const z = (rand() - 0.5) * AREA.depth + AREA.forward;
      const phase = rand();
      const speed = 0.7 + rand() * 0.6;
      c.set(colours[Math.floor(rand() * colours.length)] ?? 0xffffff);
      // Small squares and longer slips of paper.
      const w = 0.04 + rand() * 0.025;
      const long = rand() < 0.3 ? 2.6 : 1.5;
      corners.forEach(([u, v], k) => {
        const o = i * 6 + k;
        position.set([u * w, v * w * long, 0], o * 3);
        seed.set([x, z, phase, speed], o * 4);
        colour.set([c.r, c.g, c.b], o * 3);
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 4));
    geo.setAttribute("color", new THREE.BufferAttribute(colour, 3));

    const t = this.time;
    const s = attribute<"vec4">("seed", "vec4");
    // Each piece tumbles about two axes as it falls, swaying side to side, and starts over at the top.
    const tumble = t.mul(s.w.mul(3).add(1.5)).add(s.z.mul(40));
    const turn = t.mul(s.w.mul(1.7).add(0.6)).add(s.z.mul(17));
    const mat = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.positionNode = Fn(() => {
      const p = positionLocal;
      const y1 = p.y.mul(cos(tumble));
      const z1 = p.y.mul(sin(tumble));
      const x2 = p.x.mul(cos(turn)).add(z1.mul(sin(turn)));
      const z2 = p.x
        .mul(sin(turn))
        .negate()
        .add(z1.mul(cos(turn)));
      const fall = mod(t.mul(s.w).add(s.z.mul(AREA.height)), float(AREA.height));
      const sway = sin(t.mul(1.3).add(s.z.mul(13))).mul(0.3);
      return vec3(s.x.add(sway).add(x2), float(AREA.top).sub(fall).add(y1), s.y.add(z2));
    })();
    // Lighter as a piece turns its face to the light.
    mat.colorNode = vec3(abs(cos(tumble)).mul(0.35).add(0.65));
    inkOnlyInPass(mat, inkNode(0, 0, 0, 0));
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "podium.confetti";
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(UNREFLECTED);
  }

  /** The confetti at time `t` (s). */
  update(t: number): void {
    this.time.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** A streamer: how many pieces along it, its length and width (m), and how many turns it curls. */
const STREAMER = { pieces: 14, length: 1.4, width: 0.06, turns: 2.1, radius: 0.13 };

/** Paper streamers: curls of ribbon spinning down among the confetti, without end. */
export class Streamers {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicNodeMaterial;
  private time = uniform(0);

  constructor(colours: readonly number[], count = 30) {
    const n = STREAMER.pieces;
    // Each vertex: how far along its streamer (x) and which edge (y); the streamer's place, phase and speed.
    const position = new Float32Array(count * n * 18);
    const seed = new Float32Array(count * n * 24);
    const colour = new Float32Array(count * n * 18);
    const c = new THREE.Color();
    const rand = rng(0x51f15e37);
    const quad = [
      [0, -1],
      [1, -1],
      [1, 1],
      [0, -1],
      [1, 1],
      [0, 1],
    ] as const;
    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * AREA.width * 0.9;
      const z = (rand() - 0.5) * AREA.depth * 0.8 + AREA.forward;
      const phase = rand();
      const speed = 0.9 + rand() * 0.5;
      c.set(colours[Math.floor(rand() * colours.length)] ?? 0xffffff);
      for (let k = 0; k < n; k++) {
        quad.forEach(([du, edge], j) => {
          const o = (i * n + k) * 6 + j;
          position.set([(k + du) / n, edge, 0], o * 3);
          seed.set([x, z, phase, speed], o * 4);
          colour.set([c.r, c.g, c.b], o * 3);
        });
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 4));
    geo.setAttribute("color", new THREE.BufferAttribute(colour, 3));

    const t = this.time;
    const s = attribute<"vec4">("seed", "vec4");
    const height = AREA.height + STREAMER.length;
    // The curl turns as it falls, opening out toward its tail.
    const angle = positionLocal.x
      .mul(STREAMER.turns * Math.PI * 2)
      .add(t.mul(s.w.mul(2.2)))
      .add(s.z.mul(31));
    const mat = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.positionNode = Fn(() => {
      const along = positionLocal.x;
      const radius = along.mul(0.8).add(0.5).mul(STREAMER.radius);
      const fall = mod(t.mul(s.w).add(s.z.mul(height)), float(height));
      const drift = sin(t.mul(0.9).add(s.z.mul(19))).mul(0.35);
      return vec3(
        s.x.add(drift).add(cos(angle).mul(radius)),
        float(AREA.top + STREAMER.length)
          .sub(fall)
          .sub(along.mul(STREAMER.length))
          .add(positionLocal.y.mul(STREAMER.width / 2)),
        s.y.add(sin(angle).mul(radius)),
      );
    })();
    // The ribbon's face turns to the light and away as it curls.
    mat.colorNode = vec3(cos(angle.add(0.8)).mul(0.22).add(0.78));
    inkOnlyInPass(mat, inkNode(0, 0, 0, 0));
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "podium.streamers";
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(UNREFLECTED);
  }

  /** The streamers at time `t` (s). */
  update(t: number): void {
    this.time.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
