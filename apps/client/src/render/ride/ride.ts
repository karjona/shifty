// A ride, a jetski or a snowboard, in an item's colourway: its model's
// art, cel shaded like the riders (the mask's colours, glossy where the
// paint says) with an ink outline, the jetski's bars turning on their own
// bone. The art loads in the background; the ride shows once it is in and
// its shaders are compiled.
import * as THREE from "three/webgpu";
import { texture, vec3 } from "three/tsl";
import { type Colourway, type Sport, defaultOutfits, item } from "@shifty/rider";
import { inkId } from "../cel/material.ts";
import { CelTintMaterial, outlineOf } from "../cel/rider.ts";
import { whileLoading } from "../../loading.ts";
import { warmUp } from "../warm.ts";
import { type RideAsset, builtRides, loadRide } from "./assets.ts";

/** Painted plastic and fibreglass: glossy, where the mask's alpha says so. */
const FINISH = { roughness: 0.3 };
const RIM = 0.15;
const SPEC_SIZE = 0.018;

/** The model that draws an item: its own, or the sport's starter ride until its art is built. */
async function modelOf(sport: Sport, id: string | undefined): Promise<string | null> {
  const built = await builtRides();
  const own = id ? item(id)?.model : undefined;
  if (own && built.has(own)) return own;
  const starter = item(defaultOutfits("male")[sport].ride ?? "")?.model;
  return starter && built.has(starter) ? starter : null;
}

export class Ride {
  readonly group = new THREE.Group();
  /** Resolves once the art has first gone on (or turned out not to exist). */
  readonly ready: Promise<void>;
  private markReady: () => void = () => {};
  private bars: THREE.Bone | null = null;
  private turn = 0;
  private colours: Colourway;
  private mat: CelTintMaterial | null = null;
  private meshes: THREE.Object3D[] = [];
  private model: string | null = null;
  private version = 0;

  constructor(sport: Sport, id: string | undefined, colours: Colourway) {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.colours = colours;
    this.set(sport, id, colours);
  }

  /** Puts an item on: rebuilt if its model changed, repainted if only its colours did. */
  set(sport: Sport, id: string | undefined, colours: Colourway): void {
    this.colours = colours;
    this.mat?.setTints(...colours);
    const version = ++this.version;
    void whileLoading(
      (async () => {
        const model = await modelOf(sport, id);
        if (version !== this.version || model === this.model) {
          if (version === this.version) this.markReady();
          return;
        }
        if (!model) {
          this.markReady();
          return;
        }
        const asset = await loadRide(model);
        if (version !== this.version) return;
        const built = this.build(model, asset);
        await warmUp(built.root);
        if (version !== this.version) {
          built.mat.dispose();
          return;
        }
        this.clear();
        this.model = model;
        this.mat = built.mat;
        this.mat.setTints(...this.colours);
        this.bars = built.bars;
        this.meshes = built.root.children.slice();
        this.group.add(...this.meshes);
        this.steer(this.turn);
        this.markReady();
      })().catch(() => this.markReady()),
    );
  }

  /** Turns the bars about their upright (rad, + to the left). */
  steer(angle: number): void {
    this.turn = angle;
    if (this.bars) this.bars.rotation.y = angle;
  }

  private build(model: string, asset: RideAsset): { root: THREE.Group; mat: CelTintMaterial; bars: THREE.Bone | null } {
    const mat = new CelTintMaterial(asset.detail, asset.mask, FINISH, false, "kit", inkId(model));
    mat.specColorNode = vec3(texture(asset.mask).a);
    // Big hard surfaces turn away from the camera over wide areas: only a touch of the riders' rim of sky light,
    // and a smaller highlight (a broad, gently curved face would light up whole).
    mat.rimStrength = RIM;
    mat.specSize = SPEC_SIZE;
    const root = new THREE.Bone();
    const bones = [root];
    let bars: THREE.Bone | null = null;
    if (asset.bars) {
      bars = new THREE.Bone();
      bars.position.copy(asset.bars);
      root.add(bars);
      bones.push(bars);
    }
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    const mesh = new THREE.SkinnedMesh(asset.geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const outline = outlineOf(mesh, mat);
    const group = new THREE.Group();
    group.add(root, mesh, outline);
    mesh.bind(skeleton, new THREE.Matrix4());
    outline.bind(skeleton, new THREE.Matrix4());
    return { root: group, mat, bars };
  }

  private clear(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      if (m instanceof THREE.Mesh && m.material instanceof THREE.Material && m.material !== this.mat)
        m.material.dispose();
    }
    this.mat?.dispose();
    this.meshes = [];
    this.mat = null;
    this.bars = null;
  }

  dispose(): void {
    this.version++;
    this.clear();
    this.model = null;
  }
}
