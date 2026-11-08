// Summer: the bay. Sky and sun, the sea (the sim's swells plus GPU chop,
// ripples, wakes, foam and reflections, or the swells alone), the course
// on it, the coast behind, and the spray the jetskis throw.
import * as THREE from "three/webgpu";
import type { Appearance } from "@shifty/rider";
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
import { type Conditions, homeConditions } from "../game/conditions.ts";
import { mergeStatic } from "./merge.ts";
import { celify, inkNode, inkOnlyInPass } from "./cel/material.ts";
import { LOOK } from "./cel/look.ts";
import { Cumulus, skyDome } from "./cel/sky.ts";
import { Precipitation } from "./cel/precip.ts";
import { type CircuitLook, ConditionsLook } from "./look.ts";
import { Gulls } from "./cel/gulls.ts";
import { CourseView, type CourseData } from "./course.ts";
import { JetskiModel } from "./rider.ts";
import { buildScenery } from "./scenery.ts";
import { Spray } from "./spray.ts";
import { SeaWater, type WakeSource } from "./water.ts";
import { MAX_WAVES, WATER_SNAP, WAVE_FIELDS, WaveUniforms, waterGrid, waveHeight } from "./waves.ts";
import type { CameraTuning, Environment, Frame, RiderModel } from "./world.ts";

/** The water grid follows the camera and reaches across the whole bay. */
const WATER_SIZE = 1400;
const WATER_SEGMENTS = 300;

/** Chase camera on the water, in metres from the bottom of the hull. */
const CAMERA: CameraTuning = {
  fov: 55,
  fovSpeed: 6,
  fovAir: 4,
  back: 4.3,
  backPerSpeed: 0.02,
  up: 2.35,
  lookAhead: 8,
  lookUp: 0.75,
  lookFrom: "rider",
  turn: 5,
  reverseLooksAhead: true,
  heightOnGround: 7,
  heightRising: 6,
  heightInAir: 6,
  clearance: 0.9,
  airFrom: 0.4,
  airSpan: 2,
  airBack: 2.5,
  airUp: 1.2,
  tilt: 0,
};

/**
 * The bay under the sky: noon's sun stands over the town's side of the bay
 * (+x, +z), and snow lies down to the shore in winter.
 */
const BAY_LOOK: CircuitLook = {
  south: [30, 15],
  swing: 1,
  fogNear: 140,
  fogFar: 700,
  snowLine: { summer: 290, fall: 175, winter: -4, spring: 200 },
};

export interface BayOptions {
  /** "sea" = swells + GPU chop, ripples, foam and reflections (see water.ts); "basic" = swells only, cheap. */
  water: "basic" | "sea";
  /** The jetski's top speed (m/s). */
  topSpeed: number;
  /** The sim's swells (`waveParams`). */
  waves: Float32Array;
  course: CourseData;
  /** The race's season, weather and time of day (a clear summer noon if left out). */
  conditions?: Conditions;
  /** How the circuit sits under the sky (the bay's if left out). */
  look?: CircuitLook;
}

export class Bay implements Environment {
  readonly group = new THREE.Group();
  readonly camera = CAMERA;
  readonly topSpeed: number;
  readonly reflects: boolean;
  /** The season, weather and time of day it is drawn in. */
  readonly conditions: Conditions;

  /** What the conditions look like (see look.ts). */
  readonly look: ConditionsLook;
  private time = uniform(0);
  private swells = new WaveUniforms(MAX_WAVES);
  /** The swells now: the sim's, each wave's height turned as far as the race's weather has. */
  private waveParams = new Float32Array(MAX_WAVES * WAVE_FIELDS);
  /** The sim's swells as given: each wave's height at the start (field 3) and at the end (field 7). */
  private waveTurn = new Float32Array(MAX_WAVES * WAVE_FIELDS);
  private turned = 0;
  private course: CourseView;
  private water: THREE.Mesh | null = null;
  /** World xz of the water grid's centre (it follows the camera). */
  private waterOrigin = uniform(new THREE.Vector2());
  /** The full water; `null` in basic mode (see `buildWater`). */
  private sea: SeaWater | null = null;
  private wakeSources = new Map<number, WakeSource>();
  private spray: Spray;
  private gulls: Gulls | null = null;
  private cumulus = new Cumulus(new THREE.Vector3(0, 0, 300));
  private precipitation = new Precipitation();
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private background = new THREE.Color();

  constructor(opts: BayOptions) {
    this.conditions = opts.conditions ?? homeConditions("jetski");
    this.look = new ConditionsLook(this.conditions, opts.look ?? BAY_LOOK);
    this.topSpeed = opts.topSpeed;
    this.reflects = opts.water === "sea";
    this.spray = new Spray(opts.topSpeed);
    this.group.add(this.spray.group);
    this.group.add(buildScenery());
    if (opts.water === "sea") {
      this.sea = new SeaWater(WATER_SIZE, WATER_SEGMENTS);
      this.group.add(this.sea.mesh);
    } else {
      this.buildWater();
    }
    // Chop seed only needs to be stable per room: derive it from the swells.
    this.sea?.setWaves(opts.waves, Math.round(Math.abs(opts.waves[5] ?? 1) * 1e6));
    this.waveTurn.set(opts.waves.subarray(0, MAX_WAVES * WAVE_FIELDS));
    this.waveParams.set(this.waveTurn);
    this.swells.setFromSim(this.waveParams);
    this.course = new CourseView(opts.course);
    this.group.add(this.course.group);
    this.sea?.setLand(opts.course.land);
    this.spray.setShore(opts.course.land);
    celify(this.group);
    if (this.sea) this.sea.mesh.userData.noMerge = true;
    if (this.water) this.water.userData.noMerge = true;
    mergeStatic(this.group, { cell: 600, maxVertices: 4000 });
    this.group.add(skyDome(), this.cumulus.mesh, this.precipitation.group);
    this.gulls = new Gulls(new THREE.Vector3(40, 0, 40));
    this.group.add(this.gulls.group);
  }

  private fog: THREE.Fog | null = null;

  get sunOffset(): THREE.Vector3 {
    return this.look.sun;
  }

  light(scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    // (One fog for the bay: a new one would rebuild every shader that draws in it.)
    this.fog ??= new THREE.Fog(0xc4e9f8, 140, 700);
    scene.fog = this.fog;
    scene.background = this.background;
    hemi.intensity = 1.2;
    sun.intensity = 2.6;
    this.sun = sun;
    this.hemi = hemi;
    this.look.apply(0, 0, 0, null, this.fog, this.background, sun, hemi);
  }

  ground(x: number, z: number, t: number): number {
    return waveHeight(this.waveParams, x, z, t);
  }

  makeRider(slot: number, appearance: Appearance | null): RiderModel {
    return new JetskiModel(slot, appearance);
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
      const deep = LOOK.seaDeep;
      const crest = LOOK.seaShallow;
      const base = mix(deep, crest, smoothstep(-0.8, 1.2, positionWorld.y));
      // Faint 4 m grid so speed reads even on calm water.
      const gx = step(0.965, fract(positionWorld.x.div(4)));
      const gz = step(0.965, fract(positionWorld.z.div(4)));
      return mix(base, vec3(0.85, 0.95, 1.0), max(gx, gz).mul(0.12));
    });
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0.0 });
    mat.positionNode = displaced();
    mat.colorNode = colour();
    inkOnlyInPass(mat, inkNode(0, 0, 0, 0));
    const water = new THREE.Mesh(waterGrid(WATER_SIZE, WATER_SEGMENTS), mat);
    water.receiveShadow = true;
    water.frustumCulled = false;
    this.group.add(water);
    this.water = water;
  }

  /** Turns the swells' heights as far as the race's weather has turned (a storm builds lap by lap). */
  private turnSwells(turn: number): void {
    if (Math.abs(turn - this.turned) < 1e-4) return;
    this.turned = turn;
    let changed = false;
    for (let i = 0; i < MAX_WAVES; i++) {
      const o = i * WAVE_FIELDS;
      const from = this.waveTurn[o + 3] ?? 0;
      const amp = from + ((this.waveTurn[o + 7] ?? from) - from) * turn;
      if (amp !== this.waveParams[o + 3]) {
        this.waveParams[o + 3] = amp;
        changed = true;
      }
    }
    if (!changed) return;
    this.swells.setFromSim(this.waveParams);
    this.sea?.setSwells(this.waveParams);
  }

  update(f: Frame): void {
    this.time.value = f.t;
    this.turnSwells(f.turn);
    if (this.fog) this.look.apply(f.turn, f.t, f.eye.y, f.weather, this.fog, this.background, this.sun, this.hemi);
    this.cumulus.update(this.look.cover, this.look.tower);
    this.precipitation.update(this.look.rain, this.look.snow);
    this.gulls?.update(f.t);
    this.course.update(this.waveParams, f.t, f.dt, f.riders, f.nextBuoy);
    const water = (x: number, z: number) => waveHeight(this.waveParams, x, z, f.t);
    for (const r of f.riders) {
      const model = f.models.get(r.slot);
      if (model) this.spray.emit(r, model.mesh, water, f.dt);
    }
    this.spray.update(water, f.eye, f.dt);
    // Centre the water grid near what the camera looks at, in fixed steps.
    const x = Math.round(f.look.x / WATER_SNAP) * WATER_SNAP;
    const z = Math.round(f.look.z / WATER_SNAP) * WATER_SNAP;
    this.waterOrigin.value.set(x, z);
    this.water?.position.set(x, 0, z);
    this.sea?.follow(x, z);
    if (this.sea) {
      this.wakeSources.clear();
      for (const r of f.riders) this.wakeSources.set(r.slot, { x: r.x, z: r.z, speed: r.speed, grounded: r.grounded });
      this.sea.update(f.renderer, f.t, this.wakeSources, f.dt);
    }
  }
}
