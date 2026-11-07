// The water courses' environment, and the bay's. Sky and sun, the sea (the
// sim's swells plus GPU chop, ripples, wakes, foam and reflections, or the
// swells alone), the course on it, the coast behind, and the spray the
// jetskis throw. Other places on the water bring their own land and
// backdrop (see cape.ts).
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
import { mergeStatic } from "./merge.ts";
import { celify, inkNode, inkOnlyInPass } from "./cel/material.ts";
import { SKY, clouds, skyDome } from "./cel/sky.ts";
import { Gulls } from "./cel/gulls.ts";
import { CourseView, type CourseData } from "./course.ts";
import { JetskiModel } from "./rider.ts";
import { buildScenery } from "./scenery.ts";
import { Spray } from "./spray.ts";
import { SeaWater, type WakeSource } from "./water.ts";
import { MAX_SHELTERS, MAX_WAVES, PARAMS_LEN, WATER_SNAP, WaveUniforms, waterGrid, waveHeight } from "./waves.ts";
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

export interface BayOptions {
  /** "sea" = swells + GPU chop, ripples, foam and reflections (see water.ts); "basic" = swells only, cheap. */
  water: "basic" | "sea";
  /** The jetski's top speed (m/s). */
  topSpeed: number;
  /** The sim's swells (`waveParams`). */
  waves: Float32Array;
  course: CourseData;
  /** The land and backdrop round the course (the bay's coast if none). */
  scenery?: WaterScenery;
}

/** What stands round a water course besides the course itself: land, towns, the backdrop. */
export interface WaterScenery {
  readonly group: THREE.Group;
  /** Where the gulls circle. */
  readonly gulls: THREE.Vector3;
  /** The sea is hidden this far inside the land (m), where swells would show through low shores. */
  readonly inland: number;
  /** Per frame: what floats rides the swell. */
  update(waves: Float32Array, t: number): void;
}

export class Bay implements Environment {
  readonly group = new THREE.Group();
  readonly camera = CAMERA;
  readonly topSpeed: number;
  readonly reflects: boolean;

  private sky = new THREE.Color(0xa8d8f0);
  private time = uniform(0);
  private swells = new WaveUniforms(MAX_WAVES, MAX_SHELTERS);
  private waveParams = new Float32Array(PARAMS_LEN);
  private course: CourseView;
  private water: THREE.Mesh | null = null;
  /** World xz of the water grid's centre (it follows the camera). */
  private waterOrigin = uniform(new THREE.Vector2());
  /** The full water; `null` in basic mode (see `buildWater`). */
  private sea: SeaWater | null = null;
  private wakeSources = new Map<number, WakeSource>();
  private spray: Spray;
  private gulls: Gulls | null = null;
  private scenery: WaterScenery | null;

  constructor(opts: BayOptions) {
    this.topSpeed = opts.topSpeed;
    this.reflects = opts.water === "sea";
    this.scenery = opts.scenery ?? null;
    this.spray = new Spray(opts.topSpeed);
    this.group.add(this.spray.group);
    this.group.add(this.scenery?.group ?? buildScenery(this.sky));
    if (opts.water === "sea") {
      this.sea = new SeaWater(WATER_SIZE, WATER_SEGMENTS, this.scenery?.inland ?? null);
      this.group.add(this.sea.mesh);
    } else {
      this.buildWater();
    }
    // Chop seed only needs to be stable per room: derive it from the swells.
    this.sea?.setWaves(opts.waves, Math.round(Math.abs(opts.waves[5] ?? 1) * 1e6));
    this.waveParams.set(opts.waves.subarray(0, PARAMS_LEN));
    this.swells.setFromSim(this.waveParams);
    this.course = new CourseView(opts.course);
    this.group.add(this.course.group);
    this.sea?.setLand(opts.course.land);
    this.spray.setShore(opts.course.land);
    celify(this.group);
    if (this.sea) this.sea.mesh.userData.noMerge = true;
    if (this.water) this.water.userData.noMerge = true;
    mergeStatic(this.group, { cell: 600, maxVertices: 4000 });
    this.group.add(skyDome(), clouds(new THREE.Vector2(0, 300)));
    this.gulls = new Gulls(this.scenery?.gulls ?? new THREE.Vector3(40, 0, 40));
    this.group.add(this.gulls.group);
  }

  private fog: THREE.Fog | null = null;

  light(scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): void {
    scene.background = SKY.fog;
    // (One fog for the bay: a new one would rebuild every shader that draws in it.)
    this.fog ??= new THREE.Fog(SKY.fog, 140, 700);
    scene.fog = this.fog;
    hemi.color.set(0xfff4e0);
    hemi.groundColor.set(0x2a6f8f);
    hemi.intensity = 1.2;
    sun.color.set(0xfff1d6);
    sun.intensity = 2.6;
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
    inkOnlyInPass(mat, inkNode(0, 0, 0, 0));
    const water = new THREE.Mesh(waterGrid(WATER_SIZE, WATER_SEGMENTS), mat);
    water.receiveShadow = true;
    water.frustumCulled = false;
    this.group.add(water);
    this.water = water;
  }

  update(f: Frame): void {
    this.time.value = f.t;
    this.gulls?.update(f.t);
    this.course.update(this.waveParams, f.t, f.dt, f.riders, f.nextBuoy);
    this.scenery?.update(this.waveParams, f.t);
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
