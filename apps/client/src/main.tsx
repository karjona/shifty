import "@fontsource-variable/archivo/wdth.css";
import "./style.css";
import "./menu/menu.css";
import { createRoot } from "react-dom/client";
import { quickRace } from "./game/quick.ts";
import { App } from "./menu/app.tsx";

const params = new URLSearchParams(location.search);
if (params.has("name")) void quickRace(params);
else createRoot(document.querySelector("#root")!).render(<App />);
