// Typing on a phone held sideways: the keyboard leaves only a strip of the
// page in sight (Safari keeps its bars up, so as little as the page's first
// 60 CSS pixels). While a text field has the focus on a phone screen, the
// field (its label, what's typed and its form's button) stands in a bar at
// the top of what is still visible (the visual viewport) and goes back to its
// place when the keyboard goes (phone.css). Sending a form puts the keyboard
// away.
import { compactUi, menuScale } from "./scale.ts";
import { nav } from "./nav.ts";

const root = document.documentElement;
/** The field being typed in, and what moved to the bar with it. */
let typing: { input: HTMLInputElement | HTMLTextAreaElement; host: HTMLElement } | null = null;

function isTextInput(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (el instanceof HTMLInputElement &&
      !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(el.type)) ||
    el instanceof HTMLTextAreaElement
  );
}

/** Keeps the bar at the top of the visual viewport (in the menu canvas's pixels). */
function place(): void {
  if (!typing) return;
  const top = visualViewport?.offsetTop ?? 0;
  root.style.setProperty("--vv-top", `${(top / menuScale()).toFixed(1)}px`);
}

function start(input: HTMLInputElement | HTMLTextAreaElement): void {
  stop();
  if (!compactUi() || nav.device !== "touch" || !input.closest("#root")) return;
  const host = input.form ?? input.closest<HTMLElement>(".field");
  if (!host) return;
  typing = { input, host };
  host.classList.add("typing-host");
  root.dataset.typing = "";
  place();
}

function stop(): void {
  if (!typing) return;
  typing.host.classList.remove("typing-host");
  typing = null;
  delete root.dataset.typing;
  root.style.removeProperty("--vv-top");
}

/** Moves the field being typed in to the top of the visible page on a phone, and back. */
export function installTyping(): void {
  document.addEventListener("focusin", (e) => {
    if (isTextInput(e.target)) start(e.target);
  });
  // The bar holds a moment after the field lets go, so a tap on its button (which takes the focus in some
  // browsers) still lands on the button.
  document.addEventListener("focusout", (e) => {
    const was = typing?.input;
    if (!was || e.target !== was) return;
    setTimeout(() => {
      if (typing?.input === was && document.activeElement !== was) stop();
    }, 250);
  });
  visualViewport?.addEventListener("resize", place);
  visualViewport?.addEventListener("scroll", place);
  addEventListener("resize", () => {
    if (typing && !compactUi()) stop();
    place();
  });
  // Sending a form is done typing: the keyboard goes, and the screen shows what came of it.
  document.addEventListener(
    "submit",
    (e) => {
      const active = document.activeElement;
      if (nav.device === "touch" && isTextInput(active) && e.target instanceof Node && e.target.contains(active)) {
        active.blur();
      }
    },
    true,
  );
}
