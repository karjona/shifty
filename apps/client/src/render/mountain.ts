// The mountain, round any of its runs. The snow is drawn from the sim's own
// heights (a ribbon of vertices along the run, fine where the riding is, and
// a coarse grid for the mountain around it), so the slope you see is the
// slope you ride. The snow shows its shape: a low sun, shade baked into
// hollows, the forest's shade thrown across it, blue dye lines on lips and
// knuckles, old board tracks streaking down the run, and bare rock in its
// beds where the mountain is steep. Around it, built once the scenery's
// models are in (`ready`): the forest (mountain-forest.ts), rocks and rock
// walls (mountain-rocks.ts), the village, the lift, gantries, gates, flags
// and the crowd (mountain-built.ts), blown snow, smoke and birds
// (mountain-life.ts), the land beyond down to the sea (mountain-far.ts),
// red netting, falling snow, powder thrown up by the boards and the tracks
// they carve; and what each run has of its own (runs.ts: a lake, a creek,
// logs).
//
// All of it in the race's conditions (see look.ts): deep powder in winter;
// in fall a thin white run through brown slopes, rocks poking through; in
// spring hard snow up top, slush down the lower run and green meadows
// beside it. The snow on the run is the sim's (`Terrain.snow`).
import * as THREE from "three/webgpu";
import type { Appearance } from "@shifty/rider";
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uv,
  vec2,
  vec3,
  vertexStage,
} from "three/tsl";
import { noise4 } from "./cel/noise.ts";
import { LOOK, cut0 } from "./cel/look.ts";
import { Precipitation } from "./cel/precip.ts";
import { ConditionsLook } from "./look.ts";
import { CarveTrails } from "./trails.ts";
import { mergeStatic } from "./merge.ts";
import { BoarderModel } from "./boarder.ts";
import { CelMaterial, celify } from "./cel/material.ts";
import { type Conditions, homeConditions } from "../game/conditions.ts";
import { PALETTE } from "../game/seasons.ts";
import { Cumulus, skyDome } from "./cel/sky.ts";
import { ParticlePool } from "./spray.ts";
import { creek, lake, lipProps, runAt, runPoint } from "./mountain-props.ts";
import { type RunScenery, runScenery } from "./runs.ts";
import { type Models, loadModels } from "./env/models.ts";
import { waitNow } from "../loading.ts";
import { type Steps, buildNow, buildSliced } from "./slices.ts";
import { Forest, ForestSight, type Tree, forestShade, plantForest } from "./mountain-forest.ts";
import { type Building, Built, buildingAt, buildingPlan, liftEnds } from "./mountain-built.ts";
import { farLandscape, landscape } from "./mountain-far.ts";
import { MountainLife } from "./mountain-life.ts";
import { MOUNTAIN, fadingInk, gustAt, snowShade, windNow } from "./mountain-look.ts";
import { alpineRanges } from "./mountain-ranges.ts";
import { cliffFaces, rockWalls } from "./mountain-walls.ts";
import { SnowGates } from "./snow-gates.ts";
import { ROCK_SHADE, coverPatches, rockMeshes, strata } from "./mountain-rocks.ts";
import type { CameraTuning, Environment, Frame, RiderModel, RiderView } from "./world.ts";

/** What bounds a run on one side (`sim::mountain::EdgeKind`). */
export type EdgeKind = "bank" | "trees" | "netting" | "rock";

export interface RunPoint {
  s: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Half width of the groomed run, its walls, and how far riders can go (on the wider side, the left and the right). */
  half: number;
  wall: number;
  limit: number;
  limitL: number;
  limitR: number;
  /** What bounds the run on its left and its right. */
  edgeL: EdgeKind;
  edgeR: EdgeKind;
}

export interface GateData {
  s: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  half: number;
  limit: number;
  /** Its place among the course's gates (0: the start). */
  gate: number;
}

/** A gate to pass between its poles: its centre (`offset` from the centre line), the run's heading there, half the gap, and its place among the course's gates. */
export interface RunGateData {
  s: number;
  offset: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  half: number;
  gate: number;
}

/** A cliff across the run: its lip at `s` on the centre line, its face `face` m long, from `top` down to `bottom`. */
export interface CliffData {
  s: number;
  face: number;
  x: number;
  z: number;
  yaw: number;
  top: number;
  bottom: number;
  half: number;
}

/** A rock wall along one side of the run (`side`: 1 the right), from `from` to `to`, its face about `height` m over the run's edge. */
export interface RockWallData {
  from: number;
  to: number;
  side: 1 | -1;
  height: number;
}

export interface ObstacleData {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  kind: "pine" | "rock" | "tower";
  /** A rock poking through a thin cover (fall). */
  cover?: boolean;
}

export interface TableData {
  s: number;
  lip: number;
  offset: number;
  /** -1 = the whole run. */
  halfWidth: number;
}

/** A natural lip (`sim::mountain::Feature::Lip`): crest at `lip`. */
export interface LipData {
  s: number;
  lip: number;
  offset: number;
  halfWidth: number;
  height: number;
  kind: "wind" | "log" | "rock";
}

/** A spine down the run (`sim::mountain::Feature::Spine`), from `s` to `end`. */
export interface SpineData {
  s: number;
  end: number;
  offset: number;
  halfWidth: number;
  height: number;
}

/** The run, from `courseJson` (see `sim::mountain`). */
export interface RunData {
  length: number;
  startS: number;
  finishS: number;
  startGate: GateData;
  finish: GateData;
  checkpoints: GateData[];
  gates: RunGateData[];
  cliffs: CliffData[];
  walls: RockWallData[];
  /** The centre line every 4 m. */
  path: RunPoint[];
  obstacles: ObstacleData[];
  tables: TableData[];
  lips: LipData[];
  spines: SpineData[];
}

/** The sim's snow, asked for in bulk (see `sim-wasm`). */
export interface Terrain {
  /** `[x, y, z]` per (row arc length, offset). */
  ribbon(rows: Float32Array, offsets: Float32Array): Float32Array;
  /** `[height, distance from the run]` per grid point, row by row. */
  grid(x0: number, z0: number, step: number, nx: number, nz: number): Float32Array;
  /** Heights at `[x0, z0, x1, z1, ...]`. */
  heights(points: Float32Array): Float32Array;
  /** The snow under each `[x, z]` of `points`, as the sim rides it: `[depth, powder, slush, hard]` per point. */
  snow?(points: Float32Array): Float32Array;
}

/**
 * Close and low behind the rider, 1080-style: the rider fills about half
 * the screen's height, and the view tips down the slope, so the snow
 * rushing past fills the screen to about a third from the top.
 */
const CAMERA: CameraTuning = {
  fov: 52,
  fovSpeed: 6,
  fovAir: 4,
  back: 2.75,
  backPerSpeed: 0.006,
  up: 1.4,
  lookAhead: 6,
  lookUp: -0.55,
  lookFrom: "ground",
  turn: 4.5,
  reverseLooksAhead: false,
  heightOnGround: 14,
  // In the air the camera rises with the rider, but its height lags on
  // the way down: the rider drops in the frame.
  heightRising: 10,
  heightInAir: 5,
  clearance: 0.8,
  floorFollow: 6,
  airFrom: 1.2,
  airSpan: 5,
  airBack: 0.5,
  airUp: 0.3,
  tilt: 0.55,
};

/** The ribbon reaches this far either side of the centre line (less than the tightest turn's radius). */
const RIBBON_HALF = 56;
/** The coarse mountain: grid step, margin around the run, and how far below the true snow it sits. */
const GRID_STEP = 8;
const GRID_MARGIN = 420;
const GRID_SINK = 0.3;
/** Coarse vertices this close to the run hide under the ribbon. */
const GRID_HIDE = RIBBON_HALF - GRID_STEP;
const ROWS_PER_CHUNK = 96;
/** Rows of the ribbon asked of the sim at a time (see `buildSnow`). */
const RIBBON_STRETCH = 64;
/** The fog's range as the conditions' look works it out (m), and how far a clear day sees on the mountain. */
const FOG_NEAR = 45;
const FOG_FAR = 330;
const CLEAR_NEAR = 80;
const CLEAR_FAR = 4000;
/** The chase camera stays this far (m) inside a run's riding limit, and looks for its nearest point this many points either way first. */
const EYE_INSET = 1.5;
const EYE_SEARCH = 12;
/** A line of sight passes this far clear of a rock or a lift tower (m). */
const SIGHT_ROOM = 0.6;
/** The forest is cut back this far either side of the chairlift's line (m). */
const LIFT_SWATHE = 8;
/** No trees stand within this of the middle of the grid (m). */
const START_YARD = 34;
/** Trees are drawn out to this far (m), fog allowing. */
const FOREST_FAR = 1300;
/** Curvature along the run (1/m) sharper than this, at a crest, gets a dye line (lips, knuckles, the cliff). */
const DYE_BREAK = 0.16;
/** How far back up the approach from the crest the dye reaches (m). */
const DYE_WIDTH = 0.6;
/** How far either side (m) the curvature and the local pitch are measured over, and the pitch around it. */
const CURVE_SPAN = 1.5;
const PITCH_SPAN = 9;
/** A snow line below this (m) covers the whole mountain. */
const SNOW_EVERYWHERE = -1000;
/** The groomed snow reaches this far past the riding width (m). */
const RUN_EDGE = 4;

/** Snow shades to a cool violet-blue, as drawn. */
const SNOW_SHADE = [0.6, 0.67, 1.0] as const;
/** Faces off the run steeper than this (the normal's height) are bare rock. */
const ROCK_FROM = 0.72;

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

const flat = (color: number, opts: Partial<THREE.MeshStandardNodeMaterialParameters> = {}) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, flatShading: true, ...opts });

/** Offsets across the ribbon: fine on the run, coarser up the walls and beyond. */
function ribbonOffsets(): Float32Array {
  const side: number[] = [];
  for (let o = 0.8; o <= 20; o += 0.8) side.push(o);
  for (let o = 21.25; o <= 34; o += 1.25) side.push(o);
  for (let o = 36.5; o < RIBBON_HALF; o += 2.5) side.push(o);
  side.push(RIBBON_HALF);
  return Float32Array.from([...side.toReversed().map((o) => -o), 0, ...side]);
}

/** Rows along the run: every metre, every half metre across the tables and wherever the pitch breaks sharply (lips, the cliff). */
function ribbonRows(run: RunData): Float32Array {
  const breaks: number[] = [];
  const p = run.path;
  for (let i = 1; i < p.length - 1; i++) {
    const before = (p[i]!.y - p[i - 1]!.y) / (p[i]!.s - p[i - 1]!.s);
    const after = (p[i + 1]!.y - p[i]!.y) / (p[i + 1]!.s - p[i]!.s);
    if (Math.abs(after - before) > 0.3) breaks.push(p[i]!.s);
  }
  const fine = (s: number) =>
    run.tables.some((t) => s > t.s - 2 && s < t.lip + 12) ||
    run.lips.some((t) => s > t.s - 2 && s < t.lip + 10) ||
    breaks.some((b) => Math.abs(s - b) < 8);
  const rows: number[] = [];
  for (let s = -80; s <= run.length + 60; s += fine(s) ? 0.5 : 1) rows.push(s);
  return Float32Array.from(rows);
}

/** Component `k` (0-2) of `v`. */
const pick = (v: THREE.Node<"vec3">, k: number) => (k === 0 ? v.x : k === 1 ? v.y : v.z);

/**
 * The snow: white in the open, blue-grey in drifts, with grain close up and
 * rock where it's steep. On the run (`ribbon`, with `uv` = arc length and
 * offset): old board tracks streaking down it, corduroy between them, shade
 * baked into faces that rise toward the rider and into hollows (`shade`), so
 * rollers and kickers read even in flat light, and blue dye on lips and
 * knuckles (`dye`).
 * Fine detail fades out where it would be smaller than a pixel.
 */
function snowMaterial(ribbon: boolean): CelMaterial {
  // Steep faces off the run are bare rock.
  const steep = float(ROCK_FROM)
    .sub(normalWorld.y)
    .add(noise4(positionWorld.xz.mul(0.023)).z.mul(0.1))
    .add(noise4(positionWorld.xz.mul(0.19)).w.mul(0.025));
  const rock = ribbon ? cut0(steep).mul(float(1).sub(smoothstep(0.3, 0.6, attribute("run", "float")))) : cut0(steep);
  // How deep the snow lies (0 = bare ground, 1 = covered): on the run it is
  // groomed (patchy at its edges when the cover is thin); off it, down to the
  // snow line, deeper in hollows and thinner on steep faces.
  // (Worked out only where the snow can be off: never in a winter that covers it all.)
  const cover = Fn(() => {
    const covered = float(1).toVar();
    If(LOOK.snowLine.greaterThan(SNOW_EVERYWHERE), () => {
      const p = positionWorld;
      const n = noise4(p.xz.mul(0.013));
      const fine = noise4(p.xz.mul(0.21));
      const above = p.y.sub(LOOK.snowLine).add(n.x.mul(28)).div(22);
      let off: THREE.Node<"float"> = above.add(normalWorld.y.sub(0.86).mul(6)).add(fine.y.mul(0.5));
      if (ribbon) {
        const hollow = attribute("shade", "float").max(0).mul(0.8);
        off = off.add(hollow);
        const run = attribute("run", "float");
        // A thin cover (the sim's depth, m) is patchy at the run's edges, with tufts poking through.
        const thin = clamp(float(0.45).sub(attribute<"vec4">("snow", "vec4").x).div(0.3), 0, 1);
        const groomed = run
          .mul(2.2)
          .sub(1)
          .sub(thin.mul(fine.x.mul(0.6).add(1.2)));
        const tufts = noise4(p.xz.mul(0.9))
          .w.sub(float(1).sub(thin.mul(0.42)))
          .mul(5);
        off = max(off, groomed).sub(max(tufts, 0));
      }
      covered.assign(clamp(cut0(off), 0, 1));
    });
    return covered;
  })();
  const colour = Fn(() => {
    const p = positionWorld;
    const near = smoothstep(90, 20, p.distance(cameraPosition));
    const drift = noise4(p.xz.mul(0.045)).x.mul(0.5).add(0.5);
    const blotch = noise4(p.xz.mul(0.17)).y.mul(0.5).add(0.5);
    let c = mix(vec3(0.74, 0.8, 0.92), vec3(0.9, 0.93, 0.98), drift).mul(blotch.mul(0.1).add(0.9));
    c = c.mul(noise4(p.xz.mul(3.1)).z.mul(0.05).mul(near).add(1));
    if (ribbon) {
      const s = uv().x;
      const o = uv().y;
      // Metres per pixel across the run: lines thinner than that fade out.
      const px = max(fwidth(o), 0.001);
      // Old tracks: wandering lines down the run, in patches.
      const layers = [
        [2.3, 0.9, 0.11, 0.07],
        [3.7, 1.6, 0.07, 0.1],
        [5.3, 2.4, 0.045, 0.13],
      ] as const;
      // How far each track wanders and where its patches lie change over
      // metres, so they are worked out per vertex.
      const [w0, w1, w2] = layers.map(([, amp, freq], k) =>
        sin(s.mul(freq).add(k * 2.1))
          .mul(amp)
          .add(mx_noise_float(vec2(s.mul(0.02), o.mul(0.08).add(k * 7.3))).mul(amp * 1.5)),
      );
      const [p0, p1, p2] = layers.map((_, k) => mx_noise_float(vec2(s.mul(0.012), o.mul(0.04).add(k * 3.7))));
      const wanders = vertexStage(vec3(w0!, w1!, w2!));
      const patches = vertexStage(vec3(p0!, p1!, p2!));
      const lines = layers.map(([spacing, , , width], k) => {
        const wander = pick(wanders, k);
        const u = o.add(wander).div(spacing);
        const d = abs(fract(u).sub(0.5)).mul(spacing);
        // Each track its own depth: some fresh, some nearly filled in.
        const depth = hash(floor(u).add(k * 31))
          .mul(0.7)
          .add(0.3);
        const line = smoothstep(px.add(width), max(float(width).sub(px), 0), d)
          .mul(clamp(float(width).div(px), 0, 1))
          .mul(depth);
        const patch = smoothstep(-0.15, 0.3, pick(patches, k));
        return line.mul(patch);
      });
      const tracked = max(lines[0]!, lines[1]!, lines[2]!);
      c = mix(c, c.mul(vec3(0.74, 0.8, 0.93)), tracked.mul(0.75));
      // Corduroy: fine ridges along the run, on the groomed part only.
      const ridge = sin(o.mul((Math.PI * 2) / 0.32))
        .mul(0.5)
        .add(0.5);
      const groomed = smoothstep(17, 13, abs(o)).mul(clamp(float(1).sub(px.div(0.12)), 0, 1));
      c = c.mul(float(1).sub(ridge.mul(0.07).mul(groomed).mul(float(1).sub(tracked))));
      // The snow the sim has here: slush wetter, greyer and darker, the tracks cut deep into it; hard
      // snow icy and polished; fresh powder bright, filling the old tracks in.
      const snow = attribute<"vec4">("snow", "vec4");
      // (Each worked out only on a run that has that snow somewhere: `LOOK.runSnow`.)
      const sc = c.toVar();
      If(LOOK.runSnow.z.greaterThan(0.001), () => {
        const polish = smoothstep(0.2, 0.7, noise4(vec2(s.mul(0.05), o.mul(0.35))).y)
          .mul(0.5)
          .add(0.5);
        const hard = sc.mul(vec3(0.9, 0.95, 1.04)).mul(polish.mul(0.08).add(0.94));
        // Sheets of blue ice where the snow has been scraped off, long down the run, their edges cut clean.
        const sheet = noise4(vec2(s.mul(0.03), o.mul(0.22))).w.add(noise4(vec2(s.mul(0.11), o.mul(0.6))).x.mul(0.35));
        const iced = mix(hard, vec3(0.66, 0.8, 0.96), cut0(sheet.sub(0.3)).mul(0.6));
        // (A glint along each sheet's upper edge.)
        const glint = cut0(sheet.sub(0.3))
          .sub(cut0(sheet.sub(0.36)))
          .mul(LOOK.shadow);
        sc.assign(mix(sc, mix(iced, vec3(1), glint.mul(0.7)), snow.w));
      });
      // A thin cover is scratchy: grass and earth showing through in specks.
      If(LOOK.runSnow.x.greaterThan(0.001), () => {
        const thinHere = clamp(float(0.45).sub(snow.x).div(0.3), 0, 1);
        // Bare earth in small patches where it is thinnest (grass stands in them: see `grassTufts`).
        const where = noise4(p.xz.mul(2.1)).x.sub(float(0.86).sub(thinHere.mul(0.24)));
        const earth = cut0(where)
          .mul(smoothstep(0.05, 0.3, thinHere))
          .mul(near);
        sc.assign(mix(sc, LOOK.ground2, earth.mul(0.8)));
      });
      If(LOOK.runSnow.y.greaterThan(0.001), () => {
        const dirt = smoothstep(0.35, 0.8, noise4(p.xz.mul(0.6)).z).mul(0.12);
        const slush = sc.mul(vec3(0.74, 0.74, 0.76).sub(dirt)).mul(float(1).sub(tracked.mul(0.2)));
        // Wet hollows where the melt stands: darker and bluer, in soft-cornered patches, and mounds pushed up between them.
        const lie = noise4(vec2(s.mul(0.09), o.mul(0.3))).y.add(noise4(p.xz.mul(0.55)).w.mul(0.3));
        const wet = mix(slush, vec3(0.56, 0.62, 0.7), cut0(lie.sub(0.34)).mul(0.3));
        const heaped = mix(wet, vec3(0.86, 0.87, 0.9), cut0(lie.negate().sub(0.38)).mul(0.3));
        sc.assign(mix(sc, heaped, snow.z));
      });
      c = mix(sc, mix(sc, vec3(0.92, 0.95, 1.0), 0.5), snow.y.mul(float(1).sub(tracked.mul(0.5))).mul(0.6));
      // Snow blown along the run in a wind: pale streaks snaking downwind.
      const blown = c.toVar();
      If(LOOK.wind.length().greaterThan(2.5), () => {
        const { speed, dir } = windNow();
        const along = p.xz.dot(dir).sub(LOOK.time.mul(speed).mul(0.8));
        const across = p.xz.dot(vec2(dir.y.negate(), dir.x));
        const snake = noise4(
          vec2(along.mul(0.035), across.mul(0.4).add(noise4(vec2(along.mul(0.02), across.mul(0.05))).x)),
        );
        const streak = smoothstep(0.25, 0.6, snake.x.add(snake.y.mul(0.4)))
          .mul(clamp(speed.sub(2.5).div(9), 0, 1))
          .mul(gustAt(p.xz).mul(0.7).add(0.3))
          .mul(snow.x.mul(3).clamp(0, 1));
        blown.assign(mix(blown, vec3(0.97, 0.98, 1.0), streak.mul(0.55)));
      });
      c = blown;
      // Faces rising toward the rider and hollows in shade, the rest a touch brighter.
      const shade = attribute("shade", "float");
      c = c.mul(float(1).sub(max(shade, 0).mul(0.38)).add(max(shade.negate(), 0).mul(0.08)));
      // The crest of a lip or a roller catches the sun: a warm rim along it.
      const crest = smoothstep(0.45, 0.95, shade.negate()).mul(LOOK.shadow);
      c = mix(c, vec3(1.0, 0.985, 0.93), crest.mul(0.55));
    }
    // Rain greys the snow.
    c = c.mul(float(1).sub(LOOK.wet.mul(0.1)));
    // Under a closed sky the groomed run stays a touch lighter than the snow round it (cooler and darker).
    const dull = LOOK.overcast.max(float(1).sub(LOOK.shadow)).mul(0.5);
    const beside = ribbon ? float(1).sub(smoothstep(0.2, 0.9, attribute("run", "float"))) : float(1);
    c = c.mul(mix(vec3(1), vec3(0.8, 0.84, 0.92), beside.mul(dull)));
    // Where it's off: the season's grass, in drifts of two tones.
    const ground = mix(LOOK.ground, LOOK.ground2, smoothstep(0.35, 0.65, drift.add(blotch.mul(0.3)).sub(0.15)));
    c = mix(ground, c, cover);
    // Rock in its beds, with snow on the ledges where snow lies.
    const beds = strata(p);
    const face = mix(vec3(0.21, 0.19, 0.18), vec3(0.36, 0.32, 0.29), smoothstep(0.3, 0.62, normalWorld.y)).mul(
      beds.tone,
    );
    const lined = mix(face, face.mul(vec3(0.5, 0.48, 0.55)), beds.line.mul(0.8));
    const ledge = cut0(beds.up.sub(0.58))
      .mul(cut0(hash(beds.bed.mul(5.3)).sub(0.3)))
      .mul(cut0(noise4(p.xz.mul(0.13)).y.add(0.25)))
      .mul(cover);
    c = mix(c, mix(lined, vec3(0.9, 0.93, 0.99), ledge), rock);
    if (ribbon) {
      // Dye lines, painted on top of everything.
      const dye = smoothstep(0.35, 0.65, attribute("dye", "float"));
      c = mix(c, vec3(0.03, 0.17, 0.75), dye.mul(0.85));
    }
    return c;
  })();
  const mat = new CelMaterial({
    colorNode: colour,
    shade: new THREE.Color(...SNOW_SHADE),
    richness: 1.12,
    crease: 0.4,
    // The shade the forest throws across the run.
    cast: ribbon ? float(1).sub(cut0(attribute("tree", "float").sub(0.5))) : undefined,
  });
  mat.shadeNode = mix(snowShade(), vec3(...ROCK_SHADE), rock);
  // (Lines where things stand on the snow are drawn on the snow too: they fade into the fog with it.)
  return fadingInk(mat, 1, 0.4, 0, 1);
}

/** Second difference of heights `a`, `b`, `c`, spaced `h0` then `h1` apart: curvature (1/m), + = a hollow. */
function bend(a: number, b: number, c: number, h0: number, h1: number): number {
  return h0 > 0 && h1 > 0 ? (2 * ((c - b) / h1 - (b - a) / h0)) / (h0 + h1) : 0;
}

/** Red safety netting: a canvas texture with see-through holes. */
function nettingTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = "#e23d2b";
  g.lineWidth = 5;
  for (let i = -64; i < 128; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 64, 64);
    g.stroke();
    g.beginPath();
    g.moveTo(i + 64, 0);
    g.lineTo(i, 64);
    g.stroke();
  }
  // A solid band along the top.
  g.fillStyle = "#e23d2b";
  g.fillRect(0, 0, 64, 7);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Emitter {
  carve: number;
  mist: number;
  grounded: boolean;
  vy: number;
  bailing: boolean;
}

export class Mountain implements Environment {
  readonly group = new THREE.Group();
  readonly camera = CAMERA;
  readonly topSpeed = 32;

  private run: RunData;
  /** The run's point nearest the chase camera last frame (see `keepEye`). */
  private eyeIndex = 0;
  private terrain: Terrain;
  private fog: THREE.Fog | null = null;
  private background = new THREE.Color();
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  /** What the conditions look like (see look.ts). */
  readonly look: ConditionsLook;
  private precipitation!: Precipitation;
  private cumulus!: Cumulus;
  /** True snow heights on the coarse grid (for cheap lookups: particles). */
  private gridHeights = new Float32Array(0);
  private grid = { x0: 0, z0: 0, nx: 0, nz: 0 };
  private probe = new Float32Array(2);
  private powder = new ParticlePool({
    max: 3072,
    gravity: 6,
    drag: 2.2,
    lensFrom: 0.5,
    lensTo: 1.8,
    peak: 0.9,
    fadeIn: 14,
  });
  private mist = new ParticlePool({
    max: 640,
    gravity: 0.6,
    drag: 1.2,
    lensFrom: 0.2,
    lensTo: 1.0,
    peak: 0.32,
    fadeIn: 5,
  });
  private trails = new CarveTrails();
  private forest: Forest | null = null;
  private trees: Tree[] = [];
  /** The forest's lines of sight, made when a camera first asks. */
  private forestSight: ForestSight | null = null;
  private buildings: Building[] = [];
  private built: Built | null = null;
  private gates: SnowGates | null = null;
  private life: MountainLife | null = null;
  /** What stands on the mountain (built once its models are in). */
  private props = new THREE.Group();
  /** Resolves once the scenery is built and in the scene. */
  readonly ready: Promise<void>;
  private scenery: RunScenery;
  /** The most thin cover, slush and hard snow anywhere on the run (see `LOOK.runSnow`). */
  private runSnow = new THREE.Vector3();
  private emitters = new Map<number, Emitter>();
  private random = rng(77);

  /** The season, weather and time of day it is drawn in. */
  readonly conditions: Conditions;

  /** Whether its build has begun, and what tells `ready` it is done. */
  private made = false;
  private madeAll: () => void = () => {};

  /**
   * `conditions`: the race's (a clear winter noon if left out); `course`:
   * which run (`sim::CourseId`), for its scenery; `sliced`: built later, a
   * slice at a time, by whoever made it (see `build`), otherwise at once.
   */
  constructor(run: RunData, terrain: Terrain, conditions?: Conditions, course = 1, sliced = false) {
    // The scenery's models come down while the mountain is built.
    const models = loadModels("snow", waitNow());
    this.conditions = conditions ?? homeConditions("snow");
    this.run = run;
    this.terrain = terrain;
    const top = run.path[0]!.y;
    const bottom = run.path.at(-1)!.y;
    const drop = top - bottom;
    this.look = new ConditionsLook(this.conditions, {
      // Noon's sun stands down the run (+z), and stays ahead of the riders through the day.
      south: [-30, 60],
      swing: 0.55,
      fogNear: FOG_NEAR,
      fogFar: FOG_FAR,
      fogTint: [1.026, 0.91, 0.92],
      snowLine: { summer: top + 600, fall: top - drop * 0.08, winter: bottom - 3000, spring: bottom + drop * 0.6 },
      mountain: true,
    });
    this.scenery = runScenery(course);
    const made = new Promise<void>((resolve) => (this.madeAll = resolve));
    // What stands on it comes once the mountain is built and the models are in, a slice at a time.
    this.ready = Promise.all([models, made]).then(([m]) => buildSliced(this.buildScenery(m)));
    if (!sliced) buildNow(this.build());
  }

  /** Builds it (once), a piece at a time: the mountain round the run, the forest's plan, the run's snow. */
  *build(): Steps {
    if (this.made) return;
    this.made = true;
    const run = this.run;
    const terrain = this.terrain;
    const bottom = run.path.at(-1)!.y;
    const drop = run.path[0]!.y - bottom;
    let cx = 0;
    let cz = 0;
    for (const p of run.path) {
      cx += p.x / run.path.length;
      cz += p.z / run.path.length;
    }
    this.cumulus = new Cumulus(new THREE.Vector3(cx, bottom + drop * 0.5, cz));
    yield* this.cumulus.build();
    this.precipitation = new Precipitation();
    yield;
    yield* this.buildMountainAround();
    this.buildings = buildingPlan(run, this.scenery);
    yield;
    const { x0, z0, nx, nz } = this.grid;
    this.trees = plantForest({
      run,
      scenery: this.scenery,
      heights: (points) => terrain.heights(points),
      around: { x0, z0, width: (nx - 1) * GRID_STEP, depth: (nz - 1) * GRID_STEP },
      open: this.clearings(),
    });
    yield;
    yield* this.buildSnow();
    this.trails.group.userData.noMerge = true;
    this.group.add(this.trails.group, this.powder.sprite, this.mist.sprite, this.precipitation.group);
    this.group.add(skyDome(), this.cumulus.mesh);
    this.madeAll();
  }

  /** What stands on the mountain, once its models are in, a piece at a time. */
  private *buildScenery(models: Models): Steps {
    const run = this.run;
    yield* this.buildForest(models);
    this.buildFences();
    yield;
    this.buildRocks(models);
    yield;
    this.buildProps();
    yield;
    this.built = new Built(
      run,
      this.scenery,
      this.buildings,
      models,
      (x, z) => this.ground(x, z),
      PALETTE[this.conditions.season].accent,
    );
    this.props.add(this.built.group);
    this.gates = new SnowGates(run.gates, (x, z) => this.ground(x, z));
    this.group.add(this.gates.group);
    yield;
    // What is still a plain material takes the cel look, its lines fading into the fog like the rest.
    const plain = new Set<THREE.Mesh>();
    this.props.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardNodeMaterial) plain.add(o);
    });
    celify(this.props);
    yield;
    const lined = new Set<THREE.Material>();
    for (const mesh of plain) {
      const material: unknown = mesh.material;
      if (!(material instanceof CelMaterial) || lined.has(material)) continue;
      lined.add(material);
      fadingInk(material, 1, 0.8, 0, 0.9);
    }
    yield;
    mergeStatic(this.props, { cell: 400 });
    yield;
    // Choughs over the summit, over the middle of the run and over the finish.
    const over = (k: number, up: number, aside: number) => {
      const p = run.path[Math.floor(k * (run.path.length - 1))]!;
      return new THREE.Vector3(p.x + aside, p.y + up, p.z);
    };
    const flocks = [over(0.02, 40, -30), over(0.33, 55, 70), over(0.62, 50, -60), over(0.95, 60, 20)];
    this.life = new MountainLife(this.trees, this.built.chimneys, flocks);
    this.props.add(this.life.group);
    yield;
    const { x0, z0, nx, nz } = this.grid;
    const site = {
      run,
      heights: (points: Float32Array) => this.terrain.heights(points),
      around: { x0, z0, width: (nx - 1) * GRID_STEP, depth: (nz - 1) * GRID_STEP },
      ridgeStart: this.scenery.ridgeStart,
    };
    const land = landscape(site);
    yield;
    this.props.add(farLandscape(site, land));
    yield;
    this.props.add(alpineRanges(site, land));
    this.group.add(this.props);
  }

  get sunOffset(): THREE.Vector3 {
    return this.look.sun;
  }

  light(scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    // (One fog for the mountain: a new one would rebuild every shader that draws in it.)
    this.fog ??= new THREE.Fog(0xc9d4e4, CLEAR_NEAR, CLEAR_FAR);
    scene.fog = this.fog;
    scene.background = this.background;
    hemi.intensity = 1.9;
    sun.intensity = 3.1;
    this.sun = sun;
    this.hemi = hemi;
    this.look.apply(0, 0, this.run.path[0]!.y, null, this.fog, this.background, sun, hemi);
    this.openFog(this.fog);
    LOOK.runSnow.value.copy(this.runSnow);
  }

  /**
   * Opens the fog the conditions set out to the mountain's range: a clear
   * day sees most of the way down the run, and bad weather closes in as it did.
   */
  private openFog(fog: THREE.Fog): void {
    const weather = fog.far / FOG_FAR;
    fog.far = CLEAR_FAR * weather ** 4.1;
    fog.near = fog.near * (CLEAR_NEAR / FOG_NEAR) * weather ** 1.3;
    MOUNTAIN.fogNear.value = fog.near;
    MOUNTAIN.fogFar.value = fog.far;
  }

  /**
   * Keeps the chase camera inside the riding width, short of the edge by
   * `EYE_INSET`: trees lean in over the edge, and netting and rock walls
   * would stand between the camera and its rider.
   */
  keepEye(eye: { x: number; z: number }): void {
    const path = this.run.path;
    // Near where it was last frame: the camera moves a few metres a frame at most.
    let best = Infinity;
    let index = this.eyeIndex;
    const from = Math.max(0, index - EYE_SEARCH);
    const to = Math.min(path.length - 1, index + EYE_SEARCH);
    for (let i = from; i <= to; i++) {
      const p = path[i]!;
      const d = (p.x - eye.x) ** 2 + (p.z - eye.z) ** 2;
      if (d < best) {
        best = d;
        index = i;
      }
    }
    if (index === from || index === to) {
      for (let i = 0; i < path.length; i++) {
        const p = path[i]!;
        const d = (p.x - eye.x) ** 2 + (p.z - eye.z) ** 2;
        if (d < best) {
          best = d;
          index = i;
        }
      }
    }
    this.eyeIndex = index;
    const p = path[index]!;
    const rx = -Math.cos(p.yaw);
    const rz = Math.sin(p.yaw);
    const off = (eye.x - p.x) * rx + (eye.z - p.z) * rz;
    const room = Math.max(0, (off > 0 ? p.limitR : p.limitL) - EYE_INSET);
    const kept = Math.max(-room, Math.min(room, off));
    eye.x += rx * (kept - off);
    eye.z += rz * (kept - off);
  }

  sight(eye: THREE.Vector3, at: THREE.Vector3, frame = 0): boolean {
    this.forestSight ??= new ForestSight(this.trees);
    if (!this.forestSight.clear(eye, at, frame)) return false;
    const dx = at.x - eye.x;
    const dz = at.z - eye.z;
    const flat2 = dx * dx + dz * dz;
    for (const o of this.run.obstacles) {
      // The run's pines are in the forest.
      if (o.kind === "pine" || flat2 < 1e-6) continue;
      const along = Math.max(0, Math.min(1, ((o.x - eye.x) * dx + (o.z - eye.z) * dz) / flat2));
      if (eye.y + (at.y - eye.y) * along > o.y + o.height) continue;
      if (Math.hypot(eye.x + dx * along - o.x, eye.z + dz * along - o.z) < o.radius + SIGHT_ROOM) return false;
    }
    return true;
  }

  ground(x: number, z: number): number {
    this.probe[0] = x;
    this.probe[1] = z;
    return this.terrain.heights(this.probe)[0] ?? 0;
  }

  /** Snow height from the coarse grid: rough, but cheap enough for every particle. */
  private roughGround(x: number, z: number): number {
    const { x0, z0, nx, nz } = this.grid;
    const fx = (x - x0) / GRID_STEP;
    const fz = (z - z0) / GRID_STEP;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i));
    const tz = Math.max(0, Math.min(1, fz - j));
    const h = this.gridHeights;
    const a = h[j * nx + i]!;
    const b = h[j * nx + i + 1]!;
    const c = h[(j + 1) * nx + i]!;
    const d = h[(j + 1) * nx + i + 1]!;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  makeRider(slot: number, appearance: Appearance | null): RiderModel {
    return new BoarderModel(slot, appearance);
  }

  /** The run's snow: a ribbon of the sim's own heights, in chunks (so off-screen ones are culled). */
  private *buildSnow(): Steps {
    const rows = ribbonRows(this.run);
    const offsets = ribbonOffsets();
    const cols = offsets.length;
    // The sim's heights along the run, a stretch at a time.
    const xyz = new Float32Array(rows.length * cols * 3);
    for (let r = 0; r < rows.length; r += RIBBON_STRETCH) {
      xyz.set(this.terrain.ribbon(rows.subarray(r, r + RIBBON_STRETCH), offsets), r * cols * 3);
      yield;
    }
    const n = rows.length;
    // Normals from neighbours across the whole ribbon, so chunk seams don't show.
    const normals = new Float32Array(n * cols * 3);
    const at = (r: number, c: number, k: number) => xyz[(r * cols + c) * 3 + k]!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let r = 0; r < n; r++) {
      const r0 = Math.max(0, r - 1);
      const r1 = Math.min(n - 1, r + 1);
      for (let c = 0; c < cols; c++) {
        const c0 = Math.max(0, c - 1);
        const c1 = Math.min(cols - 1, c + 1);
        a.set(at(r1, c, 0) - at(r0, c, 0), at(r1, c, 1) - at(r0, c, 1), at(r1, c, 2) - at(r0, c, 2));
        b.set(at(r, c1, 0) - at(r, c0, 0), at(r, c1, 1) - at(r, c0, 1), at(r, c1, 2) - at(r, c0, 2));
        // Along the run x toward its right: up.
        const nrm = a.cross(b).normalize();
        if (nrm.y < 0) nrm.negate();
        normals.set([nrm.x, nrm.y, nrm.z], (r * cols + c) * 3);
      }
      if (r % 64 === 63) yield;
    }
    yield;
    const { shade, dye } = this.shapeOf(xyz, rows, offsets);
    yield;
    const snowRows = this.snowAlong(xyz, rows.length, cols);
    yield;
    this.buildTufts(xyz, rows, offsets, snowRows);
    yield;
    const treeShade = yield* forestShade(this.trees, this.look.sun, xyz);
    yield;
    const mat = snowMaterial(true);
    for (let start = 0; start < n - 1; start += ROWS_PER_CHUNK) {
      const end = Math.min(n - 1, start + ROWS_PER_CHUNK);
      const count = (end - start + 1) * cols;
      const pos = new Float32Array(count * 3);
      const nor = new Float32Array(count * 3);
      const uvs = new Float32Array(count * 2);
      const shaded = shade.slice(start * cols, (end + 1) * cols);
      const dyed = dye.slice(start * cols, (end + 1) * cols);
      // How far inside the riding width (1 = on the run, 0 = a few metres past its edge).
      const onRun = new Float32Array(count);
      const snowType = new Float32Array(count * 4);
      for (let r = start; r <= end; r++) {
        const limit = this.limitAt(rows[r]!);
        for (let c = 0; c < cols; c++) {
          const src = (r * cols + c) * 3;
          const dst = ((r - start) * cols + c) * 3;
          pos[dst] = xyz[src]!;
          pos[dst + 1] = xyz[src + 1]!;
          pos[dst + 2] = xyz[src + 2]!;
          // Beyond the walls the ribbon eases down to meet the coarse mountain.
          const edge = Math.abs(offsets[c]!) > RIBBON_HALF - 10 ? (Math.abs(offsets[c]!) - (RIBBON_HALF - 10)) / 10 : 0;
          pos[dst + 1]! -= GRID_SINK * edge;
          nor.set(normals.subarray(src, src + 3), dst);
          uvs[((r - start) * cols + c) * 2] = rows[r]!;
          uvs[((r - start) * cols + c) * 2 + 1] = offsets[c]!;
          snowType.set(snowRows.subarray(r * 4, r * 4 + 4), ((r - start) * cols + c) * 4);
          onRun[(r - start) * cols + c] = Math.max(
            0,
            Math.min(1, (limit + RUN_EDGE - Math.abs(offsets[c]!)) / RUN_EDGE),
          );
        }
      }
      const idx: number[] = [];
      for (let r = 0; r < end - start; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const i0 = r * cols + c;
          const i1 = i0 + 1;
          const i2 = i0 + cols;
          const i3 = i2 + 1;
          // Columns run to the right of travel (mirrored against world X),
          // so this winding faces up.
          idx.push(i0, i1, i2, i1, i3, i2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute("shade", new THREE.BufferAttribute(shaded, 1));
      geo.setAttribute("dye", new THREE.BufferAttribute(dyed, 1));
      geo.setAttribute("run", new THREE.BufferAttribute(onRun, 1));
      geo.setAttribute("snow", new THREE.BufferAttribute(snowType, 4));
      geo.setAttribute("tree", new THREE.BufferAttribute(treeShade.slice(start * cols, (end + 1) * cols), 1));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      // Each chunk is a batch of its own (so the ones out of view are culled).
      mesh.userData.noMerge = true;
      this.group.add(mesh);
      yield;
    }
  }

  /**
   * Grass standing out of the snow: on the run where the cover is thin
   * (`snowRows`, as `snowAlong` gives it), and thicker beside it wherever
   * the ground is below the season's snow line. Riders ride through it.
   */
  private buildTufts(xyz: Float32Array, rows: Float32Array, offsets: Float32Array, snowRows: Float32Array): void {
    const cols = offsets.length;
    const rand = rng(606);
    // (Its own look's: built a slice at a time, another look may be on show meanwhile.)
    const line = this.look.snowLine;
    const spots: number[] = [];
    for (let r = 2; r < rows.length - 2; r += 1) {
      const limit = this.limitAt(rows[r]!);
      const thin = Math.max(0, Math.min(1, (0.45 - snowRows[r * 4]!) / 0.3));
      for (let k = 0; k < 4; k++) {
        const c = Math.floor(rand() * cols);
        const off = Math.abs(offsets[c]!);
        const at = (r * cols + c) * 3;
        const y = xyz[at + 1]!;
        const beside = off > limit + 1.5 && off < limit + 26;
        // Meadow beside the run below the snow line; on it, only through a thin cover.
        const chance = beside ? (y < line - 12 ? 0.8 : 0) : off < limit + 1 ? thin * 0.6 : 0;
        if (rand() < chance)
          spots.push(xyz[at]! + (rand() - 0.5) * 0.8, y, xyz[at + 2]! + (rand() - 0.5) * 0.8, beside ? 1.3 : 0.75);
      }
    }
    const count = spots.length / 4;
    if (count === 0) return;
    // A tuft: nine blades fanned out from one foot.
    const pos: number[] = [];
    const tip: number[] = [];
    for (let b = 0; b < 9; b++) {
      const a = (b / 9) * Math.PI * 2 + rand();
      const lean = 0.06 + rand() * 0.14;
      const h = 0.2 + rand() * 0.16;
      const w = 0.022;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      pos.push(-cz * w, 0, cx * w, cz * w, 0, -cx * w, cx * lean, h, cz * lean);
      tip.push(0, 0, 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("tip", new THREE.Float32BufferAttribute(tip, 1));
    geo.computeVertexNormals();
    const mat = new CelMaterial({
      // Dry at the tip, the season's ground colour at the foot.
      colorNode: mix(LOOK.ground2.mul(0.8), mix(LOOK.ground, vec3(0.7, 0.62, 0.34), 0.45), attribute("tip", "float")),
      side: THREE.DoubleSide,
      silhouette: 0,
      crease: 0,
      darkness: 0,
    });
    // (Lit as the ground they stand on: every blade's normal is up.)
    mat.normalNode = vec3(0, 1, 0).transformDirection(cameraViewMatrix);
    mat.positionNode = Fn(() => {
      const p = positionLocal;
      const { speed, dir } = windNow();
      const sway = attribute("tip", "float")
        .mul(speed.mul(0.006).add(0.012))
        .mul(sin(LOOK.time.mul(3.1).add(p.x.mul(2.1)).add(p.z.mul(1.7))).add(gustAt(p.xz).mul(1.5)));
      return p.add(vec3(dir.x.mul(sway), 0, dir.y.mul(sway)));
    })();
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const s = spots[i * 4 + 3]! * (0.8 + rand() * 0.6);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
      const [x = 0, y = 0, z = 0] = spots.slice(i * 4, i * 4 + 3);
      m.compose(new THREE.Vector3(x, y - 0.02, z), q, new THREE.Vector3(s, s, s));
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    mesh.userData.noMerge = true;
    this.group.add(mesh);
  }

  /**
   * The snow the sim has on the run, row by row (it changes down the run,
   * not across it): `[depth, powder, slush, hard]` per row of the ribbon,
   * from its centre. Without the sim's snow, a deep, packed cover.
   */
  private snowAlong(xyz: Float32Array, rows: number, cols: number): Float32Array {
    const middle = (cols - 1) / 2;
    const points = new Float32Array(rows * 2);
    for (let r = 0; r < rows; r++) {
      points[r * 2] = xyz[(r * cols + middle) * 3]!;
      points[r * 2 + 1] = xyz[(r * cols + middle) * 3 + 2]!;
    }
    let snow = this.terrain.snow?.(points);
    if (!snow || snow.length < rows * 4) {
      snow = new Float32Array(rows * 4);
      for (let r = 0; r < rows; r++) snow[r * 4] = 1;
    }
    for (let r = 0; r < rows; r++) {
      const thin = Math.max(0, Math.min(1, (0.45 - snow[r * 4]!) / 0.3));
      this.runSnow.set(
        Math.max(this.runSnow.x, thin),
        Math.max(this.runSnow.y, snow[r * 4 + 2]!),
        Math.max(this.runSnow.z, snow[r * 4 + 3]!),
      );
    }
    return snow;
  }

  /**
   * The snow's shape, per ribbon vertex: `shade` (+1 a face rising steeply
   * toward a rider coming down, or a deep hollow; -1 a face falling away or
   * a sharp crest), from the local pitch against the pitch around it and
   * the curvature, and `dye` (1 on the sharpest crest of a lip, a knuckle or
   * the cliff edge, inside the riding width).
   */
  private shapeOf(
    xyz: Float32Array,
    rows: Float32Array,
    offsets: Float32Array,
  ): { shade: Float32Array; dye: Float32Array } {
    const n = rows.length;
    const cols = offsets.length;
    const y = (r: number, c: number) => xyz[(r * cols + c) * 3 + 1]!;
    // Rows `span` metres either side of each row.
    const around = (span: number) => {
      const back = new Int32Array(n);
      const ahead = new Int32Array(n);
      for (let r = 0, b = 0, a = 0; r < n; r++) {
        while (b + 1 < r && rows[b + 1]! <= rows[r]! - span) b++;
        a = Math.max(a, r);
        while (a < n - 1 && rows[a]! < rows[r]! + span) a++;
        back[r] = Math.min(b, r);
        ahead[r] = a;
      }
      return { back, ahead };
    };
    const near = around(CURVE_SPAN);
    const wide = around(PITCH_SPAN);
    const pitch = (r0: number, r1: number, c: number) =>
      r1 > r0 ? (y(r1, c) - y(r0, c)) / (rows[r1]! - rows[r0]!) : 0;
    const along = new Float32Array(n * cols);
    const shade = new Float32Array(n * cols);
    for (let r = 0; r < n; r++) {
      const r0 = near.back[r]!;
      const r1 = near.ahead[r]!;
      for (let c = 0; c < cols; c++) {
        const k = bend(y(r0, c), y(r, c), y(r1, c), rows[r]! - rows[r0]!, rows[r1]! - rows[r]!);
        const c0 = Math.max(0, c - 2);
        const c1 = Math.min(cols - 1, c + 2);
        const across = bend(y(r, c0), y(r, c), y(r, c1), offsets[c]! - offsets[c0]!, offsets[c1]! - offsets[c]!);
        const facing = pitch(r0, r1, c) - pitch(wide.back[r]!, wide.ahead[r]!, c);
        along[r * cols + c] = k;
        shade[r * cols + c] = Math.max(-1, Math.min(1, 3.5 * facing + 6 * k + 3 * across));
      }
    }
    const dye = new Float32Array(n * cols);
    for (let r = 2; r < n - 2; r++) {
      const limit = this.limitAt(rows[r]!);
      for (let c = 0; c < cols; c++) {
        if (Math.abs(offsets[c]!) > limit) continue;
        const k = along[r * cols + c]!;
        if (k > -DYE_BREAK) continue;
        let sharpest = true;
        for (const d of [-2, -1, 1, 2]) if (along[(r + d) * cols + c]! < k) sharpest = false;
        if (!sharpest) continue;
        // The line runs from the crest back up the approach, where riders see it.
        for (let b = r; b >= 0 && rows[r]! - rows[b]! <= DYE_WIDTH; b--) dye[b * cols + c] = 1;
      }
    }
    return { shade, dye };
  }

  /** How far from the centre line riders can go, at arc length `s`. */
  private limitAt(s: number): number {
    const path = this.run.path;
    const i = Math.round((s - path[0]!.s) / (path[1]!.s - path[0]!.s));
    return path[Math.max(0, Math.min(path.length - 1, i))]!.limit;
  }

  /** The mountain beyond the ribbon: a coarse grid of the sim's heights, sunk a little (and well under the ribbon). */
  private *buildMountainAround(): Steps {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.run.path) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const x0 = Math.floor((minX - GRID_MARGIN) / GRID_STEP) * GRID_STEP;
    const z0 = Math.floor((minZ - GRID_MARGIN) / GRID_STEP) * GRID_STEP;
    const nx = Math.ceil((maxX + GRID_MARGIN - x0) / GRID_STEP) + 1;
    const nz = Math.ceil((maxZ + GRID_MARGIN - z0) / GRID_STEP) + 1;
    const data = this.terrain.grid(x0, z0, GRID_STEP, nx, nz);
    this.grid = { x0, z0, nx, nz };
    this.gridHeights = new Float32Array(nx * nz);
    for (let i = 0; i < nx * nz; i++) this.gridHeights[i] = data[i * 2]!;
    yield;
    const mat = snowMaterial(false);
    const TILE = 64;
    for (let tz = 0; tz < nz - 1; tz += TILE) {
      for (let tx = 0; tx < nx - 1; tx += TILE) {
        const ex = Math.min(nx - 1, tx + TILE);
        const ez = Math.min(nz - 1, tz + TILE);
        const w = ex - tx + 1;
        const pos: number[] = [];
        const idx: number[] = [];
        let any = false;
        for (let j = tz; j <= ez; j++) {
          for (let i = tx; i <= ex; i++) {
            const k = j * nx + i;
            const dist = data[k * 2 + 1]!;
            const sink = dist < GRID_HIDE ? 6 : GRID_SINK;
            pos.push(x0 + i * GRID_STEP, data[k * 2]! - sink, z0 + j * GRID_STEP);
            if (dist >= GRID_HIDE) any = true;
          }
        }
        if (!any) continue;
        for (let j = 0; j < ez - tz; j++) {
          for (let i = 0; i < ex - tx; i++) {
            const a = j * w + i;
            idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.userData.noMerge = true;
        this.group.add(mesh);
        yield;
      }
    }
  }

  /** The forest, in its batches. */
  private *buildForest(models: Models): Steps {
    const forest = new Forest(this.trees);
    yield* forest.build(models);
    this.forest = forest;
    this.props.add(forest.group);
  }

  /** Whether a point is in open ground: round each building, beside the finish area, and from the run's edge across its lake. */
  private clearings(): (x: number, z: number) => boolean {
    const yards = this.buildings.map((b) => ({ ...buildingAt(this.run, b), r: b.yard * b.scale }));
    const path = this.run.path;
    const finish = this.run.finishS;
    // Under the chairlift: a swathe cut through the forest along its line, from station to station.
    const towers = this.run.obstacles.filter((o) => o.kind === "tower");
    const ends = liftEnds(this.run, this.scenery);
    const line: { x: number; z: number }[] = ends ? [ends[0], ...towers, ends[1]] : [];
    for (const end of ends ?? []) yards.push({ x: end.x, z: end.z, turn: 0, r: 12 });
    // Round the grid, where the intro's camera circles the riders.
    const grid = runPoint(this.run, this.run.startS - 8);
    yards.push({ x: grid.x, z: grid.z, turn: 0, r: START_YARD });
    const built = (x: number, z: number) => {
      for (const y of yards) if ((x - y.x) ** 2 + (z - y.z) ** 2 < y.r * y.r) return true;
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i]!;
        const b = line[i + 1]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
        if ((x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2 < LIFT_SWATHE * LIFT_SWATHE) return true;
      }
      // The crowd's side of the fences, from the last pitch to the end of the outrun.
      for (let i = path.length - 1; i >= 0 && path[i]!.s > finish - 72; i--) {
        const p = path[i]!;
        if ((x - p.x) ** 2 + (z - p.z) ** 2 < (p.limit + 12) ** 2) return true;
      }
      return false;
    };
    const spot = this.scenery.lake;
    if (!spot) return built;
    const side = Math.sign(spot.offset);
    const near = runPoint(this.run, spot.s).limit + 3;
    const far = Math.abs(spot.offset) + spot.across + 10;
    const c = runAt(this.run, spot.s, (side * (near + far)) / 2);
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    const along = spot.along * 1.35;
    const across = (far - near) / 2;
    return (x, z) => {
      const u = (x - c.x) * fx + (z - c.z) * fz;
      const v = (x - c.x) * -fz + (z - c.z) * fx;
      return (u / along) ** 2 + (v / across) ** 2 < 1 || built(x, z);
    };
  }

  /** Red netting along the run's edges wherever the sim's edge is netting. */
  private buildFences(): void {
    const tex = nettingTexture();
    const mat = fadingInk(
      new THREE.MeshBasicNodeMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        fog: true,
      }),
      0.6,
      0,
      0,
      0.7,
    );
    const posts: THREE.Matrix4[] = [];
    for (const side of [-1, 1]) {
      const pos: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      const pts = new Float32Array(this.run.path.length * 2);
      const tops: [number, number][] = [];
      this.run.path.forEach((p, i) => {
        // Where the sim's netting stops riders.
        const o = ((side > 0 ? p.limitR : p.limitL) + 0.15) * side;
        const x = p.x - Math.cos(p.yaw) * o;
        const z = p.z + Math.sin(p.yaw) * o;
        pts.set([x, z], i * 2);
        tops.push([x, z]);
      });
      const ys = this.terrain.heights(pts);
      let u = 0;
      let open = false;
      this.run.path.forEach((p, i) => {
        // (No netting down a cliff's face.)
        const dropping = this.run.cliffs.some((c) => p.s > c.s - 3 && p.s < c.s + c.face + 6);
        const fenced = (side > 0 ? p.edgeR : p.edgeL) === "netting" && !dropping;
        const [x, z] = tops[i]!;
        const y = ys[i]!;
        if (!fenced) {
          open = false;
          return;
        }
        const base = pos.length / 3;
        pos.push(x, y - 0.1, z, x, y + 1.15, z);
        uvs.push(u, 0, u, 1);
        if (open) idx.push(base - 2, base, base - 1, base - 1, base, base + 1);
        open = true;
        u += 4 / 1.2;
        posts.push(new THREE.Matrix4().makeTranslation(x, y + 0.55, z));
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      this.props.add(new THREE.Mesh(geo, mat));
    }
    const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 1.3, 0.06), flat(0x2a2a2a), posts.length);
    posts.forEach((m, i) => postMesh.setMatrixAt(i, m));
    this.props.add(postMesh);
  }

  /** The run's rocks: the sim's own, the crags of its scenery and the faces under its rock lips. */
  private buildRocks(models: Models): void {
    const heights = (points: Float32Array) => this.terrain.heights(points);
    for (const mesh of rockMeshes(this.run, this.scenery, models, heights)) this.props.add(mesh);
    const walls = [
      ...this.scenery.walls,
      ...this.run.walls.map((w) => ({ from: w.from, to: w.to, side: w.side, height: Math.max(3, w.height), out: 0 })),
    ];
    for (const mesh of rockWalls(this.run, walls, heights)) this.props.add(mesh);
    for (const mesh of cliffFaces(this.run, this.run.cliffs, heights)) this.props.add(mesh);
    const patches = coverPatches(this.run, (x, z) => this.ground(x, z));
    if (patches) this.props.add(patches);
  }

  /** What only some runs have: rock outcrops, a frozen lake, a creek, and logs and rocks under their lips. */
  private buildProps(): void {
    const heights = (points: Float32Array) => this.terrain.heights(points);
    const ground = (x: number, z: number) => this.ground(x, z);
    const sc = this.scenery;
    if (sc.lake) this.props.add(lake(this.run, sc.lake, heights));
    if (sc.creek) this.props.add(creek(this.run, sc.creek, heights));
    const logs = this.run.lips.filter((lip) => lip.kind === "log");
    for (const o of lipProps(this.run, logs, ground)) this.props.add(o);
  }

  update(f: Frame): void {
    const ground = (x: number, z: number) => this.roughGround(x, z);
    if (this.fog) {
      this.look.apply(f.turn, f.t, f.eye.y, f.weather, this.fog, this.background, this.sun, this.hemi);
      this.openFog(this.fog);
      this.forest?.update(f.eye, Math.min(this.fog.far + 40, FOREST_FAR));
    }
    LOOK.runSnow.value.copy(this.runSnow);
    this.cumulus.update(this.look.cover, this.look.tower);
    this.precipitation.update(this.look.rain, this.look.snow);
    MOUNTAIN.snowing.value = this.look.snow;
    this.built?.update(f.t);
    this.gates?.update(f.t, f.dt, f.riders, f.nextBuoy);
    const snowy = Math.min(1, Math.max(0, (f.eye.y - LOOK.snowLine.value + 30) / 40)) * LOOK.snowCover.value;
    this.life?.update(f.eye, f.t, f.dt, snowy, this.look.snow);
    for (const r of f.riders) this.emit(r, f.models.get(r.slot), f.dt);
    this.trails.update(f.riders, f.t);
    this.powder.update(ground, f.dt);
    this.mist.update(() => -1e6, f.dt);
  }

  /** Powder off one rider's board: a spray off the tail when carving or braking, a burst on landing and falling. */
  private emit(r: RiderView, model: RiderModel | undefined, dt: number): void {
    let e = this.emitters.get(r.slot);
    if (!e) {
      e = { carve: 0, mist: 0, grounded: r.grounded, vy: r.vy, bailing: r.bailing };
      this.emitters.set(r.slot, e);
    }
    const landed = r.grounded && !e.grounded;
    const fell = r.bailing && !e.bailing;
    const impact = landed ? Math.min(1, Math.max(0, -e.vy / 12)) : 0;
    e.grounded = r.grounded;
    e.vy = r.vy;
    e.bailing = r.bailing;
    if (!model || !r.grounded) return;
    const fwd = { x: Math.sin(r.yaw), z: Math.cos(r.yaw) };
    const right = { x: -fwd.z, z: fwd.x };
    const speed = r.speed;
    const carve = Math.min(1, (Math.abs(r.steer) * speed) / 18);
    const brake = Math.max(0, -r.lean) * Math.min(1, speed / 6);
    const rate = (carve * 0.6 + brake + (speed > 6 ? 0.08 : 0)) * 260 + impact * 900 + (fell ? 700 : 0);
    e.carve += rate * dt;
    // The edge on the outside of the turn throws the spray.
    const out = r.steer >= 0 ? 1 : -1;
    const rand = this.random;
    while (e.carve >= 1) {
      e.carve -= 1;
      const back = -0.6 + rand() * 0.5;
      const x = r.x + fwd.x * back + right.x * out * 0.15;
      const z = r.z + fwd.z * back + right.z * out * 0.15;
      const throwSide = (1.2 + rand() * 2.5) * (carve + brake) * -out;
      this.powder.spawn(
        x,
        r.y + 0.05,
        z,
        r.vx * 0.55 + right.x * throwSide + (rand() - 0.5),
        1.2 + rand() * 2.4 + impact * 3,
        r.vz * 0.55 + right.z * throwSide + (rand() - 0.5),
        0.5 + rand() * 0.5,
        0.06 + rand() * 0.06,
        0.18 + rand() * 0.2,
      );
    }
    e.mist += (rate * 0.12 + speed * 0.4) * dt;
    while (e.mist >= 1) {
      e.mist -= 1;
      this.mist.spawn(
        r.x - fwd.x * 0.8 + (rand() - 0.5),
        r.y + 0.3,
        r.z - fwd.z * 0.8 + (rand() - 0.5),
        r.vx * 0.3,
        0.4 + rand() * 0.6,
        r.vz * 0.3,
        1.2 + rand() * 0.8,
        0.6,
        2.4 + rand() * 1.6,
      );
    }
  }
}
