// Menu navigation for controller, keyboard and mouse alike. Everything
// that can be picked carries `data-nav`; the stick, the d-pad and the
// arrow keys move the browser's focus to the nearest one in that
// direction, and the mouse focuses what it hovers. A / ✕ / Enter press the
// focused element. The other buttons are actions screens subscribe to:
// back (B / ○ / Esc), play (Y / △ / P), the tabs (LB RB / L1 R1 / Q E) and
// the menu (Start / Options).
//
// The topmost `[data-nav-scope]` (a dialog) holds the focus while it is
// open. An element with `data-nav-lr` (a picker) takes left and right for
// itself, as a `nav-lr` event with `detail` -1 or 1.

export type Action = "back" | "play" | "prev" | "next" | "menu";
export type Device = "keyboard" | "mouse" | "gamepad";
export type Pad = "xbox" | "playstation" | "nintendo";
type Dir = "up" | "down" | "left" | "right";

const SELECTOR = "[data-nav]:not([disabled]):not([aria-disabled='true'])";
const REPEAT_DELAY_MS = 380;
const REPEAT_MS = 110;
const STICK = 0.55;

/** Standard Gamepad API button indices. */
const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, start: 9, up: 12, down: 13, left: 14, right: 15 };

function padKind(id: string): Pad {
  if (/054c|playstation|dualsense|dualshock/iu.test(id)) return "playstation";
  if (/057e|nintendo|pro controller|joy-con/iu.test(id)) return "nintendo";
  return "xbox";
}

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

export function scope(): HTMLElement {
  const scopes = document.querySelectorAll<HTMLElement>("[data-nav-scope]");
  return scopes[scopes.length - 1] ?? document.body;
}

function candidates(): HTMLElement[] {
  return [...scope().querySelectorAll<HTMLElement>(SELECTOR)].filter(visible);
}

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit"].includes(el.type)) ||
    el instanceof HTMLTextAreaElement
  );
}

/** The element `dir` of `from`: nearest along that way, favouring ones in line. */
function nearest(from: HTMLElement, dir: Dir, list: HTMLElement[]): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    let gap: number;
    let side: number;
    let overlap: boolean;
    switch (dir) {
      case "right":
        gap = b.left - a.right;
        side = Math.abs(by - ay);
        overlap = b.top < a.bottom && b.bottom > a.top;
        if (bx <= ax + 1) continue;
        break;
      case "left":
        gap = a.left - b.right;
        side = Math.abs(by - ay);
        overlap = b.top < a.bottom && b.bottom > a.top;
        if (bx >= ax - 1) continue;
        break;
      case "down":
        gap = b.top - a.bottom;
        side = Math.abs(bx - ax);
        overlap = b.left < a.right && b.right > a.left;
        if (by <= ay + 1) continue;
        break;
      case "up":
        gap = a.top - b.bottom;
        side = Math.abs(bx - ax);
        overlap = b.left < a.right && b.right > a.left;
        if (by >= ay - 1) continue;
        break;
    }
    const score = Math.max(0, gap) + side * (overlap ? 0.5 : 2.5);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

class Nav {
  device: Device = "mouse";
  pad: Pad = "xbox";
  /** Off while racing: the controller drives the rider, only Start reaches the menus. */
  enabled = true;

  setEnabled(on: boolean): void {
    this.enabled = on;
  }
  private handlers = new Map<Action, (() => void)[]>();
  private listeners = new Set<() => void>();
  private held = new Map<string, number>();
  private wasPressed = new Set<number>();

  constructor() {
    addEventListener("keydown", (e) => this.key(e), true);
    addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && (e.movementX !== 0 || e.movementY !== 0)) this.setDevice("mouse");
    });
    document.addEventListener("pointerover", (e) => {
      if (this.device !== "mouse" || !this.enabled) return;
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(SELECTOR) : null;
      if (el && scope().contains(el) && document.activeElement !== el && !isTextInput(document.activeElement)) {
        document.documentElement.dataset.navDir = "pointer";
        el.focus({ preventScroll: true });
      }
    });
    const poll = () => {
      this.pollPads();
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  /** Subscribes to device changes (for button glyphs). */
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private setDevice(device: Device, pad?: Pad): void {
    if (device === this.device && (pad === undefined || pad === this.pad)) return;
    this.device = device;
    if (pad) this.pad = pad;
    document.documentElement.dataset.input = device;
    for (const l of this.listeners) l();
  }

  /** Runs `handler` for `action` until the returned function is called. The newest handler wins. */
  on(action: Action, handler: () => void): () => void {
    const list = this.handlers.get(action) ?? [];
    list.push(handler);
    this.handlers.set(action, list);
    return () => {
      const i = list.lastIndexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  fire(action: Action): boolean {
    const list = this.handlers.get(action);
    const handler = list?.[list.length - 1];
    if (!handler) return false;
    handler();
    return true;
  }

  /** Focuses the screen's starting element if nothing in scope has focus. */
  ensureFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && scope().contains(active) && visible(active)) {
      return;
    }
    const list = candidates();
    const first = list.find((el) => el.hasAttribute("data-nav-autofocus")) ?? list[0];
    first?.focus({ preventScroll: true });
  }

  move(dir: Dir): void {
    const active = document.activeElement;
    const list = candidates();
    if (!(active instanceof HTMLElement) || !list.includes(active)) {
      this.ensureFocus();
      return;
    }
    if ((dir === "left" || dir === "right") && active.hasAttribute("data-nav-lr")) {
      active.dispatchEvent(new CustomEvent("nav-lr", { detail: dir === "left" ? -1 : 1, bubbles: true }));
      return;
    }
    // The focus styles read the way it came from (the fill wipes in from that side).
    document.documentElement.dataset.navDir = dir;
    nearest(active, dir, list)?.focus({ preventScroll: false });
  }

  private press(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && scope().contains(active)) {
      if (isTextInput(active)) active.form?.requestSubmit();
      else active.click();
    } else {
      this.ensureFocus();
    }
  }

  private key(e: KeyboardEvent): void {
    if (e.repeat && !e.key.startsWith("Arrow")) return;
    if (!this.enabled) {
      if (e.key === "Escape" && this.fire("menu")) e.preventDefault();
      return;
    }
    this.setDevice("keyboard");
    const typing = isTextInput(document.activeElement);
    const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const dir = dirs[e.key];
    if (dir) {
      if (typing && (dir === "left" || dir === "right")) return;
      e.preventDefault();
      this.move(dir);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (typing && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (!this.fire("back")) this.fire("menu");
      return;
    }
    if (typing) return;
    const actions: Record<string, Action> = { q: "prev", e: "next", p: "play" };
    const action = actions[e.key.toLowerCase()];
    if (action && !e.ctrlKey && !e.metaKey && !e.altKey && this.fire(action)) e.preventDefault();
  }

  private pollPads(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p?.connected);
    if (!pad) return;
    const down = (i: number) => pad.buttons[i]?.pressed === true;
    const now = performance.now();
    const pressed = new Set<number>();
    for (let i = 0; i < pad.buttons.length; i++) if (down(i)) pressed.add(i);
    const edge = (i: number) => pressed.has(i) && !this.wasPressed.has(i);
    const any = pressed.size > 0 || pad.axes.some((v) => Math.abs(v) > STICK);
    if (any) this.setDevice("gamepad", padKind(pad.id));

    if (!this.enabled) {
      if (edge(BTN.start)) this.fire("menu");
      this.wasPressed = pressed;
      this.held.clear();
      return;
    }
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    const dirs: [Dir, boolean][] = [
      ["up", down(BTN.up) || y < -STICK],
      ["down", down(BTN.down) || y > STICK],
      ["left", down(BTN.left) || x < -STICK],
      ["right", down(BTN.right) || x > STICK],
    ];
    for (const [dir, on] of dirs) {
      if (!on) {
        this.held.delete(dir);
        continue;
      }
      const next = this.held.get(dir);
      if (next === undefined) {
        this.move(dir);
        this.held.set(dir, now + REPEAT_DELAY_MS);
      } else if (now >= next) {
        this.move(dir);
        this.held.set(dir, now + REPEAT_MS);
      }
    }
    if (edge(BTN.a)) this.press();
    if (edge(BTN.b)) this.fire("back");
    if (edge(BTN.y)) this.fire("play");
    if (edge(BTN.lb)) this.fire("prev");
    if (edge(BTN.rb)) this.fire("next");
    if (edge(BTN.start) && !this.fire("menu")) this.fire("play");
    this.wasPressed = pressed;
  }
}

export const nav = new Nav();
