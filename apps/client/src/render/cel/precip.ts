// Rain and snow falling round the camera, all on the GPU: a fixed set of
// quads, each a drop or a flake placed in a box that wraps round the camera
// (so they stay put in the world as it moves), falling and drifting with
// the wind by the clock. Rain is thin streaks along its fall, snow small
// discs that sway; both shrink away close to the lens and fade in the fog.
// How much falls is a uniform: the quads past it collapse to nothing.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  float,
  fract,
  max,
  mix,
  normalize,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { LOOK } from "./look.ts";
import { UNREFLECTED, inkNode, inkOnlyInPass } from "./material.ts";
import { PIXEL_AT_1M } from "./rider.ts";

interface PrecipLook {
  count: number;
  /** The box round the camera (m): across, and high. */
  box: number;
  height: number;
  /** How fast it falls (m/s), and how much each one varies. */
  fall: number;
  /** A drop's length and width, or a flake's size (m). */
  length: number;
  width: number;
  /** How far snow sways (m). */
  sway: number;
  colour: THREE.Color;
}

const RAIN: PrecipLook = {
  count: 4500,
  box: 44,
  height: 26,
  fall: 11,
  length: 0.42,
  width: 0.008,
  sway: 0,
  colour: new THREE.Color(0.8, 0.86, 0.94),
};

const SNOW: PrecipLook = {
  count: 6000,
  box: 40,
  height: 22,
  fall: 1.3,
  length: 0.03,
  width: 0.03,
  sway: 0.5,
  colour: new THREE.Color(0.97, 0.98, 1),
};

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

/** One kind of precipitation: rain or snow. */
class Fall {
  readonly mesh: THREE.Mesh;
  /** How much falls (0-1). */
  readonly amount = uniform(0);

  constructor(look: PrecipLook, flakes: boolean, seed: number, name: string) {
    const n = look.count;
    const corner = new Float32Array(n * 4 * 2);
    const seeds = new Float32Array(n * 4 * 4);
    const index = new Uint32Array(n * 6);
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const s = [r(), r(), r(), (i + r()) / n];
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

    const amount = this.amount;
    const box = vec3(look.box, look.height, look.box);
    const placed = Fn(() => {
      const seedA = attribute<"vec4">("seed", "vec4");
      const c = attribute<"vec2">("corner", "vec2");
      const speed = float(look.fall).mul(seedA.w.mul(0.5).add(0.75));
      const drift = vec3(LOOK.wind.x, speed.negate(), LOOK.wind.y);
      const t = LOOK.time;
      // Snow sways as it falls, each flake to its own beat.
      const sway = flakes
        ? vec3(sin(t.mul(1.3).add(seedA.x.mul(40))), 0, sin(t.mul(1.1).add(seedA.z.mul(40)))).mul(look.sway)
        : vec3(0);
      const home = seedA.xyz.mul(box).add(drift.mul(t)).add(sway);
      const local = fract(home.sub(cameraPosition).div(box)).sub(0.5).mul(box);
      const at = cameraPosition.add(local);
      const toCam = normalize(cameraPosition.sub(at));
      const along = flakes ? vec3(0, 1, 0) : normalize(drift);
      const side = normalize(cross(along, toCam));
      const dist = local.length();
      // Never thinner than about a pixel, and nothing right at the lens; past the amount, nothing at all.
      const shown = smoothstep(1.2, 3.5, dist)
        .mul(seedA.w.lessThan(amount).select(1, 0))
        .mul(smoothstep(0.5, 0.42, local.y.div(look.height).abs()));
      const width = max(float(look.width), dist.mul(PIXEL_AT_1M).mul(1.1)).mul(shown);
      const length = (flakes ? width : float(look.length).mul(shown)).mul(2);
      return at.add(side.mul(c.x.mul(width))).add(along.mul(c.y.mul(length)));
    });
    const m = new THREE.MeshBasicNodeMaterial({ fog: true, side: THREE.DoubleSide });
    m.positionNode = placed();
    const c = attribute<"vec2">("corner", "vec2");
    if (flakes) {
      // A round flake, cut out.
      m.maskNode = vec2(c.x, c.y.mul(2)).length().lessThan(1);
      m.colorNode = vec3(look.colour.r, look.colour.g, look.colour.b).mul(mix(vec3(1), LOOK.lit, 0.5));
    } else {
      // A streak, its ends tapered.
      m.maskNode = c.y
        .abs()
        .mul(2)
        .lessThan(float(1).sub(c.x.abs().mul(0.5)));
      m.colorNode = vec3(look.colour.r, look.colour.g, look.colour.b).mul(mix(LOOK.horizon, vec3(1), 0.35));
    }
    inkOnlyInPass(m, inkNode(0, 0, 0, 0));
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(UNREFLECTED);
    this.mesh.renderOrder = 2;
    this.mesh.name = name;
    // (Compiled even when it isn't falling: see `World.compile`.)
    this.mesh.userData.weather = true;
  }

  set(amount: number): void {
    this.amount.value = amount;
    this.mesh.visible = amount > 0.001;
  }
}

/** Rain and snow round the camera. */
export class Precipitation {
  readonly group = new THREE.Group();
  private rain = new Fall(RAIN, false, 11, "rain");
  private snow = new Fall(SNOW, true, 23, "snowfall");

  constructor() {
    this.group.add(this.rain.mesh, this.snow.mesh);
  }

  /** How much rain and snow fall (0-1 each). */
  update(rain: number, snow: number): void {
    this.rain.set(rain);
    this.snow.set(snow);
  }
}
