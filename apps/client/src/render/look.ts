// A race's conditions on screen: where the sun stands, the light's colour,
// the sky, the clouds, the fog, the rain or snow, the sea and the season's
// colours, worked out from the season, the weather and the time of day,
// and put on the shared uniforms of the cel look (`cel/look.ts`) every
// frame as the weather turns.
import * as THREE from "three/webgpu";
import { type Conditions, type Season, type Weather, sunAt } from "../game/conditions.ts";
import { LOOK, resetLook } from "./cel/look.ts";

/** How a circuit sits under the sky. */
export interface CircuitLook {
  /** The world direction (x, z) the noon sun stands in. */
  south: [number, number];
  /** How much of the sun's swing away from noon's direction is kept (1 = all; less keeps it ahead of the riders). */
  swing: number;
  /** The fog's range on a clear day (m), and its colour as a multiple of the horizon's. */
  fogNear: number;
  fogFar: number;
  fogTint?: [number, number, number];
  /** Where snow lies down to in each season (m), on the scenery and off the run. */
  snowLine: Record<Season, number>;
  /** Rain falls as snow above the snow line, and everywhere in winter (and winter brings flurries). */
  mountain?: boolean;
}

/** The sun stands this far from what it lights (m). */
const SUN_DISTANCE = 75;
/** The light never comes in lower than this (rad): long shadows, but not stretched past the shadow map. */
const SUN_LOWEST = (10 * Math.PI) / 180;

type RGB = THREE.Color;
const hex = (h: number) => new THREE.Color(h);
const rgb = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

/** Everything about the look that changes with the weather (lerped as it turns). */
interface Sky {
  zenith: RGB;
  upper: RGB;
  horizon: RGB;
  glow: RGB;
  lit: RGB;
  shade: RGB;
  dusk: number;
  shadow: number;
  cirrus: number;
  streaks: number;
  overcast: number;
  deck: RGB;
  deckShade: RGB;
  cloud: RGB;
  cloudShade: RGB;
  /** How much of the sky the cumulus fill (0-1), and how tall they stand (1 = as built). */
  cover: number;
  tower: number;
  haze: number;
  wet: number;
  seaDeep: RGB;
  seaMid: RGB;
  seaLight: RGB;
  seaShallow: RGB;
  whitecaps: number;
  rainRings: number;
  chop: number;
  /** Rain and snow falling (0-1). */
  rain: number;
  snow: number;
  /** The fog's range, as multiples of the circuit's clear-day range. */
  fogNear: number;
  fogFar: number;
  /** The wind (m/s) when the sim has none to tell: how hard (the direction is the circuit's). */
  wind: number;
}

/** A clear sky by the sun's height (degrees): keyframes from dusk to noon. */
const CLEAR: {
  el: number;
  zenith: number;
  upper: number;
  horizon: number;
  glow: number;
  lit: RGB;
  shade: RGB;
  dusk: number;
}[] = [
  {
    el: 4,
    zenith: 0x2a4680,
    upper: 0x8a88b8,
    horizon: 0xdcb4b0,
    glow: 0xffa060,
    lit: rgb(1.06, 0.84, 0.68),
    shade: rgb(0.76, 0.74, 0.96),
    dusk: 1,
  },
  {
    el: 12,
    zenith: 0x2d5fae,
    upper: 0x7e9fd4,
    horizon: 0xe2d4cc,
    glow: 0xffc488,
    lit: rgb(1.04, 0.92, 0.8),
    shade: rgb(0.86, 0.86, 1.0),
    dusk: 0.55,
  },
  {
    el: 24,
    zenith: 0x2468c8,
    upper: 0x579fe6,
    horizon: 0xcfe6f2,
    glow: 0xffe8c4,
    lit: rgb(1.02, 0.98, 0.93),
    shade: rgb(0.97, 0.97, 1.02),
    dusk: 0.15,
  },
  {
    el: 40,
    zenith: 0x1f6dd2,
    upper: 0x4b9ff0,
    horizon: 0xc4e9f8,
    glow: 0xfff1d2,
    lit: rgb(1, 1, 1),
    shade: rgb(1, 1, 1),
    dusk: 0,
  },
];

/** Morning light is a little pinker and cooler than the evening's (at the lowest sun). */
const DAWN = { upper: 0x9a9cc8, horizon: 0xe4c0bc, glow: 0xffb48c };

/** The sea in each season's clear weather. */
const SEA: Record<Season, [number, number, number, number]> = {
  summer: [0x0f62b2, 0x1690c8, 0x46b9de, 0x37cdc8],
  fall: [0x17578f, 0x23789f, 0x4f9cbc, 0x47aaa8],
  winter: [0x234f78, 0x356a90, 0x5d8aaa, 0x5a96a0],
  spring: [0x135ea4, 0x1d84b6, 0x4caed2, 0x3dbcb6],
};

/** The light's colour by season (on top of the time of day's). */
const SEASON_LIGHT: Record<Season, RGB> = {
  summer: rgb(1, 1, 1),
  fall: rgb(1.02, 0.98, 0.93),
  winter: rgb(0.97, 0.99, 1.04),
  spring: rgb(1, 1, 0.98),
};

/**
 * Each weather: its sky (zenith, upper, horizon, glow) and how far it
 * takes over from the clear sky, its light, clouds, sea and precipitation.
 */
interface WeatherLook {
  sky: [number, number, number, number];
  weight: number;
  lit: RGB;
  shade: RGB;
  shadow: number;
  cirrus: number;
  streaks: number;
  overcast: number;
  deck: [number, number];
  cloud: number;
  cloudShade: RGB;
  cover: number;
  tower: number;
  haze: number;
  wet: number;
  sea: [number, number, number, number] | null;
  seaWeight: number;
  whitecaps: number;
  rainRings: number;
  chop: number;
  rain: number;
  snow: number;
  fogNear: number;
  fogFar: number;
  wind: number;
}

const BASE: WeatherLook = {
  sky: [0x1f6dd2, 0x4b9ff0, 0xc4e9f8, 0xfff1d2],
  weight: 0,
  lit: rgb(1, 1, 1),
  shade: rgb(1, 1, 1),
  shadow: 1,
  cirrus: 1,
  streaks: 0,
  overcast: 0,
  deck: [0xd8dde4, 0x9aa4b4],
  cloud: 0xffffff,
  cloudShade: rgb(0.66, 0.72, 0.93),
  cover: 0.62,
  tower: 1,
  haze: 0,
  wet: 0,
  sea: null,
  seaWeight: 0,
  whitecaps: 0,
  rainRings: 0,
  chop: 1,
  rain: 0,
  snow: 0,
  fogNear: 1,
  fogFar: 1,
  wind: 0,
};

const WEATHER: Record<Weather, WeatherLook> = {
  clear: BASE,
  cloudy: {
    ...BASE,
    sky: [0x6d84a6, 0x97a9c0, 0xcdd5de, 0xe8e4dc],
    weight: 0.55,
    lit: rgb(0.93, 0.94, 0.96),
    shade: rgb(1.05, 1.05, 1.04),
    shadow: 0.55,
    cirrus: 0.4,
    overcast: 0.4,
    deck: [0xe4e8ee, 0xa4adbc],
    cloud: 0xeef1f5,
    cloudShade: rgb(0.6, 0.64, 0.78),
    cover: 1,
    tower: 1.15,
    haze: 0.15,
    fogNear: 0.85,
    fogFar: 0.85,
    wind: 3,
  },
  windy: {
    ...BASE,
    sky: [0x1a62c8, 0x4596ea, 0xbfe2f4, 0xfff1d8],
    weight: 0.4,
    cirrus: 1,
    streaks: 1,
    cover: 0.42,
    tower: 0.6,
    whitecaps: 0.8,
    chop: 1.7,
    fogNear: 1.15,
    fogFar: 1.1,
    wind: 10,
  },
  fog: {
    ...BASE,
    sky: [0xa6b3c2, 0xc3cbd4, 0xd6dbe0, 0xeeeae2],
    weight: 0.9,
    lit: rgb(0.95, 0.95, 0.96),
    shade: rgb(1.1, 1.1, 1.08),
    shadow: 0.3,
    cirrus: 0,
    cover: 0,
    haze: 1,
    sea: [0x3c6a86, 0x4f7f98, 0x7c9cb0, 0x6aa0a6],
    seaWeight: 0.6,
    chop: 0.7,
    fogNear: 0.16,
    fogFar: 0.36,
    wind: 0,
  },
  rain: {
    ...BASE,
    sky: [0x4f5f75, 0x6c7c90, 0x9aa6b2, 0xb8b8b0],
    weight: 0.88,
    lit: rgb(0.8, 0.82, 0.86),
    shade: rgb(0.98, 1.0, 1.04),
    shadow: 0.1,
    cirrus: 0,
    overcast: 0.9,
    deck: [0x8c97a5, 0x5d6878],
    cloud: 0xb6bec8,
    cloudShade: rgb(0.52, 0.56, 0.66),
    cover: 1,
    tower: 0.8,
    haze: 0.5,
    wet: 0.85,
    sea: [0x2c5470, 0x3a6680, 0x5f8296, 0x588e92],
    seaWeight: 0.6,
    whitecaps: 0.2,
    rainRings: 1,
    chop: 1.2,
    rain: 0.6,
    fogNear: 0.45,
    fogFar: 0.6,
    wind: 5,
  },
  storm: {
    ...BASE,
    sky: [0x262f3c, 0x3c4654, 0x6c7682, 0x8a8a88],
    weight: 0.95,
    lit: rgb(0.7, 0.73, 0.78),
    shade: rgb(0.92, 0.95, 1.02),
    shadow: 0,
    cirrus: 0,
    overcast: 1,
    deck: [0x5a6472, 0x343c4a],
    cloud: 0x8a929c,
    cloudShade: rgb(0.44, 0.48, 0.58),
    cover: 1,
    tower: 0.9,
    haze: 0.7,
    wet: 1,
    sea: [0x24403f, 0x34584f, 0x56786c, 0x5a8478],
    seaWeight: 0.85,
    whitecaps: 1,
    rainRings: 1,
    chop: 2.2,
    rain: 1,
    fogNear: 0.32,
    fogFar: 0.45,
    wind: 14,
  },
  snow: {
    ...BASE,
    sky: [0x8d99ab, 0xadb7c4, 0xdce0e6, 0xeceae4],
    weight: 0.85,
    lit: rgb(0.94, 0.95, 0.98),
    shade: rgb(1.1, 1.1, 1.08),
    shadow: 0.35,
    cirrus: 0,
    overcast: 0.95,
    deck: [0xd4d9e0, 0xa8b0bd],
    cloud: 0xdde2e8,
    cloudShade: rgb(0.66, 0.7, 0.8),
    cover: 0,
    haze: 0.6,
    sea: [0x2c5878, 0x3c6c8c, 0x6a8ea8, 0x6496a0],
    seaWeight: 0.5,
    chop: 0.9,
    snow: 1,
    fogNear: 0.45,
    fogFar: 0.55,
    wind: 4,
  },
};

/** Season-long colours: the greens, the blossom, the bare ground off the snow. */
const SEASON: Record<
  Season,
  {
    greens: [number, number, number];
    grass: number;
    leaf: number;
    leaf2: number;
    evergreen: number;
    blossom: number;
    ground: [number, number];
  }
> = {
  summer: {
    greens: [0.25, 0, 0],
    grass: 0xa8a85a,
    leaf: 0x3f6e32,
    leaf2: 0x3f6e32,
    evergreen: 0x2f5e34,
    blossom: 0,
    ground: [0x9a8a58, 0x7c6c44],
  },
  fall: {
    greens: [0.85, 0.95, 0.35],
    grass: 0xa48a4a,
    leaf: 0xc0582a,
    leaf2: 0xd89a34,
    evergreen: 0x2c5232,
    blossom: 0,
    ground: [0x8a7650, 0x6a5638],
  },
  winter: {
    greens: [0.8, 0.95, 0.6],
    grass: 0x7c7a54,
    leaf: 0x6e6052,
    leaf2: 0x5e544a,
    evergreen: 0x223f2c,
    blossom: 0,
    ground: [0x7a7056, 0x5e5644],
  },
  spring: {
    greens: [0.9, 0.9, 0.2],
    grass: 0x7cc04a,
    leaf: 0x8acc5a,
    leaf2: 0x9ad06a,
    evergreen: 0x2f6234,
    blossom: 0.6,
    ground: [0x74a64c, 0x5a8a3e],
  },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the clear sky stands at a sun height (degrees), morning or evening. */
function clearSky(
  el: number,
  morning: boolean,
): Pick<Sky, "zenith" | "upper" | "horizon" | "glow" | "lit" | "shade" | "dusk"> {
  let i = 0;
  while (i < CLEAR.length - 2 && el > CLEAR[i + 1]!.el) i++;
  const a = CLEAR[i]!;
  const b = CLEAR[i + 1]!;
  const t = Math.max(0, Math.min(1, (el - a.el) / (b.el - a.el)));
  const mixHex = (x: number, y: number) => hex(x).lerp(hex(y), t);
  const sky = {
    zenith: mixHex(a.zenith, b.zenith),
    upper: mixHex(a.upper, b.upper),
    horizon: mixHex(a.horizon, b.horizon),
    glow: mixHex(a.glow, b.glow),
    lit: a.lit.clone().lerp(b.lit, t),
    shade: a.shade.clone().lerp(b.shade, t),
    dusk: lerp(a.dusk, b.dusk, t),
  };
  if (morning) {
    const k = Math.max(0, 1 - (el - 4) / 14);
    sky.upper.lerp(hex(DAWN.upper), k * 0.6);
    sky.horizon.lerp(hex(DAWN.horizon), k * 0.7);
    sky.glow.lerp(hex(DAWN.glow), k * 0.6);
  }
  return sky;
}

/** The look of one weather in a season at a time of day. */
function skyOf(weather: Weather, season: Season, el: number, morning: boolean): Sky {
  const clear = clearSky(el, morning);
  const w = WEATHER[weather];
  const k = w.weight;
  // A weather's own colours dim and warm as the sun goes down.
  const day = Math.max(0, Math.min(1, (el - 3) / 22));
  // (Under a closed sky the evening is grey, not warm.)
  const evening = rgb(1.04, 0.9, 0.8)
    .lerp(rgb(1, 1, 1), Math.max(day, w.overcast * 0.8))
    .multiplyScalar(lerp(0.62, 1, day));
  const tone = (h: number) => hex(h).multiply(evening);
  const sea = SEA[season].map(hex);
  const seaTo = w.sea?.map((h) => tone(h)) ?? sea;
  const seaAt = (i: number) =>
    sea[i]!.clone()
      .lerp(seaTo[i]!, w.seaWeight)
      .multiply(rgb(1, 1, 1).lerp(clear.lit, 0.5))
      .multiplyScalar(lerp(0.8, 1, day));
  const light = SEASON_LIGHT[season];
  return {
    zenith: clear.zenith.clone().lerp(tone(w.sky[0]), k),
    upper: clear.upper.clone().lerp(tone(w.sky[1]), k),
    horizon: clear.horizon.clone().lerp(tone(w.sky[2]), k),
    glow: clear.glow.clone().lerp(tone(w.sky[3]), k),
    lit: clear.lit.clone().lerp(w.lit.clone().multiply(evening), k).multiply(light),
    shade: clear.shade.clone().lerp(w.shade.clone().multiply(evening), k).multiply(light),
    dusk: clear.dusk * (1 - k * 0.85),
    shadow: w.shadow,
    cirrus: w.cirrus,
    streaks: w.streaks,
    overcast: w.overcast,
    deck: tone(w.deck[0]),
    deckShade: tone(w.deck[1]),
    cloud: tone(w.cloud),
    cloudShade: w.cloudShade.clone(),
    cover: w.cover,
    tower: w.tower,
    haze: w.haze,
    wet: w.wet,
    seaDeep: seaAt(0),
    seaMid: seaAt(1),
    seaLight: seaAt(2),
    seaShallow: seaAt(3),
    whitecaps: w.whitecaps,
    rainRings: w.rainRings,
    chop: w.chop,
    rain: w.rain,
    snow: w.snow,
    fogNear: w.fogNear,
    fogFar: w.fogFar,
    wind: w.wind,
  };
}

/** `a` toward `b` by `t`, into `out` (numbers and colours). */
function blend(out: Sky, a: Sky, b: Sky, t: number): void {
  for (const [key, x] of Object.entries(a)) {
    const y: unknown = Reflect.get(b, key);
    const o: unknown = Reflect.get(out, key);
    if (x instanceof THREE.Color && y instanceof THREE.Color && o instanceof THREE.Color) o.copy(x).lerp(y, t);
    else if (typeof x === "number" && typeof y === "number") Reflect.set(out, key, lerp(x, y, t));
  }
}

/** The look of a race's conditions on a circuit. */
export class ConditionsLook {
  readonly conditions: Conditions;
  /** Where the sun shines from, relative to what it lights (see `World.setSunOffset`). */
  readonly sun: THREE.Vector3;
  /** The weather now (as `apply` last set it). */
  readonly now: Sky;
  /** Rain and snow falling where the camera is (0-1). */
  rain = 0;
  snow = 0;
  /** The cumulus: how much of the sky they fill and how tall they stand (0-1, 1 = as built). */
  cover = 0.5;
  tower = 1;
  private circuit: CircuitLook;
  /** Where snow lies down to in this race (m). */
  private line = 0;
  private from: Sky;
  private to: Sky;
  private wind: THREE.Vector2;

  constructor(conditions: Conditions, circuit: CircuitLook) {
    this.conditions = conditions;
    this.circuit = circuit;
    const { season, time } = conditions;
    const sun = sunAt(season, time);
    const el = (sun.elevation * 180) / Math.PI;
    const morning = time < 72;
    this.from = skyOf(conditions.weather, season, el, morning);
    this.to = skyOf(conditions.turns, season, el, morning);
    this.now = skyOf(conditions.weather, season, el, morning);
    // Azimuth from noon's direction (south), kept to the circuit's swing.
    const off = (sun.azimuth - Math.PI) * circuit.swing;
    const [sx, sz] = circuit.south;
    const len = Math.hypot(sx, sz) || 1;
    const south = new THREE.Vector2(sx / len, sz / len);
    // East is a quarter turn from south toward the morning sun: north × up.
    const east = new THREE.Vector2(south.y, -south.x);
    const dir = south.clone().multiplyScalar(Math.cos(off)).addScaledVector(east, -Math.sin(off));
    const lift = Math.max(SUN_LOWEST, sun.elevation);
    this.sun = new THREE.Vector3(dir.x * Math.cos(lift), Math.sin(lift), dir.y * Math.cos(lift)).multiplyScalar(
      SUN_DISTANCE,
    );
    // The wind blows across the circuit from the sun's side, a little off it.
    this.wind = new THREE.Vector2(-south.y, south.x).add(south.clone().multiplyScalar(-0.4)).normalize();
    this.setSeason();
  }

  /** The uniforms that hold for the whole race: the season's. */
  private setSeason(): void {
    const { season, weather, turns } = this.conditions;
    const s = SEASON[season];
    const cold = weather === "snow" || turns === "snow";
    let line = this.circuit.snowLine[season];
    // Snow falling in fall or spring lies on the scenery down to the coldest season's line.
    if (cold && season !== "winter") line = lerp(line, this.circuit.snowLine.winter, 0.6);
    LOOK.snowLine.value = line;
    this.line = line;
    LOOK.snowCover.value = season === "summer" ? 0.7 : 1;
    LOOK.greens.value.set(...s.greens);
    LOOK.grass.value.setHex(s.grass);
    LOOK.leaf.value.setHex(s.leaf);
    LOOK.leaf2.value.setHex(s.leaf2);
    LOOK.evergreen.value.setHex(s.evergreen);
    LOOK.blossom.value = s.blossom;
    LOOK.ground.value.setHex(s.ground[0]);
    LOOK.ground2.value.setHex(s.ground[1]);
  }

  /**
   * Puts the look on screen for how far the weather has turned (`turn`,
   * 0-1), at `t` seconds, with the camera at height `eyeY` (in `wind`): the uniforms,
   * the fog and the background, and the lights for what isn't cel-shaded.
   */
  apply(
    turn: number,
    t: number,
    eyeY: number,
    /** The sim's wind where the camera is (m/s), if it has one. */
    wind: { windX: number; windZ: number; wind: number } | null,
    fog: THREE.Fog,
    background: THREE.Color,
    sun: THREE.DirectionalLight | null,
    hemi: THREE.HemisphereLight | null,
  ): void {
    const mix = this.conditions.weather === this.conditions.turns ? 0 : Math.max(0, Math.min(1, turn));
    const s = this.now;
    blend(s, this.from, this.to, mix);
    this.setSeason();
    LOOK.zenith.value.copy(s.zenith);
    LOOK.upper.value.copy(s.upper);
    LOOK.horizon.value.copy(s.horizon);
    LOOK.glow.value.copy(s.glow);
    LOOK.lit.value.copy(s.lit);
    LOOK.shade.value.copy(s.shade);
    LOOK.dusk.value = s.dusk;
    LOOK.shadow.value = s.shadow;
    LOOK.cirrus.value = s.cirrus;
    LOOK.streaks.value = s.streaks;
    LOOK.overcast.value = s.overcast;
    LOOK.deck.value.copy(s.deck);
    LOOK.deckShade.value.copy(s.deckShade);
    LOOK.cloud.value.copy(s.cloud);
    LOOK.cloudShade.value.copy(s.cloudShade);
    LOOK.haze.value = s.haze;
    LOOK.wet.value = s.wet;
    LOOK.seaDeep.value.copy(s.seaDeep);
    LOOK.seaMid.value.copy(s.seaMid);
    LOOK.seaLight.value.copy(s.seaLight);
    LOOK.seaShallow.value.copy(s.seaShallow);
    LOOK.whitecaps.value = s.whitecaps;
    LOOK.rainRings.value = s.rainRings;
    LOOK.chop.value = s.chop;
    LOOK.time.value = t;
    if (wind && wind.wind > 0) LOOK.wind.value.set(wind.windX, wind.windZ);
    else LOOK.wind.value.copy(this.wind).multiplyScalar(s.wind);
    this.cover = s.cover;
    this.tower = s.tower;
    // Rain falls as snow in the cold: in winter on the mountain, and above the cold line.
    const mountain = this.circuit.mountain === true;
    const cold = mountain && (this.conditions.season === "winter" || eyeY > this.line);
    const winterFlurry = mountain && this.conditions.season === "winter" ? 0.3 : 0;
    this.rain = cold ? 0 : s.rain;
    this.snow = Math.max(s.snow, cold ? s.rain : 0, winterFlurry * (1 - s.rain));
    const tint = this.circuit.fogTint ?? [1, 1, 1];
    fog.color.copy(s.horizon).multiply(rgb(...tint));
    fog.near = this.circuit.fogNear * s.fogNear;
    fog.far = this.circuit.fogFar * s.fogFar;
    background.copy(fog.color);
    LOOK.far.value.copy(fog.color);
    if (sun) sun.color.copy(s.lit).multiplyScalar(0.9);
    if (hemi) {
      hemi.color.copy(s.upper).lerp(rgb(1, 1, 1), 0.5);
      hemi.groundColor.copy(s.seaMid);
    }
  }

  /** Puts the look back as the menus have it. */
  static reset(): void {
    resetLook();
  }
}
