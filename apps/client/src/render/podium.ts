// The Tilt's podium: three stucco blocks (the winner's in the middle and
// highest) with their numbers in ink, four banners in the seasons' colours
// behind, and confetti in the same colours. Blocks and banners are one
// vertex-coloured mesh, cel-shaded; the confetti is one mesh animated on the
// GPU (no work on the CPU per frame).
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cos, float, mod, positionLocal, sin, uniform, vec3 } from "three/tsl";
import { celify, inkNode, inkOnlyInPass, UNREFLECTED } from "./cel/material.ts";
import { Parts } from "./parts.ts";

/** The podium's blocks, in the order of the places they stand for (1st, 2nd, 3rd): across (m, + = the riders' left),
 * and height (m). The riders face +z. */
export const STEPS = [
  { x: 0, height: 1.1 },
  { x: -1.56, height: 0.8 },
  { x: 1.56, height: 0.56 },
] as const;
const STEP_WIDTH = 1.5;
const STEP_DEPTH = 1.4;

const STUCCO = 0xf3ead8;
const STONE = 0xd9cbb0;
const INK = 0x1d1b17;
const POLE = 0xf6f2ea;

/** Seven-segment strokes of each number: top, upper right, lower right, bottom, lower left, upper left, middle,
 * and the flag of a 1. */
const DIGITS: Record<number, string> = { 1: "bch", 2: "abged", 3: "abgcd" };
/** The numbers' height on the blocks (m). */
const DIGIT = 0.26;
/** The plinth's height, and the slab and band at the top of each block (m). */
const PLINTH = 0.06;
const SLAB = 0.08;
const BAND = 0.08;

/** A number's strokes as boxes on a face at `z` (facing +z), centred on `(x, y)`, `h` tall. */
function digit(parts: Parts, n: number, x: number, y: number, z: number, h: number): void {
  const w = h * 0.56;
  const s = h * 0.15;
  const half = h / 2;
  const seg: Record<string, [number, number, number, number]> = {
    a: [0, half - s / 2, w, s],
    b: [w / 2 - s / 2, half / 2, s, half],
    c: [w / 2 - s / 2, -half / 2, s, half],
    d: [0, -half + s / 2, w, s],
    e: [-w / 2 + s / 2, -half / 2, s, half],
    f: [-w / 2 + s / 2, half / 2, s, half],
    g: [0, 0, w, s],
    h: [w / 2 - s * 1.1, half - s * 0.9, s * 1.2, s * 0.8],
  };
  // A 1 stands in the middle.
  const shift = n === 1 ? -(w - s) / 2 : 0;
  for (const k of DIGITS[n] ?? "") {
    const [sx, sy, sw, sh] = seg[k]!;
    parts.add(new THREE.BoxGeometry(sw, sh, 0.03), INK, x + sx + shift, y + sy, z);
  }
}

/** The podium with its banners, standing on y = 0, the riders facing +z. `banners` are the seasons' colours. */
export function buildPodium(banners: readonly number[], accent: number): THREE.Group {
  const g = new THREE.Group();
  const parts = new Parts();
  STEPS.forEach((step, i) => {
    const h = step.height;
    parts.add(new THREE.BoxGeometry(STEP_WIDTH, h - SLAB, STEP_DEPTH), STUCCO, step.x, (h - SLAB) / 2, 0);
    // A stone slab on top, a little proud, and a band of the season's colour under it.
    parts.add(new THREE.BoxGeometry(STEP_WIDTH + 0.08, SLAB, STEP_DEPTH + 0.08), STONE, step.x, h - SLAB / 2, 0);
    const band = h - SLAB - BAND / 2;
    parts.add(new THREE.BoxGeometry(STEP_WIDTH + 0.01, BAND, STEP_DEPTH + 0.01), accent, step.x, band, 0);
    // The number in the middle of the face between the plinth and the band.
    digit(parts, i + 1, step.x, (PLINTH + h - SLAB - BAND) / 2, STEP_DEPTH / 2 + 0.01, DIGIT);
  });
  // A plinth the blocks stand on.
  parts.add(new THREE.BoxGeometry(STEP_WIDTH * 3 + 0.5, PLINTH, STEP_DEPTH + 0.5), STONE, 0, PLINTH / 2, 0);
  // Banners on poles behind, one per season.
  banners.forEach((colour, i) => {
    const x = (i - (banners.length - 1) / 2) * 1.5;
    const z = -STEP_DEPTH / 2 - 0.9;
    parts.add(new THREE.CylinderGeometry(0.035, 0.045, 4.4, 6), POLE, x, 2.2, z);
    parts.add(new THREE.BoxGeometry(0.62, 0.05, 0.05), POLE, x + 0.31, 4.3, z);
    parts.add(new THREE.BoxGeometry(0.58, 1.9, 0.02), colour, x + 0.31, 3.3, z);
  });
  const mesh = parts.build({ roughness: 0.8, flatShading: true });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  celify(g, () => ({ crease: 0.6 }));
  return g;
}

/** Where the confetti falls, round the podium (m). */
const AREA = { width: 9, depth: 5, top: 6.5, height: 7.5 };

/** Confetti falling over the podium, fluttering, without end. */
export class Confetti {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicNodeMaterial;
  private time = uniform(0);

  constructor(colours: readonly number[], count = 420) {
    const corners = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ] as const;
    const position = new Float32Array(count * 18);
    const seed = new Float32Array(count * 24);
    const colour = new Float32Array(count * 18);
    const c = new THREE.Color();
    let r = 0x9e3779b9;
    const rand = () => {
      r ^= r << 13;
      r ^= r >>> 17;
      r ^= r << 5;
      return (r >>> 0) / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * AREA.width;
      const z = (rand() - 0.5) * AREA.depth;
      const phase = rand();
      const speed = 0.7 + rand() * 0.6;
      c.set(colours[Math.floor(rand() * colours.length)] ?? 0xffffff);
      const w = 0.045 + rand() * 0.025;
      corners.forEach(([u, v], k) => {
        const o = i * 6 + k;
        position.set([u * w, v * w * 1.6, 0], o * 3);
        seed.set([x, z, phase, speed], o * 4);
        colour.set([c.r, c.g, c.b], o * 3);
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 4));
    geo.setAttribute("color", new THREE.BufferAttribute(colour, 3));

    const t = this.time;
    const s = attribute<"vec4">("seed", "vec4");
    // Each piece tumbles about two axes as it falls, swaying side to side, and starts over at the top.
    const tumble = t.mul(s.w.mul(3).add(1.5)).add(s.z.mul(40));
    const turn = t.mul(s.w.mul(1.7).add(0.6)).add(s.z.mul(17));
    const mat = new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.positionNode = Fn(() => {
      const p = positionLocal;
      const y1 = p.y.mul(cos(tumble));
      const z1 = p.y.mul(sin(tumble));
      const x2 = p.x.mul(cos(turn)).add(z1.mul(sin(turn)));
      const z2 = p.x
        .mul(sin(turn))
        .negate()
        .add(z1.mul(cos(turn)));
      const fall = mod(t.mul(s.w).add(s.z.mul(AREA.height)), float(AREA.height));
      const sway = sin(t.mul(1.3).add(s.z.mul(13))).mul(0.3);
      return vec3(s.x.add(sway).add(x2), float(AREA.top).sub(fall).add(y1), s.y.add(z2));
    })();
    // Lighter as a piece turns its face to the light.
    mat.colorNode = vec3(abs(cos(tumble)).mul(0.35).add(0.65));
    inkOnlyInPass(mat, inkNode(0, 0, 0, 0));
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(UNREFLECTED);
  }

  /** The confetti at time `t` (s). */
  update(t: number): void {
    this.time.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
