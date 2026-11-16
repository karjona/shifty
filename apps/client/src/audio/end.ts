// The end of a race's cues: a tally as each line of what it paid comes in,
// the payout as the credits land, and a win for a verdict of first place.
// Each plays a sound from the library; this table is the one place that
// says which.
import { audio } from "./index.ts";
import type { SoundName } from "./library.ts";

export type EndCue = "tally" | "payout" | "win";

const CUES: Record<EndCue, { sound: SoundName; level: number; rate: number }> = {
  tally: { sound: "uiMove", level: 0.7, rate: 1 },
  payout: { sound: "checkpoint", level: 0.8, rate: 1 },
  win: { sound: "finish", level: 0.9, rate: 1 },
};

/** Plays a cue, `level` times its usual loudness. */
export function playCue(cue: EndCue, level = 1): void {
  const c = CUES[cue];
  audio.play(c.sound, c.level * level, 0, c.rate);
}
