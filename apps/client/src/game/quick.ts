// Dev: `/?name=You` skips the menus and races straight away, with a join
// ticket from the dev server (see vite.config.ts); a Tilt ends on its
// podium. The netcode e2e tests use it too. URL options: name, room, bots,
// event (snow, gp for the Tilt, or a circuit's id or name: cape, glades), season, weather, turns,
// time, seed, surface, pid, render=0, autopilot=1, scale, water.
import { CIRCUITS, SEASONS, TIMES_OF_DAY, WEATHERS, circuit, timeOf } from "@shifty/rider";
import { parseJoinTicket, WebTransportUnavailable } from "../net/transport.ts";
import { Engine } from "./engine.ts";
import { RaceSession } from "./race.ts";

const HELP = {
  jetski:
    "<b>23.4° Shifty</b> · summer · prototype<br />" +
    "Gamepad: left stick steer and lean (pull back on a crest to fly) · RT throttle · LT brake<br />" +
    "In the air: A + stick spins and flips, X + stick barrel-rolls, B + stick does a stunt. Let go in time to land!<br />" +
    "Keyboard: WASD drive · arrows steer and lean · Space spin · Shift roll · E stunt · F1 debug<br />" +
    'Pass <b class="red">red</b> buoys with them on your right, <b class="green">green</b> on your left',
  snow:
    "<b>23.4° Shifty</b> · winter · prototype<br />" +
    "Gamepad: left stick steer · stick up (or RT) tuck · down (or LT) sit back and brake<br />" +
    "Hold A to load a jump, let go at the lip · in the air: X + stick spins and flips, B grabs<br />" +
    "Keyboard: WASD steer, tuck, brake · Space jump · J / Shift spin · K / E grab · F1 debug<br />" +
    "Land flat on the board, along the slope (forward or switch), and let go of the grab first!",
};

/** An index into `names` from a name or a number in the URL (null if neither). */
function indexOf(names: readonly string[], v: string | null): number | null {
  if (v === null) return null;
  const n = /^\d+$/u.test(v) ? Number(v) : names.indexOf(v.toLowerCase());
  return n >= 0 && n < names.length ? n : null;
}

/**
 * The quick race's plan from the URL, as the dev join takes it: `event=gp`
 * (the Tilt), or one race on `event` (snow = the mountain, or a circuit's
 * id or name, as `cape` or `glades`; the bay by default) in `season` (its sport's first by default: summer
 * on the water, winter on the snow), with `weather`, `turns` (names or wire
 * numbers) and `time` (10-minute steps, HH:MM, or dawn...dusk) when given,
 * the rest drawn with `seed` (0 by default).
 */
function quickPlan(params: URLSearchParams): Map<string, string> {
  const plan = new Map<string, string>();
  const event = params.get("event");
  if (event === "gp") plan.set("tilt", "1");
  else {
    const byName = CIRCUITS.find((c) => c.key === event)?.id;
    const course = event === "snow" ? 1 : (byName ?? (event && circuit(Number(event)) ? Number(event) : 0));
    plan.set("course", String(course));
    const season = indexOf(SEASONS, params.get("season")) ?? (circuit(course)?.sport === "snow" ? 2 : 0);
    plan.set("season", String(season));
    for (const k of ["weather", "turns"]) {
      const w = indexOf(WEATHERS, params.get(k));
      if (w !== null) plan.set(k, String(w));
    }
    const time = params.get("time");
    const named = indexOf(TIMES_OF_DAY, time);
    const clock = time?.match(/^(\d{1,2}):(\d{2})$/u);
    const step =
      named !== null && !/^\d+$/u.test(time ?? "")
        ? timeOf(SEASONS[season]!, TIMES_OF_DAY[named]!)
        : clock
          ? Math.floor((Number(clock[1]) * 60 + Number(clock[2])) / 10)
          : time !== null && /^\d+$/u.test(time)
            ? Number(time)
            : null;
    if (step !== null) plan.set("time", String(step));
  }
  const seed = params.get("seed");
  if (seed && /^\d+$/u.test(seed)) plan.set("seed", seed);
  return plan;
}

export async function quickRace(params: URLSearchParams): Promise<void> {
  const status = document.querySelector<HTMLDivElement>("#status")!;
  const setStatus = (text: string) => {
    status.textContent = text;
    status.hidden = text === "";
  };
  const plan = quickPlan(params);
  const snow = circuit(Number(plan.get("course")))?.sport === "snow";
  const help = document.querySelector<HTMLDivElement>("#help")!;
  help.innerHTML = snow ? HELP.snow : HELP.jetski;
  help.hidden = false;
  try {
    setStatus("Loading…");
    const engine = await Engine.get();
    setStatus("Getting a join ticket…");
    const q = new URLSearchParams({
      name: params.get("name") || `Rider ${Math.floor(Math.random() * 900 + 100)}`,
      // A room's plan is drawn when it is made: other options, another room.
      room: params.get("room") ?? ["dev", ...plan.values()].join("-"),
      bots: params.get("bots") ?? "2",
      surface: params.get("surface") ?? "1",
    });
    for (const [k, v] of plan) q.set(k, v);
    const pid = params.get("pid");
    if (pid) q.set("pid", pid);
    const res = await fetch(`/__dev/join?${q}`);
    if (!res.ok) throw new Error(await res.text());
    const ticket = parseJoinTicket(await res.json());
    engine.show(
      new RaceSession({
        ticket,
        hud: document.querySelector<HTMLDivElement>("#ui")!,
        status: setStatus,
        render: params.get("render") !== "0",
        autopilot: params.get("autopilot") === "1",
        debug: true,
        onOver: (podium) => {
          if (!podium) {
            location.reload();
            return;
          }
          setStatus("");
          help.hidden = true;
          void import("./podium-dev.tsx").then((m) => m.showPodium(podium, () => location.reload()));
        },
      }),
    );
  } catch (e) {
    console.error(e);
    if (e instanceof WebTransportUnavailable) setStatus(e.message);
    else setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
