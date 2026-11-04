// A ride's setup: points spread over four stats, per sport. Everyone has
// the same budget, forever (it is never earned), so a setup is a choice of
// style, not an advantage. The sim applies the same rules (`sim::setup`).
import type { Sport } from "./catalog.ts";

export const STATS = ["speed", "handling", "stability", "tricks"] as const;
export type Stat = (typeof STATS)[number];

/** Points per stat, and the total every setup spends. */
export const STAT_MAX = 6;
export const STAT_BUDGET = 12;

export type Setup = Record<Stat, number>;
export type Setups = Record<Sport, Setup>;

export const BALANCED: Setup = { speed: 3, handling: 3, stability: 3, tricks: 3 };

export const defaultSetups = (): Setups => ({ summer: { ...BALANCED }, winter: { ...BALANCED } });

/** Every stat in 0-STAT_MAX and the points adding up to the budget. */
export function validSetup(s: Setup): boolean {
  let sum = 0;
  for (const k of STATS) {
    const v = s[k];
    if (!Number.isInteger(v) || v < 0 || v > STAT_MAX) return false;
    sum += v;
  }
  return sum === STAT_BUDGET;
}

/** Parses an untrusted value into a valid setup (null if it is not one). */
export function parseSetup(v: unknown): Setup | null {
  if (typeof v !== "object" || v === null) return null;
  const s: Setup = { ...BALANCED };
  for (const k of STATS) {
    const n: unknown = Reflect.get(v, k);
    if (typeof n !== "number") return null;
    s[k] = n;
  }
  return validSetup(s) ? s : null;
}

/** The four stats as bytes, in `STATS` order (join tokens, the sim). */
export const setupBytes = (s: Setup): number[] => STATS.map((k) => s[k]);
