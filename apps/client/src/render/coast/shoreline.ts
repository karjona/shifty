// A shore as lines: the outline of land given as a distance field
// (negative inside the land), traced over a rectangle into chains of points
// a couple of metres apart, each with the way out to sea.

/** A point on a shore, and the unit normal out to sea. */
export interface Trace {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

export interface TraceBounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The grid the shore is traced on (m). */
  cell: number;
}

/**
 * The shores of the land `distance` describes inside `b`: each a chain of
 * points in order along it, and whether it closes on itself.
 */
export function traceShore(
  distance: (x: number, z: number) => number,
  b: TraceBounds,
): { points: Trace[]; closed: boolean }[] {
  const nx = Math.round((b.x1 - b.x0) / b.cell) + 1;
  const nz = Math.round((b.z1 - b.z0) / b.cell) + 1;
  const v = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) v[j * nx + i] = distance(b.x0 + i * b.cell, b.z0 + j * b.cell);
  const at = (i: number, j: number) => v[j * nx + i]!;
  // A crossing lies on a grid edge: edges along x are numbered first, then edges along z.
  const across = (i: number, j: number) => j * nx + i;
  const down = (i: number, j: number) => nx * nz + j * nx + i;
  const where = new Map<number, [number, number]>();
  const cross = (id: number, ax: number, az: number, bx: number, bz: number, va: number, vb: number) => {
    if (!where.has(id)) {
      const t = va / (va - vb);
      where.set(id, [ax + (bx - ax) * t, az + (bz - az) * t]);
    }
    return id;
  };
  const links = new Map<number, number[]>();
  const link = (p: number, q: number) => {
    for (const [from, to] of [
      [p, q],
      [q, p],
    ] as const) {
      const list = links.get(from);
      if (list) list.push(to);
      else links.set(from, [to]);
    }
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = at(i, j);
      const bb = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      const code = (a < 0 ? 1 : 0) | (bb < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const x = b.x0 + i * b.cell;
      const z = b.z0 + j * b.cell;
      const top = () => cross(across(i, j), x, z, x + b.cell, z, a, bb);
      const right = () => cross(down(i + 1, j), x + b.cell, z, x + b.cell, z + b.cell, bb, c);
      const bottom = () => cross(across(i, j + 1), x, z + b.cell, x + b.cell, z + b.cell, d, c);
      const left = () => cross(down(i, j), x, z, x, z + b.cell, a, d);
      switch (code) {
        case 1:
        case 14:
          link(left(), top());
          break;
        case 2:
        case 13:
          link(top(), right());
          break;
        case 4:
        case 11:
          link(right(), bottom());
          break;
        case 8:
        case 7:
          link(bottom(), left());
          break;
        case 3:
        case 12:
          link(left(), right());
          break;
        case 6:
        case 9:
          link(top(), bottom());
          break;
        case 5:
          link(left(), top());
          link(right(), bottom());
          break;
        default:
          link(top(), right());
          link(bottom(), left());
      }
    }
  }
  const seen = new Set<number>();
  const chains: { points: Trace[]; closed: boolean }[] = [];
  const normal = (x: number, z: number): [number, number] => {
    const h = 0.6;
    const gx = distance(x + h, z) - distance(x - h, z);
    const gz = distance(x, z + h) - distance(x, z - h);
    const len = Math.hypot(gx, gz) || 1;
    return [gx / len, gz / len];
  };
  const walk = (start: number): number[] => {
    const ids = [start];
    seen.add(start);
    let here = start;
    for (;;) {
      const next = (links.get(here) ?? []).find((n) => !seen.has(n));
      if (next === undefined) break;
      seen.add(next);
      ids.push(next);
      here = next;
    }
    return ids;
  };
  const chain = (ids: number[], closed: boolean) => {
    const points: Trace[] = [];
    for (const id of ids) {
      const [x, z] = where.get(id)!;
      const last = points[points.length - 1];
      if (last && Math.hypot(last.x - x, last.z - z) < b.cell * 0.35) continue;
      const [gx, gz] = normal(x, z);
      points.push({ x, z, nx: gx, nz: gz });
    }
    if (points.length > 2) chains.push({ points, closed });
  };
  // Open chains start where a shore meets the rectangle's edge; the rest close on themselves.
  for (const [id, to] of links) if (to.length === 1 && !seen.has(id)) chain(walk(id), false);
  for (const id of links.keys()) if (!seen.has(id)) chain(walk(id), true);
  return chains;
}

/** Cuts `points` into runs where `keep` holds (a closed chain that is cut becomes open runs). */
export function cutShore<T>(
  points: readonly T[],
  closed: boolean,
  keep: (p: T) => boolean,
): { points: T[]; closed: boolean }[] {
  if (points.every(keep)) return [{ points: [...points], closed }];
  const out: { points: T[]; closed: boolean }[] = [];
  // Start a closed chain at a gap, so no run straddles its seam.
  const from = closed ? points.findIndex((p) => !keep(p)) : 0;
  let run: T[] = [];
  for (let k = 0; k < points.length; k++) {
    const p = points[(from + k) % points.length]!;
    if (keep(p)) run.push(p);
    else {
      if (run.length > 2) out.push({ points: run, closed: false });
      run = [];
    }
  }
  if (run.length > 2) out.push({ points: run, closed: false });
  return out;
}
