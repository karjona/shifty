// Scenery put together by hand: triangles, quads and whole geometries
// gathered into one mesh, each vertex with its colour (and, where the
// material wants them, a place in a texture and a weight for the wind), so
// a rock, a house or a whole town draws in one go.
import * as THREE from "three/webgpu";

/** A colour, or one worked out from where a vertex is and which way it faces. */
export type Paint = THREE.ColorRepresentation | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color);

export interface AddOptions {
  /** Facets instead of the geometry's own normals. */
  flat?: boolean;
  /** Where the geometry's texture coordinates land: a rectangle (u0, v0, u1, v1) of the material's texture. */
  uv?: readonly [number, number, number, number];
  /** The weight carried by every vertex (how far the wind moves it), or one worked out per vertex. */
  weight?: number | ((p: THREE.Vector3) => number);
  /** Texture coordinates worked out from where each vertex lands (in place of `uv`). */
  at?: (p: THREE.Vector3) => readonly [number, number];
}

const IDENTITY = new THREE.Matrix4();
const WHITE_UV = [0, 0, 0, 0] as const;

/** A transform: moved to `(x, y, z)`, turned `yaw` about y, scaled. */
export function place(x: number, y: number, z: number, yaw = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** A transform: moved to `(x, y, z)` and turned by Euler angles (XYZ order applied as YXZ: heading, then pitch, then roll). */
export function turned(x: number, y: number, z: number, rx: number, ry: number, rz: number, s = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")),
    new THREE.Vector3(s, s, s),
  );
}

export class Shape {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private uvs: number[] = [];
  private wts: number[] = [];
  private p = new THREE.Vector3();
  private n = new THREE.Vector3();
  private c = new THREE.Color();
  private nm = new THREE.Matrix3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  /** How many triangles it holds. */
  get triangles(): number {
    return this.pos.length / 9;
  }

  private colour(paint: Paint, p: THREE.Vector3, n: THREE.Vector3): THREE.Color {
    return typeof paint === "function" ? paint(p, n) : this.c.set(paint);
  }

  private push(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, u: number, v: number, w: number): void {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.uvs.push(u, v);
    this.wts.push(w);
  }

  /** Adds `geo` (left as it is), placed by `m`, painted (or, with `null`, in the colours it carries). */
  add(geo: THREE.BufferGeometry, paint: Paint | null, m: THREE.Matrix4 = IDENTITY, o: AddOptions = {}): this {
    const position = geo.attributes.position!;
    const normal = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const own = paint === null ? geo.attributes.color : undefined;
    const index = geo.index;
    const count = index ? index.count : position.count;
    const rect = o.uv ?? WHITE_UV;
    const mirrored = m.determinant() < 0;
    this.nm.getNormalMatrix(m);
    const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
    const facing = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
    const at = [0, 0, 0];
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = index ? index.getX(i + k) : i + k;
        at[k] = v;
        corner[k]!.fromBufferAttribute(position, v).applyMatrix4(m);
        if (normal && !o.flat) facing[k]!.fromBufferAttribute(normal, v).applyMatrix3(this.nm).normalize();
      }
      if (!normal || o.flat) {
        this.a.subVectors(corner[1], corner[0]);
        this.b.subVectors(corner[2], corner[0]);
        this.n.crossVectors(this.a, this.b).normalize();
        if (mirrored) this.n.negate();
        for (const f of facing) f.copy(this.n);
      }
      // A mirrored copy is wound the other way round.
      const order = mirrored ? [0, 2, 1] : [0, 1, 2];
      for (const k of order) {
        const p = corner[k]!;
        const n = facing[k]!;
        const placed = o.at?.(p);
        const u = placed ? placed[0] : uv ? rect[0] + uv.getX(at[k]!) * (rect[2] - rect[0]) : rect[0];
        const v = placed ? placed[1] : uv ? rect[1] + uv.getY(at[k]!) * (rect[3] - rect[1]) : rect[1];
        const w = typeof o.weight === "function" ? o.weight(p) : (o.weight ?? 0);
        const c = own ? this.c.fromBufferAttribute(own, at[k]!) : this.colour(paint ?? 0xffffff, p, n);
        this.push(p, n, c, u, v, w);
      }
    }
    return this;
  }

  /**
   * Goes over the vertices added since vertex `from`, in order: `touch` gets
   * each one's place in that run and its colour (to change), and returns
   * its weight.
   */
  retouch(from: number, touch: (i: number, colour: THREE.Color) => number): void {
    for (let v = from; v < this.wts.length; v++) {
      this.c.fromArray(this.col, v * 3);
      this.wts[v] = touch(v - from, this.c);
      this.c.toArray(this.col, v * 3);
    }
  }

  /** Adds `geo` and frees it. */
  take(geo: THREE.BufferGeometry, paint: Paint | null, m: THREE.Matrix4 = IDENTITY, o: AddOptions = {}): this {
    this.add(geo, paint, m, o);
    geo.dispose();
    return this;
  }

  /** A flat triangle (counter-clockwise seen from outside). */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, paint: Paint, weight = 0): this {
    this.a.subVectors(b, a);
    this.b.subVectors(c, a);
    this.n.crossVectors(this.a, this.b).normalize();
    for (const p of [a, b, c]) this.push(p, this.n, this.colour(paint, p, this.n), 0, 0, weight);
    return this;
  }

  /**
   * A flat quad (counter-clockwise seen from outside, `a` to `b` along its
   * foot), its texture rectangle running from `a` (u0, v0) to `c` (u1, v1).
   */
  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    paint: Paint,
    uv: readonly [number, number, number, number] = WHITE_UV,
    weight = 0,
  ): this {
    this.a.subVectors(b, a);
    this.b.subVectors(d, a);
    this.n.crossVectors(this.a, this.b).normalize();
    const n = this.n;
    const put = (p: THREE.Vector3, u: number, v: number) => this.push(p, n, this.colour(paint, p, n), u, v, weight);
    put(a, uv[0], uv[1]);
    put(b, uv[2], uv[1]);
    put(c, uv[2], uv[3]);
    put(a, uv[0], uv[1]);
    put(c, uv[2], uv[3]);
    put(d, uv[0], uv[3]);
    return this;
  }

  /** Everything added so far as one geometry: position, normal, colour, `uv` and `sway` (the weight). */
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute("sway", new THREE.Float32BufferAttribute(this.wts, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.uvs = [];
    this.wts = [];
    return g;
  }

  /** A mesh of everything added so far. */
  mesh(material: THREE.Material, shadows: "cast" | "receive" | "both" | "none" = "both"): THREE.Mesh {
    const mesh = new THREE.Mesh(this.build(), material);
    mesh.name = material.name;
    mesh.castShadow = shadows === "cast" || shadows === "both";
    mesh.receiveShadow = shadows === "receive" || shadows === "both";
    mesh.userData.noMerge = true;
    return mesh;
  }
}

/** A box `w` × `h` × `d` standing on y = 0. */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
}

/** A cylinder (or a cone frustum) standing on y = 0. */
export function post(r0: number, r1: number, h: number, sides = 8, rows = 1): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r1, r0, h, sides, rows).translate(0, h / 2, 0);
}

/** Seeded noise in [0, 1): a new stream per `seed`. */
export function random(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** One of `list`, picked by `r`. */
export function pick<T>(list: readonly T[], r: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(r() * list.length))]!;
}
