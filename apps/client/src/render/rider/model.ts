// A whole rider, built for a look and an outfit: skin, face, hair and
// garments as skinned meshes on one skeleton.
import * as THREE from "three/webgpu";
import type { Look } from "@shifty/rider";
import { Anatomy, type PartName } from "./anatomy.ts";
import type { Fabric, Garment } from "./clothes.ts";
import { FacePainter } from "./face.ts";
import { buildHair, hairline } from "./hair.ts";
import { type Detail, MeshBuilder } from "./mesh.ts";
import { HAIR, SKIN } from "./palette.ts";
import { Rig } from "./rig.ts";

/** How riders are drawn: how finely they are built, shaded and textured. */
export interface RiderStyle {
  name: string;
  detail: Detail;
  /** Faceted (flat-shaded) instead of smooth. */
  flat: boolean;
  /** Face texture width, and nearest-pixel filtering. */
  face: number;
  nearest: boolean;
  /** Head size relative to real proportions. */
  headScale: number;
}

export const STYLES: Record<"psx" | "n64" | "ps2", RiderStyle> = {
  psx: { name: "PS1", detail: { rings: 5, sides: 8 }, flat: true, face: 128, nearest: true, headScale: 1.15 },
  n64: {
    name: "N64 / GameCube",
    detail: { rings: 8, sides: 11 },
    flat: false,
    face: 256,
    nearest: false,
    headScale: 1.12,
  },
  ps2: { name: "PS2", detail: { rings: 12, sides: 16 }, flat: false, face: 512, nearest: false, headScale: 1.07 },
};

const SKIN_PARTS: PartName[] = [
  "torso",
  "arm.L",
  "arm.R",
  "hand.L",
  "hand.R",
  "thumb.L",
  "thumb.R",
  "leg.L",
  "leg.R",
  "foot.L",
  "foot.R",
  "ear.L",
  "ear.R",
];

/** The parts of [t0, t1] not inside any of `hidden` (each hidden stretch shrunk a little at its ends, so skin runs under a garment's edge). */
function visible(t0: number, t1: number, hidden: [number, number][]): [number, number][] {
  const overlap = 0.03;
  let spans: [number, number][] = [[t0, t1]];
  for (const [h0, h1] of hidden) {
    const a = h0 <= t0 + 1e-6 ? h0 : h0 + overlap;
    const b = h1 >= t1 - 1e-6 ? h1 : h1 - overlap;
    if (b <= a) continue;
    const next: [number, number][] = [];
    for (const [s0, s1] of spans) {
      if (b <= s0 || a >= s1) next.push([s0, s1]);
      else {
        if (a > s0) next.push([s0, a]);
        if (b < s1) next.push([b, s1]);
      }
    }
    spans = next;
  }
  return spans.filter(([a, b]) => b - a > 0.005);
}

export class RiderMesh {
  readonly group = new THREE.Group();
  readonly rig: Rig;
  readonly anatomy: Anatomy;
  /** The painted face (look testing). */
  readonly faceTexture: THREE.Texture;
  private disposables: { dispose(): void }[] = [];

  constructor(look: Look, outfit: Garment[], style: RiderStyle) {
    const a = new Anatomy(look, style.headScale);
    this.anatomy = a;
    this.rig = new Rig(a);
    this.group.add(this.rig.root);
    const hides = new Map<PartName, [number, number][]>();
    for (const g of outfit) {
      for (const [part, span] of Object.entries(g.hides?.(a) ?? {}) as [PartName, [number, number]][]) {
        hides.set(part, [...(hides.get(part) ?? []), span]);
      }
    }
    const hat = outfit.find((g) => g.hatLine)?.hatLine ?? null;

    const [skinColor] = SKIN[look.skin] ?? SKIN[1]!;
    const skin = new MeshBuilder(style.detail);
    for (const name of SKIN_PARTS) {
      const part = a.part(name);
      for (const [from, to] of visible(part.t0, part.t1, hides.get(name) ?? [])) skin.tube(part, { from, to });
    }
    this.add(skin, { color: skinColor, roughness: 0.7 }, style);

    const face = new MeshBuilder(style.detail);
    const head = a.part("head");
    for (const [from, to] of visible(head.t0, head.t1, hides.get("head") ?? [])) face.tube(head, { from, to });
    const painter = new FacePainter(a);
    const faceTex = painter.paint(look, {
      size: style.face,
      nearest: style.nearest,
      hairline: hairline(look),
    });
    this.faceTexture = faceTex;
    this.add(face, { color: 0xffffff, roughness: 0.68, texture: faceTex }, style);

    const hair = new MeshBuilder(style.detail);
    buildHair(hair, a, look, hat);
    this.add(hair, { color: HAIR[look.hairColor] ?? HAIR[1]!, roughness: 0.55 }, style);

    for (const g of outfit) {
      for (const layer of g.layers) {
        const m = new MeshBuilder(style.detail);
        layer.build(m, a);
        this.add(m, layer.fabric, style);
      }
    }
  }

  private add(m: MeshBuilder, fabric: Fabric, style: RiderStyle): void {
    if (m.empty) return;
    const geo = m.build();
    let texture = fabric.texture;
    let color = fabric.color;
    if (fabric.paint) {
      const size = style.face >= 512 ? 256 : 128;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const c = canvas.getContext("2d")!;
      c.fillStyle = `#${fabric.color.toString(16).padStart(6, "0")}`;
      c.fillRect(0, 0, size, size);
      fabric.paint(c, size, this.anatomy);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      if (style.nearest) {
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
      }
      color = 0xffffff;
    }
    const mat = new THREE.MeshStandardNodeMaterial({
      color,
      roughness: fabric.roughness ?? 0.8,
      metalness: fabric.metalness ?? 0,
      flatShading: style.flat,
    });
    if (texture) mat.map = texture;
    const mesh = new THREE.SkinnedMesh(geo, mat);
    // The sun's shadow map is far too coarse for a rider to shadow itself.
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // Riders move about a lot: skip per-frame bounds checks against a stale rest pose.
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.group.updateMatrixWorld(true);
    mesh.bind(this.rig.skeleton, mesh.matrixWorld);
    this.disposables.push(geo, mat);
    if (texture) this.disposables.push(texture);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
