// The menus' sounds: soft ticks as the focus moves, and short blips to
// pick, go back and change tabs. Anything pickable (`data-nav`) that is
// clicked, by mouse, Enter or A, sounds as a pick.
import { audio } from "./index.ts";

export type UiSound = "move" | "hover" | "select" | "back" | "tab";

export function uiSound(kind: UiSound): void {
  // A gamepad press is no gesture to the browser, but where it lets sound start, it starts here.
  // (A hover never does: the click after it will.)
  if (kind !== "hover") audio.wake();
  switch (kind) {
    case "move":
      audio.play("uiMove");
      break;
    case "hover":
      audio.play("uiMove", 0.6);
      break;
    case "select":
      audio.play("uiSelect");
      break;
    case "back":
      audio.play("uiBack");
      break;
    case "tab":
      audio.play("uiTab");
      break;
  }
}

/** Starts the game's sound (on the first gesture) and the menus' pick sound. */
export function installSound(): void {
  audio.install();
  document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-nav]")) uiSound("select");
  });
}
