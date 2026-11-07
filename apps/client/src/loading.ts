// What the page shows while the game gets ready: the boot screen until the
// first screen is in and drawing smoothly, and the loading sign (`#loading`,
// in the bottom right corner) whenever something loads: under the boot
// screen, over a season card while its course loads, and when something
// later takes long enough to notice (see Engine.show).
import { messages, onLocale } from "./i18n/index.ts";

/** Quick loads (shaders already compiled, art already here) don't flash the sign. */
export const SIGN_AFTER_MS = 250;

let booting = true;
let late = false;
let loads = 0;
let quiet = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** What holds the sign up, each with what it says (the latest one shows). */
const holds = new Map<symbol, (() => string) | null>();

/** Puts the sign up or down, saying what loads. */
function refresh(): void {
  const sign = document.querySelector<HTMLElement>("#loading");
  if (!sign) return;
  const on = booting || late || holds.size > 0;
  sign.classList.toggle("on", on);
  if (!on) return;
  const label = [...holds.values()].findLast((l) => l !== null);
  const text = label ? label() : messages().common.loading;
  const span = sign.querySelector("span");
  if (span && span.textContent !== text) span.textContent = text;
}

onLocale(refresh);

/** Puts the loading sign up while `work` runs (once it has taken long enough to notice). */
export function whileLoading<T>(work: Promise<T>): Promise<T> {
  if (quiet > 0) return work;
  if (loads++ === 0)
    timer = setTimeout(() => {
      late = true;
      refresh();
    }, SIGN_AFTER_MS);
  return work.finally(() => {
    if (--loads > 0) return;
    if (timer) clearTimeout(timer);
    timer = null;
    late = false;
    refresh();
  });
}

/**
 * Puts the loading sign up (at once, or once `after` ms have gone by) until
 * the returned function is called. `label` says what loads ("Loading…"
 * without one).
 */
export function holdLoading(label: (() => string) | null = null, after = 0): () => void {
  const id = Symbol("hold");
  const put = () => {
    holds.set(id, label);
    refresh();
  };
  const wait = after > 0 ? setTimeout(put, after) : null;
  if (!wait) put();
  return () => {
    if (wait) clearTimeout(wait);
    if (holds.delete(id)) refresh();
  };
}

/** Runs `start`; what it starts loading doesn't put the sign up (work in the background, for later). */
export function quietly<T>(start: () => T): T {
  quiet++;
  try {
    return start();
  } finally {
    quiet--;
  }
}

/** Takes the boot screen away. */
export function booted(): void {
  if (booting) {
    booting = false;
    refresh();
  }
  const el = document.querySelector("#boot");
  if (!el || el.classList.contains("gone")) return;
  el.classList.add("gone");
  setTimeout(() => el.remove(), 600);
}
