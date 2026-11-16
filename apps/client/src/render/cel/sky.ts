// The cel look's sky: a painted gradient from a deep zenith to a pale
// horizon, warmer toward the sun (and along the horizon at dawn and dusk),
// faint cirrus the wind combs into streaks, a cloud deck that closes in
// with the weather (a storm's with its shelf cloud and shafts of rain), and
// towering cumulus made of cel-shaded puffs (flat bottoms,
// lobes that each catch the light), far out over the sea and behind the
// sierra. Its colours are the conditions' (see look.ts).
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  Fn,
  If,
  atan,
  attribute,
  cameraProjectionMatrix,
  clamp,
  dot,
  float,
  fwidth,
  max,
  mix,
  modelViewMatrix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { LOOK, cut0 } from "./look.ts";
import { CelMaterial, SUN_DIR, UNREFLECTED, inkId, inklessBasic } from "./material.ts";
import { noise4 } from "./noise.ts";
import type { Steps } from "../slices.ts";

/** The sun's disc and the ring round it, as cosines of their angles from its centre (2.1° and 5°). */
const SUN_DISC = Math.cos((2.1 * Math.PI) / 180);
const SUN_RING = Math.cos((5 * Math.PI) / 180);

/** The line the cirrus is drawn out along, over the ceiling's plane (x, z; unit). */
const WISP = new THREE.Vector2(0.94, 0.34);

/** The cloud deck's big shapes at a point of the ceiling's plane: where it is thick (about -1 to 1). */
function billows(p: THREE.Node<"vec2">): THREE.Node<"float"> {
  return noise4(p.mul(0.55))
    .x.mul(0.6)
    .add(noise4(p.mul(1.6)).y.mul(0.28));
}

/** Where the sky sits in the depth range (1 = the far plane): behind all else, but never clipped by it. */
const SKY_DEPTH = 0.999999;

/** The sky's colours (the conditions' uniforms), and the clear summer horizon as a THREE.Color. */
export const SKY = {
  zenith: LOOK.zenith,
  upper: LOOK.upper,
  horizon: LOOK.horizon,
  glow: LOOK.glow,
  /** The clear summer horizon, for what starts out tinted toward it. */
  fog: new THREE.Color(0xc4e9f8),
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

/**
 * The sky dome: centred on the camera, behind everything. It is drawn after
 * the rest, at the very back of the depth range, so only the pixels nothing
 * else covers pay for its shader.
 */
export function skyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(3800, 48, 24);
  const m = inklessBasic({ side: THREE.BackSide, depthWrite: false, fog: false });
  m.vertexNode = Fn(() => {
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1));
    return vec4(clip.x, clip.y, clip.w.mul(SKY_DEPTH), clip.w);
  })();
  m.colorNode = Fn(() => {
    const d = normalize(positionLocal);
    const y = max(d.y, float(0));
    let c: THREE.Node<"vec3"> = mix(LOOK.horizon, LOOK.upper, smoothstep(0.0, 0.28, pow(y, 0.8)));
    c = mix(c, LOOK.zenith, smoothstep(0.25, 0.9, y));
    // Low sun: its warmth spreads along the horizon, most on its side of the sky.
    const flat = d.xz.div(max(d.xz.length(), float(1e-3)));
    const sunFlat = SUN_DIR.xz.div(max(SUN_DIR.xz.length(), float(1e-3)));
    const side = dot(flat, sunFlat).mul(0.5).add(0.5);
    const low = float(1).sub(smoothstep(0.0, 0.32, y));
    c = mix(c, LOOK.glow, pow(side, 3).mul(low).mul(LOOK.dusk).mul(0.75));
    const sun = max(dot(d, SUN_DIR), float(0));
    c = mix(c, LOOK.glow, pow(sun, 24).mul(0.55).add(pow(sun, 4).mul(0.12)));
    // The sun: a crisp disc, a ring of light round it.
    const sw = max(fwidth(sun), float(1e-6));
    const disc = smoothstep(float(SUN_DISC).sub(sw), float(SUN_DISC).add(sw), sun);
    const ring = smoothstep(float(SUN_RING).sub(sw.mul(2)), float(SUN_RING).add(sw.mul(2)), sun).mul(0.35);
    c = mix(c, mix(LOOK.glow, vec3(1), 0.75), max(disc, ring));
    // Where a ray through this pixel meets a flat ceiling of cloud.
    const plane = d.xz.div(max(d.y, float(0.05)));
    const drift = LOOK.wind.mul(LOOK.time.mul(0.0015));
    // High cirrus: on a fair day a few soft tufts, faint and far apart; the wind draws them out along one
    // line into mares' tails with an edge.
    const along = plane.x
      .mul(WISP.x)
      .add(plane.y.mul(WISP.y))
      .mul(mix(float(2.4), float(0.7), LOOK.streaks));
    const across = plane.y
      .mul(WISP.x)
      .sub(plane.x.mul(WISP.y))
      .mul(mix(float(5.2), float(8.5), LOOK.streaks));
    const fibres = noise4(vec2(along, across).add(drift));
    const strand = fibres.x.mul(0.7).add(noise4(vec2(along, across).mul(2.3).add(drift.mul(2))).y.mul(0.3));
    // (They gather in a few drifts and leave most of the sky plain.)
    const gather = noise4(plane.mul(0.24).add(drift).add(4.7)).z;
    const drifts = smoothstep(float(0.18).sub(LOOK.streaks.mul(0.3)), float(0.5).sub(LOOK.streaks.mul(0.25)), gather);
    const wisp = smoothstep(float(0.02).add(LOOK.streaks.mul(0.09)), float(0.5).sub(LOOK.streaks.mul(0.35)), strand)
      .mul(drifts)
      .mul(smoothstep(0.26, 0.4, y))
      .mul(smoothstep(0.66, 0.48, y))
      .mul(LOOK.cirrus);
    c = mix(c, vec3(1), wisp.mul(float(0.13).add(LOOK.streaks.mul(0.3))));
    // A band or two of soft flat clouds at mid height: large, pale, most of the sky left plain.
    const puffSky = c.toVar();
    If(LOOK.puffs.greaterThan(0.001), () => {
      // (Drawn out across the wind.)
      const pq = vec2(plane.x.mul(0.9), plane.y.mul(2.1)).add(drift.mul(5));
      const cells = noise4(pq)
        .x.mul(0.85)
        .add(noise4(pq.mul(2.1)).y.mul(0.15));
      // They gather where a slow field is high: a patch or two on a fair day, half the sky under cloud.
      const field = noise4(plane.mul(0.13).add(drift.mul(2))).z;
      const inField = field
        .sub(float(0.5).sub(LOOK.puffs.mul(0.62)))
        .min(0)
        .mul(5);
      const puff = cut0(cells.sub(0.18).add(inField))
        .mul(smoothstep(0.1, 0.2, y))
        .mul(smoothstep(0.5, 0.3, y));
      const core = cut0(cells.sub(0.42).add(inField));
      const pale = mix(puffSky, LOOK.cloud, 0.42);
      const lit = mix(puffSky, LOOK.cloud, 0.78);
      puffSky.assign(mix(puffSky, mix(pale, lit, core), puff.mul(LOOK.puffs.mul(0.4).add(0.6))));
    });
    c = puffSky;
    // The cloud deck: masses that close in with the weather, their flanks toward the sun lit and their
    // bellies dark; under a storm a shelf cloud rolls in on the wind, shafts of rain hanging from it
    // (worked out only under a deck).
    const sky = c.toVar();
    If(LOOK.overcast.greaterThan(0.001), () => {
      const q = plane.mul(0.32).add(drift.mul(4));
      const fine = noise4(q.mul(4.3)).z.mul(0.1);
      const mass = billows(q).add(fine);
      const edge = mass.sub(mix(float(0.62), float(-0.55), LOOK.overcast));
      const cloud = cut0(edge).mul(smoothstep(0.015, 0.14, y));
      // The deck thins toward the sun on a flank that faces it.
      const relief = mass.sub(billows(q.add(sunFlat.mul(0.42))).add(fine));
      const flank = cut0(relief.sub(0.07));
      const belly = cut0(relief.negate().sub(0.09)).mul(cut0(edge.sub(0.12)));
      // Four tones: lit flanks with a bright edge where they turn, thin rims, the deck, and dark bellies under it.
      const turn = flank.mul(float(1).sub(cut0(relief.sub(0.105))));
      const rim = float(1).sub(cut0(edge.sub(0.035)));
      const lit = mix(LOOK.deck, max(LOOK.horizon.rgb, LOOK.deck.rgb), turn.mul(0.6));
      const body = mix(LOOK.deckShade, lit, max(flank, rim));
      sky.assign(mix(sky, mix(body, LOOK.deckShade.mul(0.74), belly), cloud));
      const az = atan(d.z, d.x);
      const storm = smoothstep(0.75, 1, LOOK.veil);
      // The shelf: a dark roll low across the side the wind comes from, its foot scalloped and catching
      // the light, the sky pale under it.
      const windward = atan(LOOK.wind.y.negate(), LOOK.wind.x.negate().add(1e-4));
      const off = az
        .sub(windward)
        .add(Math.PI * 3)
        .mod(Math.PI * 2)
        .sub(Math.PI);
      const arc = float(1).sub(off.mul(off).mul(0.36)).max(0);
      const scallop = noise4(vec2(az.mul(5.5), 1.3).add(drift.mul(6)));
      const foot = arc.mul(0.15).add(scallop.x.mul(0.014)).add(scallop.y.mul(0.007));
      const shelf = cut0(y.sub(foot))
        .mul(cut0(arc.mul(0.3).add(scallop.z.mul(0.03)).sub(y)))
        .mul(cut0(arc.sub(0.12)));
      // (Its face is laid in terraces: a lit lip along the foot, and a paler band or two up its flank.)
      const up = y.sub(foot);
      const lip = cut0(float(0.016).sub(up));
      const terrace = cut0(up.sub(0.04).add(scallop.w.mul(0.008))).mul(cut0(float(0.052).sub(up)));
      const roll = mix(mix(LOOK.deckShade.mul(0.58), LOOK.deckShade, terrace), LOOK.deck.mul(1.12), lip);
      sky.assign(mix(sky, roll, shelf.mul(storm)));
      // Rain: shafts slanting down the wind from the deck to the horizon, one edge drawn and the other
      // trailing off; softer veils in lighter weather.
      const lean = az.mul(2.3).sub(y.mul(1.7));
      const columns = noise4(vec2(lean, 0.4).add(drift.mul(3))).x;
      const shaft = mix(
        smoothstep(-0.05, 0.35, columns),
        cut0(columns.sub(0.16)).mul(smoothstep(0.62, 0.2, columns)),
        storm,
      );
      const strokes = noise4(vec2(lean.mul(14), y.mul(1.5))).y;
      const hang = smoothstep(0.36, 0.14, y)
        .mul(smoothstep(0, 0.05, y))
        .mul(float(1).sub(shelf.mul(storm)));
      const veil = shaft.mul(hang).mul(LOOK.veil);
      sky.assign(
        mix(sky, LOOK.deckShade.mul(0.86), veil.mul(strokes.mul(0.12).add(mix(float(0.45), float(0.62), storm)))),
      );
    });
    c = sky;
    return c;
  })();
  const dome = new THREE.Mesh(geo, m);
  // After everything opaque.
  dome.renderOrder = 10;
  dome.frustumCulled = false;
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  return dome;
}

/** One cumulus: tiers of puffs on a flat base, wider than tall, about `size` metres across. */
function cumulus(size: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const tiers = [
    { n: 6 + Math.floor(r() * 3), rad: 0.15, y: 0.05, spread: 0.5 },
    { n: 4 + Math.floor(r() * 2), rad: 0.19, y: 0.2, spread: 0.32 },
    { n: 2 + Math.floor(r() * 2), rad: 0.21, y: 0.38, spread: 0.18 },
    { n: 1, rad: 0.17, y: 0.55, spread: 0.06 },
  ];
  for (const t of tiers) {
    for (let i = 0; i < t.n; i++) {
      const rad = size * t.rad * (0.75 + r() * 0.5);
      const g = new THREE.IcosahedronGeometry(rad, 2);
      const x = (t.n === 1 ? 0 : (i / (t.n - 1) - 0.5) * 2 * t.spread + (r() - 0.5) * 0.08) * size;
      g.translate(x + (t.n === 1 ? (r() - 0.5) * 0.2 * size : 0), t.y * size + rad * 0.5, (r() - 0.5) * size * 0.25);
      parts.push(g);
    }
  }
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  // A flat base, facing down.
  const pos = geo.attributes.position!;
  const nor = geo.attributes.normal!;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 0) {
      pos.setY(i, 0);
      nor.setXYZ(i, 0, -1, 0);
    }
  }
  return geo;
}

/** How many cumulus a sky can hold. */
const CUMULUS = 24;

/** Each cloud's shape, made once (every sky is made of the same clouds, placed round its own circuit). */
const made: THREE.BufferGeometry[] = [];

/**
 * Cumulus in a ring round a circuit, far out (they never fog), all in one
 * batch: as many of them as the weather's cover asks for (each one grows
 * from nothing as the cover reaches it), as tall as it lets them stand, in
 * its colours.
 */
export class Cumulus {
  readonly mesh: THREE.Mesh;
  /** How much of the sky they fill (0-1; a fair day is about 0.6), and how tall they stand (1 = as built). */
  private cover = uniform(0.5);
  private tower = uniform(1);

  private centre: THREE.Vector3;

  /** `centre`: the ring's middle (x, z) and the height its clouds stand on (y). Its clouds are made by `build`. */
  constructor(centre: THREE.Vector3) {
    this.centre = centre;
    const material = new CelMaterial({
      colorNode: LOOK.cloud.rgb,
      lit: new THREE.Color(1.02, 1.0, 0.97),
      threshold: 0.1,
      fog: false,
      silhouette: 1,
      crease: 0,
      darkness: 0.45,
      id: inkId("cloud"),
    });
    material.shadeNode = LOOK.cloudShade.rgb;
    const cloud = attribute<"vec4">("cloud", "vec4");
    const grow = clamp(this.cover.sub(cloud.w).div(0.06), 0, 1);
    const s = grow.greaterThan(0.01).select(grow.mul(0.6).add(0.4), 0);
    material.positionNode = cloud.xyz.add(positionLocal.mul(vec3(s, s.mul(this.tower), s)));
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = "cumulus";
    // (Bright against the sky: a mirror image of them would show nothing in the water.)
    this.mesh.layers.set(UNREFLECTED);
    // (Placed in the shader: its bounds are the ring's.)
    this.mesh.frustumCulled = false;
  }

  /** Makes its clouds, one at a time (see slices.ts). */
  *build(): Steps {
    const centre = this.centre;
    const r = rng(77);
    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < CUMULUS; i++) {
      const a = (i / CUMULUS) * Math.PI * 2 + (r() - 0.5) * 0.3;
      // More, bigger clouds over the sierra (north, +z) and out to sea.
      const north = Math.max(0, Math.sin(a));
      const dist = 2500 + r() * 800;
      const size = 260 + r() * 300 + north * 260;
      const geo = (made[i] ??= cumulus(size, 100 + i * 13)).clone();
      const x = centre.x + Math.cos(a) * dist;
      const z = centre.z + Math.sin(a) * dist;
      const y = centre.y + 60 + r() * 220 + north * 100;
      // Broadside to the circuit, its height varied.
      m.makeRotationY(Math.atan2(centre.x - x, centre.z - z)).scale(new THREE.Vector3(1, 0.85 + r() * 0.35, 1));
      geo.applyMatrix4(m);
      // A fair day's clouds are spread all round the sky; the rest come with the clouds.
      const rank = i % 3 !== 2 ? (((i * 7) % 16) / 16) * 0.5 : 0.5 + (((i * 5) % 8) / 8) * 0.5;
      const n = geo.attributes.position!.count;
      const at = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) at.set([x, y, z, rank], k * 4);
      geo.setAttribute("cloud", new THREE.BufferAttribute(at, 4));
      parts.push(geo);
      yield;
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = mergeGeometries(parts);
  }

  /** Shows `cover` of the clouds (0-1; a fair day is about 0.6), `tower` as tall as built. */
  update(cover: number, tower: number): void {
    this.cover.value = cover;
    this.tower.value = tower;
  }
}
