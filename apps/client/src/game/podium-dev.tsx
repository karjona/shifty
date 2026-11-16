// Dev: the end of a Tilt outside the menus. A quick race's Tilt ends on its
// podium, and `/?podium=1` goes straight to one with sample riders, for look
// checks, and on Continue to what comes after it. URL options: season (the
// accent: summer, fall, winter, spring), riders (1-8), me (your place, 1-8;
// 0 = none of them), seed (the bots' looks), place (1-8: after the podium,
// the end of one race in that place instead of the Tilt's), dq=1 (that race
// ended disqualified).
import { botAppearance, defaultAppearance } from "@shifty/rider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { messages } from "../i18n/index.ts";
import { PodiumScreen } from "../menu/screens/podium.tsx";
import { WrapUp } from "../menu/screens/wrapup.tsx";
import type { PodiumData } from "./podium.ts";
import type { RaceEnd } from "./race.ts";
import type { Season } from "./season-change.ts";
import { SEASONS } from "./seasons.ts";

/** Puts the podium on screen over the page's (empty) menus; `onDone` when the player goes on. */
export function showPodium(data: PodiumData, onDone: () => void, end?: RaceEnd): void {
  createRoot(document.querySelector("#root")!).render(
    <QueryClientProvider client={new QueryClient()}>
      <PodiumThenEnd data={data} onDone={onDone} end={end} />
    </QueryClientProvider>,
  );
}

/** The podium, then (with `end`) what comes after it. */
function PodiumThenEnd({ data, onDone, end }: { data: PodiumData; onDone: () => void; end?: RaceEnd }) {
  const [after, setAfter] = useState(false);
  const m = messages().end;
  const again = { label: m.again, run: onDone, glyph: "play" as const };
  return (
    <PodiumScreen data={data} onContinue={() => (end ? setAfter(true) : onDone())}>
      {after && end && (
        <WrapUp
          summary={{ kind: "race", end }}
          mode="single"
          match={null}
          actions={[again, { label: m.changeMode, run: onDone }, { label: m.mainMenu, run: onDone }]}
          back={{ label: m.changeMode, run: onDone }}
        />
      )}
    </PodiumScreen>
  );
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
  };
  const place = Number(params.get("place") ?? 0);
  const dq = params.get("dq") === "1";
  const end: RaceEnd = {
    podium: place > 0 ? null : data,
    course: 1,
    sport: "snow",
    conditions: { season, weather: "snow", turns: "clear", time: 84 },
    place: place > 0 ? place : me,
    racers: 8,
    finishTicks: dq ? 0 : 5490 + place * 140,
    tickHz: 60,
    disqualified: dq,
    misses: dq ? 5 : 1,
    points: 1200,
    eventCount: place > 0 ? 1 : 4,
  };
  showPodium(data, () => location.reload(), end);
}
