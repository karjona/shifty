// Riders in the cel look. The art's mask gives flat colour regions (skin,
// eyes, hair; or a garment's three colours), which become the cel albedo;
// the art's painted light is kept only as a nudge on where the shade line
// falls (shade gathers where the painter darkened: under the chin, in the
// folds), as hand-tuned shading does in fighting games. Skin shades warm,
// cloth shades cool. Every piece gets an ink outline: its own shell, a
// little larger and inside out, so lines hug the figure and thicken on
// the side away from the light.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  clamp,
  dot,
  float,
  floor,
  max,
  min,
  mix,
  mod,
  modelViewMatrix,
  modelWorldMatrix,
  normalLocal,
  positionLocal,
  pow,
  smoothstep,
  texture,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import type { Finish } from "../rider/assets.ts";
import { CelMaterial, SUN_DIR, inkNode, inkOnlyInPass } from "./material.ts";

export type TintKind = "kit" | "look" | "hair";

/** World size of one pixel of the drawing buffer at one metre away (set per frame). */
export const PIXEL_AT_1M = uniform(0.001);
/** How much darker than its surroundings a brush stroke must be to draw as an inner line. */
const INNER_LINES = 0.1;
/** Outline width of the riders, in pixels. */
export const RIDER_LINE = uniform(3.2);

const WARM_SHADE = new THREE.Color(0.86, 0.62, 0.66);
const COOL_SHADE = new THREE.Color(0.66, 0.62, 0.86);

/** What a face wears over its paint. */
export interface FaceOverlays {
  /** How much of each texel the brows and the beard cover, in the hair's colour. */
  brows: THREE.Texture;
  beard: THREE.Texture;
  /** The eye, nose and mouth presets' paint: ink lines, how the preset's shape moves the shade line (0.5 not at
   * all), and the iris (in the eye's colour) up to 0.5 then its catchlight. */
  features: readonly THREE.Texture[];
}

/** How the overlays paint (tint factors, as the art paints them: art/rider/mhface.py). */
const BROW_TONE = 0.15;
const BEARD_TONE = 0.4;
const INK_TONE = 0.03;
const IRIS_TONE = 0.41;
const GLINT_TONE = 0.95;
/** How far a face preset's shape can move the shade line. */
const SHAPE_SHADE = 1.2;

/** An overlay that covers nothing. */
export const NO_OVERLAY = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
NO_OVERLAY.needsUpdate = true;

export class CelTintMaterial extends CelMaterial {
  private main = uniform(new THREE.Color());
  private second = uniform(new THREE.Color());
  private accent = uniform(new THREE.Color());
  private hidden = uniform(0);
  /** The flat colour, also used by the outline. */
  readonly albedo: THREE.Node<"vec3">;
  readonly regionMask: THREE.Node<"bool"> | null = null;

  constructor(
    detail: THREE.Texture,
    mask: THREE.Texture,
    finish: Finish,
    regions: boolean,
    kind: TintKind,
    id = 0,
    /** The head: lit but for a clean shape of shade on the far side. */
    face = false,
    /** The paint without baked light, if the art has it: the albedo comes from it. */
    flat: THREE.Texture | null = null,
    /** The brows and beard over the flat paint. */
    overlays: FaceOverlays | null = null,
  ) {
    const glossy = finish.roughness < 0.45;
    super({
      id,
      shade: COOL_SHADE,
      threshold: face ? -0.3 : kind === "look" ? -0.08 : 0.02,
      spec: glossy ? 0.55 : kind === "look" && !face ? 0.06 : 0,
      specSize: glossy ? 0.035 : 0.1,
      rim: face ? 0 : kind === "look" ? 0.3 : 0.6,
      // The shell draws the outline; the ink pass adds lines where pieces meet, and sharp folds.
      silhouette: 0,
      crease: 0.7,
    });
    if (regions) {
      const region = floor(attribute<"float">("_region", "float").add(0.5));
      this.regionMask = mod(floor(this.hidden.div(pow(2, region))), 2).lessThan(0.5);
      this.maskNode = this.regionMask;
    }
    const [t0, t1, t2] = [this.main, this.second, this.accent];
    const g = texture(detail).rgb;
    // The face's overlays, in order: the presets' features, the beard, the brows. Each moves the mask (which
    // colour tints a texel) and the flat paint (by how much).
    let w: THREE.Node<"vec3"> = texture(mask).rgb;
    let paint: THREE.Node<"vec3"> | null = flat ? texture(flat).rgb : null;
    const over = (cover: THREE.Node<"float">, tint: THREE.Node<"vec3">, tone: THREE.Node<"vec3">) => {
      w = mix(w, tint, cover);
      if (paint) paint = mix(paint, tone, cover);
    };
    const none = vec3(0, 0, 0);
    let shapeShade: THREE.Node<"float"> = float(0);
    for (const t of overlays?.features ?? []) {
      const o = texture(t).rgb;
      const iris = clamp(o.z.mul(2), 0, 1);
      over(iris, vec3(0, 1, 0), vec3(IRIS_TONE));
      // (From a softer level, so the shade line runs in clean shapes; the art stores "no change" as 128.)
      shapeShade = shapeShade.add(
        texture(t)
          .level(float(2))
          .g.sub(128 / 255)
          .mul(2),
      );
      over(o.x, none, vec3(INK_TONE));
      over(clamp(o.z.mul(2).sub(1), 0, 1), none, vec3(GLINT_TONE));
    }
    // The brows and the beard take the hair's colour (the mask's third channel) where they cover the face.
    if (overlays) {
      const hairMask = vec3(0, 0, 1);
      over(texture(overlays.beard).r, hairMask, vec3(BEARD_TONE));
      over(texture(overlays.brows).r, hairMask, vec3(BROW_TONE));
    }
    const sum = w.x.add(w.y).add(w.z);
    const lum = dot(g, vec3(0.299, 0.587, 0.114));
    this.albedo = Fn(() => {
      const tint = t0.mul(w.x).add(t1.mul(w.y)).add(t2.mul(w.z)).div(max(sum, 1e-4));
      if (flat) {
        // Unlit paint: the tint scaled by its factor (0.5 = the tint itself), hue kept past full brightness.
        const f = paint ?? texture(flat).rgb;
        const lit = tint.mul(f.mul(2));
        const top = max(max(lit.x, lit.y), lit.z);
        const tinted = min(lit.div(max(top, 1)).add(clamp(top.sub(1), 0, 1).mul(0.5)), vec3(1));
        return mix(pow(f, vec3(2.2)), tinted, clamp(sum, 0, 1));
      }
      // Dark paint inside a colour (seams, lash lines, the mouth) stays as a mark, and so do
      // the painter's dark strokes (folds, seams, muscle lines): darker than the paint around them.
      const around = dot(texture(detail).level(float(3)).rgb, vec3(0.299, 0.587, 0.114));
      // (Skin needs a bolder stroke than cloth before it draws: freckles of paint shouldn't.)
      const inner = kind === "look" ? INNER_LINES * 1.5 : INNER_LINES;
      const stroke = smoothstep(inner * 0.5, inner, around.sub(lum));
      const mark = max(smoothstep(0.2, 0.12, lum), stroke.mul(0.85));
      const tinted = tint.mul(mix(float(1), float(0.32), mark));
      // Untinted paint (eye whites, logos): its colour, lifted out of the baked light.
      const plain = pow(min(g.mul(1.25), vec3(1)), vec3(2.2));
      return mix(plain, tinted, clamp(sum, 0, 1));
    })();
    this.colorNode = this.albedo;
    // The painter's light nudges the shade line.
    // (From a blurred level of the paint, so the shade line runs in clean shapes.)
    const soft = dot(texture(detail).level(float(kind === "look" ? 5.5 : 4)).rgb, vec3(0.299, 0.587, 0.114));
    this.biasNode = clamp(soft.sub(0.5).mul(face ? 0.25 : kind === "look" ? 0.55 : 1.2), -0.45, 0.35).sub(
      shapeShade.mul(SHAPE_SHADE),
    );
    if (!face) this.deepNode = smoothstep(0.3, 0.22, soft);
    if (kind === "hair") {
      // The sheen on anime hair: a broad, lighter band of the hair's own colour.
      this.specStrength = 0.55;
      this.specSize = 0.16;
      this.specColorNode = this.albedo.mul(0.8).add(vec3(0.18, 0.16, 0.14));
    }
    if (kind === "look") {
      // Skin shades warm, the eyes and hair cool.
      const skin = clamp(w.x.div(max(sum, 1e-4)), 0, 1).mul(clamp(sum, 0, 1));
      this.shadeNode = mix(
        vec3(COOL_SHADE.r, COOL_SHADE.g, COOL_SHADE.b),
        vec3(WARM_SHADE.r, WARM_SHADE.g, WARM_SHADE.b),
        skin,
      );
    } else if (kind === "hair") {
      this.shade.value.setRGB(0.5, 0.52, 0.72);
    }
  }

  hide(regions: number): void {
    this.hidden.value = regions;
  }

  setTints(main: number, second: number, accent: number): void {
    this.main.value.setHex(main);
    this.second.value.setHex(second);
    this.accent.value.setHex(accent);
  }
}

/** One number for the edge between two welded vertices, either way round. */
const edgeKey = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);

/**
 * 1 for each vertex, 0 on the open edges of the mesh (a cut neck, a hem):
 * the shell shrinks to the surface there, so a seam between two pieces
 * draws no line.
 */
function edgeWeights(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  const pos = geo.getAttribute("position");
  const ids = new Map<string, number>();
  const weld = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 2000)},${Math.round(pos.getY(i) * 2000)},${Math.round(pos.getZ(i) * 2000)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    weld[i] = id;
  }
  const index = geo.index;
  const tri = (t: number, c: number) => (index ? index.getX(t * 3 + c) : t * 3 + c);
  const triangles = (index ? index.count : pos.count) / 3;
  const edges = new Map<number, number>();
  for (let t = 0; t < triangles; t++) {
    for (let c = 0; c < 3; c++) {
      const k = edgeKey(weld[tri(t, c)]!, weld[tri(t, (c + 1) % 3)]!);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const open = new Set<number>();
  for (const [k, n] of edges) {
    if (n === 1) {
      open.add(Math.floor(k / 1048576));
      open.add(k % 1048576);
    }
  }
  const w = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) w[i] = open.has(weld[i]!) ? 0 : 1;
  return new THREE.BufferAttribute(w, 1);
}

/** Normals averaged over vertices that share a position, so the shell doesn't split at seams. */
function weldedNormals(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const sums = new Map<string, THREE.Vector3>();
  const keys: string[] = [];
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 2000)},${Math.round(pos.getY(i) * 2000)},${Math.round(pos.getZ(i) * 2000)}`;
    keys.push(k);
    let s = sums.get(k);
    if (!s) {
      s = new THREE.Vector3();
      sums.set(k, s);
    }
    s.add(n.fromBufferAttribute(nor, i));
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = sums.get(keys[i]!)!;
    n.copy(s).normalize();
    out.set([n.x, n.y, n.z], i * 3);
  }
  return new THREE.BufferAttribute(out, 3);
}

/** A geometry sharing `geo`'s attributes, index and morph targets, with other normals (and attributes). */
function derived(
  geo: THREE.BufferGeometry,
  normal: THREE.BufferAttribute,
  extra: Record<string, THREE.BufferAttribute> = {},
): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  out.setAttribute("normal", normal);
  for (const [name, attr] of Object.entries(extra)) out.setAttribute(name, attr);
  out.morphAttributes = geo.morphAttributes;
  out.morphTargetsRelative = geo.morphTargetsRelative;
  out.setIndex(geo.index);
  for (const g of geo.groups) out.addGroup(g.start, g.count, g.materialIndex);
  return out;
}

const hullGeometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const faceGeometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * A head whose normals lean toward an ellipsoid round it, as fighting games
 * tune faces: the shade then falls across the face in one clean shape,
 * not in blobs round every bump. `keep` is how much of the sculpt's own
 * normal stays.
 */
export function faceGeometry(geo: THREE.BufferGeometry, keep = 0.12): THREE.BufferGeometry {
  let out = faceGeometries.get(geo);
  if (out) return out;
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  // (The rest shape's box: the geometry's own would grow to hold every face preset.)
  const all = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) all.expandByPoint(p.fromBufferAttribute(pos, i));
  // The piece runs down into the neck: fit the ellipsoid to the head above the jaw.
  const jaw = all.min.y + (all.max.y - all.min.y) * 0.28;
  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    if (p.y > jaw) box.expandByPoint(p);
  }
  const c = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const span = half.y * 0.25;
  const n = new Float32Array(pos.count * 3);
  const e = new THREE.Vector3();
  const o = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    o.fromBufferAttribute(nor, i);
    // Below the jaw (the neck) the sculpt's own normals stay.
    const t = Math.min(1, Math.max(0, (p.y - (jaw - span)) / (2 * span)));
    const w = t * t * (3 - 2 * t) * (1 - keep);
    p.sub(c);
    e.set(p.x / (half.x * half.x), p.y / (half.y * half.y), p.z / (half.z * half.z)).normalize();
    e.multiplyScalar(w)
      .addScaledVector(o, 1 - w)
      .normalize();
    n.set([e.x, e.y, e.z], i * 3);
  }
  out = derived(geo, new THREE.BufferAttribute(n, 3));
  faceGeometries.set(geo, out);
  return out;
}

const limbGeometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * Limbs and torso whose normals lean toward a capsule round each bone, as
 * fighting games transfer normals from simple proxies: the shade line then
 * runs clean along an arm or a leg instead of breaking on every muscle.
 * `rest` holds the bones' rest positions in BONES order.
 */
export function limbGeometry(geo: THREE.BufferGeometry, rest: THREE.Vector3[]): THREE.BufferGeometry {
  let out = limbGeometries.get(geo);
  if (out) return out;
  // bone -> [segment end bone, how far the normal leans]
  const SEGMENTS: Record<number, [number, number]> = {
    1: [2, 0.3],
    2: [3, 0.35],
    3: [4, 0.35],
    7: [8, 0.6],
    8: [9, 0.6],
    12: [13, 0.6],
    13: [14, 0.6],
    16: [17, 0.55],
    17: [18, 0.55],
    20: [21, 0.55],
    21: [22, 0.55],
  };
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const idx = geo.getAttribute("skinIndex");
  const wgt = geo.getAttribute("skinWeight");
  if (!idx || !wgt) return geo;
  const n = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const o = new THREE.Vector3();
  const r = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const seg = new THREE.Line3();
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    o.fromBufferAttribute(nor, i);
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const b = idx.getComponent(i, k);
      const w = wgt.getComponent(i, k);
      if (w <= 0) continue;
      const s = SEGMENTS[b];
      if (!s || !rest[b] || !rest[s[0]]) {
        acc.addScaledVector(o, w);
        continue;
      }
      seg.set(rest[b], rest[s[0]]);
      seg.closestPointToPoint(p, true, c);
      r.copy(p).sub(c).normalize();
      // Never lean past the surface's own side.
      if (r.dot(o) < 0.2) r.copy(o);
      acc.addScaledVector(r.multiplyScalar(s[1]).addScaledVector(o, 1 - s[1]), w);
    }
    acc.normalize();
    n.set([acc.x, acc.y, acc.z], i * 3);
  }
  out = derived(geo, new THREE.BufferAttribute(n, 3));
  limbGeometries.set(geo, out);
  return out;
}

/** The ink outline of a rider's piece: bind it to the same skeleton. */
export function outlineOf(
  mesh: THREE.SkinnedMesh,
  mat: CelTintMaterial,
  ink = new THREE.Color(0.1, 0.06, 0.09),
): THREE.SkinnedMesh {
  let geo = hullGeometries.get(mesh.geometry);
  if (!geo) {
    geo = derived(mesh.geometry, weldedNormals(mesh.geometry), { hullWidth: edgeWeights(mesh.geometry) });
    hullGeometries.set(mesh.geometry, geo);
  }
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  m.positionNode = Fn(() => {
    const depth = modelViewMatrix.mul(vec4(positionLocal, 1)).z.negate();
    const worldN = modelWorldMatrix.mul(vec4(normalLocal, 0)).xyz.normalize();
    // Heavier on the side away from the light, as drawn.
    const heavy = smoothstep(0.4, -0.5, dot(worldN, SUN_DIR));
    const width = clamp(
      depth
        .mul(PIXEL_AT_1M)
        .mul(RIDER_LINE)
        .mul(mix(float(0.65), float(1.35), heavy)),
      0.0015,
      0.03,
    );
    return positionLocal.add(normalLocal.normalize().mul(width).mul(attribute<"float">("hullWidth", "float")));
  })();
  m.colorNode = mat.albedo.mul(vec3(ink.r, ink.g, ink.b)).add(vec3(ink.r, ink.g, ink.b).mul(0.25));
  if (mat.regionMask) m.maskNode = mat.regionMask;
  inkOnlyInPass(m, inkNode(0, 0, 0, 0));
  const hull = new THREE.SkinnedMesh(geo, m);
  // The shell takes the same shape (the face's presets) as the piece.
  if (mesh.morphTargetInfluences) hull.morphTargetInfluences = mesh.morphTargetInfluences;
  hull.frustumCulled = false;
  hull.castShadow = false;
  return hull;
}
