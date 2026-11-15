// The sierra round the valley: ranges of rock and snow standing on the far
// land's foothills (mountain-far.ts), two deep either side and one across
// the valley's head. Each is a crest line drawn by hand (its cols, its
// summits, a horn or a broad massif) with a face falling toward the valley,
// steep under the crest and easing to its foot, ribbed into buttresses with
// couloirs between. Rock shows where the face is steep and on the
// buttresses, in dark beds; snow lies in the couloirs, on the aprons and,
// in the cold seasons, over all of it. Lit in two flat tones, each range
// hazed a little more than the one in front.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  floor,
  hash,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  smoothstep,
  varying,
  vec3,
} from "three/tsl";
import { LOOK, cut0 } from "./cel/look.ts";
import { noise4 } from "./cel/noise.ts";
import { type FarSite, hazeAt, type landscape, lerp, noise2, ridged, toned, withinSight } from "./mountain-far.ts";
import { fadingInk } from "./mountain-look.ts";

/** A summit on a crest: where along it (0-1), how high over the valley floor (m), how wide (0-1 of the crest), and how pointed (1: a pyramid; more: a horn with hollow flanks; less: a dome). */
interface Summit {
  at: number;
  height: number;
  spread: number;
  horn: number;
}

/** A range: its crest through `line` (each `[x off the valley's axis, z, the crest's height over the valley floor between summits]`). */
interface Range {
  line: [number, number, number][];
  summits: Summit[];
  /** How far its face reaches out from under the crest (m). */
  width: number;
  /** How many ranges stand in front of it (0: none): it is hazed by that much more. */
  behind: number;
  seed: number;
}

/** Points along a crest, and down a face. */
const ALONG = 150;
const DOWN = 18;

/** The ranges of a valley: nearer and further ones either side, and one across its head. */
function rangesOf(length: number, ridgeStart: boolean): Range[] {
  const z = (k: number) => k * length;
  const head: Range = ridgeStart
    ? {
        // The start stands on a ridge: the head of the valley is a far range beyond the drop behind it.
        line: [
          [-4200, z(-2.3), 1250],
          [-1400, z(-2.7), 1400],
          [1300, z(-2.6), 1450],
          [4200, z(-2.2), 1250],
        ],
        summits: [
          { at: 0.3, height: 2050, spread: 0.13, horn: 1.5 },
          { at: 0.62, height: 1850, spread: 0.1, horn: 1.9 },
        ],
        width: 1500,
        behind: 1,
        seed: 5,
      }
    : {
        // The mountain the run comes down: its summit ridge, close behind the start.
        line: [
          [-2700, z(-0.75), 760],
          [-900, z(-1.05), 890],
          [700, z(-1.0), 910],
          [2700, z(-0.7), 760],
        ],
        summits: [
          { at: 0.4, height: 1260, spread: 0.19, horn: 1.35 },
          { at: 0.7, height: 1120, spread: 0.11, horn: 1.8 },
        ],
        width: 1100,
        behind: 0,
        seed: 5,
      };
  return [
    {
      // Left of the run: a long arête, and the horn that stands over the lower valley.
      line: [
        [-2300, z(-0.6), 730],
        [-1950, z(0.1), 690],
        [-2150, z(0.8), 610],
        [-1850, z(1.5), 480],
        [-1650, z(2.2), 260],
      ],
      summits: [
        { at: 0.16, height: 1010, spread: 0.12, horn: 1.4 },
        { at: 0.37, height: 900, spread: 0.11, horn: 1.6 },
        { at: 0.6, height: 1400, spread: 0.2, horn: 2.6 },
        { at: 0.84, height: 580, spread: 0.09, horn: 1.4 },
      ],
      width: 1000,
      behind: 0,
      seed: 1,
    },
    {
      // Right of the run: a broad massif with two summits, then teeth running down to the coast.
      line: [
        [2500, z(-0.6), 720],
        [2150, z(0.15), 680],
        [2400, z(0.85), 580],
        [2050, z(1.55), 460],
        [1900, z(2.2), 250],
      ],
      summits: [
        { at: 0.27, height: 1080, spread: 0.14, horn: 1.15 },
        { at: 0.36, height: 1010, spread: 0.11, horn: 1.3 },
        { at: 0.58, height: 790, spread: 0.09, horn: 1.9 },
        { at: 0.7, height: 730, spread: 0.08, horn: 1.7 },
        { at: 0.85, height: 520, spread: 0.08, horn: 1.4 },
      ],
      width: 1050,
      behind: 0,
      seed: 2,
    },
    {
      // Behind the left range: higher, further.
      line: [
        [-5600, z(-1.2), 1200],
        [-4800, z(0), 1140],
        [-5100, z(1.2), 960],
        [-4500, z(2.5), 550],
      ],
      summits: [
        { at: 0.22, height: 1750, spread: 0.14, horn: 1.5 },
        { at: 0.5, height: 1560, spread: 0.12, horn: 1.9 },
        { at: 0.76, height: 1050, spread: 0.09, horn: 1.4 },
      ],
      width: 1700,
      behind: 1,
      seed: 3,
    },
    {
      // Behind the right range.
      line: [
        [5700, z(-1.2), 1240],
        [5000, z(0.1), 1100],
        [5300, z(1.3), 920],
        [4700, z(2.6), 520],
      ],
      summits: [
        { at: 0.18, height: 1610, spread: 0.12, horn: 1.4 },
        { at: 0.44, height: 1840, spread: 0.17, horn: 1.25 },
        { at: 0.72, height: 1200, spread: 0.09, horn: 1.8 },
      ],
      width: 1700,
      behind: 1,
      seed: 4,
    },
    head,
  ];
}

/** A point on a polyline through `pts`, `t` (0-1) along it by index, eased through its corners. */
function through(pts: [number, number, number][], t: number): [number, number, number] {
  const n = pts.length - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(f);
  const k = f - i;
  // Catmull-Rom through the points.
  const p0 = pts[Math.max(0, i - 1)]!;
  const p1 = pts[i]!;
  const p2 = pts[i + 1]!;
  const p3 = pts[Math.min(n, i + 2)]!;
  const at = (c: 0 | 1 | 2) =>
    0.5 *
    (2 * p1[c] +
      (p2[c] - p0[c]) * k +
      (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * k * k +
      (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * k * k * k);
  return [at(0), at(1), at(2)];
}

/** One range's face: positions, normals, and per vertex how far down the face it is and how much of a buttress (1) or a couloir (0). */
function face(
  range: Range,
  land: ReturnType<typeof landscape>,
  out: { pos: number[]; nor: number[]; lie: number[]; index: number[] },
): void {
  const base = out.pos.length / 3;
  const seed = range.seed * 97;
  const rows: THREE.Vector3[][] = [];
  const ribs: number[][] = [];
  for (let i = 0; i <= ALONG; i++) {
    const t = i / ALONG;
    const [ox, z, ridge] = through(range.line, t);
    const [ox2, z2] = through(range.line, Math.min(1, t + 0.01));
    const [ox1, z1] = through(range.line, Math.max(0, t - 0.01));
    const x = land.axis(z) + ox;
    // The crest between summits, its teeth, and the summits standing over it; down to nothing at its ends.
    const ends = Math.min(1, t / 0.1, (1 - t) / 0.1) ** 0.7;
    let crest = ridge + 70 * ridged(t * 38, seed, seed + 1, 3) - 35;
    for (const s of range.summits) {
      const d = Math.abs(t - s.at) / s.spread;
      if (d < 1) crest = Math.max(crest, ridge + (s.height - ridge) * (1 - d) ** s.horn);
    }
    const relief = crest * ends;
    // The face falls toward the valley's axis, square to the crest.
    let nx = -(z2 - z1);
    let nz = ox2 - ox1;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const inward = Math.sign(nx * -ox + nz * (land.middle - z)) || 1;
    nx *= inward;
    nz *= inward;
    const footX = x + nx * range.width;
    const footZ = z + nz * range.width;
    const foot = land.height(footX, footZ) - 20;
    const top = land.floor(z) + relief;
    const row: THREE.Vector3[] = [];
    const rib: number[] = [];
    for (let j = 0; j <= DOWN; j++) {
      const v = j / DOWN;
      // Buttresses run down the face, wandering a little; they stand proud of it most at mid height.
      const wander = noise2(t * 9 + v * 0.7, v * 2.3, seed + 7) * 0.012;
      const r = ridged((t + wander) * 26, v * 0.8, seed + 3, 3);
      const fine = ridged((t + wander) * 71, v * 2.1, seed + 5, 2);
      const proud = Math.sin(Math.PI * v ** 0.75) * (r - 0.42) * 0.3 + Math.sin(Math.PI * v) * (fine - 0.5) * 0.07;
      // Steep under the crest, easing out to the foot.
      const fall = (1 - v) ** 2.3;
      const y = Math.max(foot, lerp(foot, top, Math.min(1, fall + proud * (1 - fall * 0.5))));
      // The crest zigzags; the buttresses push out from the face.
      const zig = (1 - v) * 60 * noise2(t * 31, 0.5, seed + 9);
      const reach = v * range.width - proud * range.width * 0.22;
      row.push(new THREE.Vector3(x + nx * reach - nz * zig, y, z + nz * reach + nx * zig));
      rib.push(Math.min(1, Math.max(0, (r - 0.2) * 1.5)));
    }
    rows.push(row);
    ribs.push(rib);
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i <= ALONG; i++) {
    for (let j = 0; j <= DOWN; j++) {
      const p = rows[i]![j]!;
      out.pos.push(p.x, p.y, p.z);
      // Normals from its neighbours along and down the face.
      a.copy(rows[Math.min(ALONG, i + 1)]![j]!).sub(rows[Math.max(0, i - 1)]![j]!);
      b.copy(rows[i]![Math.min(DOWN, j + 1)]!).sub(rows[i]![Math.max(0, j - 1)]!);
      a.cross(b).normalize();
      if (a.y < 0) a.negate();
      out.nor.push(a.x, a.y, a.z);
      out.lie.push(j / DOWN, ribs[i]![j]!, range.behind);
    }
  }
  for (let i = 0; i < ALONG; i++) {
    for (let j = 0; j < DOWN; j++) {
      const k = base + i * (DOWN + 1) + j;
      out.index.push(k, k + DOWN + 1, k + 1, k + 1, k + DOWN + 1, k + DOWN + 2);
    }
  }
}

/** The ranges' material (`lie`: how far down its face a vertex is, how much of a buttress, how many ranges in front). */
function rangeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false, side: THREE.DoubleSide });
  const p = varying(positionGeometry);
  const normal = varying(normalGeometry);
  const lie = varying(attribute<"vec3">("lie", "vec3"));
  m.positionNode = withinSight(positionGeometry);
  m.colorNode = Fn(() => {
    const n = normalize(normal);
    const wide = noise4(p.xz.mul(0.0016));
    const fine = noise4(p.xz.mul(0.011).add(p.y.mul(0.004)));
    const steep = float(1).sub(n.y);
    // Rock: where the face is steep, on the buttresses more than in the couloirs between them, in ragged patches.
    const bare = steep
      .sub(0.34)
      .mul(0.7)
      .add(lie.y.sub(0.5).mul(0.7))
      .add(fine.x.mul(0.1))
      .sub(smoothstep(0.5, 1, lie.x).mul(0.35));
    // The season's snow: over everything above its line in the cold, on the high ground only in summer.
    const line = p.y.sub(LOOK.snowLine).add(wide.x.mul(120)).add(fine.y.mul(40)).div(80);
    const snowed = cut0(line.sub(lie.y.mul(0.6)));
    // (Snow lies on a ledge across the rock here and there.)
    const band = p.y.add(p.x.mul(0.11)).sub(p.z.mul(0.05)).div(46);
    const ledged = cut0(hash(floor(band).mul(1.7).add(3)).sub(0.72)).mul(cut0(wide.w.add(0.2)));
    const rock = cut0(bare).mul(float(1).sub(ledged.mul(LOOK.snowCover)));
    // Beds across the rock, dipping one way: three tones of it, and a darker band now and then.
    const level = p.y.add(p.x.mul(0.11)).sub(p.z.mul(0.05)).add(wide.y.mul(40)).div(46);
    const bed = hash(floor(level).add(7));
    const tone = mix(float(0.78), float(1.12), bed).mul(
      mix(float(1), float(0.66), cut0(hash(floor(level).mul(3.1)).sub(0.84))),
    );
    const stone = mix(vec3(0.2, 0.18, 0.2), vec3(0.29, 0.25, 0.25), wide.z.mul(0.5).add(0.5)).mul(tone);
    // Below the snow: scree and meadow, as the far land has them.
    const scree = mix(LOOK.ground2, LOOK.ground, fine.z.mul(0.5).add(0.5));
    const snow = mix(vec3(0.84, 0.88, 0.97), vec3(0.94, 0.96, 1.0), wide.w.mul(0.5).add(0.5));
    const ground = mix(scree, snow, snowed);
    const c = mix(ground, stone, rock);
    const shade = mix(mix(vec3(0.58, 0.6, 0.88), vec3(0.5, 0.58, 1.0), snowed), vec3(0.56, 0.56, 0.86), rock);
    const lit = toned(c, n, shade);
    const d = p.distance(cameraPosition);
    // (Each range a layer of air behind the one in front.)
    const air = hazeAt(d);
    const haze = air.mul(air.mul(0.5).add(0.5)).add(lie.z.mul(0.2)).min(1);
    return mix(lit, mix(LOOK.far, LOOK.horizon, smoothstep(3000, 12000, d)), haze);
  })();
  return fadingInk(m, 0.9, 0, 0, 0.5);
}

/** The ranges round a run's valley, as one mesh. */
export function alpineRanges(site: FarSite, land: ReturnType<typeof landscape>): THREE.Mesh {
  const first = site.run.path[0]!;
  const last = site.run.path.at(-1)!;
  const out = { pos: [] as number[], nor: [] as number[], lie: [] as number[], index: [] as number[] };
  for (const range of rangesOf(last.z - first.z, site.ridgeStart)) face(range, land, out);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(out.nor, 3));
  geo.setAttribute("lie", new THREE.Float32BufferAttribute(out.lie, 3));
  geo.setIndex(out.index);
  const mesh = new THREE.Mesh(geo, rangeMaterial());
  mesh.frustumCulled = false;
  mesh.userData.noMerge = true;
  return mesh;
}
