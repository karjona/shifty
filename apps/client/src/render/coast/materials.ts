// The coast's scenery materials (shared by every circuit on the water):
// painted props (each vertex its colour), foliage that sways in the wind,
// cloth that flaps in it, and lamps that glow. A shape says how the wind
// moves it through its `sway` weight (see shape.ts).
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cos,
  float,
  instanceIndex,
  normalLocal,
  positionGeometry,
  positionLocal,
  sin,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { FOLIAGE, LOOK } from "../cel/look.ts";
import { CelMaterial, UNREFLECTED, inkId, inklessBasic } from "../cel/material.ts";

/** A breeze that never drops (m/s), so a calm day still stirs. */
const BREEZE = vec2(1.0, 0.55);

/** The wind as the scenery feels it (m/s, x and z). */
export const windNow = (): THREE.Node<"vec2"> => LOOK.wind.add(BREEZE);

const made = new Map<string, CelMaterial>();

function once(name: string, make: () => CelMaterial): CelMaterial {
  let m = made.get(name);
  if (!m) {
    m = make();
    m.name = name;
    made.set(name, m);
  }
  return m;
}

/** Painted props: walls, boats, posts, people. Snow settles on them and rain wets them. */
export function propMaterial(): CelMaterial {
  return once(
    "prop",
    () =>
      new CelMaterial({ vertexColors: true, outdoor: FOLIAGE.none, crease: 0.8, darkness: 0.85, id: inkId("prop") }),
  );
}

/** Painted props that stand apart from what is behind them (their own ink id): boats on the water. */
export function boatMaterial(): CelMaterial {
  return once(
    "boat",
    () =>
      new CelMaterial({
        vertexColors: true,
        crease: 0.8,
        darkness: 0.85,
        spec: 0.25,
        specSize: 0.05,
        id: inkId("boat"),
      }),
  );
}

/** How the wind moves a vertex of weight `sway` (its height over what holds it, m): a lean downwind, gusts, a rustle. */
function swayed(rustle: number): THREE.Node<"vec3"> {
  return Fn(() => {
    const weight = attribute<"float">("sway", "float");
    const wind = windNow();
    const speed = wind.length();
    const dir = wind.div(speed);
    const p = positionLocal;
    const phase = p.x.mul(0.05).add(p.z.mul(0.04)).add(float(instanceIndex).mul(1.37));
    const t = LOOK.time;
    const gust = sin(t.mul(0.8).add(phase))
      .mul(0.6)
      .add(sin(t.mul(2.1).add(phase.mul(1.7))).mul(0.4));
    const along = speed
      .mul(0.007)
      .add(gust.mul(speed.mul(0.009).add(0.012)))
      .mul(weight);
    const flutter = sin(t.mul(4.7).add(p.y.mul(1.9)).add(p.x.mul(2.3)).add(phase.mul(3)))
      .mul(rustle)
      .mul(speed.mul(0.08).add(0.3))
      .mul(weight.min(1.5));
    return p.add(
      vec3(dir.x.mul(along).add(flutter.mul(dir.y)), flutter.mul(0.6), dir.y.mul(along).sub(flutter.mul(dir.x))),
    );
  })();
}

/** Trees and bushes: painted, in the season's greens, swaying. `kind` is the foliage (`FOLIAGE`). */
export function foliageMaterial(kind: number = FOLIAGE.evergreen): CelMaterial {
  return once(`foliage-${kind}`, () => {
    const m = new CelMaterial({
      vertexColors: true,
      outdoor: kind,
      threshold: 0.0,
      shade: new THREE.Color(0.58, 0.66, 0.78),
      richness: 1.2,
      crease: 0.35,
      darkness: 0.7,
      id: inkId("foliage"),
    });
    m.positionNode = swayed(0.03);
    return m;
  });
}

/** Fronds and blades seen from both sides (palms, agaves, reeds). */
export function frondMaterial(): CelMaterial {
  return once("frond", () => {
    const m = new CelMaterial({
      vertexColors: true,
      outdoor: FOLIAGE.evergreen,
      side: THREE.DoubleSide,
      shade: new THREE.Color(0.58, 0.66, 0.78),
      crease: 0.2,
      darkness: 0.7,
      id: inkId("foliage"),
    });
    m.positionNode = swayed(0.06);
    return m;
  });
}

/**
 * Cloth in the wind: flags, laundry, awning skirts. `sway` is how far a
 * vertex is from where the cloth is held (m): waves run out along it.
 */
export function clothMaterial(): CelMaterial {
  return once("cloth", () => {
    const m = new CelMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      crease: 0,
      silhouette: 0.6,
      darkness: 0.7,
      id: inkId("cloth"),
    });
    m.positionNode = Fn(() => {
      const weight = attribute<"float">("sway", "float");
      const speed = windNow().length();
      const p = positionLocal;
      const phase = p.x.mul(0.31).add(p.z.mul(0.47));
      const t = LOOK.time.mul(speed.mul(0.35).add(2.2));
      const wave = sin(weight.mul(3.4).sub(t).add(phase)).add(
        sin(weight.mul(7.1).sub(t.mul(1.6)).add(phase.mul(2))).mul(0.4),
      );
      const amp = weight.min(1.2).mul(speed.mul(0.012).add(0.07));
      return p.add(normalLocal.mul(wave.mul(amp))).sub(vec3(0, weight.mul(amp).mul(0.5), 0));
    })();
    return m;
  });
}

/** A banner's ripples: two waves running along it (rad per metre, and how fast against the first). */
const RIPPLE = { long: 1.5, short: 3.3, shortGain: 0.45, shortPace: 1.7 };

/**
 * A banner hung by its top edge, along its local x: `sway` is how far below
 * that edge a vertex hangs (m). Ripples run along it and grow toward the free
 * edge, and their flanks push the shade line, so its folds read in two tones.
 */
export function bannerMaterial(): CelMaterial {
  return once("banner", () => {
    const hang = attribute<"float">("sway", "float");
    const speed = windNow().length();
    const reach = hang.mul(speed.mul(0.022).add(0.09)).min(0.6);
    const t = LOOK.time.mul(speed.mul(0.3).add(1.8));
    const along = positionGeometry.x;
    const long = along.mul(RIPPLE.long).sub(t).add(hang.mul(1.3));
    const short = along.mul(RIPPLE.short).sub(t.mul(RIPPLE.shortPace)).sub(hang.mul(0.9)).add(1.7);
    const slope = cos(long).add(cos(short).mul((RIPPLE.shortGain * RIPPLE.short) / RIPPLE.long));
    const m = new CelMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      crease: 0,
      silhouette: 0.6,
      darkness: 0.7,
      id: inkId("cloth"),
      bias: slope.mul(hang.mul(2).min(1)).mul(speed.mul(0.02).add(0.3)),
    });
    m.positionNode = Fn(() => {
      const wave = sin(long).add(sin(short).mul(RIPPLE.shortGain));
      // The free edge lifts a little as it flies.
      return positionLocal.add(normalLocal.mul(wave.mul(reach))).add(vec3(0, reach.mul(0.35), 0));
    })();
    return m;
  });
}

/** A lamp's light: unlit colour, brightened by `level` (0-1, set per frame), left out of reflections. */
export class Glow {
  readonly level = uniform(1);
  readonly material: THREE.MeshBasicNodeMaterial;

  constructor(colour: number, dim = 0.35) {
    const c = new THREE.Color(colour);
    this.material = inklessBasic({ fog: true });
    this.material.colorNode = vec3(c.r, c.g, c.b).mul(this.level.mul(1 - dim).add(dim));
  }

  /** A mesh of `geo` in this light. */
  mesh(geo: THREE.BufferGeometry): THREE.Mesh {
    const m = new THREE.Mesh(geo, this.material);
    m.layers.set(UNREFLECTED);
    m.userData.noMerge = true;
    return m;
  }
}
