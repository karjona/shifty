// Gamepad first (analog sticks and triggers), keyboard as the fallback.
// Output is analog in [-1, 1]; the sim quantizes it before predicting.

/** Hold in the air: the stick spins and flips. */
export const BUTTON_TRICK = 1;
/** Jetski, hold in the air: the stick barrel-rolls and flips. */
export const BUTTON_ROLL = 2;
/** Snowboard: hold to crouch, let go to pop. */
export const BUTTON_JUMP = 4;
/** Snowboard, in the air: grab the board (the stick picks the grab). */
export const BUTTON_GRAB = 8;

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
  /** The buttons mean different things on a jetski and on a snowboard. */
  sport: "jetski" | "snow" = "jetski";
  /** Test hook: when set, overrides real input. */
  forced: Partial<FrameInput> | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (["Space", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code))
      e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();

  constructor() {
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);
    addEventListener("blur", this.onBlur);
  }

  dispose(): void {
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("blur", this.onBlur);
  }

  read(dt: number): FrameInput {
    if (this.forced) return { steer: 0, throttle: 0, lean: 0, buttons: 0, ...this.forced };
    const pad = this.readGamepad();
    if (pad) {
      this.lastDevice = "gamepad";
      return pad;
    }
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    if (this.keys.size > 0) this.lastDevice = "keyboard";
    if (this.sport === "snow") {
      // WASD or the arrows: steer, tuck (up) and sit back (down). Space
      // jumps; J or Shift spins and flips; K or E grabs.
      const steer = (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0);
      const lean = (k("KeyW", "ArrowUp") ? 1 : 0) - (k("KeyS", "ArrowDown") ? 1 : 0);
      this.keySteer = ramp(this.keySteer, steer, dt);
      this.keyLean = ramp(this.keyLean, lean, dt);
      return {
        steer: this.keySteer,
        throttle: 0,
        lean: this.keyLean,
        buttons:
          (k("Space") ? BUTTON_JUMP : 0) |
          (k("KeyJ", "ShiftLeft", "ShiftRight") ? BUTTON_TRICK : 0) |
          (k("KeyK", "KeyE") ? BUTTON_GRAB : 0),
      };
    }
    // WASD drives; the arrows steer and lean (two hands, like a stick).
    const steer = (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0);
    const lean = (k("ArrowUp") ? 1 : 0) - (k("ArrowDown") ? 1 : 0);
    this.keySteer = ramp(this.keySteer, steer, dt);
    this.keyLean = ramp(this.keyLean, lean, dt);
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
      const held = (i: number) => pad.buttons[i]?.pressed === true;
      if (this.sport === "snow") {
        // Stick up tucks, down sits back (RT and LT do the same). A jumps
        // (hold to load); X or RB spins and flips; B or LB grabs.
        const buttons =
          (held(0) ? BUTTON_JUMP : 0) |
          (held(2) || held(5) ? BUTTON_TRICK : 0) |
          (held(1) || held(4) ? BUTTON_GRAB : 0);
        const active = steer !== 0 || lean !== 0 || rt > 0.05 || lt > 0.05 || buttons !== 0;
        if (!active && this.lastDevice === "keyboard") return null;
        return { steer, throttle: 0, lean: Math.max(-1, Math.min(1, lean + rt - lt)), buttons };
      }
      const buttons = (held(0) ? BUTTON_TRICK : 0) | (held(1) ? BUTTON_ROLL : 0);
      const active = steer !== 0 || lean !== 0 || rt > 0.05 || lt > 0.05 || buttons !== 0;
      if (!active && this.lastDevice === "keyboard") return null;
      return { steer, throttle: rt - lt, lean, buttons };
    }
    return null;
  }
}
