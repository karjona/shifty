import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { backdrop, type BackdropKind } from "../game/backdrops.ts";
import { Engine } from "../game/engine.ts";
import { type Action, type Device, nav, type Pad } from "./nav.ts";

const subscribe = (l: () => void) => nav.subscribe(l);

/** The input device last used (for button glyphs). */
export function useDevice(): { device: Device; pad: Pad } {
  const device = useSyncExternalStore(subscribe, () => nav.device);
  const pad = useSyncExternalStore(subscribe, () => nav.pad);
  return { device, pad };
}

/** Runs `handler` on a controller/keyboard action while mounted (and `enabled`). */
export function useAction(action: Action, handler: () => void, enabled = true): void {
  const run = useEffectEvent(handler);
  useEffect(() => (enabled ? nav.on(action, () => run()) : undefined), [action, enabled]);
}

/**
 * Keeps something focused: after every render, if nothing on the screen (or
 * in the open dialog) has the focus, its starting element gets it.
 */
export function useAutoFocus(): void {
  useEffect(() => {
    const id = setTimeout(() => nav.ensureFocus(), 30);
    return () => clearTimeout(id);
  });
}

/** The engine, once it has booted. */
export function useEngine(): Engine | null {
  const [engine, setEngine] = useState<Engine | null>(null);
  useEffect(() => {
    let live = true;
    void Engine.get().then((e) => {
      if (live) setEngine(e);
    });
    return () => {
      live = false;
    };
  }, []);
  return engine;
}

/** Shows a backdrop behind this screen. */
export function useBackdrop(kind: BackdropKind): void {
  const engine = useEngine();
  useEffect(() => {
    if (engine) engine.show(backdrop(kind));
  }, [engine, kind]);
}
