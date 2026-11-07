// Dev: the end of a Tilt outside the menus. A quick race's Tilt ends on its
// podium, and `/?podium=1` goes straight to one with sample riders, for look
// checks. URL options: sport (summer, winter: what they wear), season (the
// accent: summer, fall, winter, spring), riders (1-8), me (your place,
// 1-8; 0 = none of them).
import { botAppearance, defaultAppearance } from "@shifty/rider";
import { createRoot } from "react-dom/client";
import { PodiumScreen } from "../menu/screens/podium.tsx";
import type { PodiumData } from "./podium.ts";
import type { Season } from "./season-change.ts";
import { SEASONS } from "./seasons.ts";

/** Puts the podium on screen over the page's (empty) menus; `onDone` when the player goes on. */
export function showPodium(data: PodiumData, onDone: () => void): void {
  createRoot(document.querySelector("#root")!).render(<PodiumScreen data={data} onDone={onDone} />);
}

const NAMES = ["Kilian#2304", "Bot 4", "Marta#0117", "Bot 2", "Jordi#8810", "Bot 6", "Bot 7", "Bot 8"];
const POINTS = [36, 30, 27, 21, 16, 12, 9, 5];

export function podiumDev(params: URLSearchParams): void {
  const count = Math.min(8, Math.max(1, Number(params.get("riders") ?? 8)));
  const me = Number(params.get("me") ?? 1);
  const wanted = params.get("season");
  const season: Season = SEASONS.find((s) => s === wanted) ?? "winter";
  const data: PodiumData = {
    riders: NAMES.slice(0, count).map((name, i) => ({
      slot: i,
      name,
      bot: name.startsWith("Bot"),
      look: i === 0 ? defaultAppearance() : botAppearance(Number(params.get("seed") ?? 7), i),
      points: POINTS[i]!,
      me: i + 1 === me,
    })),
    season,
    sport: params.get("sport") === "summer" ? "summer" : "winter",
  };
  showPodium(data, () => location.reload());
}
