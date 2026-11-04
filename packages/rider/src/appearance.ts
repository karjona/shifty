// A rider's whole appearance (body and face, and what they wear for each
// sport), and its compact bytes: the lobby signs them into join tokens, the
// race server passes them on to everyone in the room without reading them.
import { type Kit, type Outfits, SLOTS, SPORTS, type Slot, defaultOutfits, item, itemByNumber } from "./catalog.ts";
import { DEFAULT_LOOK, type Look, PARTS, parseLook, randomLook, rng } from "./look.ts";

export interface Appearance {
  look: Look;
  outfits: Outfits;
}

export const defaultAppearance = (): Appearance => ({ look: { ...DEFAULT_LOOK }, outfits: defaultOutfits("male") });

const VERSION = 1;
/** Longest encoding: version, body, parts, and per sport a count and three bytes per slot. */
export const APPEARANCE_MAX_BYTES = 2 + PARTS.length + SPORTS.reduce((n, s) => n + 1 + SLOTS[s].length * 3, 0);

export function encodeAppearance(a: Appearance): Uint8Array {
  const out: number[] = [VERSION, a.look.body === "female" ? 1 : 0];
  for (const p of PARTS) out.push(a.look[p]);
  for (const sport of SPORTS) {
    const kit = a.outfits[sport];
    const worn = SLOTS[sport].flatMap((slot, i) => {
      const it = kit[slot] ? item(kit[slot]) : undefined;
      return it ? [[i, it.n] as const] : [];
    });
    out.push(worn.length);
    for (const [i, n] of worn) out.push(i, n & 255, n >> 8);
  }
  return Uint8Array.from(out);
}

/** Decodes appearance bytes; null if they are not valid. */
export function decodeAppearance(bytes: Uint8Array): Appearance | null {
  let i = 0;
  const next = () => (i < bytes.length ? bytes[i++]! : -1);
  if (next() !== VERSION) return null;
  const b = next();
  if (b !== 0 && b !== 1) return null;
  const raw: Record<string, unknown> = { body: b === 1 ? "female" : "male" };
  for (const p of PARTS) raw[p] = next();
  const look = parseLook(raw);
  if (!look) return null;
  const outfits = {} as Outfits;
  for (const sport of SPORTS) {
    const kit: Kit = {};
    const count = next();
    if (count < 0 || count > SLOTS[sport].length) return null;
    for (let k = 0; k < count; k++) {
      const s = next();
      const lo = next();
      const hi = next();
      const slot: Slot | undefined = SLOTS[sport][s];
      if (slot === undefined || lo < 0 || hi < 0) return null;
      const it = itemByNumber(lo | (hi << 8));
      if (!it) return null;
      kit[slot] = it.id;
    }
    outfits[sport] = kit;
  }
  return i === bytes.length ? { look, outfits } : null;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * A bot's appearance, the same on every client: a random look in starter
 * clothes, from the room's seed and the bot's seat.
 */
export function botAppearance(seed: number, slot: number): Appearance {
  const next = rng((seed * 31 + slot * 7919 + 17) >>> 0);
  const look = randomLook(next);
  const outfits = defaultOutfits(look.body);
  const pick = <T>(xs: readonly T[]) => xs[Math.min(xs.length - 1, Math.floor(next() * xs.length))]!;
  // Starter colours vary per bot, so the field isn't all one kit.
  const swap: [keyof Outfits, Slot, string[]][] = [
    ["summer", "vest", ["summer.vest.foam.yellow", "summer.vest.foam.red"]],
    [
      "summer",
      "bottom",
      look.body === "female"
        ? ["summer.bottom.swimsuit.black", "summer.bottom.swimsuit.red"]
        : ["summer.bottom.boardshorts.navy", "summer.bottom.boardshorts.teal"],
    ],
    ["summer", "ride", ["summer.ride.runabout.yellow", "summer.ride.runabout.blue"]],
    ["winter", "top", ["winter.top.puffer.red", "winter.top.puffer.blue"]],
    ["winter", "head", ["winter.head.beanie.white", "winter.head.beanie.red"]],
    ["winter", "bottom", ["winter.bottom.pants.navy", "winter.bottom.pants.grey"]],
    ["winter", "ride", ["winter.ride.freestyle.lime", "winter.ride.freestyle.pink"]],
  ];
  for (const [sport, slot, ids] of swap) outfits[sport][slot] = pick(ids);
  return { look, outfits };
}
