// The menus and the race HUD are laid out on a 1920×1080 canvas; this scales
// them to fit the window (CSS `zoom`, from --ui-zoom). A short window (a
// phone on its side) gets a compact canvas instead, about 640 tall and as
// wide as the window allows, so type and rows stay big enough to read and
// tap; `data-compact` on the root element lets the layouts tighten for it.
let zoom = 1;

/** Below this many CSS pixels tall, the window gets the compact canvas. */
const COMPACT_BELOW = 600;
/** The compact canvas's height. */
const COMPACT_HEIGHT = 640;

const fit = () => {
  const compact = innerHeight < COMPACT_BELOW;
  const z = compact ? innerHeight / COMPACT_HEIGHT : Math.max(0.4, Math.min(innerWidth / 1920, innerHeight / 1080));
  zoom = Number(z.toFixed(4));
  const root = document.documentElement;
  root.style.setProperty("--ui-zoom", String(zoom));
  if (compact) root.dataset.compact = "";
  else delete root.dataset.compact;
};

/** Keeps --ui-zoom fitted to the window. */
export function fitUi(): void {
  fit();
  addEventListener("resize", fit);
}

/** The canvas's scale on screen: window pixels per canvas pixel. */
export function uiZoom(): number {
  return zoom;
}

/** Whether the window has the compact canvas (a phone on its side). */
export function compactUi(): boolean {
  return document.documentElement.dataset.compact !== undefined;
}
