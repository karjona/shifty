// What the conditions do to the cel look, as uniforms every material
// shares: the light's colour on the lit and the shade side, how much cast
// shadows show, the sky, the clouds, the haze over distant scenery, the
// snow settled on upward faces, how wet things are, the season's greens and
// the sea's colours. An environment sets them for its race (see
// `render/look.ts`); materials read them, so a change of weather or season
// is new numbers, never a new shader.
//
// Scenery opts in through its cel options (`CelOptions.outdoor`):
// `weathered` turns a surface's colour into the season's (greens by kind)
// and lays snow and wet on it.
import * as THREE from "three/webgpu";
import { clamp, dot, float, fwidth, max, mix, normalWorld, positionWorld, smoothstep, uniform, vec3 } from "three/tsl";
import { noise4 } from "./noise.ts";

const colour = (hex: number) => uniform(new THREE.Color(hex));

/** What foliage a surface is, for the season's colours (`CelOptions.outdoor`). */
export const FOLIAGE = {
  /** Stone, roofs, rock, paving: snow and wet only. */
  none: 0,
  /** Grass, fields, meadows. */
  grass: 1,
  /** Broadleaf trees: they turn in the fall, stand bare in winter and blossom in spring. */
  leaf: 2,
  /** Pines, cypresses, palms. */
  evergreen: 3,
} as const;

export const LOOK = {
  /** The light's colour on lit surfaces, and on shaded ones (multiples of the colour). */
  lit: uniform(new THREE.Color(1, 1, 1)),
  shade: uniform(new THREE.Color(1, 1, 1)),
  /** How much cast shadows show (0 = none, under an overcast sky). */
  shadow: uniform(1),
  /** The sky: zenith, upper sky and horizon, and the glow round the sun. */
  zenith: colour(0x1f6dd2),
  upper: colour(0x4b9ff0),
  horizon: colour(0xc4e9f8),
  glow: colour(0xfff1d2),
  /** How far the sun's warmth spreads along the horizon (0 at noon, 1 at dawn and dusk). */
  dusk: uniform(0),
  /** Cirrus wisps high up (0-1), and how far the wind streaks them (0-1). */
  cirrus: uniform(1),
  streaks: uniform(0),
  /** A cloud deck over the sky (0 = none, 1 = closed), lit and in shade. */
  overcast: uniform(0),
  deck: colour(0xd8dde4),
  deckShade: colour(0x9aa4b4),
  /** The cumulus: lit colour, and the shade tone (a multiple of it). */
  cloud: colour(0xffffff),
  cloudShade: uniform(new THREE.Color(0.66, 0.72, 0.93)),
  /** The colour distance fades into (the fog's), and how much more distant scenery fades into it (0-1). */
  far: colour(0xc4e9f8),
  haze: uniform(0),
  /** Snow settles on upward faces above this height (m), and how fully (0-1). */
  snowLine: uniform(1e5),
  snowCover: uniform(1),
  /** How wet the ground is (0-1). */
  wet: uniform(0),
  /** What greens turn to (a colour for a mid green), and how far, per kind of foliage. */
  grass: colour(0x7fa04e),
  leaf: colour(0x3f6e32),
  evergreen: colour(0x2f5e34),
  /** How far greens turn: grass, leaf, evergreen (0-1 each). */
  greens: uniform(new THREE.Vector3(0, 0, 0)),
  /** A second colour broadleaf trees turn to in patches (fall's gold among the rust). */
  leaf2: colour(0x3f6e32),
  /** Blossom on broadleaf trees (0-1), and its colour. */
  blossom: uniform(0),
  blossomColour: colour(0xffc6d9),
  /** The sea: deep water, the bay, the light slopes, the shallows. */
  seaDeep: colour(0x0f62b2),
  seaMid: colour(0x1690c8),
  seaLight: colour(0x46b9de),
  seaShallow: colour(0x37cdc8),
  /** Whitecaps (0-1), rain rings on the water (0-1), and how rough the fine chop is (1 = calm day). */
  whitecaps: uniform(0),
  rainRings: uniform(0),
  chop: uniform(1),
  /** On the mountain: bare ground where the snow is off it (two tones), and slush below this height (m). */
  ground: colour(0x8a7650),
  ground2: colour(0x6e5a3c),
  slushLine: uniform(-1e5),
  /** How thin the cover on the run is (0 = deep, 1 = patchy at its edges). */
  thin: uniform(0),
  /** Seconds, and the wind (m/s, x and z) the sky and the precipitation drift with. */
  time: uniform(0),
  wind: uniform(new THREE.Vector2(0.6, -0.3)),
};

/** The colour of settled snow. */
export const SNOW = new THREE.Color(0.95, 0.96, 1.0);

/** An anti-aliased step of `x` at 0. */
export function cut0(x: THREE.Node<"float">): THREE.Node<"float"> {
  const w = max(fwidth(x), float(1e-4)).mul(0.75);
  return smoothstep(w.negate(), w, x);
}

/** How green a colour is (0-1). */
function greenness(c: THREE.Node<"vec3">): THREE.Node<"float"> {
  return clamp(c.g.sub(max(c.r, c.b)).mul(9), 0, 1);
}

/**
 * A colour in the season: greens turned toward the season's colour for
 * their kind of foliage (`kind`, see `FOLIAGE`), keeping their lightness.
 */
export function seasonal(c: THREE.Node<"vec3">, kind: THREE.Node<"float">): THREE.Node<"vec3"> {
  const band = (k: number) => clamp(float(1).sub(kind.sub(k).abs().mul(2)), 0, 1);
  const isGrass = band(FOLIAGE.grass);
  const isLeaf = band(FOLIAGE.leaf);
  const isEver = band(FOLIAGE.evergreen);
  const patches = noise4(positionWorld.xz.mul(0.09));
  const leaf = mix(LOOK.leaf, LOOK.leaf2, smoothstep(-0.25, 0.25, patches.x));
  const tint = LOOK.grass.mul(isGrass).add(leaf.mul(isLeaf)).add(LOOK.evergreen.mul(isEver));
  const amount = dot(LOOK.greens, vec3(isGrass, isLeaf, isEver)).mul(greenness(c));
  // The season's colours are for a mid green (linear luminance about 0.15): lighter and darker greens follow.
  const light = clamp(dot(c, vec3(0.3, 0.59, 0.11)).div(0.15), 0.4, 2.2);
  let out = mix(c, tint.mul(light), amount);
  // Blossom: specks on broadleaf crowns.
  const speck = cut0(noise4(positionWorld.xz.mul(1.7).add(positionWorld.y)).w.sub(float(0.62)));
  out = mix(out, LOOK.blossomColour, speck.mul(LOOK.blossom).mul(isLeaf).mul(amount.greaterThan(0.01).select(1, 0)));
  return out;
}

/**
 * A surface out in the weather: in the season's colours, with snow on its
 * upward faces above the snow line (a ragged, crisp edge, thinner on
 * slopes) and darker where the rain wets it.
 */
export function weathered(c: THREE.Node<"vec3">, kind: THREE.Node<"float">): THREE.Node<"vec3"> {
  const p = positionWorld;
  const up = normalWorld.y;
  const n = noise4(p.xz.mul(0.021));
  const fine = noise4(p.xz.mul(0.43).add(p.y.mul(0.3)));
  const above = clamp(p.y.sub(LOOK.snowLine).add(n.x.mul(14)).div(10), -1, 1);
  const lying = up.sub(0.52).mul(5).add(fine.z.mul(0.5));
  const snow = cut0(above.add(lying.min(1)).sub(float(1).sub(LOOK.snowCover).mul(2.5)).add(n.y.mul(0.3)).sub(0.4));
  const season = seasonal(c, kind);
  const wet = LOOK.wet.mul(smoothstep(0.2, 0.8, up));
  const soaked = mix(season, season.mul(season).mul(1.25), wet.mul(0.55)).mul(float(1).sub(wet.mul(0.18)));
  return mix(soaked, vec3(SNOW.r, SNOW.g, SNOW.b), snow);
}

/** Puts the look back as it is with no conditions (the menus' clear summer noon). */
export function resetLook(): void {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const u: unknown = Reflect.get(LOOK, k);
    if (u instanceof THREE.UniformNode) {
      const value: unknown = u.value;
      if (value instanceof THREE.Color && v instanceof THREE.Color) value.copy(v);
      else if (value instanceof THREE.Vector2 && v instanceof THREE.Vector2) value.copy(v);
      else if (value instanceof THREE.Vector3 && v instanceof THREE.Vector3) value.copy(v);
      else if (typeof v === "number") u.value = v;
    }
  }
}

/** Every value of `LOOK` as it starts. */
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  Object.entries(LOOK).map(([k, u]) => {
    const v: unknown = u.value;
    return [k, v instanceof THREE.Color || v instanceof THREE.Vector2 || v instanceof THREE.Vector3 ? v.clone() : v];
  }),
);
