// Gamepad first (analog sticks and triggers), keyboard as the fallback.
// Output is analog in [-1, 1]; the sim quantizes it before predicting.

/** Hold in the air: the stick spins and flips. */
export const BUTTON_TRICK = 1;
/** Hold in the air: the stick barrel-rolls and flips. */
export const BUTTON_ROLL = 2;

export interface FrameInput {
  steer: number;
  throttle: number;
  /** -1 = lean back (nose up), 1 = lean forward (nose down). */
  lean: number;
  buttons: number;
}

const DEADZONE = 0.12;
const KEY_RAMP_RATE = 6; // per second, so keyboard axes ramp instead of snapping

function deadzone(v: number): number {
  if (Math.abs(v) < DEADZONE) return 0;
  return (Math.sign(v) * (Math.abs(v) - DEADZONE)) / (1 - DEADZONE);
}

function ramp(current: number, target: number, dt: number): number {
  const step = KEY_RAMP_RATE * dt;
  return current + Math.max(-step, Math.min(step, target - current));
}

export class InputReader {
  private keys = new Set<string>();
  private keySteer = 0;
  private keyLean = 0;
  lastDevice: "keyboard" | "gamepad" = "keyboard";
  /** Test hook: when set, overrides real input. */
  forced: Partial<FrameInput> | null = null;

  constructor() {
    addEventListener("keydown", (e) => {
      if (["Space", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code))
        e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
  }

  read(dt: number): FrameInput {
    if (this.forced) return { steer: 0, throttle: 0, lean: 0, buttons: 0, ...this.forced };
    const pad = this.readGamepad();
    if (pad) {
      this.lastDevice = "gamepad";
      return pad;
    }
    // WASD drives; the arrows steer and lean (two hands, like a stick).
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const steer = (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0);
    const lean = (k("ArrowUp") ? 1 : 0) - (k("ArrowDown") ? 1 : 0);
    this.keySteer = ramp(this.keySteer, steer, dt);
    this.keyLean = ramp(this.keyLean, lean, dt);
    if (this.keys.size > 0) this.lastDevice = "keyboard";
    return {
      steer: this.keySteer,
      throttle: (k("KeyW") ? 1 : 0) - (k("KeyS") ? 1 : 0),
      lean: this.keyLean,
      buttons: (k("Space") ? BUTTON_TRICK : 0) | (k("ShiftLeft", "ShiftRight") ? BUTTON_ROLL : 0),
    };
  }

  private readGamepad(): FrameInput | null {
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      const steer = deadzone(pad.axes[0] ?? 0);
      // Stick up = lean forward.
      const lean = -deadzone(pad.axes[1] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const buttons = (pad.buttons[0]?.pressed ? BUTTON_TRICK : 0) | (pad.buttons[1]?.pressed ? BUTTON_ROLL : 0);
      const active = steer !== 0 || lean !== 0 || rt > 0.05 || lt > 0.05 || buttons !== 0;
      if (!active && this.lastDevice === "keyboard") return null;
      return { steer, throttle: rt - lt, lean, buttons };
    }
    return null;
  }
}
