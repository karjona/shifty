// The game: the menus, or (dev server only) a quick race, a look check, the podium or the sound board.
import "./style.css";
import "./menu/menu.css";
import { createRoot } from "react-dom/client";
import { installSound } from "./audio/ui.ts";
import { App } from "./menu/app.tsx";
import { devParams } from "./dev-params.ts";
import { booted } from "./loading.ts";

installSound();

// The quick race, the look checks, the podium and the sound board only exist on the dev server: builds
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
else if (import.meta.env.DEV && devParams.has("sfx"))
  void import("./audio/soundboard.ts").then((m) => {
    booted();
    m.soundBoard();
  });
else if (import.meta.env.DEV && devParams.has("podium"))
  void import("./game/podium-dev.tsx").then((m) => m.podiumDev(devParams));
else createRoot(document.querySelector("#root")!).render(<App />);
