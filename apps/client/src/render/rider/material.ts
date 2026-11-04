// The riders' material: a painted detail texture tinted by a mask, so one
// texture serves every skin tone and colourway (see art/rider/paint.py).
// Where the mask is set, the detail holds tint factors (0.5 = the tint
// itself, lower darkens, higher brightens); elsewhere it holds a
// plain sRGB colour. A rim of sky light picks out the silhouette.
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
  step,
  texture,
  uniform,
  vec3,
} from "three/tsl";

export interface Finish {
  roughness: number;
  metalness?: number;
  /** Strength of the rim light (0-1). */
  rim?: number;
}

export class TintMaterial extends THREE.MeshStandardNodeMaterial {
  /** Look testing: draw the painted colour unlit. */
  static unlit = false;

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
      const dark = tint.mul(g.mul(2));
      // Highlights brighten the colour itself first, and only whiten near the top.
      const up = g.mul(2).sub(1);
      const light = min(tint.mul(up.mul(2).add(1)), vec3(1)).add(vec3(1).sub(tint).mul(up.mul(up).mul(0.5)));
      const tinted = mix(dark, light, step(0.5, g));
      const plain = pow(g, vec3(2.2));
      return mix(plain, tinted, clamp(sum, 0, 1));
    })();
    this.colorNode = albedo;
    const rim = float(finish.rim ?? 0.5);
    const facing = clamp(normalView.dot(positionViewDirection), 0, 1);
    const edge = pow(float(1).sub(facing), 3).mul(rim);
    this.emissiveNode = mix(albedo, vec3(0.85, 0.92, 1), 0.5)
      .mul(edge)
      .mul(0.55);
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
