// Colours of skin, hair and eyes, one per preset.

/** Skin tones, light to deep: [base, shade (creases, under the brow), warm (lips, cheeks)]. */
export const SKIN: readonly (readonly [number, number, number])[] = [
  [0xf1d0b8, 0xd2a88e, 0xe39a8c],
  [0xe2b896, 0xbf8f6e, 0xd48a78],
  [0xc99a72, 0xa3744f, 0xbd7a62],
  [0xa8774f, 0x825734, 0x9e5f48],
  [0x7d5235, 0x5e3b22, 0x7a4234],
  [0x55361f, 0x3d2512, 0x5a2e22],
];

/** Hair colours: black, dark brown, brown, auburn, blonde, grey. */
export const HAIR: readonly number[] = [0x1a1512, 0x3b2617, 0x6a4527, 0x8c3f1f, 0xc9a25e, 0x9a9590];

/** Eye colours (iris): dark brown, hazel, green, blue, grey. */
export const EYES: readonly number[] = [0x3a2414, 0x7a5a2a, 0x4f7a3e, 0x3f6f9e, 0x6f7c86];

export const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** Mixes two colours (0 = a, 1 = b). */
export function blend(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return m(16) | m(8) | m(0);
}
