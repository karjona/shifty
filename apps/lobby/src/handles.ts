// Player handles: `name#tag`. Names are 3-20 characters of letters (any
// script, accents welcome), digits, single spaces and `_ - . ·` (for the
// Catalan `l·l`), with at least one letter or digit; the server picks the
// 4-digit tag.

export const NAME_MIN = 3;
export const NAME_MAX = 20;
/** UTF-8 bytes; with `#1234` it must fit the race protocol's 48-byte names. */
export const NAME_MAX_BYTES = 40;
export const RENAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type NameProblem = "short" | "long" | "chars" | "reserved" | "rude";

const ALLOWED = /^[\p{L}\p{M}\p{N} _.\-·]+$/u;

/** Trims, joins runs of spaces, and composes accents (NFC). */
export function cleanName(raw: string): string {
  return raw.normalize("NFC").trim().replaceAll(/\s+/gu, " ");
}

/**
 * The name folded for comparisons: lower case, no accents or symbols, and
 * common look-alike digits read as letters (`L0rd` = `lord`).
 */
export function nameKey(name: string): string {
  return cleanName(name)
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[ _.\-·]/gu, "");
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };
const deLeet = (key: string) => key.replaceAll(/[0134578]/gu, (d) => LEET[d] ?? d);

const RESERVED = new Set([
  "admin",
  "administrator",
  "administrador",
  "moderator",
  "moderador",
  "mod",
  "shifty",
  "staff",
  "support",
  "soporte",
  "suport",
  "system",
  "sistema",
  "official",
  "oficial",
  "bot",
  "root",
  "deletedrider",
]);

/** Words no handle may contain anywhere (English, Spanish, Catalan). */
const RUDE_ANYWHERE = ["fuck", "nigger", "nigga", "faggot", "gilipollas", "hijoputa", "fillputa", "hitler", "motherf"];

/**
 * Words no handle may have as a whole word: inside longer words they are
 * often innocent (`computadora`, `balcony`, `Scunthorpe`).
 */
const RUDE_WORDS = new Set([
  "shit",
  "cunt",
  "bitch",
  "whore",
  "rape",
  "nazi",
  "retard",
  "puta",
  "puto",
  "polla",
  "cono",
  "joder",
  "maricon",
  "marica",
  "zorra",
  "subnormal",
  "follar",
  "mierda",
  "cabron",
  "collons",
  "merda",
  "cony",
  "mamon",
  "pajero",
]);

const fold = (s: string) => s.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase();

/** Why a name can't be a handle, or null if it can. */
export function checkName(raw: string): NameProblem | null {
  const name = cleanName(raw);
  const chars = Array.from(new Intl.Segmenter().segment(name)).length;
  if (chars < NAME_MIN) return "short";
  if (chars > NAME_MAX || new TextEncoder().encode(name).length > NAME_MAX_BYTES) return "long";
  if (!ALLOWED.test(name) || !/[\p{L}\p{N}]/u.test(name)) return "chars";
  const key = nameKey(name);
  const plain = deLeet(key);
  if (RESERVED.has(key) || RESERVED.has(plain)) return "reserved";
  if (RUDE_ANYWHERE.some((w) => key.includes(w) || plain.includes(w))) return "rude";
  const words = name.split(/[ _.\-·]+/u).map((w) => fold(w).replaceAll(/^x+|x+$/gu, ""));
  if (words.some((w) => RUDE_WORDS.has(w) || RUDE_WORDS.has(deLeet(w)))) return "rude";
  return null;
}

/** `Lord Kylian#0042`. */
export const formatHandle = (name: string, tag: number) => `${name}#${String(tag).padStart(4, "0")}`;

/** A random tag in 1..=9999. */
export function randomTag(): number {
  const buf = new Uint16Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! % 9999) + 1;
}
