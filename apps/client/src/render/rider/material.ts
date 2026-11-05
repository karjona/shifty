// The riders' material: a painted detail texture tinted by a mask, so one
// texture serves every skin tone and colourway (see art/rider/paint.py).
// Where the mask is set, the detail holds tint factors per channel (0.5 =
// the tint itself, lower darkens, higher brightens, keeping the hue);
// elsewhere it holds a plain sRGB colour. A rim of sky light picks out the silhouette.
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  clamp,
  floor,
  float,
  max,
  min,
  mix,
  mod,
  normalView,
  positionViewDirection,
  pow,
  texture,
  uniform,
  vec3,
} from "three/tsl";

export interface Finish {
  roughness: number;
  metalness?: number;
  /** Strength of the rim light (0-1). */
  rim?: number;
  /** How much of the painted colour shows whatever the light (0-1; TintMaterial.FLAT by default). */
  flat?: number;
}

export class TintMaterial extends THREE.MeshStandardNodeMaterial {
  /** Look testing: draw the painted colour unlit. */
  static unlit = false;
  /** How much of the painted colour shows whatever the light (the rest is lit by the scene), by default. */
  static readonly FLAT = 0.42;

  /** Main, second and accent tints (for skin: skin, eyes, hair). */
  private main = uniform(new THREE.Color());
  private second = uniform(new THREE.Color());
  private accent = uniform(new THREE.Color());

  /** Body regions not drawn (bits), on meshes tagged with `_region`. */
  private hidden = uniform(0);

  constructor(detail: THREE.Texture, mask: THREE.Texture, finish: Finish, regions = false) {
    super({ roughness: finish.roughness, metalness: finish.metalness ?? 0 });
    if (regions) {
      const region = floor(attribute<"float">("_region", "float").add(0.5));
      this.maskNode = mod(floor(this.hidden.div(pow(2, region))), 2).lessThan(0.5);
    }
    const [t0, t1, t2] = [this.main, this.second, this.accent];
    const albedo = Fn(() => {
      const g = texture(detail).rgb;
      const w = texture(mask).rgb;
      const sum = w.x.add(w.y).add(w.z);
      const tint = t0.mul(w.x).add(t1.mul(w.y)).add(t2.mul(w.z)).div(max(sum, 1e-4));
      // Twice the factor times the tint; past full brightness the hue holds and the excess turns to white.
      const lit = tint.mul(g.mul(2));
      const top = max(max(lit.x, lit.y), lit.z);
      const tinted = min(lit.div(max(top, 1)).add(clamp(top.sub(1), 0, 1).mul(0.5)), vec3(1));
      const plain = pow(g, vec3(2.2));
      return mix(plain, tinted, clamp(sum, 0, 1));
    })();
    // The paint carries the shading: the scene's lights only add part of it, the rest shows as painted.
    const flat = finish.flat ?? TintMaterial.FLAT;
    this.colorNode = albedo.mul(1 - flat);
    const rim = float(finish.rim ?? 0.5);
    const facing = clamp(normalView.dot(positionViewDirection), 0, 1);
    const edge = pow(float(1).sub(facing), 3).mul(rim);
    this.emissiveNode = albedo.mul(flat).add(
      mix(albedo, vec3(0.85, 0.92, 1), 0.5)
        .mul(edge)
        .mul(0.55),
    );
    if (TintMaterial.unlit) {
      this.colorNode = vec3(0);
      this.emissiveNode = albedo;
    }
  }

  /** Hides body regions (bits of REGIONS). */
  hide(regions: number): void {
    this.hidden.value = regions;
  }

  /** Sets the tints (0xRRGGBB, sRGB). */
  setTints(main: number, second: number, accent: number): void {
    this.main.value.setHex(main);
    this.second.value.setHex(second);
    this.accent.value.setHex(accent);
  }
}
