import { GUI } from "lil-gui";
import type { NetConditions } from "../net/conditioner.ts";

export interface DebugState {
  transport: string;
  renderer: string;
  rttMs: number;
  inputLead: number;
  timeScale: number;
  predictedTick: number;
  snapshotTick: number;
  lastCorrectionCm: number;
  mispredictions: number;
  resyncs: number;
  snapshotBytes: number;
  inputsPerPacket: number;
  downKbps: number;
  upKbps: number;
  fps: number;
}

export interface DebugSettings {
  renderScale: number;
}

/** Netcode debug panel: live stats plus knobs for testing by feel. */
export function createDebugPanel(net: NetConditions, settings: DebugSettings, onRenderScale: (s: number) => void) {
  const gui = new GUI({ title: "Shifty debug (F1)" });
  const state: DebugState = {
    transport: "-",
    renderer: "-",
    rttMs: 0,
    inputLead: 0,
    timeScale: 1,
    predictedTick: 0,
    snapshotTick: 0,
    lastCorrectionCm: 0,
    mispredictions: 0,
    resyncs: 0,
    snapshotBytes: 0,
    inputsPerPacket: 0,
    downKbps: 0,
    upKbps: 0,
    fps: 0,
  };
  const stats = gui.addFolder("Netcode");
  const ro = (key: keyof DebugState, label: string, decimals = 0) => {
    const c = stats.add(state, key).name(label).disable();
    if (typeof state[key] === "number") c.decimals(decimals);
    return c;
  };
  ro("transport", "transport");
  ro("renderer", "renderer");
  ro("rttMs", "rtt ms");
  ro("inputLead", "input lead (ticks)");
  ro("timeScale", "clock scale", 3);
  ro("predictedTick", "predicted tick");
  ro("snapshotTick", "server tick");
  ro("lastCorrectionCm", "last correction cm", 1);
  ro("mispredictions", "mispredictions");
  ro("resyncs", "clock resyncs");
  ro("snapshotBytes", "snapshot bytes");
  ro("inputsPerPacket", "inputs/packet");
  ro("downKbps", "down kbit/s", 1);
  ro("upKbps", "up kbit/s", 1);
  ro("fps", "fps");

  const fake = gui.addFolder("Fake bad network");
  fake.add(net, "lagMs", 0, 400, 5).name("added RTT ms");
  fake.add(net, "jitterMs", 0, 100, 1).name("jitter ms");
  fake.add(net, "lossPct", 0, 30, 0.5).name("loss %");

  const view = gui.addFolder("View");
  view.add(settings, "renderScale", 0.25, 1, 0.05).name("render scale").onChange(onRenderScale);

  let visible = true;
  const onKey = (e: KeyboardEvent) => {
    if (e.code === "F1") {
      e.preventDefault();
      visible = !visible;
      gui.show(visible);
    }
  };
  addEventListener("keydown", onKey);

  return {
    state,
    refresh() {
      for (const c of gui.controllersRecursive()) c.updateDisplay();
    },
    destroy() {
      removeEventListener("keydown", onKey);
      gui.destroy();
    },
  };
}
