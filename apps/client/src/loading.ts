// What the page shows while the game gets ready: the boot screen until the
// first screen is in and drawing smoothly, then a small sign while
// something later loads (see Engine.show).

/** Quick loads (shaders already compiled, art already here) don't flash the sign. */
const SIGN_AFTER_MS = 250;

const listeners = new Set<() => void>();
let shown = false;
let loads = 0;
let quiet = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function show(on: boolean): void {
  if (shown === on) return;
  shown = on;
  for (const l of listeners) l();
}

/** Puts the loading sign up while `work` runs (once it has taken long enough to notice). */
export function whileLoading<T>(work: Promise<T>): Promise<T> {
  if (quiet > 0) return work;
  if (loads++ === 0) timer = setTimeout(() => show(true), SIGN_AFTER_MS);
  return work.finally(() => {
    if (--loads > 0) return;
    if (timer) clearTimeout(timer);
    timer = null;
    show(false);
  });
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

/** Whether the loading sign is up. */
export function busy(): boolean {
  return shown;
}

export function onBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Takes the boot screen away. */
export function booted(): void {
  const el = document.querySelector("#boot");
  if (!el || el.classList.contains("gone")) return;
  el.classList.add("gone");
  setTimeout(() => el.remove(), 600);
}
