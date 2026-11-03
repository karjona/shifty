export const LOCALES = ["en", "es", "ca"] as const;
export type Locale = (typeof LOCALES)[number];

export const isLocale = (v: unknown): v is Locale =>
  typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/**
 * A supported locale from an explicit choice (`es`) or an Accept-Language
 * list (`ca-ES,ca;q=0.9,es;q=0.8`), in order of preference; English if none.
 */
export function pickLocale(header: string | null | undefined): Locale {
  if (!header) return "en";
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: tag.trim().toLowerCase().split("-")[0] ?? "", q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((r) => r.lang && !Number.isNaN(r.q))
    .toSorted((a, b) => b.q - a.q || a.i - b.i);
  return ranked.map((r) => r.lang).find(isLocale) ?? "en";
}
