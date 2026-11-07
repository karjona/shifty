// The game: the menus, or (dev server only) a quick race or a look check.
import "./style.css";
import "./menu/menu.css";
import { createRoot } from "react-dom/client";
import { App } from "./menu/app.tsx";
import { fitUi } from "./menu/scale.ts";
import { devParams } from "./dev-params.ts";
import { booted } from "./loading.ts";

fitUi();

// The quick race and the look checks only exist on the dev server: builds
// drop these branches and the modules with them (and vite.config.ts fails a
// build that still has them).
if (import.meta.env.DEV && devParams.has("name")) void import("./game/quick.ts").then((m) => m.quickRace(devParams));
else if (import.meta.env.DEV && devParams.has("lookdev"))
  void import("./game/lookdev.ts").then((m) => {
    booted();
    return m.lookdev(devParams);
  });
else if (import.meta.env.DEV && devParams.has("celshot"))
  void import("./game/celshot.ts").then((m) => m.celshot(devParams));
else createRoot(document.querySelector("#root")!).render(<App />);
