// What the mountain's scenery shares in its shaders: how much snow lies on
// things at a place (by the season's snow line, more while it snows), and
// the wind as trees, flags and blown snow feel it (gusts travelling
// downwind).
import type * as THREE from "three/webgpu";
import { clamp, float, max, positionView, sin, smoothstep, uniform, vec2 } from "three/tsl";
import { LOOK } from "./cel/look.ts";
import { noise4 } from "./cel/noise.ts";

export const MOUNTAIN = {
  /** Snow falling now (0-1): it loads the boughs and the roofs. */
  snowing: uniform(0),
  /** The fog's range (m). */
  fogNear: uniform(45),
  fogFar: uniform(330),
};

/** How clear of the fog a pixel is (1 = this side of it, 0 = lost in it): ink lines fade by it. */
export function clearOfFog(): THREE.Node<"float"> {
  return smoothstep(MOUNTAIN.fogFar, MOUNTAIN.fogNear, positionView.z.negate()).pow(1.5);
}

/** The colour of snow lying on scenery (lit). */
export const SCENERY_SNOW = [0.93, 0.95, 1.0] as const;

/**
 * How much snow lies on scenery at world point `p`: 0 below the snow line,
 * 1 a winter's load above it (ragged over some tens of metres), and more
 * while it snows.
 */
export function snowLoad(p: THREE.Node<"vec3">): THREE.Node<"float"> {
  const n = noise4(p.xz.mul(0.013)).x;
  const above = p.y.sub(LOOK.snowLine).add(n.mul(28)).div(12);
  return clamp(above.add(LOOK.snowCover.sub(1).mul(3)), 0, 1).mul(MOUNTAIN.snowing.mul(0.45).add(0.85));
}

/** The wind's speed (m/s) and the way it blows (x, z; unit). */
export function windNow(): { speed: THREE.Node<"float">; dir: THREE.Node<"vec2"> } {
  const speed = LOOK.wind.length();
  return { speed, dir: LOOK.wind.div(max(speed, 0.01)) };
}

/** A gust passing world point `p` (x, z): 0-1, in waves that travel downwind. */
export function gustAt(p: THREE.Node<"vec2">): THREE.Node<"float"> {
  const { speed, dir } = windNow();
  const along = p.dot(dir);
  const across = p.dot(vec2(dir.y.negate(), dir.x));
  const t = LOOK.time;
  const a = sin(
    along
      .mul(0.11)
      .sub(t.mul(speed.mul(0.09).add(0.5)))
      .add(sin(across.mul(0.05)).mul(1.7)),
  );
  const b = sin(along.mul(0.031).sub(t.mul(0.37)).add(across.mul(0.043)));
  return clamp(a.mul(0.35).add(b.mul(0.35)).add(0.5), float(0), float(1));
}
