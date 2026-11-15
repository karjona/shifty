// The coast's vegetation: stone pines (a bent trunk forking under a broad
// crown of lobes with flat bases), palms (a ringed trunk, fronds arching
// from the heart and hanging dead below it), cypresses, agaves and scrub.
// Each kind is a few shapes drawn many times (instanced); they sway with
// the wind and take the season's greens (see materials.ts).
import * as THREE from "three/webgpu";
import { foliageMaterial, frondMaterial } from "./materials.ts";
import { type Paint, Shape, place, random } from "./shape.ts";

const BARK = new THREE.Color(0x8a6a4c);
const BARK_DARK = new THREE.Color(0x6e5038);
const NEEDLES = new THREE.Color(0x4c8a3a);
const NEEDLES_TOP = new THREE.Color(0x5e9c44);
const NEEDLES_UNDER = new THREE.Color(0x2d5a30);
const FROND = new THREE.Color(0x4f8f3c);
const FROND_DARK = new THREE.Color(0x3c7434);
const FROND_DEAD = new THREE.Color(0xb39a58);
const CYPRESS = new THREE.Color(0x2f6034);
const CYPRESS_TOP = new THREE.Color(0x3c7240);
const AGAVE = new THREE.Color(0x6a9c7c);
const BUSH = [new THREE.Color(0x6a8e42), new THREE.Color(0x587c3a), new THREE.Color(0x7c9a4c)];

/** A pine's needles: dark under the crown, lightest on top. */
const needles: Paint = (_p, n) => (n.y < -0.5 ? NEEDLES_UNDER : n.y > 0.55 ? NEEDLES_TOP : NEEDLES);

/** A tube through `points` with a radius at each, `sides` round, smooth: a trunk or a limb. */
export function tube(points: THREE.Vector3[], radii: number[], sides: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const t = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  points.forEach((p, k) => {
    const next = points[Math.min(points.length - 1, k + 1)]!;
    const prev = points[Math.max(0, k - 1)]!;
    t.subVectors(next, prev).normalize();
    // (A frame across the tube: off the x axis, or the z axis where the tube runs along x.)
    if (Math.abs(t.x) < 0.9) u.set(1, 0, 0).addScaledVector(t, -t.x).normalize();
    else u.set(0, 0, 1).addScaledVector(t, -t.z).normalize();
    v.crossVectors(t, u);
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const nx = u.x * Math.cos(a) + v.x * Math.sin(a);
      const ny = u.y * Math.cos(a) + v.y * Math.sin(a);
      const nz = u.z * Math.cos(a) + v.z * Math.sin(a);
      const r = radii[k] ?? radii[radii.length - 1] ?? 0.1;
      pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r);
      nor.push(nx, ny, nz);
    }
  });
  for (let k = 0; k < points.length - 1; k++)
    for (let i = 0; i < sides; i++) {
      const a = k * sides + i;
      const b = k * sides + ((i + 1) % sides);
      idx.push(a, b, a + sides, b, b + sides, a + sides);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** A lobe of foliage: a ball about 1 in radius with a flat base at `base` (-1 to 0). */
function lobe(detail: number, base: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position!;
  const n = g.attributes.normal!;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < base) {
      p.setY(i, base);
      n.setXYZ(i, 0, -1, 0);
    }
  }
  return g;
}

/**
 * A stone pine about `height` tall with a crown `spread` across, its foot
 * at the origin. `lobes` is how many the crown is made of (fewer for one
 * seen from far).
 */
export function pineGeometry(seed: number, height: number, spread: number, lobes: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const lean = (r() - 0.5) * 2.4;
  const leanZ = (r() - 0.5) * 1.6;
  const top = height * 0.74;
  const weigh = (p: THREE.Vector3) => (p.y * Math.max(0, p.y)) / height;
  const trunk = [0, 0.3, 0.62, 1].map(
    (k) => new THREE.Vector3(lean * k * k + Math.sin(k * 3.1) * 0.25, top * k, leanZ * k * k),
  );
  s.take(tube(trunk, [0.34, 0.27, 0.22, 0.18], 6), (p) => (p.y < top * 0.5 ? BARK_DARK : BARK), undefined, {
    weight: weigh,
  });
  const head = trunk[3]!;
  const ball = lobe(1, -0.28);
  const paint = needles;
  const rad = spread / 2;
  // The crown: a big lobe over the trunk, smaller ones round and below it.
  const middle = new THREE.Vector3(head.x, head.y + rad * 0.42, head.z);
  s.add(ball, paint, place(middle.x, middle.y, middle.z, r() * 6, rad * 0.66, rad * 0.4, rad * 0.66), {
    weight: weigh,
  });
  const turn = r() * Math.PI * 2;
  for (let i = 0; i < lobes - 1; i++) {
    const a = turn + ((i + (r() - 0.5) * 0.5) / (lobes - 1)) * Math.PI * 2;
    const out = rad * (0.5 + r() * 0.16);
    const size = rad * (0.42 + r() * 0.16);
    const at = new THREE.Vector3(
      head.x + Math.cos(a) * out,
      head.y + rad * (0.12 + r() * 0.16),
      head.z + Math.sin(a) * out,
    );
    s.add(ball, paint, place(at.x, at.y, at.z, r() * 6, size, size * (0.5 + r() * 0.12), size), { weight: weigh });
    // A limb from the fork up into every other lobe.
    if (i % 2 === 0) {
      const fork = trunk[2]!.clone().lerp(head, 0.5);
      const knee = fork
        .clone()
        .lerp(at, 0.55)
        .add(new THREE.Vector3(0, -rad * 0.12, 0));
      s.take(
        tube([fork, knee, at.clone().add(new THREE.Vector3(0, -size * 0.1, 0))], [0.15, 0.11, 0.07], 4),
        BARK,
        undefined,
        {
          weight: weigh,
        },
      );
    }
  }
  ball.dispose();
  return s.build();
}

/** A palm about `height` tall to its heart, its foot at the origin. */
export function palmGeometry(seed: number, height: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const lean = (r() - 0.5) * 1.6;
  const leanZ = (r() - 0.5) * 1.2;
  const rings = 8;
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    pts.push(new THREE.Vector3(lean * t * t, height * t, leanZ * t * t));
    radii.push((0.36 - 0.1 * t + (k === 0 ? 0.1 : 0)) * (k % 2 === 0 ? 1 : 0.92));
  }
  const weigh = (p: THREE.Vector3) => (p.y * Math.max(0, p.y)) / height;
  const heart = pts[rings]!;
  s.take(tube(pts, radii, 7), (p) => (Math.floor((p.y / height) * rings * 2) % 2 === 0 ? BARK : BARK_DARK), undefined, {
    weight: weigh,
  });
  // The heart: the stubs of old fronds under the crown.
  s.take(
    new THREE.CylinderGeometry(0.5, 0.3, 0.9, 7),
    new THREE.Color(0x9a7a4a),
    place(heart.x, heart.y + 0.2, heart.z),
    {
      weight: weigh,
    },
  );
  const fronds = 15;
  for (let f = 0; f < fronds; f++) {
    const dead = f >= fronds - 3;
    const upper = f < 9;
    const a = (f / (upper ? 9 : 6)) * Math.PI * 2 + r() * 0.5;
    const rise = dead ? -0.5 - r() * 0.3 : upper ? 0.55 + r() * 0.55 : 0.05 + r() * 0.3;
    const length = dead ? 2.2 : 3.3 + r() * 0.9;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const segs = 6;
    const spine = (t: number) => {
      const reach = length * Math.cos(rise) * t * (1 - 0.12 * t);
      const y = length * (Math.sin(rise) * t - 0.62 * t * t);
      return new THREE.Vector3(heart.x + ca * reach, heart.y + 0.6 + y, heart.z + sa * reach);
    };
    const edge = (t: number, side: number, i: number) => {
      // Leaflets hang from the spine, in and out along it.
      const w = 0.62 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.95)), 0.6) * (i % 2 === 0 ? 1 : 0.72);
      const p = spine(t);
      return new THREE.Vector3(p.x - sa * w * side, p.y - w * 0.55, p.z + ca * w * side);
    };
    const colour = dead ? FROND_DEAD : f % 3 === 0 ? FROND_DARK : FROND;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const w0 = heart.y + length * t0;
      for (const side of [-1, 1]) {
        const a0 = spine(t0);
        const a1 = spine(t1);
        const e0 = edge(t0, side, i);
        const e1 = edge(t1, side, i + 1);
        const weight = weigh(heart) + (w0 - heart.y) * 1.6;
        if (side > 0) {
          s.tri(a0, e0, e1, colour, weight);
          s.tri(a0, e1, a1, colour, weight);
        } else {
          s.tri(a0, e1, e0, colour, weight);
          s.tri(a0, a1, e1, colour, weight);
        }
      }
    }
  }
  return s.build();
}

/** A cypress about `height` tall and `width` across, its foot at the origin. */
export function cypressGeometry(seed: number, height: number, width: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const profile: [number, number][] = [
    [0.3, 0.05],
    [0.8, 0.14],
    [1, 0.32],
    [0.92, 0.55],
    [0.62, 0.78],
    [0.28, 0.94],
    [0.02, 1],
  ];
  const g = new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2((x * width) / 2, y * height)),
    7,
  );
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (Math.sin(p.getY(i) * 2.1 + Math.atan2(p.getZ(i), p.getX(i)) * 3 + r() * 0.4) * 0.5 + 0.5) * 0.14;
    p.setXYZ(i, p.getX(i) * k, p.getY(i), p.getZ(i) * k);
  }
  const weigh = (q: THREE.Vector3) => (q.y * Math.max(0, q.y)) / height;
  s.take(g, (q) => (q.y > height * 0.6 ? CYPRESS_TOP : CYPRESS), undefined, { weight: weigh });
  s.take(new THREE.CylinderGeometry(0.12, 0.15, height * 0.08, 5).translate(0, height * 0.03, 0), BARK_DARK);
  return s.build();
}

/** An agave: a rosette of pointed leaves about 1.6 across. */
export function agaveGeometry(seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const leaves = 9;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + r() * 0.4;
    const rise = i % 2 === 0 ? 0.5 + r() * 0.3 : 1.0 + r() * 0.25;
    const length = 0.75 + r() * 0.35;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const at = (t: number, side: number) => {
      const w = 0.13 * (1 - t) * (t < 0.2 ? 0.6 + t * 2 : 1) * side;
      const reach = Math.cos(rise) * length * t;
      const y = Math.sin(rise) * length * t - 0.25 * t * t + Math.abs(side) * 0.05;
      return new THREE.Vector3(ca * reach - sa * w, y, sa * reach + ca * w);
    };
    for (const [t0, t1] of [
      [0, 0.5],
      [0.5, 1],
    ] as const) {
      s.tri(at(t0, 0), at(t0, 1), at(t1, 1), AGAVE, t1 * 0.5);
      s.tri(at(t0, 0), at(t1, 1), at(t1, 0), AGAVE, t1 * 0.5);
      s.tri(at(t0, 0), at(t1, -1), at(t0, -1), AGAVE, t1 * 0.5);
      s.tri(at(t0, 0), at(t1, 0), at(t1, -1), AGAVE, t1 * 0.5);
    }
  }
  return s.build();
}

/** A bush: a couple of low lobes about 1.5 across. */
export function bushGeometry(seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const s = new Shape();
  const ball = lobe(1, -0.2);
  const n = 2 + Math.floor(r() * 2);
  const tone = BUSH[Math.floor(r() * BUSH.length)]!;
  const dark = tone.clone().multiplyScalar(0.72);
  for (let i = 0; i < n; i++) {
    const size = 0.55 + r() * 0.35;
    s.add(
      ball,
      (_p, nn) => (nn.y < -0.3 ? dark : tone),
      place((r() - 0.5) * 0.9, size * 0.2, (r() - 0.5) * 0.9, r() * 6, size, size * (0.6 + r() * 0.25), size),
      { weight: (p) => p.y * 0.5 },
    );
  }
  ball.dispose();
  return s.build();
}

export type Plant = "pine" | "pineFar" | "palm" | "cypress" | "agave" | "bush";

interface Variant {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** The size (m) the shape was built at: an instance asks for its own. */
  size: number;
  shadows: boolean;
}

let kit: Record<Plant, Variant[]> | null = null;

/** The shapes every planting draws from (built once, shared). */
function variants(): Record<Plant, Variant[]> {
  if (kit) return kit;
  const foliage = foliageMaterial();
  const frond = frondMaterial();
  kit = {
    pine: [
      { geometry: pineGeometry(11, 9, 7.5, 7), material: foliage, size: 9, shadows: true },
      { geometry: pineGeometry(23, 9, 8.5, 6), material: foliage, size: 9, shadows: true },
      { geometry: pineGeometry(37, 9, 6.5, 6), material: foliage, size: 9, shadows: true },
    ],
    pineFar: [
      { geometry: pineGeometry(41, 9, 8, 4), material: foliage, size: 9, shadows: false },
      { geometry: pineGeometry(53, 9, 7, 3), material: foliage, size: 9, shadows: false },
    ],
    palm: [
      { geometry: palmGeometry(5, 7), material: frond, size: 7, shadows: true },
      { geometry: palmGeometry(9, 7), material: frond, size: 7, shadows: true },
    ],
    cypress: [
      { geometry: cypressGeometry(3, 10, 2.4), material: foliage, size: 10, shadows: true },
      { geometry: cypressGeometry(7, 10, 2.0), material: foliage, size: 10, shadows: true },
    ],
    agave: [{ geometry: agaveGeometry(2), material: frond, size: 1, shadows: false }],
    bush: [
      { geometry: bushGeometry(4), material: foliage, size: 1, shadows: false },
      { geometry: bushGeometry(6), material: foliage, size: 1, shadows: false },
    ],
  };
  return kit;
}

/**
 * Plants to stand somewhere: `add` them one by one, `build` draws each
 * kind's shapes as one batch. They are never turned (the wind blows the
 * same way through all of them), only sized and tinted.
 */
export class Planting {
  private items = new Map<Variant, { m: THREE.Matrix4; tint: number }[]>();
  private n = 0;

  /** A plant of `kind` at `(x, y, z)`, `size` tall (m; across for agaves and bushes), `tint` (about 1) its shade of green. */
  add(kind: Plant, x: number, y: number, z: number, size: number, tint = 1): void {
    const list = variants()[kind];
    const variant = list[this.n++ % list.length]!;
    const k = size / variant.size;
    // Wider or narrower than its height, a little: no two alike.
    const wide = k * (0.9 + ((this.n * 0.618) % 1) * 0.25);
    let batch = this.items.get(variant);
    if (!batch) this.items.set(variant, (batch = []));
    batch.push({ m: place(x, y, z, 0, wide, k, wide), tint });
  }

  build(): THREE.Group {
    const g = new THREE.Group();
    const c = new THREE.Color();
    for (const [variant, list] of this.items) {
      const mesh = new THREE.InstancedMesh(variant.geometry, variant.material, list.length);
      list.forEach((it, i) => {
        mesh.setMatrixAt(i, it.m);
        mesh.setColorAt(i, c.setScalar(it.tint));
      });
      mesh.castShadow = variant.shadows;
      mesh.receiveShadow = false;
      mesh.computeBoundingSphere();
      g.add(mesh);
    }
    g.userData.noMerge = true;
    return g;
  }
}
