// Trick names for the HUD, in the player's language: rotations first
// ("Double backflip 360"), then the grab ("540 Melon") or, on a jetski,
// the stunt ("Backflip + Superman").

import { messages } from "../i18n/index.ts";

export interface TrickParts {
  /** Signed half turns of spin, full flips (+ = backflip) and full barrel rolls. */
  spin: number;
  flip: number;
  roll: number;
  /** Snowboard grab and jetski stunt ids (0 = none). */
  grab: number;
  stunt: number;
}

export function trickName(t: TrickParts): string {
  const m = messages().tricks;
  const rotations: string[] = [];
  if (t.flip !== 0) rotations.push(m.times(Math.abs(t.flip), t.flip > 0 ? m.backflip : m.frontflip));
  if (t.roll !== 0) rotations.push(m.times(Math.abs(t.roll), m.barrelRoll));
  if (t.spin !== 0) rotations.push(String(Math.abs(t.spin) * 180));
  let name = rotations.join(" ");
  if (t.grab > 0) name = [name, m.grabs[t.grab] ?? ""].filter(Boolean).join(" ");
  if (t.stunt > 0) name = [name, m.stunts[t.stunt] ?? ""].filter(Boolean).join(" + ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}
