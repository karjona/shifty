// The four seasons' colours, shared by the 3D backdrops and the menus' CSS
// (the accent colour follows the season on screen).
import * as THREE from "three/webgpu";
import type { Season } from "./season-change.ts";

export const SEASONS: Season[] = ["summer", "fall", "winter", "spring"];

/** Per season: deep, mid and bright colours, and the UI accent. */
export const PALETTE: Record<Season, { deep: number; mid: number; bright: number; accent: number }> = {
  summer: { deep: 0x0b4f6c, mid: 0x1fa6a8, bright: 0xffb86b, accent: 0x2ad1c4 },
  fall: { deep: 0x4a1f12, mid: 0xc4572a, bright: 0xf2c14e, accent: 0xf29a3a },
  winter: { deep: 0x1b2a4e, mid: 0x5b8fd6, bright: 0xe8f1ff, accent: 0x8cc4ff },
  spring: { deep: 0x1f4a2a, mid: 0x6fbf5a, bright: 0xffc6d9, accent: 0x9be36b },
};

/** Seconds each season holds on the main menu (it blends into the next). */
export const SEASON_SECONDS = 14;

/** The season at time `t` (s) of the main menu's cycle, and how far it has blended into the next (0-1). */
export function seasonAt(t: number): { from: Season; to: Season; mix: number } {
  const x = (((t / SEASON_SECONDS) % 4) + 4) % 4;
  const i = Math.floor(x);
  const f = x - i;
  // Hold most of the time, blend over the last third.
  const mix = Math.min(1, Math.max(0, (f - 0.66) / 0.34));
  return { from: SEASONS[i]!, to: SEASONS[(i + 1) % 4]!, mix: mix * mix * (3 - 2 * mix) };
}

const tmp = new THREE.Color();

/** Sets the menus' accent colour (CSS `--accent`). */
export function setAccent(color: number | THREE.Color): void {
  tmp.set(color);
  document.documentElement.style.setProperty("--accent", `#${tmp.getHexString()}`);
}

/** The accent between two seasons. */
export function accentBetween(a: Season, b: Season, mix: number): THREE.Color {
  return new THREE.Color(PALETTE[a].accent).lerp(new THREE.Color(PALETTE[b].accent), mix);
}
