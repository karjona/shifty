// The game's text in English, Spanish and Catalan. The chosen language is
// kept in this browser; the first time, the browser's preference picks it.
import { useSyncExternalStore } from "react";
import { ca } from "./ca.ts";
import { en, type Messages } from "./en.ts";
import { es } from "./es.ts";

export const LOCALES = ["en", "es", "ca"] as const;
export type Locale = (typeof LOCALES)[number];
export type { Messages };

const MESSAGES: Record<Locale, Messages> = { en, es, ca };
const KEY = "shifty.locale";

export const isLocale = (v: unknown): v is Locale =>
  typeof v === "string" && (LOCALES as readonly string[]).includes(v);

function initial(): Locale {
  const saved = localStorage.getItem(KEY);
  if (isLocale(saved)) return saved;
  for (const lang of navigator.languages) {
    const short = lang.toLowerCase().split("-")[0];
    if (isLocale(short)) return short;
  }
  return "en";
}

let locale: Locale = initial();
const listeners = new Set<() => void>();
document.documentElement.lang = locale;

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  localStorage.setItem(KEY, next);
  document.documentElement.lang = next;
  for (const l of listeners) l();
}

/** A label from a table of them by id (titles, problems...), or null for an unknown id. */
export function labelOf(table: Record<string, string>, id: string): string | null {
  return Object.hasOwn(table, id) ? (table[id] ?? null) : null;
}

/** The current language's messages (outside React). */
export function messages(): Messages {
  return MESSAGES[locale];
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

/** The current language's messages; re-renders when it changes. */
export function useT(): Messages {
  return MESSAGES[useLocale()];
}
