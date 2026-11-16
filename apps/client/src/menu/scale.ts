// The menus and the race HUD are laid out on a 1920×1080 canvas; this scales
// them to fit the window (CSS `zoom`: --ui-zoom for the HUD, --menu-zoom for
// the menus). A window narrower than 16:9 gets a canvas down to 1800 wide
// (taller than 1080) before it scales down further, so type stays readable
// in a small window. A short window (a phone on its side) is a phone screen, marked
// `data-compact` on the root element: the menus and the HUD are drawn at one
// fixed scale (PHONE_ZOOM) on a canvas as large as the window at that scale,
// so type and tap targets keep the same size on every phone (phone.css lays
// them out on it). The screen's safe areas (the Dynamic Island, the home
// indicator) come as canvas lengths in --safe-top, --safe-right,
// --safe-bottom and --safe-left.
let zoom = 1;
let menuZoom = 1;

/** The narrowest canvas a window gets (the layouts hold down to this width). */
const MIN_WIDTH = 1800;
/** Below this many CSS pixels tall, the window is a phone screen. */
const COMPACT_BELOW = 600;
/**
 * The scale on a phone screen: the canvas's 24 px body type is 14.4 CSS
 * pixels, its 76 px rows and buttons 45.6 (a finger's tap target).
 */
export const PHONE_ZOOM = 0.6;

const SIDES = ["top", "right", "bottom", "left"] as const;

/** Reads `env(safe-area-inset-*)` off an element outside the zoomed layers. */
let probe: HTMLElement | null = null;
function safeAreas(): Record<(typeof SIDES)[number], number> {
  if (!probe) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      SIDES.map((s) => `padding-${s}:env(safe-area-inset-${s},0px)`).join(";");
    document.documentElement.append(probe);
  }
  const css = getComputedStyle(probe);
  const px = (s: (typeof SIDES)[number]) => Number.parseFloat(css.getPropertyValue(`padding-${s}`)) || 0;
  return { top: px("top"), right: px("right"), bottom: px("bottom"), left: px("left") };
}

const fit = () => {
  const compact = innerHeight < COMPACT_BELOW;
  const z = compact ? PHONE_ZOOM : Math.max(0.4, Math.min(innerWidth / MIN_WIDTH, innerHeight / 1080));
  zoom = Number(z.toFixed(4));
  menuZoom = zoom;
  const root = document.documentElement;
  root.style.setProperty("--ui-zoom", String(zoom));
  root.style.setProperty("--menu-zoom", String(menuZoom));
  const safe = safeAreas();
  for (const s of SIDES) root.style.setProperty(`--safe-${s}`, `${(safe[s] / menuZoom).toFixed(1)}px`);
  if (compact) root.dataset.compact = "";
  else delete root.dataset.compact;
};

/** Keeps --ui-zoom and --menu-zoom fitted to the window. */
export function fitUi(): void {
  fit();
  addEventListener("resize", fit);
  // Safari settles `viewport-fit=cover` (and so the safe areas) a moment after the first layout.
  addEventListener("orientationchange", () => requestAnimationFrame(fit));
  addEventListener("load", fit);
}

/** The HUD canvas's scale on screen: window pixels per canvas pixel. */
export function uiZoom(): number {
  return zoom;
}

/** The menu canvas's scale on screen: window pixels per canvas pixel. */
export function menuScale(): number {
  return menuZoom;
}

/** Whether the window is a phone screen (a phone on its side). */
export function compactUi(): boolean {
  return document.documentElement.dataset.compact !== undefined;
}
