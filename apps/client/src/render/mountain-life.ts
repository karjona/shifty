// What moves on the mountain besides the riders: snow blown along the
// ground in the wind (streaks round the camera, all on the GPU), snow
// shaken off the boughs, smoke from the chimneys, and choughs wheeling over
// the run. The wind and the weather set how much of each there is.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  cross,
  float,
  fract,
  max,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import { LOOK } from "./cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId, inkNode, inkOnlyInPass } from "./cel/material.ts";
import { PIXEL_AT_1M } from "./cel/rider.ts";
import type { Tree } from "./mountain-forest.ts";
import { ParticlePool } from "./spray.ts";

/** Streaks of blown snow: how many, and the box round the camera they blow through (m: across, and high). */
const STREAKS = 2200;
const BOX = 56;
const BOX_HIGH = 4;
/** Below this wind (m/s) no snow blows; from `FULL_WIND` all of it does. */
const CALM = 2.5;
const FULL_WIND = 13;
/** Trees this close to the camera (m) drop their snow now and then, and chimneys this close smoke. */
const PUFF_NEAR = 90;
const SMOKE_NEAR = 420;

/** Seeded noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Snow blowing along the ground: thin white streaks drawn along the wind, in a box that wraps round the camera. */
function spindrift(amount: THREE.Node<"float">): THREE.Mesh {
  const n = STREAKS;
  const corner = new Float32Array(n * 4 * 2);
  const seeds = new Float32Array(n * 4 * 4);
  const index = new Uint32Array(n * 6);
  const r = rng(71);
  for (let i = 0; i < n; i++) {
    const s = [r(), r() ** 1.6, r(), (i + r()) / n];
    for (let k = 0; k < 4; k++) {
      corner.set([k & 1 ? 1 : -1, k & 2 ? 0.5 : -0.5], (i * 4 + k) * 2);
      seeds.set(s, (i * 4 + k) * 4);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  // (The quads are placed in the shader; `position` only sizes the buffers.)
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  geo.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
  geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const m = new THREE.MeshBasicNodeMaterial({ fog: true, side: THREE.DoubleSide });
  const box = vec3(BOX, BOX_HIGH, BOX);
  m.positionNode = Fn(() => {
    const seed = attribute<"vec4">("seed", "vec4");
    const c = attribute<"vec2">("corner", "vec2");
    const t = LOOK.time;
    const wind = vec3(LOOK.wind.x, 0, LOOK.wind.y);
    const speed = max(wind.length(), 0.01);
    const along = wind.div(speed);
    // Each streak rides the wind at its own pace, snaking as it goes; low ones are the most.
    const pace = seed.w.mul(0.5).add(0.6);
    const snake = vec3(
      sin(t.mul(1.7).add(seed.x.mul(50))).mul(0.6),
      sin(t.mul(2.3).add(seed.z.mul(50))).mul(0.25),
      sin(t.mul(1.3).add(seed.y.mul(50))).mul(0.6),
    );
    const home = seed.xyz.mul(box).add(wind.mul(t).mul(pace)).add(snake);
    const local = fract(
      home
        .sub(cameraPosition)
        .div(box)
        .add(vec3(0, 0.94, 0)),
    )
      .sub(vec3(0.5, 0.94, 0.5))
      .mul(box);
    const at = cameraPosition.add(local);
    const toCam = normalize(cameraPosition.sub(at));
    const side = normalize(cross(along, toCam));
    const dist = local.length();
    // Nothing right at the lens or at the box's edge; past the amount, nothing at all.
    const shown = smoothstep(3, 9, dist)
      .mul(smoothstep(BOX * 0.5, BOX * 0.36, dist))
      .mul(seed.w.lessThan(amount).select(1, 0));
    const width = max(float(0.018), dist.mul(PIXEL_AT_1M).mul(0.9)).mul(shown);
    const length = speed.mul(0.03).add(0.22).mul(seed.x.mul(0.8).add(0.6)).mul(shown);
    return at.add(side.mul(c.y.mul(width).mul(2))).add(along.mul(c.x.mul(length)));
  })();
  const c = attribute<"vec2">("corner", "vec2");
  // A streak, tapered to its ends.
  m.maskNode = c.y.abs().mul(2).lessThan(float(1).sub(c.x.abs()));
  m.colorNode = vec3(0.96, 0.97, 1).mul(LOOK.lit.mul(0.5).add(0.5));
  inkOnlyInPass(m, inkNode(0, 0, 0, 0));
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.layers.set(UNREFLECTED);
  mesh.renderOrder = 2;
  mesh.name = "spindrift";
  // (Compiled even in a calm: see `World.compile`.)
  mesh.userData.weather = true;
  return mesh;
}

interface Chough {
  centre: THREE.Vector3;
  radius: number;
  speed: number;
  phase: number;
  bob: number;
}

/**
 * A chough: a body, a tail and two broad wings with fingers at their tips.
 * `wing` is how far along a wing a vertex is (0 on the body), signed by its side.
 */
function choughGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const tri = (pts: number[][], along: number[]) => {
    for (const p of pts) pos.push(...p);
    wing.push(...along);
  };
  // The body: a slim diamond, nose to tail, and the tail's fan.
  tri(
    [
      [0, 0.05, 0.28],
      [0.07, 0, 0],
      [-0.07, 0, 0],
    ],
    [0, 0, 0],
  );
  tri(
    [
      [0.07, 0, 0],
      [0, 0.03, -0.24],
      [-0.07, 0, 0],
    ],
    [0, 0, 0],
  );
  tri(
    [
      [0, 0.02, -0.2],
      [0.12, 0, -0.48],
      [-0.12, 0, -0.48],
    ],
    [0, 0, 0],
  );
  for (const s of [-1, 1]) {
    const pts = [
      [0, 0, 0.14],
      [0, 0, -0.16],
      [s * 0.45, 0, 0.12],
      [s * 0.5, 0, -0.2],
      [s * 0.95, 0, 0.02],
      [s * 0.9, 0, -0.26],
      [s * 1.08, 0, -0.12],
    ];
    for (const [i, j, k] of [
      [0, 2, 1],
      [1, 2, 3],
      [2, 4, 3],
      [3, 4, 5],
      [4, 6, 5],
    ] as const) {
      tri([pts[i]!, pts[j]!, pts[k]!], [pts[i]![0]!, pts[j]![0]!, pts[k]![0]!]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("wing", new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * Choughs: black birds in small flocks, circling and gliding on the
 * mountain's air. One batch: each bird's place, heading, bank and wing beat
 * ride on its instance, and the shader poses it.
 */
class Choughs {
  readonly mesh: THREE.InstancedMesh;
  private birds: Chough[] = [];
  /** Per bird: x, y, z, heading; and bank, wing beat (rad). */
  private place: THREE.InstancedBufferAttribute;
  private pose: THREE.InstancedBufferAttribute;

  constructor(flocks: THREE.Vector3[]) {
    const r = rng(313);
    flocks.forEach((centre, f) => {
      const count = 4 + Math.floor(r() * 4);
      for (let i = 0; i < count; i++) {
        this.birds.push({
          centre: centre.clone().add(new THREE.Vector3((r() - 0.5) * 30, r() * 14, (r() - 0.5) * 30)),
          radius: 14 + r() * 26,
          speed: (0.16 + r() * 0.12) * (f % 2 === 0 ? 1 : -1),
          phase: r() * Math.PI * 2,
          bob: r() * 10,
        });
      }
    });
    const n = this.birds.length;
    this.place = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.pose = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.place.setUsage(THREE.DynamicDrawUsage);
    this.pose.setUsage(THREE.DynamicDrawUsage);
    const geometry = choughGeometry();
    geometry.setAttribute("place", this.place);
    geometry.setAttribute("pose", this.pose);
    const black = new CelMaterial({
      color: 0x24242c,
      side: THREE.DoubleSide,
      shade: new THREE.Color(0.6, 0.6, 0.9),
      id: inkId("chough"),
      crease: 0,
    });
    black.positionNode = Fn(() => {
      const p = positionGeometry;
      const place = attribute<"vec4">("place", "vec4");
      const pose = attribute<"vec2">("pose", "vec2");
      // The wings beat about the body's length; then the bird banks, turns to its heading and takes its place.
      const reach = attribute("wing", "float");
      const flapped = vec3(reach.mul(cos(pose.y)), p.y.add(reach.abs().mul(sin(pose.y))), p.z);
      const banked = vec3(
        flapped.x.mul(cos(pose.x)).sub(flapped.y.mul(sin(pose.x))),
        flapped.x.mul(sin(pose.x)).add(flapped.y.mul(cos(pose.x))),
        flapped.z,
      );
      const turned = vec3(
        banked.x.mul(cos(place.w)).add(banked.z.mul(sin(place.w))),
        banked.y,
        banked.z.mul(cos(place.w)).sub(banked.x.mul(sin(place.w))),
      );
      return turned.mul(SIZE).add(place.xyz);
    })();
    this.mesh = new THREE.InstancedMesh(geometry, black, n);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(UNREFLECTED);
    this.mesh.userData.noMerge = true;
  }

  update(t: number): void {
    const place = this.place.array;
    const pose = this.pose.array;
    this.birds.forEach((b, i) => {
      const a = b.phase + t * b.speed;
      // An oval, drifting up and down the air.
      place[i * 4] = b.centre.x + Math.cos(a) * b.radius;
      place[i * 4 + 1] = b.centre.y + Math.sin(t * 0.31 + b.bob) * 5 + Math.sin(a * 2) * 1.5;
      place[i * 4 + 2] = b.centre.z + Math.sin(a) * b.radius * 0.7;
      const dir = Math.sign(b.speed);
      // Along the oval, banked into it.
      place[i * 4 + 3] = -a - (dir * Math.PI) / 2 + Math.PI;
      pose[i * 2] = dir * 0.4;
      // A few beats, then a long glide (held on twos).
      const tt = Math.floor(t * 12) / 12;
      const flapping = Math.sin(tt * 0.6 + b.bob) > 0.55;
      pose[i * 2 + 1] = flapping ? Math.sin(tt * 13 + b.bob) * 0.6 : 0.12;
    });
    this.place.needsUpdate = true;
    this.pose.needsUpdate = true;
  }
}

/** A chough's size against its model's (about 2 m across the wings). */
const SIZE = 1.5;

/** The mountain's life (see the file's header). */
export class MountainLife {
  readonly group = new THREE.Group();
  private blowing = uniform(0);
  private drift: THREE.Mesh;
  private puffs = new ParticlePool({
    max: 420,
    gravity: 2.2,
    drag: 1.6,
    lensFrom: 0.6,
    lensTo: 2.2,
    peak: 0.8,
    fadeIn: 8,
  });
  private smoke = new ParticlePool({
    max: 360,
    gravity: -0.5,
    drag: 0.5,
    lensFrom: 1,
    lensTo: 4,
    peak: 0.85,
    fadeIn: 6,
  });
  private choughs: Choughs;
  private trees: Tree[];
  private chimneys: THREE.Vector3[];
  private random = rng(4711);
  private puffDue = 0;
  private smokeDue = 0;

  /** `trees`: the forest (boughs shed snow); `chimneys`: where smoke rises; `flocks`: where choughs circle. */
  constructor(trees: Tree[], chimneys: THREE.Vector3[], flocks: THREE.Vector3[]) {
    this.trees = trees;
    this.chimneys = chimneys;
    this.drift = spindrift(this.blowing);
    this.choughs = new Choughs(flocks);
    this.group.add(this.drift, this.puffs.sprite, this.smoke.sprite, this.choughs.mesh);
    this.group.userData.noMerge = true;
  }

  /**
   * A frame: `eye` the camera, `snowy` how much snow lies where it is
   * (0-1), `snowing` how hard it snows (0-1). The wind is the look's.
   */
  update(eye: THREE.Vector3, t: number, dt: number, snowy: number, snowing: number): void {
    const wind = LOOK.wind.value;
    const speed = wind.length();
    const blowing = Math.min(1, Math.max(0, (speed - CALM) / (FULL_WIND - CALM))) * snowy;
    this.blowing.value = blowing * (0.3 + 0.3 * snowing);
    this.drift.visible = blowing > 0.001;
    this.choughs.update(t);
    const rand = this.random;
    // Snow off the boughs: a tree near the camera sheds a puff, more often in a wind.
    this.puffDue -= dt * (0.25 + blowing * 2.2 + snowing * 0.5) * snowy;
    while (this.puffDue <= 0 && this.trees.length > 0) {
      this.puffDue += 1;
      for (let tries = 0; tries < 60; tries++) {
        const tree = this.trees[Math.floor(rand() * this.trees.length)]!;
        const d = Math.hypot(tree.x - eye.x, tree.z - eye.z);
        if (d > PUFF_NEAR || d < 6) continue;
        const a = rand() * Math.PI * 2;
        const out = 0.8 + rand() * 1.4 * tree.scale;
        const x = tree.x + Math.cos(a) * out;
        const z = tree.z + Math.sin(a) * out;
        const y = tree.y + (4 + rand() * 6) * tree.scale;
        for (let k = 0; k < 9; k++) {
          this.puffs.spawn(
            x + (rand() - 0.5) * 0.8,
            y + (rand() - 0.5) * 0.6,
            z + (rand() - 0.5) * 0.8,
            wind.x * 0.25 + (rand() - 0.5) * 0.8,
            -0.4 - rand() * 0.8,
            wind.y * 0.25 + (rand() - 0.5) * 0.8,
            1.4 + rand() * 1.2,
            0.25 + rand() * 0.2,
            0.7 + rand() * 0.5,
          );
        }
        break;
      }
    }
    this.puffs.update(() => -1e6, dt);
    // Smoke: a puff from each chimney in sight, leaning with the wind.
    this.smokeDue -= dt * 5;
    while (this.smokeDue <= 0 && this.chimneys.length > 0) {
      this.smokeDue += 1;
      const c = this.chimneys[Math.floor(rand() * this.chimneys.length)]!;
      if (c.distanceTo(eye) > SMOKE_NEAR) continue;
      this.smoke.spawn(
        c.x + (rand() - 0.5) * 0.2,
        c.y + 0.2,
        c.z + (rand() - 0.5) * 0.2,
        wind.x * 0.35 + (rand() - 0.5) * 0.3,
        0.9 + rand() * 0.5,
        wind.y * 0.35 + (rand() - 0.5) * 0.3,
        5 + rand() * 3,
        0.5,
        2.2 + rand() * 1.4,
      );
    }
    this.smoke.update(() => -1e6, dt);
  }
}
