// The page's entry, kept small: the boot screen's words at once, laid out
// for the window, then the game itself, a big download the first time.
import { ca } from "./i18n/ca.ts";
import { en } from "./i18n/en.ts";
import { es } from "./i18n/es.ts";
import { initialLocale } from "./i18n/locale.ts";
import { fitUi } from "./menu/scale.ts";

fitUi();

const words = { en, es, ca }[initialLocale()].common;
const label = document.querySelector("#loading span");
if (label) label.textContent = words.loading;
const rotate = document.querySelector("#rotate span");
if (rotate) rotate.textContent = words.rotate;

void import("./start.tsx");
