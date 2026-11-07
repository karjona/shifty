// On-screen controls for touch screens, over the race: a stick that comes
// to wherever the left thumb lands (and follows it past its rim), and a
// fan of buttons for the right thumb, which can slide from one to another
// without lifting (hold Trick, then slide to Stunt). They make the same
// input as a gamepad: steer and lean from the stick, the buttons' bits,
// and the jetski's gas (always on with a brake, or held on a button).
import "./controls.css";
import { messages } from "../i18n/index.ts";
import { BUTTON_GRAB, BUTTON_JUMP, BUTTON_ROLL, BUTTON_TRICK, type FrameInput } from "../input.ts";
import { type GasMode, touchSettings } from "./device.ts";

type Key = "trick" | "roll" | "stunt" | "jump" | "grab" | "gas" | "brake";
/** Where a button sits in the fan: the big one under the thumb, and around it. */
type Spot = "main" | "left" | "upleft" | "up" | "far";

const BITS: Record<Key, number> = {
  trick: BUTTON_TRICK,
  roll: BUTTON_ROLL,
  stunt: BUTTON_GRAB,
  jump: BUTTON_JUMP,
  grab: BUTTON_GRAB,
  gas: 0,
  brake: 0,
};

/** The fan for each sport (and the jetski's gas mode). */
function layout(sport: "jetski" | "snow", gas: GasMode): [Key, Spot][] {
  if (sport === "snow")
    return [
      ["jump", "main"],
      ["trick", "left"],
      ["grab", "up"],
    ];
  if (gas === "hold")
    return [
      ["gas", "main"],
      ["trick", "left"],
      ["roll", "upleft"],
      ["stunt", "up"],
      ["brake", "far"],
    ];
  return [
    ["trick", "main"],
    ["roll", "left"],
    ["stunt", "up"],
    ["brake", "far"],
  ];
}

/** How far the knob goes from the stick's centre (CSS px): full tilt. */
const REACH = 52;
/** The stick's ring (CSS px, its radius in controls.css). */
const RING = 64;
/** Where the stick waits for a thumb: this far in from the left and up from the bottom (CSS px). */
const REST = { x: 150, y: 128 };
const DEADZONE = 0.1;
/** A touch this close to a button (in radii) presses it... */
const PRESS = 1.3;
/** ...and a thumb sliding off one keeps it until this far. */
const KEEP = 1.55;

interface Button {
  key: Key;
  el: HTMLDivElement;
  x: number;
  y: number;
  r: number;
}

function deadzone(v: number): number {
  const a = Math.abs(v);
  return a < DEADZONE ? 0 : (Math.sign(v) * (a - DEADZONE)) / (1 - DEADZONE);
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  parent.append(el);
  return el;
}

export class TouchControls {
  sport: "jetski" | "snow" = "jetski";
  private root: HTMLDivElement;
  private fan: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private buttons: Button[] = [];
  private rest = { x: 0, y: 0 };
  private built = "";
  private shown = false;
  /** The thumb on the stick: where it came down (the centre, which follows it) and where it is. */
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  /** The thumbs on the buttons side, each with the button it holds. */
  private fingers = new Map<number, Key | null>();
  private touched = false;

  constructor() {
    this.root = div("touch-controls", document.body);
    this.root.hidden = true;
    const left = div("touch-zone left", this.root);
    const right = div("touch-zone right", this.root);
    this.base = div("touch-stick", this.root);
    this.knob = div("touch-knob", this.base);
    this.fan = div("touch-fan", this.root);
    for (const zone of [left, right]) {
      zone.addEventListener("pointerdown", this.down);
      // No loupe, callout or text selection under a thumb held still.
      zone.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    }
    addEventListener("pointerdown", this.anyDown, { capture: true, passive: true });
    addEventListener("pointermove", this.move, { passive: true });
    addEventListener("pointerup", this.up, { passive: true });
    addEventListener("pointercancel", this.up, { passive: true });
    addEventListener("resize", this.measure);
  }

  /** A finger touched the screen since the last call. */
  takeTouched(): boolean {
    const t = this.touched;
    this.touched = false;
    return t;
  }

  /**
   * Shows the controls (or takes them off, letting go of everything held).
   * `touching`: the player is on the touch screen, so the HUD keeps clear
   * of the thumbs (also while the controls are off, under the race menu).
   */
  show(on: boolean, touching = on): void {
    const root = document.documentElement;
    if (touching !== (root.dataset.touch !== undefined)) {
      if (touching) root.dataset.touch = "";
      else delete root.dataset.touch;
    }
    if (on) this.build();
    if (on === this.shown) return;
    this.shown = on;
    this.root.hidden = !on;
    if (!on) this.release();
    else this.measure();
  }

  read(): FrameInput {
    let steer = 0;
    let lean = 0;
    const s = this.stick;
    if (s) {
      const dx = (s.x - s.ox) / REACH;
      const dy = (s.y - s.oy) / REACH;
      const len = Math.hypot(dx, dy);
      const k = len > 1 ? 1 / len : 1;
      steer = deadzone(dx * k);
      lean = deadzone(-dy * k);
    }
    const held = new Set(this.fingers.values());
    let buttons = 0;
    for (const key of held) if (key) buttons |= BITS[key];
    let throttle = 0;
    if (this.sport === "jetski") {
      if (held.has("brake")) throttle = -1;
      else if (touchSettings().gas === "auto" || held.has("gas")) throttle = 1;
    }
    return { steer, throttle, lean, buttons };
  }

  dispose(): void {
    this.show(false, false);
    removeEventListener("pointerdown", this.anyDown, { capture: true });
    removeEventListener("pointermove", this.move);
    removeEventListener("pointerup", this.up);
    removeEventListener("pointercancel", this.up);
    removeEventListener("resize", this.measure);
    this.root.remove();
  }

  /** The buttons for this sport, labelled in the player's language. */
  private build(): void {
    const gas = touchSettings().gas;
    const id = `${this.sport}:${gas}:${messages().race.touch.trick}`;
    if (id === this.built) return;
    this.built = id;
    this.release();
    const labels = messages().race.touch;
    this.fan.replaceChildren();
    this.buttons = layout(this.sport, gas).map(([key, spot]) => {
      const el = div(`touch-button ${spot}`, this.fan);
      el.dataset.key = key;
      el.textContent = labels[key];
      return { key, el, x: 0, y: 0, r: 0 };
    });
    if (this.shown) this.measure();
  }

  /** Where the buttons are on screen, for the thumbs (CSS lays them out), and where the stick waits. */
  private measure = (): void => {
    if (!this.shown) return;
    // The root is padded by the screen's safe area (the notch, the home bar).
    const pad = getComputedStyle(this.root);
    this.rest = {
      x: parseFloat(pad.paddingLeft) + REST.x,
      y: innerHeight - parseFloat(pad.paddingBottom) - REST.y,
    };
    this.drawStick();
    for (const b of this.buttons) {
      const r = b.el.getBoundingClientRect();
      b.x = r.left + r.width / 2;
      b.y = r.top + r.height / 2;
      b.r = r.width / 2;
    }
  };

  /** The button a thumb at (x, y) is on: the nearest within `reach` radii. */
  private hit(x: number, y: number, reach: number): Key | null {
    let best: Key | null = null;
    let bestD = Infinity;
    for (const b of this.buttons) {
      const d = Math.hypot(x - b.x, y - b.y) / b.r;
      if (d <= reach && d < bestD) {
        best = b.key;
        bestD = d;
      }
    }
    return best;
  }

  private anyDown = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") this.touched = true;
  };

  private down = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") return;
    if (e.clientX < innerWidth / 2) {
      if (this.stick) return;
      // The stick comes to the thumb, kept whole on the screen.
      const ox = Math.max(RING + 4, Math.min(innerWidth / 2 - RING, e.clientX));
      const oy = Math.max(RING + 4, Math.min(innerHeight - RING - 4, e.clientY));
      this.stick = { id: e.pointerId, ox, oy, x: e.clientX, y: e.clientY };
      this.base.classList.add("on");
      this.drawStick();
      return;
    }
    this.fingers.set(e.pointerId, this.hit(e.clientX, e.clientY, PRESS));
    this.drawButtons();
  };

  private move = (e: PointerEvent): void => {
    const s = this.stick;
    if (s && e.pointerId === s.id) {
      s.x = e.clientX;
      s.y = e.clientY;
      // Past the rim, the centre follows the thumb: turning back is quick.
      const dx = s.x - s.ox;
      const dy = s.y - s.oy;
      const len = Math.hypot(dx, dy);
      if (len > REACH) {
        s.ox = s.x - (dx / len) * REACH;
        s.oy = s.y - (dy / len) * REACH;
      }
      this.drawStick();
      return;
    }
    if (!this.fingers.has(e.pointerId)) return;
    const key = this.fingers.get(e.pointerId) ?? null;
    const on = key ? this.buttons.find((b) => b.key === key) : undefined;
    if (on && Math.hypot(e.clientX - on.x, e.clientY - on.y) <= on.r * KEEP) return;
    const next = this.hit(e.clientX, e.clientY, PRESS);
    if (next === key) return;
    this.fingers.set(e.pointerId, next);
    this.drawButtons();
  };

  private up = (e: PointerEvent): void => {
    if (this.stick?.id === e.pointerId) {
      this.stick = null;
      this.base.classList.remove("on");
      this.drawStick();
    } else if (this.fingers.delete(e.pointerId)) {
      this.drawButtons();
    }
  };

  private release(): void {
    this.stick = null;
    this.fingers.clear();
    this.base.classList.remove("on");
    this.drawStick();
    this.drawButtons();
  }

  private drawStick(): void {
    const s = this.stick ?? { ox: this.rest.x, oy: this.rest.y, x: this.rest.x, y: this.rest.y };
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    const k = Math.min(1, REACH / Math.max(1e-6, Math.hypot(dx, dy)));
    this.base.style.translate = `${s.ox}px ${s.oy}px`;
    this.knob.style.translate = `${dx * k}px ${dy * k}px`;
  }

  private drawButtons(): void {
    const held = new Set(this.fingers.values());
    for (const b of this.buttons) b.el.classList.toggle("held", held.has(b.key));
  }
}
