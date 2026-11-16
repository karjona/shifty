// The end of a race's cues: a tally as each line of what it paid comes in,
// a roll of clicks while the credits count up, the payout as they land,
// and a win for a verdict of first place. Each plays a sound from the
// library; this table is the one place that says which.
import { audio } from "./index.ts";
import type { SoundName } from "./library.ts";

export type EndCue = "tally" | "roll" | "payout" | "win";

const CUES: Record<EndCue, { sound: SoundName; level: number; rate: number }> = {
  tally: { sound: "tally", level: 0.9, rate: 1 },
  roll: { sound: "roll", level: 0.8, rate: 1 },
  payout: { sound: "payout", level: 0.9, rate: 1 },
  win: { sound: "win", level: 0.9, rate: 1 },
};

/** A whole tone, as a playback rate. */
const TONE = 2 ** (2 / 12);

/** Plays a cue, `level` times its usual loudness, `steps` whole tones up (a tally climbs line by line). */
export function playCue(cue: EndCue, level = 1, steps = 0): void {
  const c = CUES[cue];
  audio.play(c.sound, c.level * level, 0, c.rate * TONE ** steps);
}
