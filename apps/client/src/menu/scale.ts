// The menus are laid out on a 1920×1080 canvas; this scales them to fit the
// window (CSS `zoom` on #root, from --ui-zoom).
const fit = () => {
  const z = Math.max(0.4, Math.min(innerWidth / 1920, innerHeight / 1080));
  document.documentElement.style.setProperty("--ui-zoom", z.toFixed(4));
};
fit();
addEventListener("resize", fit);
