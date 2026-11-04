// Garments: lofted over the same body parts as the skin, pushed out from
// it, so every garment fits every body, build and height. Where a garment
// covers a whole stretch of a part, the skin under it is not built; where
// its edge has a shape (a neckline, straps), the garment dips under the
// skin past the edge instead.
import * as THREE from "three/webgpu";
import { type Anatomy, BONE, type PartName } from "./anatomy.ts";
import { bell, sectionPoint, smoothstep } from "./curve.ts";
import type { MeshBuilder } from "./mesh.ts";

/** How a garment's surface looks. */
export interface Fabric {
  color: number;
  roughness?: number;
  metalness?: number;
  /** A ready texture (the face). */
  texture?: THREE.Texture;
  /**
   * Paints details (straps, bands, trim) on a square canvas of `size`
   * pixels over the base colour, in the layer's texture coordinates: x is
   * round the part (the front in the middle), y down from v = 1.
   */
  paint?: (c: CanvasRenderingContext2D, size: number, a: Anatomy) => void;
}

/** Paints a band across a texture between v0 and v1. */
export function band(c: CanvasRenderingContext2D, size: number, v0: number, v1: number, color: number): void {
  c.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  c.fillRect(0, (1 - v1) * size, size, (v1 - v0) * size);
}

/** One surface of a garment (a garment can have a few: a jacket and its trim). */
export interface Layer {
  fabric: Fabric;
  build(m: MeshBuilder, a: Anatomy): void;
}

export interface Garment {
  layers: Layer[];
  /** Stretches of body parts it hides completely: part → [from, to] in the part's t. */
  hides?: (a: Anatomy) => Partial<Record<PartName, [number, number]>>;
  /** Headwear: the hat's lower edge (head units) by φ; hair above it is not built. */
  hatLine?: (phi: number) => number;
}

/** Torso t at a height (fraction of standing height). */
export const torsoT = (yFrac: number) => (yFrac - 0.47) / 0.37;
const KNEE = 0.49;

const both = (f: (L: "L" | "R") => void) => {
  f("L");
  f("R");
};

/**
 * An offset that dips under the skin past a garment's edge: `inside` is
 * how far inside the edge a point is (positive in, negative out), in the
 * same units as `soft`, so the edge runs smoothly between vertices.
 */
const edge = (inside: number, on: number, soft: number) => on - (on + 0.006) * smoothstep(soft, -soft, inside);

export function boardshorts(color: number, trim: number): Garment {
  const top = torsoT(0.575);
  // Torso on v 0-0.5, legs on 0.5-1, so the waistband stays on the waist.
  const legV = (t: number, phi: number): [number, number] => [(phi + Math.PI) / (Math.PI * 2), 0.5 + (t + 0.08) * 0.9];
  return {
    hides: () => ({ torso: [0, top - 0.05], "leg.L": [-0.08, 0.36], "leg.R": [-0.08, 0.36] }),
    layers: [
      {
        fabric: {
          color,
          roughness: 0.8,
          paint: (c, size) => {
            band(c, size, (top - 0.035) * 0.5, top * 0.5, trim);
            // A stripe down the outside of each leg.
            c.fillStyle = `#${trim.toString(16).padStart(6, "0")}`;
            for (const x of [0.25, 0.75]) c.fillRect(x * size - size * 0.012, 0, size * 0.024, size * 0.5);
          },
        },
        build(m, a) {
          m.tube(a.part("torso"), {
            from: 0,
            to: top,
            offset: () => 0.012,
            hemEnd: true,
            uv: (t, phi) => [(phi + Math.PI) / (Math.PI * 2), t * 0.5],
          });
          both((L) =>
            m.tube(a.part(`leg.${L}`), {
              from: -0.08,
              to: 0.4,
              offset: (t) => 0.012 + Math.max(0, t) * 0.03,
              hemEnd: true,
              uv: legV,
            }),
          );
        },
      },
    ],
  };
}

export function swimsuit(color: number): Garment {
  // Leg openings: down the leg past where it meets the hips (so the edge
  // runs round the leg itself), higher on the outside.
  const legCut = (phi: number, side: number) => 0.11 - 0.09 * smoothstep(-0.3, 1.2, phi * side);
  return {
    hides: () => ({ torso: [0, torsoT(0.7)], "leg.L": [-0.08, 0.0], "leg.R": [-0.08, 0.0] }),
    layers: [
      {
        fabric: { color, roughness: 0.55 },
        build(m, a) {
          both((L) =>
            m.tube(a.part(`leg.${L}`), {
              from: -0.08,
              to: 0.16,
              offset: (t, phi) => edge(legCut(phi, L === "L" ? 1 : -1) - t, 0.003, 0.025),
            }),
          );
          m.tube(a.part("torso"), {
            from: 0,
            to: 1,
            offset: (t, phi) => {
              const yf = 0.47 + t * 0.37;
              const front = Math.abs(phi) < Math.PI / 2;
              // Neckline in front, a low back, straps over the shoulders.
              const neck = front ? 0.73 - 0.02 * bell(phi, 0.4) : 0.68;
              const strap = 0.09 - Math.abs(Math.abs(phi) - (front ? 0.55 : Math.PI - 0.55));
              return edge(Math.max((neck - yf) * 4, strap), 0.003, 0.03);
            },
          });
        },
      },
    ],
  };
}

export function lifeVest(color: number, straps: number): Garment {
  const from = torsoT(0.6);
  const to = torsoT(0.81);
  return {
    hides: () => ({ torso: [from + 0.05, to - 0.06] }),
    layers: [
      {
        fabric: {
          color,
          roughness: 0.6,
          paint: (c, size) => {
            for (const y of [0.635, 0.69]) band(c, size, torsoT(y), torsoT(y + 0.017), straps);
            // Buckles in front.
            c.fillStyle = "#d8d8d2";
            for (const y of [0.635, 0.69])
              c.fillRect(size * 0.47, (1 - torsoT(y + 0.02)) * size, size * 0.06, (0.023 / 0.37) * size);
          },
        },
        build(m, a) {
          m.tube(a.part("torso"), {
            from,
            to,
            // Thick foam; open at the neck in front.
            offset: (t, phi) => {
              const yf = 0.47 + t * 0.37;
              const v = bell(phi, 0.32) * smoothstep(0.74, 0.8, yf);
              return 0.034 - v * 0.04;
            },
            hemStart: true,
            hemEnd: true,
          });
        },
      },
    ],
  };
}

export function jacket(color: number, trim: number): Garment {
  const from = torsoT(0.555);
  const u = (phi: number) => (phi + Math.PI) / (Math.PI * 2);
  // Body on v 0-0.45, sleeves on 0.5-0.95, the collar at the top.
  const sleeveV = (t: number) => 0.5 + ((t + 0.14) / 1.14) * 0.45;
  return {
    hides: (a) => ({
      torso: [from + 0.06, 1],
      "arm.L": [-0.14, 0.95],
      "arm.R": [-0.14, 0.95],
      head: [0, a.headT(-0.2)],
    }),
    layers: [
      {
        fabric: {
          color,
          roughness: 0.75,
          paint: (c, size) => {
            // Hem, cuffs, a zip, a stripe across the chest.
            band(c, size, from * 0.45, (from + 0.06) * 0.45, trim);
            band(c, size, sleeveV(0.93), sleeveV(0.985), trim);
            band(c, size, torsoT(0.71) * 0.45, torsoT(0.725) * 0.45, trim);
            c.fillStyle = `#${trim.toString(16).padStart(6, "0")}`;
            c.fillRect(size * 0.495, (1 - 0.45) * size, size * 0.01, size * 0.45);
          },
        },
        build(m, a) {
          // Puffy: quilted in bands.
          const quilt = (t: number) => 0.004 * Math.cos(t * Math.PI * 2 * 6);
          m.tube(a.part("torso"), {
            from,
            to: 1,
            offset: (t) => 0.03 + quilt(t),
            hemStart: 0.6,
            capEnd: false,
            uv: (t, phi) => [u(phi), t * 0.45],
          });
          both((L) =>
            m.tube(a.part(`arm.${L}`), {
              from: -0.14,
              to: 0.985,
              offset: (t) => 0.026 - t * 0.006 + quilt(t * 1.4),
              hemEnd: true,
              uv: (t, phi) => [u(phi), sleeveV(t)],
            }),
          );
          // A high collar round the neck.
          m.tube(a.part("head"), {
            from: 0,
            to: a.headT(-0.12),
            offset: () => 0.016,
            hemEnd: true,
            uv: (_t, phi) => [u(phi), 0.98],
          });
        },
      },
    ],
  };
}

export function snowPants(color: number): Garment {
  return {
    hides: () => ({ torso: [0, torsoT(0.6)], "leg.L": [-0.08, 1.04], "leg.R": [-0.08, 1.04] }),
    layers: [
      {
        fabric: { color, roughness: 0.85 },
        build(m, a) {
          // The waist sits under a jacket, so it is snug.
          m.tube(a.part("torso"), {
            from: 0,
            to: torsoT(0.63),
            offset: (t) => 0.022 - smoothstep(torsoT(0.54), torsoT(0.6), t) * 0.008,
            hemEnd: true,
          });
          both((L) =>
            m.tube(a.part(`leg.${L}`), {
              from: -0.08,
              to: 1.0,
              // Baggy, gathering over the boots.
              offset: (t) => 0.022 + smoothstep(0.4, 0.95, t) * 0.02 + bell(t - KNEE, 0.08) * 0.005,
              hemEnd: true,
            }),
          );
        },
      },
    ],
  };
}

export function boots(color: number, sole: number): Garment {
  return {
    hides: () => ({ "foot.L": [0, 0.98], "foot.R": [0, 0.98] }),
    layers: [
      {
        fabric: { color, roughness: 0.6 },
        build(m, a) {
          both((L) => {
            m.tube(a.part(`foot.${L}`), { offset: (_t, phi) => 0.016 + (Math.cos(phi) > 0 ? 0.004 : 0) });
            m.tube(a.part(`leg.${L}`), { from: 0.8, to: 1.04, offset: () => 0.03, hemStart: true });
          });
        },
      },
      {
        fabric: { color: sole, roughness: 0.9 },
        build(m, a) {
          both((L) =>
            m.tube(a.part(`foot.${L}`), {
              offset: (_t, phi) => (Math.cos(phi) < -0.55 ? 0.024 : -0.004),
              sides: 1.4,
            }),
          );
        },
      },
    ],
  };
}

export function waterShoes(color: number): Garment {
  return {
    hides: () => ({ "foot.L": [0.1, 0.9], "foot.R": [0.1, 0.9] }),
    layers: [
      {
        fabric: { color, roughness: 0.7 },
        build(m, a) {
          both((L) => m.tube(a.part(`foot.${L}`), { offset: (_t, phi) => 0.005 + (Math.cos(phi) < -0.6 ? 0.006 : 0) }));
        },
      },
    ],
  };
}

export function gloves(color: number): Garment {
  return {
    hides: () => ({ "hand.L": [0, 0.97], "hand.R": [0, 0.97], "thumb.L": [0, 0.92], "thumb.R": [0, 0.92] }),
    layers: [
      {
        fabric: { color, roughness: 0.8 },
        build(m, a) {
          both((L) => {
            m.tube(a.part(`hand.${L}`), { offset: () => 0.007 });
            m.tube(a.part(`thumb.${L}`), { offset: () => 0.006 });
            m.tube(a.part(`arm.${L}`), { from: 0.9, to: 1.0, offset: () => 0.032, hemStart: true });
          });
        },
      },
    ],
  };
}

export function beanie(color: number, cuffColor: number): Garment {
  const rim = (phi: number) => 0.63 + 0.02 * bell(phi, 0.7) - 0.04 * bell(Math.abs(phi) - Math.PI / 2, 0.5);
  return {
    hatLine: rim,
    hides: (a) => ({ head: [a.headT(0.72), 1] }),
    layers: [
      {
        fabric: {
          color,
          roughness: 0.95,
          paint: (c, size, a) => {
            // The turned-up cuff, following the rim; ribbing above it.
            c.fillStyle = `#${cuffColor.toString(16).padStart(6, "0")}`;
            for (let x = 0; x < size; x++) {
              const phi = (x / size) * Math.PI * 2 - Math.PI;
              const v0 = a.headT(rim(phi));
              const v1 = a.headT(rim(phi) + 0.075);
              c.fillRect(x, (1 - v1) * size, 1, (v1 - v0) * size + 2);
            }
            c.fillStyle = "rgba(0,0,0,0.12)";
            for (let x = 0; x < size; x += 6) c.fillRect(x, 0, 2, size);
          },
        },
        build(m, a) {
          m.tube(a.part("head"), {
            from: a.headT(0.56),
            offset: (t, phi) => {
              const h = a.headU(t);
              if (h < rim(phi)) return -0.004;
              // The cuff stands a little proud of the rest.
              return h < rim(phi) + 0.075 ? 0.019 : 0.016 + smoothstep(0.8, 1, h) * 0.003;
            },
          });
        },
      },
    ],
  };
}

export function goggles(frame: number, lens: number): Garment {
  const lensBand = (u: number, phi: number) => Math.abs(phi) < 1.1 && u > 0.445 && u < 0.585;
  const strapBand = (u: number) => u > 0.505 && u < 0.56;
  return {
    layers: [
      {
        fabric: { color: frame, roughness: 0.5 },
        build(m, a) {
          m.tube(a.part("head"), {
            from: a.headT(0.43),
            to: a.headT(0.6),
            offset: (t, phi) => {
              const u = a.headU(t);
              if (Math.abs(phi) < 1.18 && u > 0.43 && u < 0.6) return 0.024 + 0.006 * bell(phi, 0.6);
              return strapBand(u) ? 0.022 : -0.006;
            },
            capEnd: false,
          });
        },
      },
      {
        fabric: { color: lens, roughness: 0.12, metalness: 0.7 },
        build(m, a) {
          m.tube(a.part("head"), {
            from: a.headT(0.44),
            to: a.headT(0.59),
            offset: (t, phi) => (lensBand(a.headU(t), phi) ? 0.028 + 0.007 * bell(phi, 0.6) : -0.006),
            capEnd: false,
            sides: 1.3,
          });
        },
      },
    ],
  };
}

export function cap(color: number, peakColor: number): Garment {
  const rim = (phi: number) => 0.68 - 0.06 * smoothstep(1.2, 2.6, Math.abs(phi));
  return {
    hatLine: rim,
    hides: (a) => ({ head: [a.headT(0.8), 1] }),
    layers: [
      {
        fabric: { color, roughness: 0.85 },
        build(m, a) {
          m.tube(a.part("head"), {
            from: a.headT(0.58),
            offset: (t, phi) => (a.headU(t) > rim(phi) ? 0.012 : -0.004),
          });
        },
      },
      {
        fabric: { color: peakColor, roughness: 0.8 },
        build(m, a) {
          // The peak: a curved shelf out over the forehead.
          const u = rim(0) + 0.01;
          const s = a.headAt(u);
          const shape = new THREE.Shape();
          const pts: THREE.Vector2[] = [];
          const n = 12;
          for (let i = 0; i <= n; i++) {
            const phi = -1.15 + (i / n) * 2.3;
            const p = sectionPoint(s, phi, 0.006, new THREE.Vector3());
            pts.push(new THREE.Vector2(p.x, p.z));
          }
          for (let i = n; i >= 0; i--) {
            const phi = -1.15 + (i / n) * 2.3;
            const p = sectionPoint(s, phi, 0.006 + 0.07 * Math.cos(phi * 1.2), new THREE.Vector3());
            pts.push(new THREE.Vector2(p.x, p.z));
          }
          shape.setFromPoints(pts);
          const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: false });
          // Shape space (x, z) → model space, tipped down a little at the front.
          geo.rotateX(Math.PI / 2);
          geo.translate(0, s.c.y + 0.003, 0);
          const tip = new THREE.Matrix4().makeRotationX(0.16);
          const pivot = new THREE.Vector3(0, s.c.y, s.c.z + s.df);
          geo.translate(-pivot.x, -pivot.y, -pivot.z).applyMatrix4(tip).translate(pivot.x, pivot.y, pivot.z);
          m.rigid(geo, BONE.head);
        },
      },
    ],
  };
}
