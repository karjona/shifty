// Lettering on scenery art: the names on an arch, a shopfront or a
// sponsor's barrier. The art says where each sign is (its `sign` anchors:
// a box, a text, a style, an ink and maybe a paper colour); here they are
// set in the game's typeface into one texture and drawn as one mesh of
// flat panels. Without a paper colour only the letters show.
import * as THREE from "three/webgpu";
import { FOLIAGE } from "../cel/look.ts";
import { CelMaterial } from "../cel/material.ts";
import type { EnvAnchor } from "./model.ts";

const FAMILY = '"Archivo Variable", system-ui, sans-serif';
/** The texture's width, and the most rows it may grow to (pixels). */
const ATLAS = 2048;
const ATLAS_ROWS = 2048;
/** Pixels of texture per metre of a sign's height, and the limits of a sign's height in it (pixels). */
const DENSITY = 380;
const CELL_MIN = 56;
const CELL_MAX = 300;
/** Clear pixels round every sign in the texture. */
const GUTTER = 6;
/** How long the typeface may take to load before signs are set in the fallback (ms). */
const FONT_WAIT_MS = 4000;

/** How a kind of sign is set: its font at a size, its letter-spacing (em), and how tall its capitals stand in the box (1 = as tall as fits). */
interface Style {
  font: (px: number) => string;
  spacing: number;
  fill: number;
}

const STYLES: Record<string, Style> = {
  /** Expanded heavy italic: titles. */
  display: { font: (px) => `italic 800 expanded ${px}px ${FAMILY}`, spacing: 0, fill: 1 },
  /** Wide, spaced capitals: labels. */
  caps: { font: (px) => `600 expanded ${px}px ${FAMILY}`, spacing: 0.16, fill: 1 },
  /** A bold italic wordmark: a brand's name. */
  brand: { font: (px) => `italic 800 ${px}px ${FAMILY}`, spacing: 0, fill: 0.74 },
};

interface Sign {
  matrix: THREE.Matrix4;
  text: string;
  w: number;
  h: number;
  style: Style;
  ink: THREE.Color;
  paper: THREE.Color | null;
  /** Its cell in the texture (pixels). */
  x: number;
  y: number;
  cw: number;
  ch: number;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** A colour the art gives: a number, or the name of one the scene chooses (`palette`). */
function colourOf(v: unknown, palette: Readonly<Record<string, number>>): THREE.Color | null {
  if (typeof v === "number") return new THREE.Color(v);
  const named = typeof v === "string" ? palette[v] : undefined;
  return named === undefined ? null : new THREE.Color(named);
}

function parse(a: EnvAnchor, palette: Readonly<Record<string, number>>): Sign | null {
  const d = a.data;
  const text = typeof d.text === "string" ? d.text : "";
  const w = num(d.w, 0);
  const h = num(d.h, 0);
  if (w <= 0 || h <= 0) return null;
  const style = STYLES[typeof d.style === "string" ? d.style : "display"] ?? STYLES.display!;
  return {
    matrix: a.matrix,
    text,
    w,
    h,
    style,
    ink: colourOf(d.ink, palette) ?? new THREE.Color(0x1d1b17),
    paper: colourOf(d.paper, palette),
    x: 0,
    y: 0,
    cw: 0,
    ch: 0,
  };
}

/** Gives every sign a cell in the texture, row by row; returns the rows used (pixels). */
function pack(list: Sign[]): number {
  for (const s of list) {
    let ch = Math.min(CELL_MAX, Math.max(CELL_MIN, Math.round(s.h * DENSITY)));
    let cw = Math.round((ch * s.w) / s.h);
    const most = ATLAS - GUTTER * 2;
    if (cw > most) {
      ch = Math.max(8, Math.round((ch * most) / cw));
      cw = most;
    }
    s.cw = cw;
    s.ch = ch;
  }
  let x = GUTTER;
  let y = GUTTER;
  let row = 0;
  for (const s of list.toSorted((a, b) => b.ch - a.ch)) {
    if (x + s.cw + GUTTER > ATLAS) {
      x = GUTTER;
      y += row + GUTTER;
      row = 0;
    }
    s.x = x;
    s.y = y;
    x += s.cw + GUTTER;
    row = Math.max(row, s.ch);
  }
  return y + row + GUTTER;
}

/** The width of `text` set at the context's font, with `spacing` pixels between letters. */
function measure(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  if (spacing === 0) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}

/** Sets a sign's text in its cell: as big as the cell's height allows, smaller if it would not fit across. */
function draw(ctx: CanvasRenderingContext2D, s: Sign): void {
  if (!s.text) return;
  // Capitals stand as tall as the style's share of the cell (less on paper, which keeps a margin).
  ctx.font = s.style.font(s.ch);
  const cap = ctx.measureText("H").actualBoundingBoxAscent || s.ch * 0.7;
  let px = (s.ch * s.ch * s.style.fill * (s.paper ? 0.6 : 0.84)) / cap;
  ctx.font = s.style.font(px);
  let width = measure(ctx, s.text, s.style.spacing * px);
  const room = s.cw * (s.paper ? 0.88 : 0.97);
  if (width > room) {
    px *= room / width;
    ctx.font = s.style.font(px);
    width = measure(ctx, s.text, s.style.spacing * px);
  }
  const m = ctx.measureText("H");
  const baseline = s.y + s.ch / 2 + (m.actualBoundingBoxAscent || px * 0.7) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x, s.y, s.cw, s.ch);
  ctx.clip();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  let x = s.x + (s.cw - width) / 2;
  const spacing = s.style.spacing * px;
  if (spacing === 0) ctx.fillText(s.text, x, baseline);
  else {
    for (const ch of s.text) {
      ctx.fillText(ch, x, baseline);
      x += ctx.measureText(ch).width + spacing;
    }
  }
  ctx.restore();
}

/** A colour's bytes as the texture stores them (sRGB). */
function bytes(c: THREE.Color): [number, number, number] {
  const s = c.clone().convertLinearToSRGB();
  return [Math.round(s.r * 255), Math.round(s.g * 255), Math.round(s.b * 255)];
}

/**
 * The texture: the letters are drawn white on clear, then every cell is
 * painted in its own colours, ink over paper by how much letter covers each
 * pixel (clear cells keep the ink's colour under their edges, so letters
 * cut out clean).
 */
function atlas(list: Sign[], rows: number): THREE.DataTexture {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  for (const s of list) draw(ctx, s);
  const image = ctx.getImageData(0, 0, ATLAS, rows);
  const px = image.data;
  for (const s of list) {
    const ink = bytes(s.ink);
    const paper = s.paper ? bytes(s.paper) : null;
    const g = GUTTER - 1;
    for (let y = Math.max(0, s.y - g); y < Math.min(rows, s.y + s.ch + g); y++) {
      for (let x = Math.max(0, s.x - g); x < Math.min(ATLAS, s.x + s.cw + g); x++) {
        const o = (y * ATLAS + x) * 4;
        const k = px[o + 3]! / 255;
        for (let c = 0; c < 3; c++) px[o + c] = paper ? Math.round(paper[c]! + (ink[c]! - paper[c]!) * k) : ink[c]!;
        px[o + 3] = paper ? 255 : px[o + 3]!;
      }
    }
  }
  const t = new THREE.DataTexture(px, ATLAS, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** The game's typeface, ready to draw with (or the fallback, if it does not come). */
async function typeface(list: Sign[]): Promise<void> {
  const fonts = new Set(list.map((s) => s.style.font(64)));
  const loads = Promise.all([...fonts].map((f) => document.fonts.load(f, "Hg°í·")));
  await Promise.race([loads, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]).catch(() => {});
}

/**
 * The signs of a scene's art as one mesh, in the art's space (null if it
 * has none). Each anchor is a panel centred on its origin, in its XY plane
 * and facing its +Z: `w` along X, `h` along Y, `text` set in `style`
 * (`display`, `caps` or `brand`) in `ink`, on `paper` if it has one (a panel
 * without text is just its paper). A colour is a number, or a name the
 * scene gives a colour to in `palette` (the season's accent).
 */
export async function signs(
  anchors: EnvAnchor[] | undefined,
  palette: Readonly<Record<string, number>> = {},
): Promise<THREE.Mesh | null> {
  const list = (anchors ?? []).map((a) => parse(a, palette)).filter((s): s is Sign => s !== null);
  if (list.length === 0) return null;
  await typeface(list);
  const rows = Math.min(ATLAS_ROWS, pack(list));
  const map = atlas(list, rows);
  const position = new Float32Array(list.length * 12);
  const normal = new Float32Array(list.length * 12);
  const uv = new Float32Array(list.length * 8);
  const index: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  list.forEach((s, i) => {
    n.set(0, 0, 1).transformDirection(s.matrix);
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;
    corners.forEach(([cx, cy], k) => {
      p.set((cx * s.w) / 2, (cy * s.h) / 2, 0).applyMatrix4(s.matrix);
      position.set([p.x, p.y, p.z], (i * 4 + k) * 3);
      normal.set([n.x, n.y, n.z], (i * 4 + k) * 3);
      // The texture's rows run from the top down.
      uv.set([(s.x + ((cx + 1) / 2) * s.cw) / ATLAS, (s.y + ((1 - cy) / 2) * s.ch) / rows], (i * 4 + k) * 2);
    });
    index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  const material = new CelMaterial({ map, outdoor: FOLIAGE.none, silhouette: 0, crease: 0 });
  material.alphaTest = 0.5;
  const mesh = new THREE.Mesh(g, material);
  mesh.name = "env.signs";
  mesh.receiveShadow = true;
  return mesh;
}
