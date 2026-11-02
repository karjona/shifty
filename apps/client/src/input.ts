// Gamepad first (analog sticks and triggers), keyboard as the fallback.
// Output is analog in [-1, 1]; the sim quantizes it before predicting.

export const BUTTON_JUMP = 1;

export interface FrameInput {
  steer: number;
  throttle: number;
  buttons: number;
}

const DEADZONE = 0.12;
const KEY_STEER_RATE = 6; // per second, so keyboard steering ramps instead of snapping

function deadzone(v: number): number {
  if (Math.abs(v) < DEADZONE) return 0;
  return (Math.sign(v) * (Math.abs(v) - DEADZONE)) / (1 - DEADZONE);
}

export class InputReader {
  private keys = new Set<string>();
  private keySteer = 0;
  lastDevice: "keyboard" | "gamepad" = "keyboard";
  /** Test hook: when set, overrides real input. */
  forced: FrameInput | null = null;

  constructor() {
    addEventListener("keydown", (e) => {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
  }

  read(dt: number): FrameInput {
    if (this.forced) return this.forced;
    const pad = this.readGamepad();
    if (pad) {
      this.lastDevice = "gamepad";
      return pad;
    }
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const target = (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0);
    const step = KEY_STEER_RATE * dt;
    this.keySteer += Math.max(-step, Math.min(step, target - this.keySteer));
    if (this.keys.size > 0) this.lastDevice = "keyboard";
    return {
      steer: this.keySteer,
      throttle: (k("KeyW", "ArrowUp") ? 1 : 0) - (k("KeyS", "ArrowDown") ? 1 : 0),
      buttons: k("Space") ? BUTTON_JUMP : 0,
    };
  }

  private readGamepad(): FrameInput | null {
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      const steer = deadzone(pad.axes[0] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const jump = pad.buttons[0]?.pressed ?? false;
      const active = steer !== 0 || rt > 0.05 || lt > 0.05 || jump;
      if (!active && this.lastDevice === "keyboard") return null;
      return { steer, throttle: rt - lt, buttons: jump ? BUTTON_JUMP : 0 };
    }
    return null;
  }
}
