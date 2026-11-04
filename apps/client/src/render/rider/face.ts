// The face, painted: a texture wrapped round the head (u around, front in
// the middle; v up the head part), like the faces of the PS1/N64 greats.
// Skin shading, eyes, brows, nose, lips, the scalp under the hair and
// facial hair are drawn on a large canvas in the head's own coordinates,
// then scaled down to the style's resolution.
import * as THREE from "three/webgpu";
import type { Look } from "@shifty/rider";
import type { Anatomy } from "./anatomy.ts";
import { sectionPoint } from "./curve.ts";
import { EYES, HAIR, SKIN, blend, hex } from "./palette.ts";

/** Drawing canvas size; the texture is scaled down from it. */
const W = 1024;
const H = 512;

/** Eye shapes: half width, half height, outer-corner lift (m), lid heaviness (0-1). */
const EYE_SHAPES = [
  { w: 0.0125, h: 0.0055, lift: 0, lid: 0.3 },
  { w: 0.0118, h: 0.0068, lift: 0.0003, lid: 0.15 },
  { w: 0.013, h: 0.0042, lift: 0, lid: 0.7 },
  { w: 0.0124, h: 0.0052, lift: -0.0022, lid: 0.4 },
  { w: 0.0124, h: 0.0052, lift: 0.0024, lid: 0.25 },
];

/** Brows: thickness (m), arch (m), rise toward the outer end (m), how far out they reach. */
const BROWS = [
  { thick: 0.0042, arch: 0.0012, rise: 0, reach: 1 },
  { thick: 0.0028, arch: 0.0034, rise: 0.0008, reach: 1.02 },
  { thick: 0.0062, arch: 0.0008, rise: -0.0006, reach: 1.04 },
  { thick: 0.0045, arch: 0.0005, rise: 0.0042, reach: 0.98 },
  { thick: 0.0038, arch: 0.0026, rise: -0.0012, reach: 0.96 },
];

type Pt = [number, number];

export interface FaceOptions {
  /** Texture width (height is half). */
  size: number;
  /** Nearest-pixel filtering (the PS1 look) instead of smooth. */
  nearest: boolean;
  /** Where the hair starts (head units), by angle round the head; null = no hair painted on the scalp. */
  hairline: ((phi: number) => number) | null;
}

export class FacePainter {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private anatomy: Anatomy;

  constructor(anatomy: Anatomy) {
    this.anatomy = anatomy;
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Canvas position of head height `u` and angle φ. */
  private at(phi: number, u: number): Pt {
    const v = this.anatomy.headT(u);
    return [((phi + Math.PI) / (Math.PI * 2)) * W, (1 - v) * H];
  }

  /** The angle round the head where a point `x` metres left of the middle of the face sits at height `u`. */
  private phiOf(x: number, u: number): number {
    const s = this.anatomy.headAt(u);
    const target = Math.abs(x);
    const p = new THREE.Vector3();
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (sectionPoint(s, mid, 0, p).x < target) lo = mid;
      else hi = mid;
    }
    return Math.sign(x) * (lo + hi) * 0.5;
  }

  /** Canvas position of a point on the face seen from the front: `x` metres to the rider's left, at head height `u`. */
  private front(x: number, u: number): Pt {
    return this.at(this.phiOf(x, u), u);
  }

  private path(points: Pt[], close = true): void {
    const c = this.ctx;
    c.beginPath();
    points.forEach(([x, u], i) => {
      const [px, py] = this.front(x, u);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    });
    if (close) c.closePath();
  }

  /** Pixels per metre across the front of the face. */
  private get scale(): number {
    return (this.front(0.01, 0.45)[0] - this.front(0, 0.45)[0]) / 0.01;
  }

  /** A soft round blot of colour on the face. */
  private blot(x: number, u: number, r: number, color: string, alpha: number): void {
    const [px, py] = this.front(x, u);
    const rp = r * this.scale;
    const g = this.ctx.createRadialGradient(px, py, 0, px, py, rp);
    g.addColorStop(0, color);
    g.addColorStop(1, `${color}00`);
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = g;
    this.ctx.fillRect(px - rp, py - rp, rp * 2, rp * 2);
    this.ctx.globalAlpha = 1;
  }

  paint(look: Look, opts: FaceOptions): THREE.CanvasTexture {
    const c = this.ctx;
    const a = this.anatomy;
    const hu = a.headH / 0.226;
    const [skin, shade, warm] = SKIN[look.skin] ?? SKIN[1]!;
    const hair = HAIR[look.hairColor] ?? HAIR[1]!;
    const female = !a.male;
    c.globalAlpha = 1;
    c.fillStyle = hex(skin);
    c.fillRect(0, 0, W, H);

    // Shading baked into the skin: under the jaw, the eye sockets, the
    // sides of the nose, cheeks, the line from nose to mouth.
    const shadeHex = hex(shade);
    const [, jawY] = this.at(0, -0.14);
    const [, chinY] = this.at(0, -0.03);
    const neckShade = c.createLinearGradient(0, chinY, 0, jawY);
    neckShade.addColorStop(0, `${shadeHex}00`);
    neckShade.addColorStop(1, shadeHex);
    c.globalAlpha = 0.35;
    c.fillStyle = neckShade;
    c.fillRect(0, chinY, W, H - chinY);
    c.globalAlpha = 1;
    // Light bounced up under the chin, so the jaw doesn't read as a beard.
    this.blot(0, 0.0, 0.05 * hu, hex(blend(skin, 0xffffff, 0.25)), 0.55);
    for (const side of [1, -1]) {
      this.blot(side * 0.03 * hu, 0.5, 0.022 * hu, shadeHex, 0.2);
      this.blot(side * 0.013 * hu, 0.36, 0.01 * hu, shadeHex, 0.12);
      this.blot(side * 0.045 * hu, 0.33, 0.022 * hu, hex(warm), female ? 0.12 : 0.06);
      this.blot(side * 0.06 * hu, 0.28, 0.018 * hu, shadeHex, 0.1);
      // Nose-to-mouth fold.
      c.strokeStyle = shadeHex;
      c.globalAlpha = 0.14;
      c.lineWidth = 0.0018 * this.scale;
      this.path(
        [
          [side * 0.017 * hu, 0.27],
          [side * 0.024 * hu, 0.21],
          [side * 0.028 * hu, 0.15],
        ],
        false,
      );
      c.stroke();
      c.globalAlpha = 1;
    }
    // Ear shadows (the ears stand off the sides of the head).
    for (const side of [1, -1]) {
      const [ex, ey] = this.at(side * Math.PI * 0.52, 0.4);
      const g = c.createRadialGradient(ex, ey, 0, ex, ey, 0.03 * this.scale);
      g.addColorStop(0, shadeHex);
      g.addColorStop(1, `${shadeHex}00`);
      c.globalAlpha = 0.4;
      c.fillStyle = g;
      c.fillRect(ex - 60, ey - 60, 120, 120);
      c.globalAlpha = 1;
    }

    // Scalp under the hair.
    if (opts.hairline) this.scalp(opts.hairline, hair);
    if (look.facialHair > 0) this.facialHair(look.facialHair, hair, skin);

    this.nose(look.nose, shade, hu);
    this.mouth(look, warm, shade, skin, hu);
    for (const side of [1, -1]) this.eye(side, look, skin, shade, hu, female);
    for (const side of [1, -1]) this.brow(side, look, hair, hu, female);

    // Scale down to the style's size, halving each step for clean filtering.
    let src: HTMLCanvasElement = this.canvas;
    while (src.width / 2 >= opts.size) {
      const half = document.createElement("canvas");
      half.width = src.width / 2;
      half.height = src.height / 2;
      const hc = half.getContext("2d")!;
      hc.imageSmoothingQuality = "high";
      hc.drawImage(src, 0, 0, half.width, half.height);
      src = half;
    }
    const tex = new THREE.CanvasTexture(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    if (opts.nearest) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    }
    return tex;
  }

  private scalp(hairline: (phi: number) => number, hair: number): void {
    const c = this.ctx;
    c.fillStyle = hex(blend(hair, 0x000000, 0.1));
    for (let x = 0; x < W; x++) {
      const phi = (x / W) * Math.PI * 2 - Math.PI;
      const [, y] = this.at(phi, hairline(phi));
      c.fillRect(x, 0, 1, y);
      // A soft edge, so the hairline doesn't look painted on.
      const g = c.createLinearGradient(0, y, 0, y + 10);
      g.addColorStop(0, hex(hair));
      g.addColorStop(1, `${hex(hair)}00`);
      c.globalAlpha = 0.6;
      c.fillStyle = g;
      c.fillRect(x, y, 1, 10);
      c.globalAlpha = 1;
      c.fillStyle = hex(blend(hair, 0x000000, 0.1));
    }
  }

  private facialHair(kind: number, hair: number, skin: number): void {
    const c = this.ctx;
    // Regions by angle round the head: [φ, bottom, top] in head units, where hair grows.
    const lipLine = (phi: number) => 0.165 + Math.abs(phi) * 0.06;
    const beardTop = (phi: number) => {
      const a = Math.abs(phi);
      if (a > 1.45) return 0.42 + (a - 1.45) * 0.1; // sideburns
      if (a > 0.75) return 0.27 + ((a - 0.75) / 0.7) * 0.15;
      if (a > 0.4) return 0.2 + ((a - 0.4) / 0.35) * 0.07;
      return 0.205;
    };
    const color = blend(hair, 0x000000, 0.15);
    const grow = (phi: number, u: number): number => {
      const a = Math.abs(phi);
      const top = beardTop(phi);
      const bottom = -0.1;
      const inBeard = a < 1.75 && u > bottom && u < top;
      const lips = a < 0.36 && u > 0.098 && u < lipLine(phi) - 0.002;
      const mous = a < 0.42 && u > lipLine(phi) - 0.01 && u < 0.215 + (a > 0.3 ? -0.03 : 0);
      const chin = a < 0.34 && u > -0.06 && u < 0.098;
      switch (kind) {
        case 1:
          return inBeard && !lips ? 0.42 : 0;
        case 2:
          return mous ? 1 : 0;
        case 3:
          return mous || chin || (a < 0.42 && u > 0.09 && u < 0.17 && a > 0.3) ? 1 : 0;
        case 4:
          return inBeard && !lips ? 1 : 0;
        default:
          return 0;
      }
    };
    // Paint strand by strand: short dark dashes where the hair grows.
    const img = c.getImageData(0, 0, W, H);
    const d = img.data;
    const cr = (color >> 16) & 255;
    const cg = (color >> 8) & 255;
    const cb = color & 255;
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let y = 0; y < H; y++) {
      const v = 1 - y / H;
      const u = this.anatomy.headU(v);
      if (u < -0.15 || u > 0.5) continue;
      for (let x = 0; x < W; x++) {
        const phi = (x / W) * Math.PI * 2 - Math.PI;
        // Feathered edges: average the coverage around the pixel.
        let g = 0;
        for (const [dx, du] of [
          [0, 0],
          [0.03, 0],
          [-0.03, 0],
          [0, 0.012],
          [0, -0.012],
        ] as const)
          g += grow(phi + dx, u + du);
        g /= 5;
        if (g <= 0) continue;
        const stubble = kind === 1;
        const k = stubble ? g * (0.5 + rnd() * 0.5) : Math.min(1, g * (0.75 + rnd() * 0.35));
        const i = (y * W + x) * 4;
        const shadeK = stubble ? 1 : 0.85 + rnd() * 0.3;
        d[i] = d[i]! + (cr * shadeK - d[i]!) * k;
        d[i + 1] = d[i + 1]! + (cg * shadeK - d[i + 1]!) * k;
        d[i + 2] = d[i + 2]! + (cb * shadeK - d[i + 2]!) * k;
      }
    }
    c.putImageData(img, 0, 0);
    void skin;
  }

  private nose(kind: number, shade: number, hu: number): void {
    const c = this.ctx;
    const wide = kind === 3 ? 1.35 : kind === 4 ? 0.85 : 1;
    const base = kind === 1 ? 0.268 : kind === 4 ? 0.24 : 0.255;
    c.fillStyle = hex(blend(shade, 0x000000, 0.35));
    for (const side of [1, -1]) {
      c.globalAlpha = 0.75;
      this.path(
        Array.from({ length: 10 }, (_, i): Pt => {
          const t = (i / 10) * Math.PI * 2;
          return [side * (0.0075 * wide + Math.cos(t) * 0.0035 * wide) * hu, base + Math.sin(t) * 0.006];
        }),
      );
      c.fill();
      c.globalAlpha = 1;
      // The sides of the nose, in shade.
      c.strokeStyle = hex(shade);
      c.globalAlpha = 0.35;
      c.lineWidth = 0.003 * this.scale;
      this.path(
        [
          [side * 0.0095 * wide * hu, 0.46],
          [side * 0.0105 * wide * hu, 0.36],
          [side * 0.0135 * wide * hu, 0.29],
          [side * 0.0125 * wide * hu, base + 0.01],
        ],
        false,
      );
      c.stroke();
      c.globalAlpha = 1;
    }
  }

  private mouth(look: Look, warm: number, shade: number, skin: number, hu: number): void {
    const c = this.ctx;
    const a = this.anatomy;
    const full = [1, 0.6, 1.45, 1.05, 0.95][look.mouth] ?? 1;
    const hw = 0.024 * a.mouthWidth * hu;
    const mid = 0.138;
    const female = !a.male;
    const lip = blend(skin, warm, female ? 0.75 : 0.45);
    const upperH = 0.022 * full;
    const lowerH = 0.028 * full;
    const curve = (n: number, f: (s: number) => number) =>
      Array.from({ length: n + 1 }, (_, i): Pt => {
        const s = (i / n) * 2 - 1;
        return [s * hw, f(s)];
      });
    // Upper lip with a cupid's bow, lower lip fuller.
    const bow = look.mouth === 4 ? 0.006 : 0.003;
    const upper = curve(16, (s) => mid + upperH * Math.sqrt(1 - s * s) * (1 - (bow / upperH) * Math.exp(-s * s * 60)));
    const line = curve(16, (s) => mid + 0.002 * (1 - s * s) - (look.mouth === 3 ? 0.002 * s * s : 0));
    const lower = curve(16, (s) => mid - lowerH * Math.pow(1 - s * s, 0.8));
    c.fillStyle = hex(lip);
    this.path([...upper, ...line.reverse()]);
    c.fill();
    c.fillStyle = hex(blend(lip, skin, 0.15));
    this.path([...line.reverse(), ...lower.reverse()]);
    c.fill();
    // The line between the lips, darker at the corners.
    c.strokeStyle = hex(blend(shade, 0x000000, 0.45));
    c.lineWidth = 0.0016 * this.scale;
    this.path(
      curve(16, (s) => mid + 0.0015 * (1 - s * s)),
      false,
    );
    c.stroke();
    // A shadow under the lower lip.
    this.blot(0, mid - lowerH - 0.012, 0.012 * hu, hex(shade), 0.35);
  }

  private eye(side: number, look: Look, skin: number, shade: number, hu: number, female: boolean): void {
    const c = this.ctx;
    const e = EYE_SHAPES[look.eyes] ?? EYE_SHAPES[0]!;
    const cx = side * 0.032 * hu;
    const cu = 0.475;
    // Head units per metre at eye height.
    const k = 1 / this.anatomy.headH;
    const hw = e.w * hu * 1.15;
    const hh = e.h * hu * 1.18;
    const n = 18;
    const lid = (s: number, top: boolean) => {
      // s: -1 inner corner to 1 outer corner.
      const lift = e.lift * hu * (s + 1) * 0.5;
      const shape = Math.pow(Math.max(0, 1 - s * s), top ? 0.75 : 0.9) * (top ? 1 : 0.72);
      const tilt = top ? 0.12 * (s + 0.3) : 0;
      return cu + (lift + (top ? 1 : -1) * hh * shape * (1 - tilt * 0.3)) * k;
    };
    const xs = (s: number) => cx + side * s * hw;
    const top = Array.from({ length: n + 1 }, (_, i): Pt => {
      const s = (i / n) * 2 - 1;
      return [xs(s), lid(s, true)];
    });
    const bottom = Array.from({ length: n + 1 }, (_, i): Pt => {
      const s = 1 - (i / n) * 2;
      return [xs(s), lid(s, false)];
    });
    // The lid crease above, and shade over the socket.
    c.strokeStyle = hex(shade);
    c.globalAlpha = 0.45 + e.lid * 0.3;
    c.lineWidth = 0.0016 * this.scale;
    this.path(
      top.map(([x, u]) => [x + side * 0.0004, u + (0.004 - e.lid * 0.0022) * hu * k * 1.4]),
      false,
    );
    c.stroke();
    c.globalAlpha = 1;
    // White, iris, pupil, clipped to the opening.
    c.save();
    this.path([...top, ...bottom]);
    c.fillStyle = hex(blend(0xf4efe6, skin, 0.18));
    c.fill();
    c.clip();
    const [ix, iy] = this.front(cx - side * 0.0008 * hu, cu + 0.0004 * k);
    const ir = 0.0064 * hu * this.scale;
    const iris = EYES[look.eyeColor] ?? EYES[0]!;
    const g = c.createRadialGradient(ix, iy, ir * 0.2, ix, iy, ir);
    g.addColorStop(0, hex(blend(iris, 0xffffff, 0.15)));
    g.addColorStop(0.75, hex(iris));
    g.addColorStop(1, hex(blend(iris, 0x000000, 0.5)));
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(ix, iy, ir, ir * 1.02, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#0b0908";
    c.beginPath();
    c.arc(ix, iy, ir * 0.42, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.85)";
    c.beginPath();
    c.arc(ix - ir * 0.3, iy - ir * 0.35, ir * 0.2, 0, Math.PI * 2);
    c.fill();
    // The upper lid's shadow on the eyeball.
    c.fillStyle = "rgba(40,20,10,0.28)";
    this.path([
      ...top,
      ...top
        .slice()
        .reverse()
        .map(([x, u]): Pt => [x, u - hh * k * 0.55]),
    ]);
    c.fill();
    c.restore();
    // Lids: a strong upper line (lashes), a faint lower one.
    c.strokeStyle = "#1c120c";
    c.lineCap = "round";
    c.lineWidth = (female ? 0.0026 : 0.0019) * this.scale;
    this.path(top, false);
    c.stroke();
    if (female) {
      // A small flick at the outer corner.
      const [ox, ou] = top[n]!;
      this.path(
        [
          [ox - side * 0.002 * hu, ou + 0.0006 * k],
          [ox + side * 0.0028 * hu, ou + 0.0022 * k],
        ],
        false,
      );
      c.stroke();
    }
    c.strokeStyle = hex(blend(shade, 0x000000, 0.2));
    c.globalAlpha = 0.5;
    c.lineWidth = 0.001 * this.scale;
    this.path(bottom, false);
    c.stroke();
    c.globalAlpha = 1;
  }

  private brow(side: number, look: Look, hair: number, hu: number, female: boolean): void {
    const c = this.ctx;
    const b = BROWS[look.brows] ?? BROWS[0]!;
    const k = 1 / this.anatomy.headH;
    const inner = 0.014 * hu;
    const outer = 0.052 * hu * b.reach;
    const base = 0.548;
    const thick = b.thick * (female ? 0.8 : 1) * hu;
    const n = 14;
    const along = (s: number): Pt => {
      const x = side * (inner + (outer - inner) * s);
      const u = base + (b.arch * Math.sin(Math.PI * Math.pow(s, 0.8)) + b.rise * s - 0.0015 * s * s) * hu * k;
      return [x, u];
    };
    const width = (s: number) => thick * (s < 0.15 ? 0.7 + s * 2 : 1 - Math.pow(s, 2.2) * 0.75);
    const upper = Array.from({ length: n + 1 }, (_, i): Pt => {
      const s = i / n;
      const [x, u] = along(s);
      return [x, u + width(s) * 0.5 * k];
    });
    const lower = Array.from({ length: n + 1 }, (_, i): Pt => {
      const s = 1 - i / n;
      const [x, u] = along(s);
      return [x, u - width(s) * 0.5 * k];
    });
    const color = look.hairColor === 4 ? blend(hair, 0x3b2617, 0.45) : blend(hair, 0x000000, 0.12);
    c.fillStyle = hex(color);
    c.globalAlpha = 0.92;
    this.path([...upper, ...lower]);
    c.fill();
    c.globalAlpha = 1;
  }
}
