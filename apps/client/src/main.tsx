// The page's entry, kept small: the boot screen's words and bar at once,
// laid out for the window, then the game itself, a big download the first
// time, counted in as it comes.
import { ca } from "./i18n/ca.ts";
import { en } from "./i18n/en.ts";
import { es } from "./i18n/es.ts";
import { initialLocale } from "./i18n/locale.ts";
import { bootLoad, download, setWords, showBoot } from "./loading.ts";
import { fitUi } from "./menu/scale.ts";

/** Nothing waits longer than this (ms) for the boot screen's typeface before its words show. */
const FONT_WAIT_MS = 2500;

fitUi();

const locale = initialLocale();
document.documentElement.lang = locale;
const words = { en, es, ca }[locale].common;
setWords(
  () => words.loadingSteps,
  () => words.loading,
);
const rotate = document.querySelector("#rotate span");
if (rotate) rotate.textContent = words.rotate;
showBoot();

// The wordmark and the line show once their typeface is in.
const boot = document.querySelector("#boot");
const fonts = Promise.all([
  document.fonts.load('400 52px "Archivo Variable"'),
  document.fonts.load('italic 900 57px "Archivo Variable"'),
]);
void Promise.race([fonts, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))])
  .catch(() => {})
  .then(() => boot?.classList.add("fonts"));

/** The game's code and the WASM sim, with their sizes (builds put the list in the page). */
function plan(): [string, number][] {
  try {
    const v: unknown = JSON.parse(document.querySelector("#boot-plan")?.textContent ?? "[]");
    return Array.isArray(v)
      ? v.filter((f): f is [string, number] => Array.isArray(f) && typeof f[0] === "string" && typeof f[1] === "number")
      : [];
  } catch {
    return [];
  }
}

// The code comes down counted, and the game then loads it from the
// browser's cache; the sim is kept for the engine, which asks for it next.
// (On the dev server, which serves the modules one by one, it is timed.)
const wait = bootLoad();
const code = wait.begin("code");
const files = plan().flatMap(([url, size]) => {
  const sim = url.endsWith(".wasm");
  const bytes = download(url, wait, "code", size, sim).then(
    () => null,
    () => null,
  );
  return sim ? [] : [bytes];
});
void Promise.all(files)
  .then(() => import("./start.tsx"))
  .finally(() => code.end());
