// The sound sign: browsers hold sound back until a key or a click (a
// gamepad press doesn't count), so a player on a gamepad could go without
// it for good. While sound is held back and a gamepad is in use, a small
// paper tag in the bottom margin says how to get it; it goes once sound
// runs, in the menus and in races alike.
import "./hint.css";
import { messages, onLocale } from "../i18n/index.ts";
import { audio } from "./index.ts";

/** A gamepad press may itself start sound where the browser allows it: give it this long (ms). */
const GRACE_MS = 400;
/** A stick past this counts as using the gamepad. */
const STICK = 0.5;

const MUTED =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 7h4l5-4v14l-5-4H2z" fill="currentColor"/>' +
  '<path d="M13.5 7.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2" fill="none"/></svg>';

function padInUse(): boolean {
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad?.connected) continue;
    if (pad.buttons.some((b) => b.pressed) || pad.axes.some((v) => Math.abs(v) > STICK)) return true;
  }
  return false;
}

/** Watches for a gamepad while sound is held back, and shows the sign until sound runs. */
export function installSoundHint(): void {
  let sign: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let shown = false;
  let padSince = -1;
  const show = (on: boolean) => {
    if (on === shown) return;
    shown = on;
    if (on && !sign) {
      sign = document.createElement("div");
      sign.id = "sound-hint";
      sign.setAttribute("role", "status");
      const tag = document.createElement("div");
      tag.innerHTML = MUTED;
      label = document.createElement("span");
      label.textContent = messages().common.soundLocked;
      tag.append(label);
      sign.append(tag);
      document.body.append(sign);
    }
    sign?.classList.toggle("on", on);
  };
  onLocale(() => {
    if (label) label.textContent = messages().common.soundLocked;
  });
  const watch = (now: number) => {
    if (audio.ctx?.state === "running") {
      show(false);
      return;
    }
    if (padSince < 0 && padInUse()) padSince = now;
    show(padSince >= 0 && now - padSince > GRACE_MS);
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}
