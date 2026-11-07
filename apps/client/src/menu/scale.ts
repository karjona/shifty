// The menus and the race HUD are laid out on a 1920×1080 canvas; this scales
// them to fit the window (CSS `zoom`, from --ui-zoom).
let zoom = 1;

const fit = () => {
  zoom = Number(Math.max(0.4, Math.min(innerWidth / 1920, innerHeight / 1080)).toFixed(4));
  document.documentElement.style.setProperty("--ui-zoom", String(zoom));
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
