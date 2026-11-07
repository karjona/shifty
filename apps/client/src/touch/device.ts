// What the screen is and what it allows: a touch screen, an iPhone or iPad,
// the game opened from the Home Screen, full screen and the landscape lock
// (where the browser has them), the install prompt (Chrome), and keeping
// the screen awake through a race. Plus the touch settings, kept across
// reloads.

/** A phone or tablet: touch is the main way in. */
export function touchScreen(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

/** Has a touch screen at all (a laptop's counts). */
export function canTouch(): boolean {
  return navigator.maxTouchPoints > 0 || matchMedia("(any-pointer: coarse)").matches;
}

/** An iPhone or iPad (iPadOS says it is a Mac, but Macs have no touch screen). */
export function apple(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/u.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/** Opened from the Home Screen (or installed): no browser bars around the game. */
export function standalone(): boolean {
  return (
    matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches ||
    Reflect.get(navigator, "standalone") === true
  );
}

// --- settings ---

/** Jetski gas on a touch screen: always on (a button brakes), or held on a button. */
export type GasMode = "auto" | "hold";

interface TouchSettings {
  gas: GasMode;
}

const KEY = "shifty.touch";
const listeners = new Set<() => void>();

function load(): TouchSettings {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    // Bad JSON or no storage: defaults.
  }
  const gas: unknown = typeof saved === "object" && saved !== null ? Reflect.get(saved, "gas") : undefined;
  return { gas: gas === "hold" ? "hold" : "auto" };
}

let settings = load();

export function touchSettings(): Readonly<TouchSettings> {
  return settings;
}

export function setGasMode(gas: GasMode): void {
  settings = { ...settings, gas };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the setting lasts until the page closes.
  }
  changed();
}

let version = 0;

/** Calls `l` when a touch setting, full screen or the install prompt changes. */
export function onScreenChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Goes up at every change `onScreenChange` reports. */
export function screenVersion(): number {
  return version;
}

function changed(): void {
  version++;
  for (const l of listeners) l();
}

// --- full screen ---

/** The browser can put the page in full screen (not on iPhone). */
export function canFullscreen(): boolean {
  return document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";
}

export function fullscreen(): boolean {
  return document.fullscreenElement !== null && document.fullscreenElement !== undefined;
}

/** The player left full screen this session: a tap doesn't take them back. */
let declined = false;
/** Our own way out (the setting), which isn't the player turning it down. */
let leaving = false;

/** Full screen, held sideways where the browser can lock it (Android). Call from a tap or a click. */
export function enterFullscreen(): void {
  declined = false;
  if (!canFullscreen() || fullscreen()) return;
  document.documentElement
    .requestFullscreen({ navigationUI: "hide" })
    .then(() => {
      const orientation: ScreenOrientation | undefined = screen.orientation;
      if (typeof orientation?.lock === "function") void orientation.lock("landscape").catch(() => undefined);
    })
    .catch(() => undefined);
}

export function exitFullscreen(): void {
  declined = true;
  if (!fullscreen()) return;
  leaving = true;
  void document.exitFullscreen().catch(() => undefined);
}

/**
 * On a touch screen that can, the first tap puts the game in full screen,
 * and so does any later one until the player leaves it themselves (then
 * only the setting does). Also takes the install prompt (Chrome) for the
 * settings, instead of the browser's own banner, and keeps Safari on a
 * phone from pinch-zooming the game.
 */
export function installScreen(): void {
  // Safari's pinch zoom on a phone (the viewport's maximum-scale doesn't stop it).
  document.addEventListener("gesturestart", (e) => {
    if (touchScreen()) e.preventDefault();
  });
  addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType === "mouse" || declined || standalone() || !touchScreen()) return;
      enterFullscreen();
    },
    { capture: true, passive: true },
  );
  document.addEventListener("fullscreenchange", () => {
    if (!fullscreen()) {
      if (!leaving) declined = true;
      leaving = false;
    }
    changed();
  });
  addEventListener("beforeinstallprompt", (e) => {
    if (!isInstallPrompt(e)) return;
    e.preventDefault();
    installPrompt = e;
    changed();
  });
  addEventListener("appinstalled", () => {
    installPrompt = null;
    changed();
  });
}

// --- install (Chrome on Android, and desktop) ---

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

let installPrompt: InstallPrompt | null = null;

function isInstallPrompt(e: Event): e is InstallPrompt {
  return typeof Reflect.get(e, "prompt") === "function";
}

/** The browser offers to install the game (with its own prompt). */
export function canInstall(): boolean {
  return installPrompt !== null;
}

export function install(): void {
  const p = installPrompt;
  if (!p) return;
  installPrompt = null;
  changed();
  void p.prompt().catch(() => undefined);
}

// --- awake ---

/** Keeps the screen on (a race on a gamepad gives the phone no touches) until the returned function is called. */
export function keepAwake(): () => void {
  let lock: WakeLockSentinel | null = null;
  let live = true;
  const request = () => {
    if (!live || lock || document.hidden || !("wakeLock" in navigator)) return;
    void navigator.wakeLock
      .request("screen")
      .then((l) => {
        if (live) lock = l;
        else void l.release();
      })
      .catch(() => undefined);
  };
  // The browser lets go of the lock when the page hides.
  const visible = () => {
    if (document.hidden) lock = null;
    else request();
  };
  document.addEventListener("visibilitychange", visible);
  request();
  return () => {
    live = false;
    document.removeEventListener("visibilitychange", visible);
    void lock?.release().catch(() => undefined);
    lock = null;
  };
}
