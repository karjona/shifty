import "@fontsource-variable/archivo/wdth.css";
import "./style.css";
import "./menu/menu.css";
import { createRoot } from "react-dom/client";
import { App } from "./menu/app.tsx";

const params = new URLSearchParams(location.search);
// The quick race only exists on the dev server: builds drop this branch and
// the module with it (and vite.config.ts fails a build that still has it).
if (import.meta.env.DEV && params.has("name")) void import("./game/quick.ts").then((m) => m.quickRace(params));
else if (import.meta.env.DEV && params.has("lookdev")) void import("./game/lookdev.ts").then((m) => m.lookdev(params));
else createRoot(document.querySelector("#root")!).render(<App />);
