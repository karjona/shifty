// Hair: five styles per body. Each is a shell over the scalp (from the
// hairline to the crown), with long hair hanging below it and ties (a
// ponytail, a bun) where the style has them. Under a hat only what shows
// below the hat line is built. The scalp under the shell is painted in the
// hair colour on the face texture, so short styles read even where the
// shell is thin.
import * as THREE from "three/webgpu";
import type { Look } from "@shifty/rider";
import { type Anatomy, BONE, type Influence } from "./anatomy.ts";
import { bell, keyed, ringAngles, sectionPoint, smoothstep } from "./curve.ts";
import type { MeshBuilder } from "./mesh.ts";

interface HairStyle {
  /** Hairline height (head units) by |φ| (0 front, π back), and a shift for side partings. */
  hairline: readonly (readonly number[])[];
  /** Shell thickness (m) at angle φ and head height u. */
  thick: (phi: number, u: number) => number;
  /** Hanging length below the shell (m) by φ; 0 = none. */
  hang?: (phi: number) => number;
  /** A tie at the back: a ponytail from this head height. */
  ponytail?: { u: number; length: number; radius: number };
  bun?: { u: number; phi: number; radius: number };
  /** Lowers the hairline over the forehead on one side (a fringe), by φ. */
  fringe?: (phi: number) => number;
}

const NAPE = [
  [0, 0.8],
  [0.55, 0.775],
  [0.9, 0.71],
  [1.25, 0.6],
  [1.6, 0.56],
  [2.0, 0.42],
  [2.6, 0.25],
  [Math.PI, 0.2],
];

const COVER_EARS = [
  [0, 0.8],
  [0.55, 0.77],
  [0.9, 0.68],
  [1.25, 0.5],
  [1.6, 0.36],
  [2.0, 0.3],
  [2.6, 0.24],
  [Math.PI, 0.2],
];

const top = (u: number) => smoothstep(0.55, 0.9, u);
const back = (phi: number) => smoothstep(1.6, 2.6, Math.abs(phi));

const MALE: HairStyle[] = [
  // Buzz cut: painted on.
  { hairline: NAPE, thick: () => 0.0015 },
  // Short crop.
  { hairline: NAPE, thick: (_p, u) => 0.005 + top(u) * 0.009 },
  // Side-swept, longer on top.
  {
    hairline: NAPE,
    thick: (phi, u) => 0.006 + top(u) * (0.016 + 0.008 * Math.tanh(phi * 1.5)),
    fringe: (phi) => bell(phi - 0.25, 0.35) * 0.07,
  },
  // Curly top, faded sides.
  {
    hairline: NAPE,
    thick: (phi, u) => 0.003 + top(u) * (0.024 + 0.006 * Math.sin(phi * 9) * Math.sin(u * 40)),
  },
  // Long, to the neck (surfer).
  {
    hairline: COVER_EARS,
    thick: (_p, u) => 0.012 + top(u) * 0.008,
    hang: (phi) => smoothstep(0.75, 1.5, Math.abs(phi)) * (0.07 + back(phi) * 0.07),
  },
];

const FEMALE: HairStyle[] = [
  // Pixie.
  {
    hairline: NAPE,
    thick: (phi, u) => 0.005 + top(u) * (0.011 + 0.004 * Math.tanh(-phi * 2)),
    fringe: (phi) => bell(phi + 0.2, 0.4) * 0.09,
  },
  // Bob, to the jaw.
  {
    hairline: COVER_EARS,
    thick: (_p, u) => 0.011 + top(u) * 0.007,
    hang: (phi) => smoothstep(0.7, 1.3, Math.abs(phi)) * (0.085 - back(phi) * 0.02),
    fringe: (phi) => bell(phi, 0.55) * 0.11,
  },
  // Ponytail, pulled back.
  {
    hairline: NAPE,
    thick: (_p, u) => 0.004 + top(u) * 0.006,
    ponytail: { u: 0.62, length: 0.24, radius: 0.022 },
  },
  // Long and straight, past the shoulders.
  {
    hairline: COVER_EARS,
    thick: (_p, u) => 0.011 + top(u) * 0.007,
    hang: (phi) => smoothstep(0.7, 1.3, Math.abs(phi)) * (0.13 + back(phi) * 0.15),
  },
  // High bun.
  {
    hairline: NAPE,
    thick: (_p, u) => 0.004 + top(u) * 0.006,
    bun: { u: 0.93, phi: Math.PI, radius: 0.042 },
  },
];

export function hairStyle(look: Look): HairStyle {
  const set = look.body === "male" ? MALE : FEMALE;
  return set[look.hair] ?? set[0]!;
}

/** Where the hair starts, by φ (head units), for painting the scalp. */
export function hairline(look: Look): (phi: number) => number {
  const style = hairStyle(look);
  const line = keyed(style.hairline);
  return (phi) => line(Math.abs(phi))[0]! - (style.fringe?.(phi) ?? 0) * 0.5;
}

/**
 * Builds the hair into `mesh`. `hat` is the hat's lower edge (head units)
 * by φ, if a hat is worn: nothing above it is built.
 */
export function buildHair(mesh: MeshBuilder, a: Anatomy, look: Look, hat: ((phi: number) => number) | null): void {
  const style = hairStyle(look);
  if (look.body === "male" && look.hair === 0) return;
  const line = keyed(style.hairline);
  const hs = a.headH / 0.226;
  const sides = Math.max(10, Math.round((mesh.detail.sides * 1.6) / 2) * 2);
  const columns = ringAngles(sides, 0.35);
  const rows = Math.max(4, Math.round(mesh.detail.rings * 0.9));
  const crownU = 0.985;
  const weightsAt = (u: number): Influence[] => {
    // Hair below the head follows the neck, then the shoulders.
    if (u >= 0.15) return [[BONE.head, 1]];
    const k = smoothstep(-0.6, 0.15, u);
    return [
      [BONE.head, k],
      [BONE.neck, (1 - k) * 0.6],
      [BONE.chest, (1 - k) * 0.4],
    ];
  };

  // The shell: rows from the hanging ends (if any) up through the hairline
  // to the crown (or the hat line).
  const lineAt = (phi: number) => line(Math.abs(phi))[0]! - (style.fringe?.(phi) ?? 0);
  const hangRows = style.hang ? Math.max(2, Math.round(rows * 0.6)) : 0;
  const grid: THREE.Vector3[][] = [];
  const meta: { u: number; v: number }[][] = [];
  const scalpPoint = (phi: number, u: number, extra = 0) =>
    sectionPoint(
      a.headAt(u),
      phi,
      style.thick(phi, u) * smoothstep(lineAt(phi) - 0.02, lineAt(phi) + 0.05, u) + 0.0012 + extra,
      new THREE.Vector3(),
    );
  for (let r = -hangRows; r <= rows; r++) {
    const row: THREE.Vector3[] = [];
    const rowMeta: { u: number; v: number }[] = [];
    for (const phi of columns) {
      const start = lineAt(phi);
      const end = hat ? Math.min(crownU, Math.max(start, hat(phi) + 0.015)) : crownU;
      if (r >= 0) {
        const u = start + (end - start) * (r / rows);
        // The lowest row tucks onto the scalp: a clean edge.
        row.push(
          r === 0 && !style.hang ? sectionPoint(a.headAt(u), phi, 0.0005, new THREE.Vector3()) : scalpPoint(phi, u),
        );
        rowMeta.push({ u, v: 0.3 + 0.7 * (r / rows) });
      } else {
        // Hanging below the hairline: straight down, flaring a little, and
        // sloping back so it clears the shoulders.
        const len = style.hang!(phi) * hs;
        const f = -r / hangRows;
        const from = scalpPoint(phi, start);
        const out = new THREE.Vector3(from.x, 0, from.z + 0.012).normalize();
        const p = from
          .clone()
          .addScaledVector(new THREE.Vector3(0, -1, 0), len * f)
          .addScaledVector(out, (0.006 + len * 0.12) * f)
          .add(new THREE.Vector3(0, 0, -0.03 * f * back(phi)));
        row.push(p);
        rowMeta.push({ u: start - (len * f) / a.headH, v: 0.3 * (1 - f) });
      }
    }
    grid.push(row);
    meta.push(rowMeta);
  }
  // Long hair: the ends fold back in, so the shell has some thickness at the tips.
  if (style.hang) {
    const tip = grid[0]!.map((p, c) => {
      const phi = columns[c]!;
      const inward = new THREE.Vector3(-p.x, 0, -p.z - 0.01).normalize();
      return p
        .clone()
        .addScaledVector(inward, style.hang!(phi) > 0.01 ? 0.014 : 0.002)
        .add(new THREE.Vector3(0, 0.004, 0));
    });
    grid.unshift(tip);
    meta.unshift(meta[0]!.map((m) => ({ u: m.u, v: 0 })));
  }
  const crown = a.headAt(crownU).c.clone();
  const topThick = style.thick(Math.PI, crownU);
  const fullTop = !hat;
  mesh.surface(grid, {
    vertex: (r, c) => {
      const m = meta[Math.min(r, meta.length - 1)]![c]!;
      return { uv: [((columns[c]! + Math.PI) / (Math.PI * 2)) * 6, m.v], weights: weightsAt(m.u) };
    },
    centre: (r) => {
      const u = Math.min(crownU, meta[Math.min(r, meta.length - 1)]![0]!.u);
      return new THREE.Vector3(0, a.chinY + u * a.headH, -0.012);
    },
    capEnd: fullTop ? new THREE.Vector3(crown.x, a.height + topThick + 0.001, crown.z) : null,
  });

  if (style.ponytail) {
    const p = style.ponytail;
    const s = a.headAt(p.u);
    const root = sectionPoint(s, Math.PI, style.thick(Math.PI, p.u) - 0.004, new THREE.Vector3());
    const dir = new THREE.Vector3(0, -0.75, -0.66).normalize();
    tie(mesh, root, dir, p.length * hs, p.radius * hs, sides, (t) => weightsAt(p.u - t * 1.6));
  }
  if (style.bun && !hat) {
    const b = style.bun;
    const s = a.headAt(b.u);
    const centre = sectionPoint(s, b.phi, style.thick(b.phi, b.u) + b.radius * 0.6, new THREE.Vector3());
    const geo = new THREE.SphereGeometry(b.radius * hs, Math.max(8, sides / 2), Math.max(6, sides / 3));
    geo.scale(1, 0.8, 1);
    geo.translate(centre.x, centre.y, centre.z);
    mesh.rigid(geo, BONE.head);
  }
}

/** A tapered tie of hair (a ponytail) hanging from `root` along `dir`. */
function tie(
  mesh: MeshBuilder,
  root: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  radius: number,
  sides: number,
  weights: (t: number) => Influence[],
): void {
  const n = 7;
  const side = new THREE.Vector3(1, 0, 0);
  const front = new THREE.Vector3().crossVectors(side, dir).normalize();
  const cols = ringAngles(Math.max(6, sides / 2), 0);
  const grid: THREE.Vector3[][] = [];
  const centres: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Gathered at the band, full below it, tapering to the tip; it curls under a little.
    const r = radius * (t < 0.12 ? 0.55 + t * 3 : 1.05 - t * 0.75);
    const c = root
      .clone()
      .addScaledVector(dir, t * length)
      .add(new THREE.Vector3(0, 0, length * 0.18 * t * t));
    centres.push(c);
    grid.push(
      cols.map((phi) =>
        c
          .clone()
          .addScaledVector(side, Math.sin(phi) * r)
          .addScaledVector(front, Math.cos(phi) * r * 0.8),
      ),
    );
  }
  mesh.surface(grid, {
    vertex: (r, c) => ({ uv: [(c / (cols.length - 1)) * 2, 1 - r / n], weights: weights(r / n) }),
    centre: (r) => centres[r]!,
    capStart: root.clone(),
    capEnd: centres[n]!.clone().addScaledVector(dir, radius * 0.4),
  });
}
