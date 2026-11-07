// A rider's figure: the body and what they wear for a sport, skinned to
// one rig. The art loads in the background; the figure fills in when it
// arrives (and is empty until then).
import * as THREE from "three/webgpu";
import {
  type Appearance,
  type Colourway,
  EYE_COLOURS,
  HAIR_COLOURS,
  type Kit,
  type Look,
  REQUIRED,
  SKIN_TONES,
  SLOTS,
  type Sport,
  defaultOutfits,
  item,
} from "@shifty/rider";
import { type ModelAsset, type TintSource, builtModels, loadModel, loadOverlay } from "./assets.ts";
import { inkId } from "../cel/material.ts";
import { CelTintMaterial, type FaceOverlays, NO_OVERLAY, faceGeometry, limbGeometry, outlineOf } from "../cel/rider.ts";
import { whileLoading } from "../../loading.ts";
import { warmUp } from "../warm.ts";
import { type Pose, Rig } from "./rig.ts";
import { type Body, bodyFromRest } from "./skeleton.ts";

/** Standing heights per height preset (m). Both bodies' art is built 1.78 m tall (the male's middle preset). */
const HEIGHTS = { male: [1.68, 1.73, 1.78, 1.83, 1.88], female: [1.58, 1.63, 1.68, 1.73, 1.78] };
const ART_HEIGHT = 1.78;

interface Worn {
  model: string;
  colours: Colourway | null;
  /** Only these pieces of the model (all if absent). */
  pieces?: readonly string[];
}

/** How each hat leaves the hair: the hair model's piece that shows under it. */
const HAIR_UNDER: Record<string, string> = { "summer.head.cap": "cap", "winter.head.beanie": "beanie" };

/** The look's parts that only tint or size the figure (`build` doesn't show): changing them repaints it, no rebuild. */
type PaintPart = "skin" | "hairColor" | "eyeColor" | "height" | "build";

/** A piece's tints, from the look or the item's colourway. */
function tintsOf(look: Look, source: TintSource, colours: Colourway | null): Colourway {
  const hair = HAIR_COLOURS[look.hairColor] ?? HAIR_COLOURS[1]!;
  if (source === "hair") return [hair, hair, hair];
  const own: Colourway = [SKIN_TONES[look.skin] ?? SKIN_TONES[1]!, EYE_COLOURS[look.eyeColor] ?? EYE_COLOURS[0]!, hair];
  return source === "look" ? own : (colours ?? own);
}

/** The figure's scale for a look's height, on a body's art. */
function heightScale(body: Look["body"], height: number): number {
  return (HEIGHTS[body][height] ?? ART_HEIGHT) / ART_HEIGHT;
}

/** The look's parts that shape the face: each preset but the first is a morph target of the art, `<part>.<n>`. */
const SHAPES = ["eyes", "nose", "mouth"] as const;

/** What a look wears over its face: its eyes', nose's and mouth's paint (the first nose and mouth have none), its
 * brows and beard. */
async function overlaysFor(look: Look): Promise<FaceOverlays> {
  const [brows, beard, ...features] = await Promise.all([
    loadOverlay(look.body, `brows.${look.brows}`),
    look.facialHair > 0 ? loadOverlay(look.body, `beard.${look.facialHair}`) : Promise.resolve(null),
    loadOverlay(look.body, `eyes.${look.eyes}`),
    look.nose > 0 ? loadOverlay(look.body, `nose.${look.nose}`) : Promise.resolve(null),
    look.mouth > 0 ? loadOverlay(look.body, `mouth.${look.mouth}`) : Promise.resolve(null),
  ]);
  return {
    brows: brows ?? NO_OVERLAY,
    beard: beard ?? NO_OVERLAY,
    features: features.filter((f): f is THREE.Texture => f !== null),
  };
}

/** The body whose art draws a look: its own, or the male art until a body's art is built. */
async function artBody(look: Look): Promise<Look["body"]> {
  return (await builtModels(look.body)).has("body") ? look.body : "male";
}

/** What a rider wears: their hair (as it sits under any hat), then each item, for the models the art has.
 * A required slot whose model isn't built yet shows the starter model there, in the item's colours. */
async function worn(look: Look, kit: Kit, sport: Sport): Promise<Worn[]> {
  const built = await builtModels(look.body);
  const starters = defaultOutfits(look.body);
  const items = SLOTS[sport].flatMap((slot) => {
    const id = kit[slot];
    const it = id ? item(id) : undefined;
    if (!it) return [];
    const starter = REQUIRED[sport].includes(slot) ? starters[sport][slot] : undefined;
    const model = [it.model, starter && item(starter)?.model].find((m): m is string => m !== undefined && built.has(m));
    return model ? [{ model, colours: it.colours }] : [];
  });
  const style = built.has(`hair.${look.hair}`) ? `hair.${look.hair}` : "hair.0";
  const hat = items.find((i) => i.model in HAIR_UNDER);
  const hair: Worn[] = built.has(style)
    ? [{ model: style, colours: null, pieces: [hat ? HAIR_UNDER[hat.model]! : "free"] }]
    : [];
  return [...hair, ...items];
}

export class RiderFigure {
  readonly group = new THREE.Group();
  /** The rig and the body's measures, once the art has loaded. */
  rig: Rig | null = null;
  body: Body | null = null;
  private meshes: THREE.SkinnedMesh[] = [];
  private materials: Painted[] = [];
  /** What the figure is built as (the look but its paint, what it wears, the sport). */
  private key = "";
  /** The latest look asked for: its paint goes on whatever is built. */
  private look: Look | null = null;
  private version = 0;
  private pending: Pose | null = null;
  private rigFor: Look["body"] | null = null;
  /** Called each time the figure has been (re)built. */
  onBuilt: (() => void) | null = null;
  /** Resolves once the art has first gone on. */
  readonly ready: Promise<void>;
  private markReady: () => void = () => {};

  constructor(appearance: Appearance, sport: Sport) {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.set(appearance, sport);
  }

  /** Dresses the figure: rebuilt when its shape or what it wears changed, repainted when only colours or size did. */
  set(appearance: Appearance, sport: Sport): void {
    this.look = appearance.look;
    const shape: Partial<Look> = { ...appearance.look };
    for (const part of ["skin", "hairColor", "eyeColor", "height", "build"] satisfies PaintPart[]) delete shape[part];
    const key = JSON.stringify([shape, appearance.outfits[sport], sport]);
    if (key === this.key) {
      this.repaint();
      return;
    }
    this.key = key;
    const version = ++this.version;
    void whileLoading(
      (async () => {
        const look = { ...appearance.look, body: await artBody(appearance.look) };
        const items = await worn(look, appearance.outfits[sport], sport);
        const [overlays, ...assets] = await Promise.all([
          overlaysFor(look),
          loadModel(look.body, "body"),
          ...items.map((i) => loadModel(look.body, i.model)),
        ]);
        if (version !== this.version) return;
        const built = this.build(look, assets, [{ model: "body", colours: null }, ...items], overlays);
        if (!built) return;
        // Its shaders compile before it shows; the last look stays on until then.
        await warmUp(built.group);
        if (version === this.version) this.commit(built);
        else built.dispose();
      })(),
    );
  }

  /** Poses the rig (kept for when the art arrives, if it hasn't yet). */
  pose(p: Pose): void {
    if (this.rig) this.rig.apply(p);
    else this.pending = p;
  }

  /** Model-space units per metre of the art: poses work in the art's size, the group scales it. */
  get scale(): number {
    return this.group.scale.x;
  }

  /** A look's meshes, bound to a rig (this figure's, if the body is the same), not shown yet. */
  private build(look: Look, assets: ModelAsset[], wearing: Worn[], overlays: FaceOverlays): Built | null {
    const [body] = assets;
    if (!body) return null;
    const sameRig = this.rig !== null && this.rigFor === look.body;
    const measures = sameRig ? this.body! : bodyFromRest(body.rest, ART_HEIGHT);
    const rig = sameRig ? this.rig! : new Rig(measures);
    const group = new THREE.Group();
    group.scale.setScalar(heightScale(look.body, look.height));
    const meshes: THREE.SkinnedMesh[] = [];
    const materials: Painted[] = [];
    const hidden = assets.reduce((h, a, i) => (i === 0 ? h : a.pieces.reduce((g, p) => g | p.hides, h)), 0);
    for (const [i, asset] of assets.entries()) {
      const w = wearing[i];
      for (const piece of asset.pieces) {
        if (w?.pieces && !w.pieces.includes(piece.name)) continue;
        const regions = piece.geometry.hasAttribute("_region");
        const face = i === 0 && piece.name === "face";
        const mat = new CelTintMaterial(
          piece.detail,
          piece.mask,
          piece.finish,
          regions,
          piece.tints,
          // The body's pieces are one skin: no line where they meet.
          inkId(i === 0 ? "body" : `${w?.model}.${piece.name}`),
          face,
          piece.flat,
          face ? overlays : null,
        );
        if (regions) mat.hide(hidden);
        const colours = w?.colours ?? null;
        mat.setTints(...tintsOf(look, piece.tints, colours));
        const geometry = face
          ? faceGeometry(piece.geometry)
          : piece.tints === "hair"
            ? piece.geometry
            : limbGeometry(piece.geometry, body.rest);
        const mesh = new THREE.SkinnedMesh(geometry, mat);
        for (const part of SHAPES) {
          const target = piece.morphs[`${part}.${look[part]}`];
          if (target !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[target] = 1;
        }
        mesh.castShadow = true;
        // Riders move about a lot: skip per-frame bounds checks against a stale rest pose.
        mesh.frustumCulled = false;
        group.add(mesh);
        mesh.bind(rig.skeleton, new THREE.Matrix4());
        meshes.push(mesh);
        mesh.receiveShadow = true;
        const outline = outlineOf(mesh, mat);
        group.add(outline);
        outline.bind(rig.skeleton, new THREE.Matrix4());
        meshes.push(outline);
        materials.push({ mat, tints: piece.tints, colours });
      }
    }
    return {
      group,
      rig,
      body: measures,
      rigFor: look.body,
      meshes,
      materials,
      dispose: () => {
        for (const m of materials) m.mat.dispose();
      },
    };
  }

  /** Puts a built look on (in place of the last one). */
  private commit(b: Built): void {
    this.clear();
    if (b.rig !== this.rig) this.rig?.root.removeFromParent();
    this.rig = b.rig;
    this.body = b.body;
    this.rigFor = b.rigFor;
    this.group.add(b.rig.root, ...b.meshes);
    this.meshes = b.meshes;
    this.materials = b.materials;
    this.repaint();
    if (this.pending) {
      b.rig.apply(this.pending);
      this.pending = null;
    }
    this.markReady();
    this.onBuilt?.();
  }

  /** Puts the latest look's colours and size on what is built. */
  private repaint(): void {
    const look = this.look;
    if (!look || !this.rigFor) return;
    for (const m of this.materials) m.mat.setTints(...tintsOf(look, m.tints, m.colours));
    this.group.scale.setScalar(heightScale(this.rigFor, look.height));
  }

  private clear(): void {
    for (const m of this.meshes) m.removeFromParent();
    for (const m of this.materials) m.mat.dispose();
    this.meshes = [];
    this.materials = [];
  }

  dispose(): void {
    this.version++;
    this.clear();
  }
}

/** A look built and waiting to go on. */
interface Built {
  group: THREE.Group;
  rig: Rig;
  body: Body;
  rigFor: Look["body"];
  meshes: THREE.SkinnedMesh[];
  materials: Painted[];
  dispose(): void;
}

/** A piece's material, and where its tints come from. */
interface Painted {
  mat: CelTintMaterial;
  tints: TintSource;
  colours: Colourway | null;
}
