// The game's text in English, Spanish and Catalan. The chosen language is
// kept in this browser; the first time, the browser's preference picks it.
import { useSyncExternalStore } from "react";
import { ca } from "./ca.ts";
import { en, type Messages } from "./en.ts";
import { es } from "./es.ts";
import { LOCALE_KEY, type Locale, initialLocale } from "./locale.ts";

export { LOCALES, type Locale, isLocale } from "./locale.ts";
export type { Messages };

const MESSAGES: Record<Locale, Messages> = { en, es, ca };

let locale: Locale = initialLocale();
const listeners = new Set<() => void>();
document.documentElement.lang = locale;

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  localStorage.setItem(LOCALE_KEY, next);
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
