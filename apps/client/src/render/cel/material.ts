// Cel shading: two tones per surface (lit and shade), split on a hard line
// by the sun and the shadows it casts, with a crisp highlight and an
// optional rim. Every lit surface of the cel look uses it.
import * as THREE from "three/webgpu";
import { STYLE } from "./look.ts";
import {
  clamp,
  diffuseColor,
  dot,
  float,
  fwidth,
  max,
  mix,
  mrt,
  pow,
  normalView,
  output,
  positionViewDirection,
  screenCoordinate,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

/** The sun's unshadowed strength (sum of its colour's channels × intensity), to tell light from cast shadow. */
export const SUN_STRENGTH = uniform(1);
/** Toward the sun (world). */
export const SUN_DIR = uniform(new THREE.Vector3(0, 1, 0));

/**
 * Lets `m` write its ink only into the cel pass: other passes (shadow maps,
 * reflections) have no ink target to write it to.
 */
export function inkOnlyInPass<M extends THREE.NodeMaterial>(m: M, ink: THREE.MRTNode): M {
  m.mrtNode = ink;
  const setup = m.setup.bind(m);
  m.setup = (builder: THREE.NodeBuilder) => {
    const saved = m.mrtNode;
    if (builder.renderer.getMRT() === null) m.mrtNode = null;
    const out = setup(builder);
    m.mrtNode = saved;
    return out;
  };
  return m;
}

/** What the ink pass reads for each pixel (see post.ts): silhouette and crease weights, and an id. */
export function inkNode(silhouette: number, crease: number, id: number, darkness = 1): THREE.MRTNode {
  return mrt({ output, ink: vec4(silhouette, crease, id, darkness) });
}

export interface CelOptions {
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  flatShading?: boolean;
  fog?: boolean;
  side?: THREE.Side;
  /** The shade tone, as a multiple of the colour. */
  shade?: THREE.ColorRepresentation;
  /** The lit tone, as a multiple of the colour. */
  lit?: THREE.ColorRepresentation;
  /** Where light turns to shade, on the cosine of the sun's angle (-1 to 1). */
  threshold?: number;
  /** A per-pixel shift of the threshold (positive = more light). */
  bias?: THREE.Node<"float">;
  /** Strength and size (0-1) of the highlight. */
  spec?: number;
  specSize?: number;
  /** How much richer shade is than the colour (1 = a plain multiple of it). */
  richness?: number;
  /** Strength of a rim of sky light on the silhouette. */
  rim?: number;
  /** Screen-space ink: silhouettes, creases (0 = none, 1 = full). */
  silhouette?: number;
  crease?: number;
  /** Objects with different ids get a line where they meet. */
  id?: number;
  /** A colour node instead of `color`. */
  colorNode?: THREE.Node<"vec3">;
  map?: THREE.Texture | null;
  /** How dark its lines are (0 = the colour itself, 1 = full ink). */
  darkness?: number;
}

/** Default shade: a cool, slightly violet tone, as in a painted shadow. */
export const SHADE = new THREE.Color(0.62, 0.6, 0.82);
export const LIT = new THREE.Color(1.0, 0.98, 0.94);

/** three types lighting inputs and material colour nodes as plain nodes; these are all vec3s. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asVec3 = (n: THREE.Node): THREE.Node<"vec3"> => n as THREE.Node<"vec3">;

class CelLightingModel extends THREE.LightingModel {
  private m: CelMaterial;

  constructor(m: CelMaterial) {
    super();
    this.m = m;
  }

  override direct(input: THREE.LightingModelDirectInput): void {
    const m = this.m;
    const lightDirection = asVec3(input.lightDirection);
    const lightColor = asVec3(input.lightColor);
    const directDiffuse = asVec3(input.reflectedLight.directDiffuse);
    const directSpecular = asVec3(input.reflectedLight.directSpecular);
    const n = normalView;
    const ndl = dot(n, lightDirection);
    const x = m.biasNode ? ndl.add(m.biasNode) : ndl;
    const w = max(fwidth(x), float(1e-3)).mul(0.75);
    const facing = smoothstep(m.threshold.sub(w), m.threshold.add(w), x);
    // The light arrives with the cast shadow already in it.
    const unshadowed = clamp(dot(lightColor, vec3(1)).div(SUN_STRENGTH), 0, 1);
    const band = facing.mul(smoothstep(0.4, 0.6, unshadowed));
    const albedo = diffuseColor.rgb;
    const shade: THREE.Node<"vec3"> = m.shadeNode ?? m.shade.rgb;
    // Shade is darker and richer than the colour, as painters mix it (a power keeps it from going grey).
    const shaded = pow(albedo, vec3(m.richness)).mul(shade);
    // A second, deeper shade in the darkest folds (where the painter darkened most).
    let deepShaded = m.deepNode ? mix(shaded, shaded.mul(0.72), m.deepNode) : shaded;
    if (STYLE === "comic") {
      // Comic shade: a halftone of dots, on a 45° screen, bigger where the shade is deeper.
      const cell = 7;
      const r2 = Math.SQRT1_2;
      const p = vec2(
        screenCoordinate.x.add(screenCoordinate.y).mul(r2),
        screenCoordinate.y.sub(screenCoordinate.x).mul(r2),
      ).div(cell);
      const d = p.fract().sub(0.5).length();
      const size = m.deepNode ? mix(float(0.3), float(0.42), m.deepNode) : float(0.3);
      const aa = fwidth(d);
      const halftone = smoothstep(size.add(aa), size.sub(aa), d);
      deepShaded = mix(albedo.mul(m.lit).mul(0.92), shaded.mul(0.85), halftone);
    }
    directDiffuse.addAssign(mix(deepShaded, albedo.mul(m.lit), band));
    if (m.specStrength > 0) {
      const h = lightDirection.add(positionViewDirection).normalize();
      const nh = dot(n, h);
      const edge = float(1 - m.specSize);
      const sw = max(fwidth(nh), float(1e-3));
      const spec = smoothstep(edge.sub(sw), edge.add(sw), nh).mul(band).mul(m.specStrength);
      directSpecular.addAssign(m.specColorNode ? m.specColorNode.mul(spec) : vec3(spec));
    }
    if (m.rimStrength > 0) {
      const nv = dot(n, positionViewDirection);
      const rw = max(fwidth(nv), float(1e-3));
      // A crisp edge of sky light on the shade side, as in fighting-game key art.
      const rim = smoothstep(float(0.34).add(rw), float(0.34).sub(rw), nv).mul(float(1).sub(band)).mul(m.rimStrength);
      directSpecular.addAssign(
        albedo
          .mul(0.45)
          .add(vec3(0.32, 0.38, 0.5))
          .mul(rim),
      );
    }
  }

  override indirect(): void {}
}

export class CelMaterial extends THREE.MeshToonNodeMaterial {
  readonly isCelMaterial = true;
  shade = uniform(new THREE.Color().copy(SHADE));
  lit = uniform(new THREE.Color().copy(LIT));
  threshold = uniform(0);
  biasNode: THREE.Node<"float"> | null;
  /** The highlight's colour (white if null). */
  specColorNode: THREE.Node<"vec3"> | null = null;
  /** Where shade deepens to a second, darker tone (0-1). */
  deepNode: THREE.Node<"float"> | null = null;
  /** A per-pixel shade tone, instead of `shade`. */
  shadeNode: THREE.Node<"vec3"> | null = null;
  specStrength: number;
  /** How much richer (more saturated) shade is than the colour (1 = a plain multiple). */
  richness: number;
  specSize: number;
  rimStrength: number;

  constructor(o: CelOptions = {}) {
    super({
      color: o.color ?? 0xffffff,
      vertexColors: o.vertexColors ?? false,
      fog: o.fog ?? true,
      side: o.side ?? THREE.FrontSide,
      map: o.map ?? null,
    });
    Object.assign(this, { flatShading: o.flatShading ?? false });
    if (o.colorNode) this.colorNode = o.colorNode;
    if (o.shade !== undefined) this.shade.value.set(o.shade);
    if (o.lit !== undefined) this.lit.value.set(o.lit);
    this.threshold.value = o.threshold ?? 0.05;
    this.biasNode = o.bias ?? null;
    this.specStrength = o.spec ?? 0;
    this.richness = o.richness ?? 1.3;
    this.specSize = o.specSize ?? 0.04;
    this.rimStrength = o.rim ?? 0;
    inkOnlyInPass(this, inkNode(o.silhouette ?? 1, o.crease ?? 1, o.id ?? 0, o.darkness ?? 1));
  }

  override setupLightingModel(): THREE.LightingModel {
    return new CelLightingModel(this);
  }
}

/** A hashed id in (0, 1) for `inkNode`, from any string. */
export function inkId(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return ((h >>> 0) % 997) / 997 + 0.0005;
}

/** Unlit colour (sky, glows) that the ink pass leaves alone. */
export function inklessBasic(params: THREE.MeshBasicNodeMaterialParameters): THREE.MeshBasicNodeMaterial {
  return inkOnlyInPass(new THREE.MeshBasicNodeMaterial(params), inkNode(0, 0, 0, 0));
}

/**
 * Swaps the standard materials under `root` for cel ones (same colour,
 * vertex colours and facets). `tune` picks per-material options.
 */
export function celify(
  root: THREE.Object3D,
  tune: (m: THREE.MeshStandardNodeMaterial, o: THREE.Mesh) => CelOptions = () => ({}),
  /** Also convert materials with their own colour node (it becomes the cel colour). */
  keepColorNodes = false,
): void {
  const done = new Map<THREE.Material, CelMaterial>();
  const swap = (m: THREE.Material, o: THREE.Mesh): THREE.Material => {
    if (!(m instanceof THREE.MeshStandardNodeMaterial)) return m;
    if (m.positionNode || (!keepColorNodes && (m.colorNode || m.emissiveNode))) return m;
    let c = done.get(m);
    if (!c) {
      const colorNode: unknown = m.userData.colorNode ?? (keepColorNodes ? m.colorNode : null);
      c = new CelMaterial({
        colorNode: colorNode instanceof THREE.Node ? asVec3(colorNode) : undefined,
        color: m.color,
        map: m.map,
        vertexColors: m.vertexColors,
        flatShading: m.flatShading,
        fog: m.fog,
        side: m.side,
        ...tune(m, o),
      });
      done.set(m, c);
    }
    return c;
  };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.material = Array.isArray(o.material) ? o.material.map((m) => swap(m, o)) : swap(o.material, o);
  });
}
