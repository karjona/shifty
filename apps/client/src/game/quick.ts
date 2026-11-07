// Dev: `/?name=You` skips the menus and races straight away, with a join
// ticket from the dev server (see vite.config.ts). The netcode e2e tests
// use it too. URL options: name, room, bots, event (snow, or gp for the
// Tilt), surface, pid, render=0, autopilot=1, scale, water.
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

export async function quickRace(params: URLSearchParams): Promise<void> {
  const status = document.querySelector<HTMLDivElement>("#status")!;
  const setStatus = (text: string) => {
    status.textContent = text;
    status.hidden = text === "";
  };
  const snow = params.get("event") === "snow";
  const gp = params.get("event") === "gp";
  const help = document.querySelector<HTMLDivElement>("#help")!;
  help.innerHTML = snow ? HELP.snow : HELP.jetski;
  help.hidden = false;
  try {
    setStatus("Loading…");
    const engine = await Engine.get();
    setStatus("Getting a join ticket…");
    const q = new URLSearchParams({
      name: params.get("name") || `Rider ${Math.floor(Math.random() * 900 + 100)}`,
      room: params.get("room") ?? (snow ? "dev-snow" : "dev"),
      bots: params.get("bots") ?? "2",
      surface: params.get("surface") ?? "1",
      course: snow ? "1" : "0",
    });
    if (gp) q.set("events", "0,1");
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
        onOver: () => location.reload(),
      }),
    );
  } catch (e) {
    console.error(e);
    if (e instanceof WebTransportUnavailable) setStatus(e.message);
    else setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
