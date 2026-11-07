// What the page shows while the 3D gets ready: the boot screen until the
// first backdrop can be drawn, then a small sign while a later one warms up
// (see Engine.warm).

/** Quick warm-ups (shaders already compiled) don't flash the sign. */
const SIGN_AFTER_MS = 250;

const listeners = new Set<() => void>();
let shown = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function set(on: boolean): void {
  if (shown === on) return;
  shown = on;
  for (const l of listeners) l();
}

/** The 3D is busy getting something ready (or done). */
export function setBusy(on: boolean): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (on) timer = setTimeout(() => set(true), SIGN_AFTER_MS);
  else set(false);
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
