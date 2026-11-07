// The page's entry, kept small: the boot screen's words at once, then the
// game itself, a big download the first time.
import { ca } from "./i18n/ca.ts";
import { en } from "./i18n/en.ts";
import { es } from "./i18n/es.ts";
import { initialLocale } from "./i18n/locale.ts";

const label = document.querySelector("#boot .boot-loading");
if (label) label.textContent = { en, es, ca }[initialLocale()].common.loading;

void import("./start.tsx");
