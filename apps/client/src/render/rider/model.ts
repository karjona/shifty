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
import { type ModelAsset, builtModels, loadModel, loadOverlay } from "./assets.ts";
import { inkId } from "../cel/material.ts";
import { CelTintMaterial, type FaceOverlays, NO_OVERLAY, faceGeometry, limbGeometry, outlineOf } from "../cel/rider.ts";
import { type Pose, Rig } from "./rig.ts";
import { type Body, bodyFromRest } from "./skeleton.ts";

/** Standing heights per height preset (m); the art is built at the middle one. */
const HEIGHTS = { male: [1.68, 1.73, 1.78, 1.83, 1.88], female: [1.58, 1.63, 1.68, 1.73, 1.78] };
const ART_HEIGHT = { male: 1.78, female: 1.68 };

interface Worn {
  model: string;
  colours: Colourway | null;
  /** Only these pieces of the model (all if absent). */
  pieces?: readonly string[];
}

/** How each hat leaves the hair: the hair model's piece that shows under it. */
const HAIR_UNDER: Record<string, string> = { "summer.head.cap": "cap", "winter.head.beanie": "beanie" };

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
  const starters = defaultOutfits("male");
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
  private materials: CelTintMaterial[] = [];
  private key = "";
  private version = 0;
  private pending: Pose | null = null;
  private rigFor: Look["body"] | null = null;
  /** Called each time the figure has been (re)built. */
  onBuilt: (() => void) | null = null;

  constructor(appearance: Appearance, sport: Sport) {
    this.set(appearance, sport);
  }

  /** Dresses the figure (rebuilt only when something changed). */
  set(appearance: Appearance, sport: Sport): void {
    const key = JSON.stringify([appearance.look, appearance.outfits[sport], sport]);
    if (key === this.key) return;
    this.key = key;
    const version = ++this.version;
    void (async () => {
      const look = { ...appearance.look, body: await artBody(appearance.look) };
      const items = await worn(look, appearance.outfits[sport], sport);
      const [overlays, ...assets] = await Promise.all([
        overlaysFor(look),
        loadModel(look.body, "body"),
        ...items.map((i) => loadModel(look.body, i.model)),
      ]);
      if (version === this.version) {
        this.build(look, assets, [{ model: "body", colours: null }, ...items], overlays);
      }
    })();
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

  private build(look: Look, assets: ModelAsset[], wearing: Worn[], overlays: FaceOverlays): void {
    this.clear();
    const [body] = assets;
    if (!body) return;
    if (!this.rig || this.rigFor !== look.body) {
      this.rig?.root.removeFromParent();
      this.body = bodyFromRest(body.rest, ART_HEIGHT[look.body]);
      this.rig = new Rig(this.body);
      this.rigFor = look.body;
      this.group.add(this.rig.root);
    }
    const s = (HEIGHTS[look.body][look.height] ?? ART_HEIGHT[look.body]) / ART_HEIGHT[look.body];
    this.group.scale.setScalar(s);
    const hair = HAIR_COLOURS[look.hairColor] ?? HAIR_COLOURS[1]!;
    const own: Colourway = [
      SKIN_TONES[look.skin] ?? SKIN_TONES[1]!,
      EYE_COLOURS[look.eyeColor] ?? EYE_COLOURS[0]!,
      hair,
    ];
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
        const tints: Colourway =
          piece.tints === "look" ? own : piece.tints === "hair" ? [hair, hair, hair] : (w?.colours ?? own);
        mat.setTints(...tints);
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
        this.group.add(mesh);
        mesh.bind(this.rig.skeleton, new THREE.Matrix4());
        this.meshes.push(mesh);
        mesh.receiveShadow = true;
        const outline = outlineOf(mesh, mat);
        this.group.add(outline);
        outline.bind(this.rig.skeleton, new THREE.Matrix4());
        this.meshes.push(outline);
        this.materials.push(mat);
      }
    }
    if (this.pending) {
      this.rig.apply(this.pending);
      this.pending = null;
    }
    this.onBuilt?.();
  }

  private clear(): void {
    for (const m of this.meshes) m.removeFromParent();
    for (const m of this.materials) m.dispose();
    this.meshes = [];
    this.materials = [];
  }

  dispose(): void {
    this.version++;
    this.clear();
  }
}
