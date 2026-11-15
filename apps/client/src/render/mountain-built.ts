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
  float,
  floor,
  hash,
  mix,
  normalLocal,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uv,
  vec3,
} from "three/tsl";
import { LOOK, cut0 } from "./cel/look.ts";
import { CelMaterial, inkId } from "./cel/material.ts";
import type { Models } from "./env/models.ts";
import { SCENERY_SNOW, fadingInk, gustAt, snowLoad, windNow } from "./mountain-look.ts";
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
    scale: lodge.size > 1 ? 1 : 0.8,
    yard: 15,
  });
  if (scenery.village) {
    const side = (model: string, s: number, out: number, right: boolean, scale = 1): Building => ({
      model,
      s,
      offset: (runPoint(run, s).limit + out) * (right ? 1 : -1),
      faces: "run",
      scale,
      yard: model === "hotel" ? 15 : 10,
    });
    plan.push(
      side("chalet_a", finish - 62, 19, true),
      side("hotel", finish + 22, 24, true),
      side("inn", finish + 78, 19, true),
      side("chalet_c", finish - 20, 44, true, 1.1),
      side("chalet_b", finish + 60, 46, true),
      side("chalet_b", finish - 48, 18, false),
      side("church", finish + 30, 27, false),
      side("chalet_a", finish + 84, 17, false),
      side("inn", finish - 2, 46, false),
      side("chalet_c", finish + 64, 44, false),
      // Across the end of the outrun, looking up the run.
      { model: "chalet_c", s: end + 62, offset: -27, faces: "up", scale: 1.1, yard: 10 },
      { model: "inn", s: end + 70, offset: 2, faces: "up", scale: 1.1, yard: 12 },
      { model: "chalet_a", s: end + 60, offset: 30, faces: "up", scale: 1, yard: 10 },
    );
  } else {
    // By the lodge: a couple of chalets up the bank.
    plan.push(
      { model: "chalet_a", s: lodge.s - 44, offset: (limit + 34) * lodge.side, faces: "run", scale: 1, yard: 10 },
      { model: "chalet_c", s: lodge.s + 46, offset: (limit + 30) * lodge.side, faces: "run", scale: 1, yard: 10 },
      { model: "chalet_b", s: end + 66, offset: 8, faces: "up", scale: 1, yard: 10 },
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
      return mix(painted, vec3(...SCENERY_SNOW), masks.y);
    })(),
    shade: new THREE.Color(0.6, 0.6, 0.86),
    richness: 1.15,
    id: inkId("built"),
  });
  fadingInk(m, 1, 0.6, inkId("built"), 0.85);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    return p.sub(
      vec3(
        0,
        masks.x
          .mul(masks.y)
          .mul(float(1).sub(snowLoad(p)))
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
      return mix(painted, vec3(...SCENERY_SNOW), masks.y);
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
          .mul(float(1).sub(snowLoad(p)))
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
    return p.add(vec3(0, bounce.add(pump), 0));
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

  constructor(
    run: RunData,
    scenery: RunScenery,
    plan: Building[],
    models: Models,
    ground: (x: number, z: number) => number,
  ) {
    this.run = run;
    this.models = models;
    this.ground = ground;
    for (const b of plan) this.building(b);
    this.lift(scenery);
    this.gantry(run.startGate, bandTexture("23.4° SHIFTY · COSTA NEVADA", "#1f3b6e", "#ffffff", false), 12);
    this.gantry(run.finish, bandTexture("FINISH", "#f4f4f0", "#111111", true), 18);
    this.gates();
    this.finishArea(scenery);
    this.instances(this.tinted, clothMaterial(), true);
    this.instances(this.crowd, crowdMaterial(), true);
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
      model: r < 0.45 ? "spectator_a" : r < 0.75 ? "spectator_c" : "spectator_b",
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
        mesh.setMatrixAt(i, m.compose(at.set(t.x, t.y, t.z), q, size.setScalar(t.scale)));
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
    const topAt = scenery.liftTop
      ? runAt(this.run, scenery.liftTop.s, scenery.liftTop.offset)
      : { x: first.x - down.x * 110, z: first.z - down.z * 110 };
    const bottomAt = { x: last.x + down.x * 110, z: last.z + down.z * 110 };
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
    const wire = new THREE.LineBasicNodeMaterial({ color: 0x30343a });
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
    const mesh = new THREE.InstancedMesh(empty, builtMaterial(), each * 2);
    const riders = new THREE.InstancedMesh(full, builtMaterial(), each);
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
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
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
        const p = a.clone().lerp(b, f);
        const yaw = Math.atan2(b.x - a.x, b.z - a.z) + (upward ? Math.PI : 0);
        q.setFromAxisAngle(up, yaw);
        m.compose(p, q, one);
        // Two chairs in three going up have riders on.
        if (upward && k % 3 !== 2) c.riders.setMatrixAt(full++, m);
        else c.mesh.setMatrixAt(empty++, m);
      }
    }
    for (let i = full; i < c.riders.count; i++) c.riders.setMatrixAt(i, hidden);
    for (let i = empty; i < c.mesh.count; i++) c.mesh.setMatrixAt(i, hidden);
    c.mesh.instanceMatrix.needsUpdate = true;
    c.riders.instanceMatrix.needsUpdate = true;
  }

  /** A gantry across the run at a gate: a leg either side, a lattice beam, and a banner hung from it. */
  private gantry(g: GateData, banner: THREE.Texture, wide: number): void {
    const half = g.limit + 1.6;
    const rx = Math.cos(g.yaw);
    const rz = -Math.sin(g.yaw);
    const feet = [-1, 1].map((side) => {
      const x = g.x + rx * half * side;
      const z = g.z + rz * half * side;
      return { x, z, y: this.ground(x, z) };
    });
    const top = Math.max(feet[0]!.y, feet[1]!.y, g.y) + 6.3;
    for (const f of feet) this.place("gantry_leg", f.x, f.y, f.z, g.yaw, (top - f.y + 0.3) / 6.6);
    const bay = this.models.get("truss_bay");
    if (bay) {
      const count = Math.ceil(half * 2);
      const beam = new THREE.InstancedMesh(bay, builtMaterial(), count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.yaw);
      const one = new THREE.Vector3((half * 2) / count, 1, 1);
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
    const printed = new CelMaterial({ map: banner, crease: 0, silhouette: 0.6 });
    for (const back of [0, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(wide, wide / 8), printed);
      const out = back ? 0.03 : -0.03;
      sign.position.set(g.x + Math.sin(g.yaw) * out, top - 0.4 - wide / 16, g.z + Math.cos(g.yaw) * out);
      sign.rotation.y = g.yaw + (back ? 0 : Math.PI);
      sign.castShadow = back === 0;
      sign.userData.noMerge = true;
      this.group.add(sign);
    }
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
        // The crowd behind the board, two deep in places.
        for (let row = 0; row < 2; row++) {
          if (this.random() < (scenery.village ? 0.42 : 0.6) + row * 0.25) continue;
          const at = runAt(run, s + (this.random() - 0.5) * 2.4, offset + side * (1.1 + row * 0.9));
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
  }
}

/** A brand's colour, by its place in `BRANDS` (they come round again). */
const brand = (k: number) => new THREE.Color(BRANDS[k % BRANDS.length]![1]).getHex();

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
