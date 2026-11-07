// Which language the game speaks: the one chosen in this browser, else the
// browser's preference, else English.
export const LOCALES = ["en", "es", "ca"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_KEY = "shifty.locale";

export const isLocale = (v: unknown): v is Locale =>
  typeof v === "string" && (LOCALES as readonly string[]).includes(v);

export function initialLocale(): Locale {
  const saved = localStorage.getItem(LOCALE_KEY);
  if (isLocale(saved)) return saved;
  for (const lang of navigator.languages) {
    const short = lang.toLowerCase().split("-")[0];
    if (isLocale(short)) return short;
  }
  return "en";
}
