// What a rider looks like: one preset per part, picked from a short row
// (no sliders). The same numbers drive the 3D model in the client, the
// lobby's checks and the bytes in a join token.

export type Body = "male" | "female";

/** How many presets each part has. */
export const PRESETS = {
  skin: 6,
  hair: 5,
  hairColor: 6,
  eyes: 5,
  eyeColor: 5,
  brows: 5,
  nose: 5,
  mouth: 5,
  facialHair: 5,
  height: 5,
  build: 5,
} as const;

export type Part = keyof typeof PRESETS;

/** The parts in the order the creator shows them (and the order they are encoded in). */
export const PARTS: readonly Part[] = [
  "skin",
  "hair",
  "hairColor",
  "eyes",
  "eyeColor",
  "brows",
  "nose",
  "mouth",
  "facialHair",
  "height",
  "build",
];

export interface Look {
  body: Body;
  skin: number;
  /** Hair style: each body has its own five. */
  hair: number;
  hairColor: number;
  eyes: number;
  eyeColor: number;
  brows: number;
  nose: number;
  mouth: number;
  /** Moustache and beard (male only; 0 = clean-shaven). */
  facialHair: number;
  height: number;
  build: number;
}

export const DEFAULT_LOOK: Look = {
  body: "male",
  skin: 1,
  hair: 1,
  hairColor: 1,
  eyes: 0,
  eyeColor: 0,
  brows: 0,
  nose: 0,
  mouth: 0,
  facialHair: 0,
  height: 2,
  build: 2,
};

/** Whether a part can be changed on this body. */
export function partApplies(body: Body, part: Part): boolean {
  return part !== "facialHair" || body === "male";
}

/** A copy with every part in range and the body's rules applied. */
export function normalizeLook(look: Look): Look {
  const out: Look = { ...look, body: look.body === "female" ? "female" : "male" };
  for (const part of PARTS) {
    const v = Math.trunc(look[part]);
    out[part] = Number.isFinite(v) && v >= 0 && v < PRESETS[part] ? v : DEFAULT_LOOK[part];
  }
  if (out.body !== "male") out.facialHair = 0;
  return out;
}

/** Parses an untrusted value into a look (null if it is not one). */
export function parseLook(v: unknown): Look | null {
  if (typeof v !== "object" || v === null) return null;
  const body: unknown = Reflect.get(v, "body");
  if (body !== "male" && body !== "female") return null;
  const look: Look = { ...DEFAULT_LOOK, body };
  for (const part of PARTS) {
    const n: unknown = Reflect.get(v, part);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= PRESETS[part]) return null;
    look[part] = n;
  }
  if (body !== "male" && look.facialHair !== 0) return null;
  return look;
}

/** A small deterministic generator (mulberry32), for bots' looks. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random look from `next` (0-1). */
export function randomLook(next: () => number): Look {
  const pick = (n: number) => Math.min(n - 1, Math.floor(next() * n));
  const body: Body = next() < 0.5 ? "male" : "female";
  const look: Look = { ...DEFAULT_LOOK, body };
  for (const part of PARTS) look[part] = pick(PRESETS[part]);
  // Most people keep their natural colour, and most faces are shaven.
  if (next() < 0.8) look.hairColor = Math.min(look.hairColor, 3);
  if (body !== "male" || next() < 0.45) look.facialHair = 0;
  return look;
}

/**
 * The colour of each colour preset (0xRRGGBB), for swatches in the
 * creator; the art takes its base tones from these too.
 */
export const SKIN_TONES: readonly number[] = [0xf1d0b8, 0xe2b896, 0xc99a72, 0xa8774f, 0x7d5235, 0x55361f];
/** Black, dark brown, brown, auburn, blonde, grey. */
export const HAIR_COLOURS: readonly number[] = [0x1a1512, 0x3b2617, 0x6a4527, 0x8c3f1f, 0xc9a25e, 0x9a9590];
/** Dark brown, hazel, green, blue, grey. */
export const EYE_COLOURS: readonly number[] = [0x3a2414, 0x7a5a2a, 0x4f7a3e, 0x3f6f9e, 0x6f7c86];
