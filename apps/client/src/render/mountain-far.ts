// The land beyond the mountain the sim knows: the valley's sides rising to
// ridges and peaks, the sierra behind the start, and below the finish the
// valley running down to the coastal plain, a town on the shore and the sea
// out to the horizon. One sheet of ground laid round the sim's own (meeting
// its heights where they join), snowed on down to the season's snow line,
// wooded below the tree line, in two flat tones by the sun, and laid back
// in layers of haze. It reaches far past the camera's range, so the shader
// draws what lies beyond a few kilometres closer along its line of sight.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  smoothstep,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import { LOOK, cut0 } from "./cel/look.ts";
import { SUN_DIR, inkNode, inkOnlyInPass } from "./cel/material.ts";
import { noise4 } from "./cel/noise.ts";
import { MOUNTAIN } from "./mountain-look.ts";
import type { RunData } from "./mountain.ts";

/** Where the far land goes round. */
export interface FarSite {
  run: RunData;
  heights(points: Float32Array): Float32Array;
  /** The square of mountain the sim's snow is drawn on (m). */
  around: { x0: number; z0: number; width: number; depth: number };
  /** The start stands on a ridge: the ground falls away behind it (else it climbs to the summit). */
  ridgeStart: boolean;
}

/** Rings of the sheet: how far out from the sim's mountain each lies (m), wider apart the further out. */
const RINGS: number[] = [-24];
for (let d = 24, step = 50; d < 21000; step *= 1.085) {
  RINGS.push(d);
  d += step;
}
/** Points along a side of the sheet are about this far apart (m), and a corner is a fan of this many. */
const SIDE_STEP = 36;
const CORNER = 12;
/** The sim's ground gives way to the land beyond over these distances from its edge (m). */
const BLEND_FROM = 120;
const BLEND_TO = 1000;
/** The sea lies this far below the finish (m), and the coast this far beyond it. */
const SEA_BELOW = 540;
const COAST = 5200;
/** What lies further than this from the camera (m) is drawn within this much more: the camera sees no further. */
const NEAR_SHELL = 2800;
const SHELL = 1100;

const fade = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ramp = (x: number, a: number, b: number) => fade(Math.min(1, Math.max(0, (x - a) / (b - a))));

/** Seeded hash in [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1]. */
function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

/** Ridged fractal noise in [0, 1]: sharp crests, soft valleys. */
function ridged(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq, seed + i * 31));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/** The land beyond the sim's, as a height at (x, z): see the file's header. */
function landscape(site: FarSite): { height(x: number, z: number): number; sea: number } {
  const path = site.run.path;
  const first = path[0]!;
  const last = path.at(-1)!;
  const top = first.y;
  const bottom = last.y;
  const z1 = last.z;
  const sea = bottom - SEA_BELOW;
  /** The run's centre line (x) at z, carried on straight past its ends. */
  const axisX = (z: number) => {
    if (z <= first.z) return first.x;
    if (z >= z1) return last.x + (z - z1) * 0.06;
    const i = Math.min(path.length - 2, Math.floor(((z - first.z) / (z1 - first.z)) * (path.length - 1)));
    return path[i]!.x;
  };
  const height = (x: number, z: number) => {
    const u = x - axisX(z);
    // The valley's floor: down the run, over the shelf the finish stands on, and down to the plain and the shore.
    let axis: number;
    if (z < 0) {
      axis = site.ridgeStart
        ? top - 420 * ramp(-z, 200, 2600) + 260 * ramp(-z, 5200, 9000)
        : top + 380 * ramp(-z, 0, 1900) - 300 * ramp(-z, 2600, 5200) + 420 * ramp(-z, 6500, 10000);
    } else if (z <= z1) {
      axis = lerp(top, bottom, z / z1);
    } else {
      const s = z - z1;
      const shelf = bottom + 70 * ramp(s, 0, 520);
      axis = lerp(shelf, sea + 26, ramp(s, 520, 4300));
    }
    // Mountains either side of it: highest up behind the start, down to headlands at the shore.
    const inland = ramp(-z, -z1 - 4600, 2500);
    const crest = lerp(130, 1050, inland) + 520 * ramp(-z, 1500, 7000);
    const open = ramp(Math.abs(u), 60, 1150);
    // (Bent a little, so ranges don't run straight.)
    const wx = x + 600 * noise2(x / 3100, z / 3100, 41);
    const wz = z + 600 * noise2(x / 3100 + 9, z / 3100, 43);
    const range = ridged(wx / 2500 + 3.1, wz / 3600 + 1.7, 11, 5);
    const spur = ridged(wx / 640, wz / 640, 23, 3);
    // Now and then a peak stands over its range.
    const peak = Math.max(0, noise2(wx / 1900 + 5, wz / 1900, 57)) ** 2 * 1.5;
    const hills = crest * open * (0.16 + 1.25 * range ** 1.5 + 0.3 * spur * open + peak * inland);
    // The shore: a ragged line across the valley's mouth, the ground running out under the sea.
    const shore = z1 + COAST + 700 * noise2(x / 2600, 0.5, 5) + 260 * noise2(x / 700, 2.5, 7);
    const dry = 1 - ramp(z, shore - 500, shore + 900);
    return lerp(sea - 60, axis + hills, dry);
  };
  return { height, sea };
}

/** How far from the box `[x0, x0 + w] × [z0, z0 + d]` a point is (m; negative inside). */
function outside(x: number, z: number, x0: number, z0: number, w: number, d: number): number {
  const dx = Math.max(x0 - x, x - (x0 + w));
  const dz = Math.max(z0 - z, z - (z0 + d));
  if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
  return Math.max(dx, dz);
}

/** The sheet of far ground: rings round the sim's mountain, wider apart the further out. */
function sheet(site: FarSite, land: (x: number, z: number) => number): THREE.BufferGeometry {
  const { x0, z0, width, depth } = site.around;
  // Round the box: each point of its edge, and the way out from it.
  const edge: { x: number; z: number; nx: number; nz: number }[] = [];
  const corners = [
    { x: x0 + width, z: z0, a: -Math.PI / 2 },
    { x: x0 + width, z: z0 + depth, a: 0 },
    { x: x0, z: z0 + depth, a: Math.PI / 2 },
    { x: x0, z: z0, a: Math.PI },
  ];
  corners.forEach((c, k) => {
    for (let i = 0; i <= CORNER; i++) {
      const a = c.a + (i / CORNER) * (Math.PI / 2);
      edge.push({ x: c.x, z: c.z, nx: Math.cos(a), nz: Math.sin(a) });
    }
    const next = corners[(k + 1) % 4]!;
    const steps = Math.max(2, Math.round(Math.hypot(next.x - c.x, next.z - c.z) / SIDE_STEP));
    const a = c.a + Math.PI / 2;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      edge.push({ x: lerp(c.x, next.x, t), z: lerp(c.z, next.z, t), nx: Math.cos(a), nz: Math.sin(a) });
    }
  });
  const n = edge.length;
  const rings = RINGS.length;
  const points = new Float32Array(n * rings * 2);
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < n; i++) {
      const e = edge[i]!;
      points.set([e.x + e.nx * RINGS[r]!, e.z + e.nz * RINGS[r]!], (r * n + i) * 2);
    }
  }
  const sim = site.heights(points);
  const pos = new Float32Array(n * rings * 3);
  for (let k = 0; k < n * rings; k++) {
    const x = points[k * 2]!;
    const z = points[k * 2 + 1]!;
    const out = outside(x, z, x0, z0, width, depth);
    const w = ramp(out, BLEND_FROM, BLEND_TO);
    // Just under the sim's snow where the two overlap.
    const tucked = sim[k]! - (out < 0 ? 4 : out < 60 ? 1.5 : 0);
    pos.set([x, w >= 1 ? land(x, z) : lerp(tucked, land(x, z), w), z], k * 3);
  }
  const index: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      index.push(a, b, a + n, b, b + n, a + n);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** A point drawn no further than the camera sees: past `NEAR_SHELL`, closer along its line of sight. */
function withinSight(p: THREE.Node<"vec3">): THREE.Node<"vec3"> {
  const away = p.sub(cameraPosition);
  const d = away.length();
  const beyond = max(d.sub(NEAR_SHELL), 0);
  const drawn = min(d, float(NEAR_SHELL)).add(float(SHELL).mul(float(1).sub(exp(beyond.div(-9000)))));
  return cameraPosition.add(away.div(max(d, 1)).mul(drawn));
}

/**
 * How far a point `d` m away is lost in the air (0-1): as the scene's fog
 * has it close by, and no more than the haze that distance lays on it (so
 * the far land stays in sight on a clear day, and looms in bad weather).
 */
function hazeAt(d: THREE.Node<"float">): THREE.Node<"float"> {
  const fog = smoothstep(MOUNTAIN.fogNear, MOUNTAIN.fogFar, d);
  const air = float(0.45).add(float(0.5).mul(float(1).sub(exp(d.div(-5500)))));
  const thick = LOOK.haze.pow(0.35);
  return min(fog, air.add(float(1).sub(air).mul(thick)));
}

/** Two flat tones by the sun, as the cel look lights things (`shade` a multiple of the colour). */
function toned(c: THREE.Node<"vec3">, n: THREE.Node<"vec3">, shade: THREE.Node<"vec3">): THREE.Node<"vec3"> {
  const lit = cut0(dot(n, SUN_DIR).sub(0.08));
  return mix(c.pow(vec3(1.12)).mul(shade).mul(LOOK.shade), c.mul(LOOK.lit), lit);
}

/** The far land's material. */
function landMaterial(sea: number, top: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  const p = varying(positionGeometry);
  m.positionNode = withinSight(positionGeometry);
  m.colorNode = Fn(() => {
    // Each face flat, as cut from the rock: it is all in the light or all in shade.
    const face = normalize(cross(dFdx(p), dFdy(p)));
    const n = face.mul(face.y.sign());
    const wide = noise4(p.xz.mul(0.0011));
    const mid = noise4(p.xz.mul(0.0047));
    const fine = noise4(p.xz.mul(0.021));
    const high = p.y.sub(sea);
    // The ground by its height: sand at the shore, fields on the plain, meadow and scree above.
    const fields = mix(LOOK.ground, LOOK.grass, smoothstep(-0.2, 0.3, mid.x)).mul(mid.y.mul(0.12).add(1));
    // (As the sim's own mountain has it, so the two join unseen.)
    const drift = noise4(p.xz.mul(0.045)).x.mul(0.5).add(0.5);
    const meadow = mix(LOOK.ground, LOOK.ground2, smoothstep(0.35, 0.65, drift.sub(0.1)));
    let c: THREE.Node<"vec3"> = mix(fields, meadow, smoothstep(60, 260, high.add(wide.x.mul(60))));
    c = mix(vec3(0.83, 0.76, 0.6), c, cut0(high.sub(7).add(fine.x.mul(3))));
    // Woods on the slopes below the tree line, in patches.
    const wooded = cut0(
      mid.w
        .mul(0.5)
        .add(wide.y.mul(0.5))
        .add(0.16)
        .sub(smoothstep(top - 140, top + 40, p.y))
        .sub(smoothstep(110, 40, high)),
    );
    const woods = mix(vec3(0.07, 0.15, 0.1), LOOK.evergreen.mul(0.75), 0.5);
    c = mix(c, woods, wooded);
    // Rock where it is steep.
    const rock = cut0(float(0.73).sub(n.y).add(fine.y.mul(0.05)));
    c = mix(c, vec3(0.3, 0.27, 0.27), rock);
    // Snow down to the season's line, ragged, thinner on the steep and in the woods.
    const line = p.y
      .sub(LOOK.snowLine)
      .add(wide.z.mul(90))
      .add(fine.z.mul(22))
      .div(60)
      .add(n.y.sub(0.8).mul(1.6))
      .sub(wooded.mul(0.5));
    const snowy = cut0(line).mul(LOOK.snowCover);
    const snow = mix(vec3(0.82, 0.87, 0.97), vec3(0.93, 0.95, 1.0), wide.w.mul(0.5).add(0.5));
    c = mix(c, snow, snowy.mul(mix(float(1), float(0.45), wooded)));
    const shade = mix(vec3(0.58, 0.6, 0.88), vec3(0.52, 0.6, 1.0), snowy);
    const lit = toned(c, n, shade);
    const d = p.distance(cameraPosition);
    return mix(lit, mix(LOOK.far, LOOK.horizon, smoothstep(3000, 12000, d)), hazeAt(d));
  })();
  return inkOnlyInPass(m, inkNode(0.5, 0, 0, 0.3));
}

/** The sea, out to the horizon: deep water, lighter toward the shore, a path of light under the sun. */
function seaMesh(site: FarSite, sea: number): THREE.Mesh {
  const last = site.run.path.at(-1)!;
  const geo = new THREE.RingGeometry(600, 26000, 40, 14, 0, Math.PI);
  geo.rotateX(-Math.PI / 2);
  // (Its half circle opens down the valley, toward +z.)
  geo.rotateY(Math.PI);
  geo.translate(last.x, sea, last.z + COAST - 1500);
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  const p = varying(positionGeometry);
  m.positionNode = withinSight(positionGeometry);
  m.colorNode = Fn(() => {
    const off = p.z.sub(last.z + COAST);
    const band = noise4(p.xz.mul(0.0009)).x;
    let c: THREE.Node<"vec3"> = mix(LOOK.seaLight, LOOK.seaMid, cut0(off.sub(500).add(band.mul(400))));
    c = mix(c, LOOK.seaDeep, cut0(off.sub(2600).add(band.mul(1200))));
    // The sun's path: streaks of light toward it.
    const toSun = normalize(SUN_DIR.xz);
    const away = p.xz.sub(cameraPosition.xz);
    const along = dot(normalize(away), toSun);
    const streak = noise4(p.xz.mul(vec2(0.004, 0.0007))).y;
    const glint = cut0(along.sub(0.985).add(streak.mul(0.012))).mul(LOOK.shadow);
    c = mix(c.mul(LOOK.lit), LOOK.glow, glint.mul(0.6));
    const d = p.distance(cameraPosition);
    return mix(c, mix(LOOK.far, LOOK.horizon, smoothstep(3000, 12000, d)), hazeAt(d));
  })();
  inkOnlyInPass(m, inkNode(0, 0, 0, 0));
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  return mesh;
}

/** The town on the shore: white houses under tiled roofs, too far to be more than that. */
function town(site: FarSite, land: (x: number, z: number) => number, sea: number): THREE.Mesh {
  const last = site.run.path.at(-1)!;
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const wall = new THREE.Color(0xf2ece0);
  const roof = new THREE.Color(0xc0693f);
  const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const bp = box.attributes.position!;
  const bn = box.attributes.normal!;
  let placed = 0;
  for (let k = 0; k < 900 && placed < 150; k++) {
    // Thick round its middle, thinning along the shore.
    const a = hash2(k, 1, 91) * Math.PI * 2;
    const r = hash2(k, 2, 91) ** 1.6;
    const x = last.x + 500 + Math.cos(a) * r * 1500;
    const z = last.z + COAST - 700 + Math.sin(a) * r * 520;
    const y = land(x, z);
    if (y < sea + 5 || y > sea + 90) continue;
    placed++;
    const w = 26 + hash2(k, 3, 91) * 34;
    const h = 14 + hash2(k, 4, 91) * 26 * (1 - r);
    const turn = hash2(k, 5, 91) * 0.6;
    const cs = Math.cos(turn);
    const sn = Math.sin(turn);
    for (let i = 0; i < bp.count; i++) {
      const lx = bp.getX(i) * w;
      const lz = bp.getZ(i) * w * 0.8;
      pos.push(x + lx * cs + lz * sn, y + (bp.getY(i) + 0.4) * h, z - lx * sn + lz * cs);
      nor.push(bn.getX(i) * cs + bn.getZ(i) * sn, bn.getY(i), -bn.getX(i) * sn + bn.getZ(i) * cs);
      const c = bn.getY(i) > 0.5 ? roof : wall;
      col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  const p = varying(positionGeometry);
  const normal = varying(normalGeometry);
  m.positionNode = withinSight(positionGeometry);
  m.colorNode = Fn(() => {
    const lit = toned(attribute<"vec3">("color", "vec3"), normalize(normal), vec3(0.62, 0.62, 0.86));
    const d = p.distance(cameraPosition);
    return mix(lit, LOOK.far, hazeAt(d));
  })();
  inkOnlyInPass(m, inkNode(0, 0, 0, 0));
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  return mesh;
}

/** The land beyond the mountain: the far ground, the sea and the town on the shore. */
export function farLandscape(site: FarSite): THREE.Group {
  const g = new THREE.Group();
  const land = landscape(site);
  const ground = new THREE.Mesh(sheet(site, land.height), landMaterial(land.sea, site.run.path[0]!.y));
  ground.frustumCulled = false;
  g.add(ground, seaMesh(site, land.sea), town(site, land.height, land.sea));
  g.userData.noMerge = true;
  return g;
}
