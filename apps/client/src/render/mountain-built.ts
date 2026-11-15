// What is built on the mountain (the models of art/env/buildings.py and
// props.py): the village at the finish, the start hut and the lodge, the
// chairlift with its chairs travelling, the start and finish gantries,
// checkpoint gates, flags, sponsor boards, and the crowd. Roofs carry the
// snow that lies at their height, windows light up at dusk, cloth flaps in
// the wind and the crowd cheers.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  floor,
  hash,
  mix,
  modelWorldMatrix,
  normalLocal,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { LOOK, cut0 } from "./cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId, inkNode, inkOnlyInPass } from "./cel/material.ts";
import type { Models } from "./env/models.ts";
import { MOUNTAIN, fadingInk, gustAt, scenerySnow, shadeKept, snowLoad, snowShade, windNow } from "./mountain-look.ts";
import { runAt, runPoint } from "./mountain-props.ts";
import type { GateData, RunData } from "./mountain.ts";
import type { RunScenery } from "./runs.ts";

/** A building, where it stands along the run. */
export interface Building {
  model: string;
  /** Along the run and right of its centre line (m). */
  s: number;
  offset: number;
  /** Which way its front looks: at the run ("run"), up it ("up") or down it ("down"). */
  faces: "run" | "up" | "down";
  scale: number;
  /** The forest keeps this far from its middle (m). */
  yard: number;
}

/** A snow cap sinks this many times its height without snow (more than anything is scaled by). */
const CAP_SINK = 2.4;
/** The made-up brands of Costa Nevada, in their colours (background, ink). */
export const BRANDS: [string, string, string][] = [
  ["TRAMUNTANA", "#1f3b6e", "#ffffff"],
  ["GARBÍ", "#f08a24", "#1d1a16"],
  ["LLEVANT", "#12a39a", "#ffffff"],
  ["XALOC", "#d8342a", "#ffe9a8"],
  ["PONENT", "#6b3fa0", "#ffffff"],
];
const JACKETS = [0xd8452e, 0x2e7fbf, 0xe8b62c, 0x3fae6a, 0x8a4fbf, 0xf2f0ea, 0xe86a2c, 0x2a3a5c, 0xd85a9a];

/** Where chimneys smoke from, per model (m, from its origin). */
const CHIMNEYS: Record<string, [number, number, number][]> = {
  chalet_a: [[1.98, 8.9, -0.9]],
  chalet_b: [[2.31, 8.9, -0.96]],
  chalet_c: [[1.76, 8.9, -0.84]],
  inn: [[3.6, 13, -1.28]],
  hotel: [
    [-6, 18.3, -1],
    [5.6, 18.1, -1.2],
  ],
  hut: [[5.04, 6, -0.6]],
  lodge: [[-4.2, 11, -2.2]],
};

/** The buildings of a run: the village round the finish, the start hut, the lodge. */
export function buildingPlan(run: RunData, scenery: RunScenery): Building[] {
  const finish = run.finishS;
  const end = run.path.at(-1)!.s;
  const limit = run.finish.limit;
  const plan: Building[] = [{ model: "hut", s: run.path[0]!.s - 13, offset: 0, faces: "down", scale: 1, yard: 12 }];
  const lodge = scenery.lodge;
  const at = runPoint(run, lodge.s);
  plan.push({
    model: "lodge",
    s: lodge.s,
    offset: (at.limit + lodge.out + 8) * lodge.side,
    faces: "run",
    scale: lodge.size > 1 ? 1.2 : 0.9,
    yard: 16,
  });
  if (scenery.village) {
    const side = (model: string, s: number, out: number, right: boolean, scale = 1.25): Building => ({
      model,
      s,
      offset: (runPoint(run, s).limit + out) * (right ? 1 : -1),
      faces: "run",
      scale,
      yard: model === "hotel" ? 15 : 10,
    });
    plan.push(
      // Along the finish straight, their fronts to it: the hotel and the church tower over the rest.
      side("chalet_a", finish - 66, 16, true),
      side("hotel", finish + 26, 21, true, 1.3),
      side("inn", finish + 76, 17, true),
      side("chalet_b", finish - 62, 16, false),
      side("church", finish + 34, 24, false, 1.5),
      side("chalet_a", finish + 82, 15, false),
      // Behind them, up the bank.
      side("chalet_c", finish - 24, 42, true, 1.3),
      side("chalet_b", finish + 64, 46, true, 1.3),
      side("inn", finish - 8, 44, false, 1.3),
      side("chalet_c", finish + 72, 42, false, 1.3),
      // Across the end of the outrun, looking up the run.
      { model: "chalet_c", s: end + 50, offset: -30, faces: "up", scale: 1.4, yard: 12 },
      { model: "inn", s: end + 58, offset: 2, faces: "up", scale: 1.4, yard: 14 },
      { model: "chalet_a", s: end + 50, offset: 34, faces: "up", scale: 1.4, yard: 12 },
    );
  } else {
    // By the lodge: a couple of chalets up the bank.
    plan.push(
      { model: "chalet_a", s: lodge.s - 44, offset: (limit + 30) * lodge.side, faces: "run", scale: 1.25, yard: 11 },
      { model: "chalet_c", s: lodge.s + 46, offset: (limit + 26) * lodge.side, faces: "run", scale: 1.25, yard: 11 },
      { model: "chalet_b", s: end + 56, offset: 8, faces: "up", scale: 1.4, yard: 12 },
    );
  }
  return plan;
}

/** Where a building stands (x, z) and which way it is turned. */
export function buildingAt(run: RunData, b: Building): { x: number; z: number; turn: number } {
  const at = runAt(run, b.s, b.offset);
  const side = Math.sign(b.offset) || 1;
  const turn =
    b.faces === "down"
      ? at.yaw
      : b.faces === "up"
        ? at.yaw + Math.PI
        : Math.atan2(side * Math.cos(at.yaw), -side * Math.sin(at.yaw));
  return { x: at.x, z: at.z, turn };
}

let built: CelMaterial | null = null;

/**
 * What is built, in its painted colours: a vertex's colour is its own; its
 * masks (`uv`) are a snow cap's height (m) and whether it is one; alpha 0
 * is glass, dark by day and lit from inside toward dusk and under a storm.
 */
export function builtMaterial(): CelMaterial {
  if (built) return built;
  const masks = uv();
  const m = new CelMaterial({
    colorNode: Fn(() => {
      const c = attribute<"vec4">("color", "vec4");
      // Some windows are lit, more of them as the light goes.
      const pane = hash(
        floor(positionWorld.x.mul(0.45))
          .add(floor(positionWorld.y.mul(0.4)).mul(57))
          .add(floor(positionWorld.z.mul(0.45)).mul(131)),
      );
      const dark = LOOK.dusk.max(LOOK.overcast.mul(0.75));
      const lamp = cut0(dark.mul(1.25).sub(pane).sub(0.1));
      const glass = mix(c.rgb, vec3(1.0, 0.74, 0.36).mul(1.5), lamp);
      const painted = mix(glass, c.rgb, cut0(c.a.sub(0.5)));
      return mix(painted, scenerySnow(), masks.y);
    })(),
    shade: new THREE.Color(0.6, 0.6, 0.86),
    richness: 1.15,
    id: inkId("built"),
  });
  fadingInk(m, 1, 0.6, inkId("built"), 0.85);
  // (Snow on a roof shades as the snow round it does.)
  m.shadeNode = mix(vec3(0.6, 0.6, 0.86).mul(shadeKept()), snowShade(), masks.y);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    return p.sub(
      vec3(
        0,
        masks.x
          .mul(masks.y)
          .mul(float(1).sub(snowLoad(modelWorldMatrix.mul(vec4(p, 1)).xyz)))
          .mul(CAP_SINK),
        0,
      ),
    );
  })();
  built = m;
  return m;
}

let cloth: CelMaterial | null = null;

/**
 * Flags, gate panels and boards: what has alpha 0 takes its instance's
 * `tint`, and flaps in the wind by how far it is from what holds it (`uv.x`).
 */
function clothMaterial(): CelMaterial {
  if (cloth) return cloth;
  const masks = uv();
  const m = new CelMaterial({
    colorNode: Fn(() => {
      const c = attribute<"vec4">("color", "vec4");
      const painted = mix(c.rgb.mul(attribute<"vec3">("tint", "vec3")), c.rgb, cut0(c.a.sub(0.5)));
      return mix(painted, scenerySnow(), masks.y);
    })(),
    side: THREE.DoubleSide,
    shade: new THREE.Color(0.66, 0.62, 0.84),
    richness: 1.2,
    id: inkId("cloth"),
  });
  fadingInk(m, 0.8, 0, inkId("cloth"), 0.7);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const { speed } = windNow();
    const gust = gustAt(p.xz);
    const free = masks.x.mul(float(1).sub(masks.y));
    const wave = sin(
      LOOK.time.mul(speed.mul(0.5).add(4)).sub(masks.x.mul(4.5)).add(p.y.mul(2.3)).add(p.x.add(p.z).mul(0.7)),
    );
    const reach = speed.mul(0.014).add(0.03).mul(gust.mul(0.7).add(0.5));
    const flapped = p.add(normalLocal.normalize().mul(wave.mul(free).mul(reach)));
    return flapped.sub(
      vec3(
        0,
        masks.x
          .mul(masks.y)
          .mul(float(1).sub(snowLoad(modelWorldMatrix.mul(vec4(p, 1)).xyz)))
          .mul(CAP_SINK),
        0,
      ),
    );
  })();
  cloth = m;
  return m;
}

let people: CelMaterial | null = null;

/**
 * The crowd: jackets and hats in each figure's `tint`; they bounce and
 * throw their arms up (`uv`: how much a vertex goes with a raised arm, and
 * with the bounce), each to its own beat, held on twos.
 */
function crowdMaterial(): CelMaterial {
  if (people) return people;
  const masks = uv();
  const m = new CelMaterial({
    colorNode: Fn(() => {
      const c = attribute<"vec4">("color", "vec4");
      return mix(c.rgb.mul(attribute<"vec3">("tint", "vec3")), c.rgb, cut0(c.a.sub(0.5)));
    })(),
    shade: new THREE.Color(0.62, 0.6, 0.84),
    richness: 1.2,
    crease: 0.3,
    id: inkId("crowd"),
  });
  fadingInk(m, 1, 0.3, inkId("crowd"), 0.85);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const who = attribute<"vec3">("tint", "vec3").dot(vec3(12.9, 78.2, 37.7));
    const t = floor(LOOK.time.mul(12)).div(12);
    // Now and then a cheer: a few bounces, arms pumping.
    const cheer = smoothstep(0.15, 0.25, sin(t.mul(0.9).add(who.mul(5))));
    const beat = sin(t.mul(9).add(who.mul(11)));
    const bounce = beat.abs().mul(0.09).mul(cheer).mul(masks.y);
    const pump = beat.mul(0.07).mul(cheer.mul(0.7).add(0.3)).mul(masks.x);
    // And a wave runs along the fence now and then: up on their toes, arms higher, as it passes.
    const passing = sin(t.mul(2.4).sub(p.x.add(p.z).mul(0.16)))
      .max(0)
      .pow(6);
    const wave = passing.mul(smoothstep(0.3, 0.6, sin(t.mul(0.23)))).mul(masks.y.mul(0.2).add(masks.x.mul(0.22)));
    return p.add(vec3(0, bounce.add(pump).add(wave), 0));
  })();
  people = m;
  return m;
}

/** Deterministic noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface Tinted {
  model: string;
  x: number;
  y: number;
  z: number;
  turn: number;
  scale: number;
  tint: number;
  /** Its width, height and depth against the model's (on top of `scale`). */
  size?: [number, number, number];
}

/** A text band: `text` on a colour, checkered along its edges or not. */
function bandTexture(text: string, bg: string, fg: string, checker: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 1024, 128);
  if (checker) {
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 === 0 ? "#111" : "#f4f4f0";
        g.fillRect(x * 16, y * 16, 16, 16);
        g.fillRect(x * 16, 96 + y * 16, 16, 16);
      }
  }
  g.fillStyle = fg;
  g.font = "italic 800 68px Archivo, ui-sans-serif, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 512, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The brands' wordmarks, one above the other. */
function brandsTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128 * BRANDS.length;
  const g = c.getContext("2d")!;
  BRANDS.forEach(([name, bg, fg], i) => {
    g.fillStyle = bg;
    g.fillRect(0, i * 128, 512, 128);
    g.fillStyle = fg;
    g.fillRect(0, i * 128 + 108, 512, 8);
    g.font = "italic 800 62px Archivo, ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(name, 256, i * 128 + 58);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Everything built on a run. */
export class Built {
  readonly group = new THREE.Group();
  /** Where chimneys smoke from (world). */
  readonly chimneys: THREE.Vector3[] = [];
  private run: RunData;
  private models: Models;
  private ground: (x: number, z: number) => number;
  private tinted: Tinted[] = [];
  private crowd: Tinted[] = [];
  private chairs: {
    mesh: THREE.InstancedMesh;
    riders: THREE.InstancedMesh;
    line: THREE.Vector3[][];
    lengths: number[];
  } | null = null;
  private random = rng(909);
  private accent = 0xd4262f;
  /** Where lamps shine (world): they glow as the light goes. */
  readonly lamps: THREE.Vector3[] = [];
  private scratch = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3() };

  /** `accent`: the season's colour, for the gantries' cloth. */
  constructor(
    run: RunData,
    scenery: RunScenery,
    plan: Building[],
    models: Models,
    ground: (x: number, z: number) => number,
    accent: number,
  ) {
    this.run = run;
    this.models = models;
    this.ground = ground;
    this.accent = accent;
    for (const b of plan) this.building(b);
    this.lift(scenery);
    this.gantry(run.startGate, bandTexture("23.4° SHIFTY · COSTA NEVADA", "#1f3b6e", "#ffffff", false), 16);
    this.gantry(run.finish, bandTexture("FINISH", "#f4f4f0", "#111111", true), 28);
    this.gates();
    this.finishArea(scenery);
    this.instances(this.tinted, clothMaterial(), true);
    this.instances(this.crowd, crowdMaterial(), true);
    this.glows();
  }

  /** Lowest ground under a `w` by `d` footprint at (x, z), turned by `turn`. */
  private footing(x: number, z: number, turn: number, w: number, d: number): number {
    let low = Infinity;
    for (const [u, v] of [
      [0, 0],
      [-w, d],
      [w, d],
      [w, -d],
      [-w, -d],
    ] as const) {
      const px = x + u * Math.cos(turn) + v * Math.sin(turn);
      const pz = z - u * Math.sin(turn) + v * Math.cos(turn);
      low = Math.min(low, this.ground(px, pz));
    }
    return low;
  }

  /** A static model, placed. */
  private place(model: string, x: number, y: number, z: number, turn: number, scale = 1): THREE.Mesh | null {
    const geometry = this.models.get(model);
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, builtMaterial());
    mesh.position.set(x, y, z);
    mesh.rotation.y = turn;
    mesh.scale.setScalar(scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private building(b: Building): void {
    const at = buildingAt(this.run, b);
    const box = this.models.get(b.model)?.boundingBox;
    if (!box) return;
    const w = (box.max.x * b.scale) / 2;
    const d = (box.max.z * b.scale) / 2;
    // Its floor a little over the lowest ground under it.
    const y = this.footing(at.x, at.z, at.turn, w, d) + 0.5;
    const mesh = this.place(b.model, at.x, y, at.z, at.turn, b.scale);
    if (!mesh) return;
    mesh.updateMatrixWorld();
    for (const c of CHIMNEYS[b.model] ?? []) this.chimneys.push(new THREE.Vector3(...c).applyMatrix4(mesh.matrixWorld));
    // People at the lodge and the hut.
    if (b.model === "lodge" || b.model === "hut") {
      const n = b.model === "lodge" ? 9 : 5;
      for (let k = 0; k < n; k++) {
        const local =
          b.model === "lodge"
            ? new THREE.Vector3(-6 + this.random() * 16, 1.25, 6.4 + this.random() * 3)
            : new THREE.Vector3(-6 + this.random() * 12, 0.72, 3.6 + this.random());
        const p = local.applyMatrix4(mesh.matrixWorld);
        this.spectator(p.x, p.y, p.z, at.turn + (this.random() - 0.5) * 0.8);
      }
    }
  }

  private spectator(x: number, y: number, z: number, turn: number): void {
    const r = this.random();
    this.crowd.push({
      model: CROWD[Math.floor(r * CROWD.length)]!,
      x,
      y,
      z,
      turn,
      scale: 0.92 + this.random() * 0.16,
      tint: JACKETS[Math.floor(this.random() * JACKETS.length)]!,
    });
  }

  /** Batches of a model that take a colour each: one instanced mesh per model. */
  private instances(list: Tinted[], material: CelMaterial, shadow: boolean): void {
    const byModel = new Map<string, Tinted[]>();
    for (const t of list) {
      let group = byModel.get(t.model);
      if (!group) byModel.set(t.model, (group = []));
      group.push(t);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const at = new THREE.Vector3();
    const size = new THREE.Vector3();
    const colour = new THREE.Color();
    for (const [model, group] of byModel) {
      const source = this.models.get(model);
      if (!source) continue;
      // (Its own geometry: the tints are per instance.)
      const geometry = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(source.attributes)) geometry.setAttribute(name, a);
      geometry.setIndex(source.index);
      const tints = new Float32Array(group.length * 3);
      const mesh = new THREE.InstancedMesh(geometry, material, group.length);
      group.forEach((t, i) => {
        q.setFromAxisAngle(up, t.turn);
        const [sx, sy, sz] = t.size ?? [1, 1, 1];
        mesh.setMatrixAt(i, m.compose(at.set(t.x, t.y, t.z), q, size.set(sx, sy, sz).multiplyScalar(t.scale)));
        colour.setHex(t.tint);
        tints.set([colour.r, colour.g, colour.b], i * 3);
      });
      geometry.setAttribute("tint", new THREE.InstancedBufferAttribute(tints, 3));
      mesh.computeBoundingSphere();
      mesh.castShadow = shadow;
      mesh.userData.noMerge = true;
      this.group.add(mesh);
    }
  }

  /** The chairlift: towers where the sim has them, a station at each end, the cables, and chairs on them. */
  private lift(scenery: RunScenery): void {
    const towers = this.run.obstacles.filter((o) => o.kind === "tower");
    if (towers.length < 2) return;
    const first = new THREE.Vector3(towers[0]!.x, towers[0]!.y, towers[0]!.z);
    const last = new THREE.Vector3(towers.at(-1)!.x, towers.at(-1)!.y, towers.at(-1)!.z);
    const down = last.clone().sub(first).setY(0).normalize();
    const yaw = Math.atan2(down.x, down.z);
    for (const t of towers) this.place("lift_tower", t.x, t.y, t.z, yaw, t.height / 14);
    // The top station (where the run's scenery has it, or up the line) and the bottom one.
    const [topAt, bottomAt] = liftEnds(this.run, scenery)!;
    const ends: THREE.Vector3[] = [];
    for (const [at, toward] of [
      [topAt, first],
      [bottomAt, last],
    ] as const) {
      const turn = Math.atan2(toward.x - at.x, toward.z - at.z);
      const y = this.footing(at.x, at.z, turn, 4.2, 6.5) + 0.2;
      const mesh = this.place("lift_station", at.x, y, at.z, turn);
      mesh?.updateMatrixWorld();
      ends.push(
        mesh ? new THREE.Vector3(0, 4.0, 4.0).applyMatrix4(mesh.matrixWorld) : new THREE.Vector3(at.x, y + 4, at.z),
      );
    }
    const tops = [ends[0]!, ...towers.map((t) => new THREE.Vector3(t.x, t.y + t.height - 0.95, t.z)), ends[1]!];
    // Two cables, each a sagging line from support to support.
    const line: THREE.Vector3[][] = [];
    const wire = fadingInk(new THREE.LineBasicNodeMaterial({ color: 0x30343a }), 0, 0, 0, 0);
    for (const side of [-2.6, 2.6]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < tops.length - 1; i++) {
        const a = tops[i]!;
        const b = tops[i + 1]!;
        const right = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
        const n = 12;
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
          const t = k / n;
          const p = a.clone().lerp(b, t).addScaledVector(right, side);
          p.y -= Math.sin(t * Math.PI) * a.distanceTo(b) * 0.014;
          pts.push(p);
        }
      }
      line.push(pts);
      const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wire);
      cable.userData.noMerge = true;
      this.group.add(cable);
    }
    const lengths = line.map((pts) => pts.reduce((sum, p, i) => (i ? sum + p.distanceTo(pts[i - 1]!) : 0), 0));
    const each = Math.floor(lengths[0]! / CHAIR_GAP);
    const empty = this.models.get("chair");
    const full = this.models.get("chair_riders");
    if (!empty || !full) return;
    const mesh = liveried(empty, each * 2, 0);
    const riders = liveried(full, each, 2);
    for (const o of [mesh, riders]) {
      o.castShadow = true;
      o.frustumCulled = false;
      o.userData.noMerge = true;
      this.group.add(o);
    }
    this.chairs = { mesh, riders, line, lengths };
    this.update(0);
  }

  /** Moves the chairs along their cables: up one side, down the other. */
  update(t: number): void {
    const c = this.chairs;
    if (!c) return;
    const { m, q, p } = this.scratch;
    const each = c.riders.count;
    let empty = 0;
    let full = 0;
    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const pts = c.line[sideIndex]!;
      const length = c.lengths[sideIndex]!;
      // The first cable carries chairs up (toward its start), the second down.
      const upward = sideIndex === 0;
      for (let k = 0; k < each; k++) {
        const along = (((k * CHAIR_GAP + (upward ? -1 : 1) * t * CHAIR_SPEED) % length) + length) % length;
        // The point `along` the line.
        let walked = 0;
        let i = 1;
        for (; i < pts.length - 1; i++) {
          const step = pts[i]!.distanceTo(pts[i - 1]!);
          if (walked + step >= along) break;
          walked += step;
        }
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const f = Math.min(1, (along - walked) / Math.max(1e-3, a.distanceTo(b)));
        p.copy(a).lerp(b, f);
        const yaw = Math.atan2(b.x - a.x, b.z - a.z) + (upward ? Math.PI : 0);
        q.setFromAxisAngle(UP, yaw);
        m.compose(p, q, ONE);
        // Two chairs in three going up have riders on.
        if (upward && k % 3 !== 2) c.riders.setMatrixAt(full++, m);
        else c.mesh.setMatrixAt(empty++, m);
      }
    }
    for (let i = full; i < c.riders.count; i++) c.riders.setMatrixAt(i, HIDDEN);
    for (let i = empty; i < c.mesh.count; i++) c.mesh.setMatrixAt(i, HIDDEN);
    c.mesh.instanceMatrix.needsUpdate = true;
    c.riders.instanceMatrix.needsUpdate = true;
  }

  /** A gantry across the run at a gate: a leg either side with floodlights, a lattice beam, a banner hung from it, and cloth in the season's colour either side of the banner and down the legs. */
  private gantry(g: GateData, banner: THREE.Texture, wide: number): void {
    const half = g.limit + 1.8;
    const rx = Math.cos(g.yaw);
    const rz = -Math.sin(g.yaw);
    const feet = [-1, 1].map((side) => {
      const x = g.x + rx * half * side;
      const z = g.z + rz * half * side;
      return { x, z, y: this.ground(x, z), side };
    });
    const top = Math.max(feet[0]!.y, feet[1]!.y, g.y) + 7.2;
    for (const f of feet) {
      const tall = (top - f.y + 0.4) / 6.6;
      const leg = this.place("gantry_leg", f.x, f.y, f.z, g.yaw, 1);
      leg?.scale.set(1.7, tall, 1.7);
      this.lamps.push(new THREE.Vector3(f.x, f.y + 6.95 * tall, f.z));
      // A long cloth down the leg's inner side, facing up the run and down it.
      this.tinted.push({
        model: "drape",
        x: f.x - rx * 1.5 * f.side,
        y: top - 0.9,
        z: f.z - rz * 1.5 * f.side,
        turn: g.yaw,
        scale: 1,
        tint: this.accent,
        size: [1.5, 4.6, 1],
      });
    }
    const bay = this.models.get("truss_bay");
    if (bay) {
      const count = Math.ceil(half);
      const beam = new THREE.InstancedMesh(bay, builtMaterial(), count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.yaw);
      const one = new THREE.Vector3((half * 2) / count, 2, 2);
      for (let k = 0; k < count; k++) {
        const along = -half + (k * half * 2) / count;
        beam.setMatrixAt(k, m.compose(new THREE.Vector3(g.x + rx * along, top, g.z + rz * along), q, one));
      }
      beam.computeBoundingSphere();
      beam.castShadow = true;
      beam.userData.noMerge = true;
      this.group.add(beam);
    }
    // The banner reads from up the run and from below it.
    const deep = wide / 8;
    const printed = fadingInk(new CelMaterial({ map: banner }), 0.6, 0, 0, 0.8);
    for (const back of [0, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(wide, deep), printed);
      const out = back ? 0.04 : -0.04;
      sign.position.set(g.x + Math.sin(g.yaw) * out, top - 0.7 - deep / 2, g.z + Math.cos(g.yaw) * out);
      sign.rotation.y = g.yaw + (back ? 0 : Math.PI);
      sign.castShadow = true;
      this.group.add(sign);
    }
    // Either side of it, the season's colour, hung from the beam.
    const room = half - 2.6 - wide / 2;
    if (room > 2) {
      for (const side of [-1, 1]) {
        const along = (wide / 2 + 0.4 + room / 2) * side;
        this.tinted.push({
          model: "drape",
          x: g.x + rx * along,
          y: top - 0.7,
          z: g.z + rz * along,
          turn: g.yaw,
          scale: 1,
          tint: this.accent,
          size: [room, deep * 0.8, 1],
        });
      }
    }
  }

  /** The lamps' glow: a warm disc at each, facing the camera, coming up as the light goes. */
  private glows(): void {
    if (this.lamps.length === 0) return;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const at = new Float32Array(this.lamps.length * 3);
    this.lamps.forEach((p, i) => at.set([p.x, p.y, p.z], i * 3));
    geometry.setAttribute("lamp", new THREE.InstancedBufferAttribute(at, 3));
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const centre = attribute<"vec3">("lamp", "vec3");
    // A disc a few metres across, turned to the camera.
    m.vertexNode = cameraProjectionMatrix.mul(
      cameraViewMatrix.mul(vec4(centre, 1)).add(vec4(positionGeometry.xy.mul(GLOW_SIZE), 0, 0)),
    );
    const dark = LOOK.dusk.max(LOOK.overcast.mul(0.75));
    const r = uv().sub(0.5).length().mul(2);
    const reach = smoothstep(MOUNTAIN.fogFar, MOUNTAIN.fogNear, centre.distance(cameraPosition));
    m.colorNode = vec3(1.0, 0.72, 0.36);
    m.opacityNode = smoothstep(1, 0.1, r)
      .pow(2)
      .mul(smoothstep(0.2, 0.7, dark))
      .mul(reach)
      .mul(0.75);
    inkOnlyInPass(m, inkNode(0, 0, 0, 0));
    const mesh = new THREE.InstancedMesh(geometry, m, this.lamps.length);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.layers.set(UNREFLECTED);
    mesh.userData.noMerge = true;
    this.group.add(mesh);
  }

  /** Checkpoints: a pair of gate panels either side of the run, red then blue down the mountain. */
  private gates(): void {
    this.run.checkpoints.forEach((g, i) => {
      for (const side of [-1, 1]) {
        for (const back of [0, 1.6]) {
          const o = (g.limit + 1.3 + back * 0.5) * side;
          const x = g.x - Math.cos(g.yaw) * o - Math.sin(g.yaw) * back;
          const z = g.z + Math.sin(g.yaw) * o - Math.cos(g.yaw) * back;
          this.tinted.push({
            model: "gate",
            x,
            y: this.ground(x, z),
            z,
            turn: g.yaw + Math.PI + side * 0.25,
            scale: 1.25,
            tint: i % 2 === 0 ? 0xd8342a : 0x2456c8,
          });
        }
      }
    });
  }

  /** The finish straight: feather flags, sponsor boards along the fences, and the crowd behind them; flags at the start. */
  private finishArea(scenery: RunScenery): void {
    const run = this.run;
    const finish = run.finishS;
    const stand = (model: string, s: number, offset: number, faceIn: boolean, tint: number, scale = 1) => {
      const at = runAt(run, s, offset);
      const side = Math.sign(offset) || 1;
      this.tinted.push({
        model,
        x: at.x,
        y: this.ground(at.x, at.z),
        z: at.z,
        turn: faceIn ? Math.atan2(side * Math.cos(at.yaw), -side * Math.sin(at.yaw)) : at.yaw + Math.PI,
        scale,
        tint,
      });
    };
    let k = 0;
    for (const s of [run.startS - 6, run.startS + 14]) {
      for (const side of [-1, 1]) stand("feather", s, (runPoint(run, s).limit + 2.4) * side, false, brand(k++), 1.1);
    }
    for (let s = finish - 84; s <= finish + 36; s += 12) {
      for (const side of [-1, 1]) stand("feather", s, (runPoint(run, s).limit + 2.6) * side, false, brand(k++), 1.15);
    }
    // Boards along both fences of the finish area, a wordmark on each.
    const marks = brandsTexture();
    const faces: THREE.BufferGeometry[] = [];
    const end = Math.min(finish + 86, run.path.at(-1)!.s);
    let n = 0;
    for (let s = finish + 4; s < end; s += 3.15) {
      for (const side of [-1, 1]) {
        const offset = (runPoint(run, s).limit + 1.0) * side;
        const which = (n + (side > 0 ? 2 : 0)) % BRANDS.length;
        stand("board", s, offset, true, 0xffffff);
        const placed = this.tinted.at(-1)!;
        const face = new THREE.PlaneGeometry(2.96, 0.9);
        const uvs = face.attributes.uv!;
        for (let i = 0; i < uvs.count; i++) uvs.setY(i, 1 - (which + 1 - uvs.getY(i)) / BRANDS.length);
        face.translate(0, 0.48, 0.065);
        face.applyMatrix4(
          new THREE.Matrix4().compose(
            new THREE.Vector3(placed.x, placed.y, placed.z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placed.turn),
            new THREE.Vector3(1, 1, 1),
          ),
        );
        faces.push(face);
        // The crowd behind the board, three deep in places.
        for (let row = 0; row < 3; row++) {
          if (this.random() < (scenery.village ? 0.12 : 0.4) + row * 0.24) continue;
          const at = runAt(run, s + (this.random() - 0.5) * 2.4, offset + side * (1.1 + row * 0.85));
          const inward = Math.atan2(side * Math.cos(at.yaw), -side * Math.sin(at.yaw));
          this.spectator(
            at.x,
            this.ground(at.x, at.z) - 0.05 + row * 0.12,
            at.z,
            inward + (this.random() - 0.5) * 0.9 - side * 0.5,
          );
        }
      }
      n++;
    }
    const sheet = new THREE.Mesh(mergeFaces(faces), new CelMaterial({ map: marks, crease: 0, silhouette: 0 }));
    sheet.userData.noMerge = true;
    this.group.add(sheet);
    // Either side of the last metres before the line: a grandstand, full.
    for (const side of [-1, 1]) {
      const s = finish - 17;
      const at = runAt(run, s, (runPoint(run, s).limit + 5.2) * side);
      const turn = inward(at, side);
      const seats = { model: "grandstand", x: at.x, y: this.footing(at.x, at.z, turn, 6, 2) + 0.2, z: at.z, turn };
      this.tinted.push({ ...seats, scale: 1.15, tint: brand(side > 0 ? 0 : 3) });
      const seat = new THREE.Matrix4().compose(
        new THREE.Vector3(seats.x, seats.y, seats.z),
        new THREE.Quaternion().setFromAxisAngle(UP, turn),
        new THREE.Vector3(1.15, 1.15, 1.15),
      );
      for (let tier = 0; tier < 5; tier++) {
        for (let place = 0; place < 14; place++) {
          if (this.random() < 0.18) continue;
          const p = new THREE.Vector3(
            -5.6 + place * 0.86 + (this.random() - 0.5) * 0.3,
            0.5 + tier * 0.45,
            -tier * 0.85 - 0.25,
          );
          p.applyMatrix4(seat);
          this.spectator(p.x, p.y, p.z, turn + (this.random() - 0.5) * 0.5);
        }
      }
    }
    // The timing board by the line, snowcats parked beyond the crowd, and floodlights along the fences.
    // (Up the run from the line: what stands tall beyond it would stand between the cameras and the finishers.)
    const board = runAt(run, finish - 36, -(runPoint(run, finish - 36).limit + 5.5));
    this.tinted.push({
      model: "timing_board",
      x: board.x,
      y: this.ground(board.x, board.z),
      z: board.z,
      turn: inward(board, -1) - 0.5,
      scale: 1.3,
      tint: this.accent,
    });
    for (const [s, out, side, yaw] of [
      [finish - 44, 9, 1, 0.25],
      [finish - 58, 9.5, -1, Math.PI - 0.3],
      [run.startS - 14, 9, -1, 0.5],
    ] as const) {
      const at = runAt(run, s, (runPoint(run, s).limit + out) * side);
      this.place("snowcat", at.x, this.footing(at.x, at.z, at.yaw + yaw, 2.4, 3.2) + 0.25, at.z, at.yaw + yaw, 1.05);
    }
    for (let s = finish - 66; s <= end; s += 26) {
      for (const side of [-1, 1]) {
        const at = runAt(run, s, (runPoint(run, s).limit + 4.1) * side);
        const y = this.ground(at.x, at.z);
        this.place("lamp_post", at.x, y, at.z, inward(at, side), 1);
        this.lamps.push(new THREE.Vector3(at.x, y + 6.8, at.z));
      }
    }
  }
}

/** Who stands in the crowd: mostly onlookers, some with their board or skis. */
const CROWD = [
  "spectator_a",
  "spectator_a",
  "spectator_a",
  "spectator_c",
  "spectator_c",
  "spectator_b",
  "spectator_b",
  "boarder_a",
  "boarder_b",
  "boarder_c",
];
/** A lamp's glow is this wide (m). */
const GLOW_SIZE = 5;

/** A brand's colour, by its place in `BRANDS` (they come round again). */
const brand = (k: number) => new THREE.Color(BRANDS[k % BRANDS.length]![1]).getHex();

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
/** What puts an instance out of sight. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** How far (x, z) is beyond a run's riding limit (m; negative on the run). */
function clearOfRun(run: RunData, x: number, z: number): number {
  let best = Infinity;
  for (const p of run.path) best = Math.min(best, Math.hypot(p.x - x, p.z - z) - p.limit);
  return best;
}

/**
 * Where a run's chairlift ends: its top and its bottom station (null with
 * no lift). The top is where the run's scenery has it; otherwise a station
 * stands off the end of the line, turned aside if the line runs on down
 * the run: the nearest place clear of the riding width that the chairs can
 * come down to without crossing it low.
 */
export function liftEnds(
  run: RunData,
  scenery: RunScenery,
): [{ x: number; z: number }, { x: number; z: number }] | null {
  const towers = run.obstacles.filter((o) => o.kind === "tower");
  if (towers.length < 2) return null;
  const first = towers[0]!;
  const last = towers.at(-1)!;
  const length = Math.hypot(last.x - first.x, last.z - first.z);
  const down = { x: (last.x - first.x) / length, z: (last.z - first.z) / length };
  const station = (from: { x: number; z: number }, way: number) => {
    let best = { x: from.x + down.x * way * 110, z: from.z + down.z * way * 110 };
    let least = Infinity;
    for (const bend of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      const dx = (down.x * Math.cos(bend) + down.z * Math.sin(bend)) * way;
      const dz = (down.z * Math.cos(bend) - down.x * Math.sin(bend)) * way;
      for (let d = 40; d <= 260; d += 10) {
        const cost = Math.abs(bend) * 150 + d;
        if (cost >= least || clearOfRun(run, from.x + dx * d, from.z + dz * d) < STATION_ROOM) continue;
        // (Over the last of the span the chairs hang within reach of the snow.)
        let low = true;
        for (let k = 0.45; k <= 1 && low; k += 0.05)
          low = clearOfRun(run, from.x + dx * d * k, from.z + dz * d * k) > 2;
        if (!low) continue;
        least = cost;
        best = { x: from.x + dx * d, z: from.z + dz * d };
      }
    }
    return best;
  };
  const top = scenery.liftTop ? runAt(run, scenery.liftTop.s, scenery.liftTop.offset) : station(first, -1);
  return [top, station(last, 1)];
}

/** A lift station stands at least this far beyond the riding limit (m). */
const STATION_ROOM = 14;
/** `count` chairs of a model, each in a brand's colours (the brands in turn from `from`): its own copy of the geometry, with the tints. */
function liveried(source: THREE.BufferGeometry, count: number, from: number): THREE.InstancedMesh {
  const geometry = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(source.attributes)) geometry.setAttribute(name, a);
  geometry.setIndex(source.index);
  const tints = new Float32Array(count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < count; i++) {
    colour.setHex(brand(from + i));
    tints.set([colour.r, colour.g, colour.b], i * 3);
  }
  geometry.setAttribute("tint", new THREE.InstancedBufferAttribute(tints, 3));
  return new THREE.InstancedMesh(geometry, clothMaterial(), count);
}

/** The heading that faces the run from `side` of it (1: its right). */
const inward = (at: { yaw: number }, side: number) => Math.atan2(side * Math.cos(at.yaw), -side * Math.sin(at.yaw));

/** Chairs hang this far apart along the cable (m), and travel this fast (m/s). */
const CHAIR_GAP = 15;
const CHAIR_SPEED = 2.4;

/** Flat faces as one geometry. */
function mergeFaces(faces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (const f of faces) {
    const base = pos.length / 3;
    pos.push(...f.attributes.position!.array);
    nor.push(...f.attributes.normal!.array);
    uvs.push(...f.attributes.uv!.array);
    for (const i of f.index!.array) index.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}
