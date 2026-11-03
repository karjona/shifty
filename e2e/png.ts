// Reads the pixels of a PNG screenshot in Node, so checking what is on the
// screen never waits on the page (whose main thread can be busy drawing for
// seconds per frame without a GPU). Handles what browsers write for
// screenshots: 8-bit RGB or RGBA, not interlaced.
import { inflateSync } from "node:zlib";

export interface Pixels {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA). */
  channels: number;
  /** Rows top to bottom, `width * channels` bytes each. */
  data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth predictor (PNG filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(png: Buffer): Pixels {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let o = 8; o + 8 <= png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.toString("latin1", o + 4, o + 8);
    const body = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${color}, interlace ${interlace}`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels]! : 0;
      const b = y > 0 ? data[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? data[row - stride + x - channels]! : 0;
      const predicted =
        filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      data[row + x] = (raw[src + x]! + predicted) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** Distinct colours (4 bits per channel) on an evenly spaced `cols` x `rows` grid of samples. */
export function distinctColours(p: Pixels, cols = 64, rows = 36): number {
  const seen = new Set<number>();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = Math.floor(((i + 0.5) * p.width) / cols);
      const y = Math.floor(((j + 0.5) * p.height) / rows);
      const o = (y * p.width + x) * p.channels;
      seen.add((p.data[o]! >> 4) | ((p.data[o + 1]! >> 4) << 4) | ((p.data[o + 2]! >> 4) << 8));
    }
  }
  return seen.size;
}
