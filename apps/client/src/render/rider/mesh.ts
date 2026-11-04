// Lofts body parts (and clothes over them) into skinned geometry: rings of
// cross-sections along each part, weighted to the skeleton.
import * as THREE from "three/webgpu";
import type { Influence, Part } from "./anatomy.ts";
import { ringAngles, sectionPoint } from "./curve.ts";

/** How finely riders are built. */
export interface Detail {
  /** Rings along a part, and vertices around a ring, at relative size 1. */
  rings: number;
  sides: number;
}

export interface TubeOptions {
  /** Range of the part's t to loft (defaults to the whole part). */
  from?: number;
  to?: number;
  /** Outward offset (m) at t, φ: clothes, hair. */
  offset?: (t: number, phi: number) => number;
  /**
   * Close the open ends with a lip back toward the body (the edge of a
   * sleeve, a hem): true goes nearly to the skin, a number keeps that
   * fraction of the offset (to stop on a garment underneath).
   */
  hemStart?: boolean | number;
  hemEnd?: boolean | number;
  /** Override the part's caps. */
  capStart?: boolean;
  capEnd?: boolean;
  /** Texture coordinates (defaults: u around from the back, v = t). */
  uv?: (t: number, phi: number) => [number, number];
  /** Scale the ring and side counts. */
  rings?: number;
  sides?: number;
}

const tmp = new THREE.Vector3();

export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private skinI: number[] = [];
  private skinW: number[] = [];
  private idx: number[] = [];
  readonly detail: Detail;

  constructor(detail: Detail) {
    this.detail = detail;
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  private vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, w: Influence[]): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    const top = [...w].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, x]) => s + x, 0) || 1;
    for (let k = 0; k < 4; k++) {
      this.skinI.push(top[k]?.[0] ?? 0);
      this.skinW.push((top[k]?.[1] ?? 0) / sum);
    }
    return i;
  }

  /**
   * The ts a part is lofted at between `a` and `b`: the part's own even
   * grid (the same for every layer over it, so a strap and the vest under
   * it bend at the same rings), its marks, and the two ends.
   */
  ringTs(part: Part, a: number, b: number, scale: number): number[] {
    const n = Math.max(2, Math.ceil(this.detail.rings * part.rings * scale));
    const step = (part.t1 - part.t0) / (n - 1);
    const ts = [a, b];
    for (let i = 0; i < n; i++) {
      const t = part.t0 + step * i;
      if (t > a && t < b) ts.push(t);
    }
    for (const m of part.marks) if (m > a && m < b) ts.push(m);
    ts.sort((x, y) => x - y);
    const out: number[] = [];
    const gap = step * 0.3;
    for (const t of ts) {
      if (out.length === 0 || t - out[out.length - 1]! > gap) out.push(t);
      else if (t === b) out[out.length - 1] = b;
    }
    if (out.length === 1) out.push(b);
    return out;
  }

  tube(part: Part, o: TubeOptions = {}): void {
    const a = Math.max(part.t0, o.from ?? part.t0);
    const b = Math.min(part.t1, o.to ?? part.t1);
    if (b - a < 1e-4) return;
    const offset = o.offset ?? (() => 0);
    const ts = this.ringTs(part, a, b, o.rings ?? 1);
    const sides = Math.max(4, Math.round((this.detail.sides * part.sides * (o.sides ?? 1)) / 2) * 2);
    // Columns from the back (-π) round through the front (0) to the back again (π, the seam).
    const columns = ringAngles(sides, part.frontBias);
    const uvOf = o.uv ?? ((t: number, phi: number) => [(phi + Math.PI) / (Math.PI * 2), t]);

    // Rings, with lips where a garment ends on the body.
    type Ring = { t: number; scale: number };
    const rings: Ring[] = ts.map((t) => ({ t, scale: 1 }));
    const lip = (h: boolean | number) => (h === true ? 0.15 : Number(h));
    if (o.hemStart) rings.unshift({ t: a, scale: lip(o.hemStart) });
    if (o.hemEnd) rings.push({ t: b, scale: lip(o.hemEnd) });

    const grid: THREE.Vector3[][] = rings.map(({ t, scale }) => {
      const s = part.at(t);
      return columns.map((phi) =>
        sectionPoint(s, phi, offset(t, phi) * scale - (scale < 1 ? 0.002 : 0), new THREE.Vector3()),
      );
    });
    const capStart = (o.capStart ?? true) && part.capStart && a === part.t0;
    const capEnd = (o.capEnd ?? true) && part.capEnd && b === part.t1;
    const capPoint = (p: THREE.Vector3, t: number) => {
      const c = part.at(t).c;
      return p.clone().add(p.clone().sub(c).normalize().multiplyScalar(offset(t, 0)));
    };
    this.surface(grid, {
      vertex: (r, c, p) => {
        const t = rings[r]!.t;
        const phi = columns[c]!;
        return { uv: uvOf(t, phi), weights: part.weights(t, phi, p) };
      },
      centre: (r) => part.at(rings[r]!.t).c,
      capStart: capStart ? capPoint(part.capStart!, a) : null,
      capEnd: capEnd ? capPoint(part.capEnd!, b) : null,
    });
  }

  /**
   * A grid of points wrapped round (rows of columns; each row's last point
   * is its first again, the texture seam), shaded smooth, facing away from
   * `centre`, optionally closed at either end with a point.
   */
  surface(
    grid: THREE.Vector3[][],
    o: {
      vertex: (r: number, c: number, p: THREE.Vector3) => { uv: [number, number]; weights: Influence[] };
      centre: (r: number) => THREE.Vector3;
      capStart?: THREE.Vector3 | null;
      capEnd?: THREE.Vector3 | null;
    },
  ): void {
    const R = grid.length;
    const C = grid[0]!.length;
    // Smooth normals across the grid (the seam column shares its twin's).
    const normals: THREE.Vector3[][] = grid.map((row, r) =>
      row.map((_, c) => {
        const cc = c === C - 1 ? 0 : c;
        const left = grid[r]![(cc - 1 + (C - 1)) % (C - 1)]!;
        const right = grid[r]![(cc + 1) % (C - 1)]!;
        const down = grid[Math.max(0, r - 1)]![cc]!;
        const up = grid[Math.min(R - 1, r + 1)]![cc]!;
        const n = new THREE.Vector3().crossVectors(right.clone().sub(left), up.clone().sub(down));
        if (n.lengthSq() < 1e-14) n.copy(grid[r]![cc]!).sub(o.centre(r));
        return n.normalize();
      }),
    );
    // Outward? Compare with the direction from the centre.
    let outward = 0;
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C - 1; c++) outward += normals[r]![c]!.dot(tmp.copy(grid[r]![c]!).sub(o.centre(r)));
    const flip = outward < 0;
    if (flip) for (const row of normals) for (const n of row) n.negate();

    const ids: number[][] = grid.map((row, r) =>
      row.map((p, c) => {
        const { uv, weights } = o.vertex(r, c, p);
        return this.vertex(p, normals[r]![c]!, uv[0], uv[1], weights);
      }),
    );
    for (let r = 0; r < R - 1; r++)
      for (let c = 0; c < C - 1; c++) {
        const i0 = ids[r]![c]!;
        const i1 = ids[r]![c + 1]!;
        const i2 = ids[r + 1]![c + 1]!;
        const i3 = ids[r + 1]![c]!;
        if (flip) this.idx.push(i0, i3, i1, i1, i3, i2);
        else this.idx.push(i0, i1, i3, i1, i2, i3);
      }

    // Caps: a fan to a single point, continuing the winding past the end row.
    const cap = (point: THREE.Vector3, r: number, start: boolean) => {
      const n = point.clone().sub(o.centre(r)).normalize();
      const { uv, weights } = o.vertex(r, 0, point);
      const centreId = this.vertex(point, n, 0.5, uv[1] + (start ? -0.01 : 0.01), weights);
      for (let c = 0; c < C - 1; c++) {
        const i0 = ids[r]![c]!;
        const i1 = ids[r]![c + 1]!;
        if (start !== flip) this.idx.push(i1, i0, centreId);
        else this.idx.push(i0, i1, centreId);
      }
    };
    if (o.capStart) cap(o.capStart, 0, true);
    if (o.capEnd) cap(o.capEnd, R - 1, false);
  }

  /**
   * Adds rigid geometry (a cap's peak, goggles): `geo` in model space,
   * moved by one bone.
   */
  rigid(geo: THREE.BufferGeometry, bone: number): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const uv = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) {
      const id = this.vertex(
        tmp.set(p.getX(i), p.getY(i), p.getZ(i)),
        new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)),
        uv ? uv.getX(i) : 0,
        uv ? uv.getY(i) : 0,
        [[bone, 1]],
      );
      this.idx.push(id);
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.skinI, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.skinW, 4));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}
