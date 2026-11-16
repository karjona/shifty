import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { backdrop, type BackdropKind, type RiderShot, type ScreenBox, setMenuShot } from "../game/backdrops.ts";
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

/**
 * A ref for a list that scrolls: it says on the element (`data-more`: up,
 * down or both) which way more of the list is hidden, for the styles to
 * fade that edge out.
 */
export function useScrollEdges(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return undefined;
    const update = () => {
      const up = el.scrollTop > 2;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      const more = up && down ? "both" : up ? "up" : down ? "down" : "";
      if (more) el.setAttribute("data-more", more);
      else el.removeAttribute("data-more");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const sizes = new ResizeObserver(update);
    sizes.observe(el);
    const content = new MutationObserver(update);
    content.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      sizes.disconnect();
      content.disconnect();
    };
  }, [el]);
  return setEl;
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

/**
 * Frames your rider on the main menu's colours for `shot`, in the free
 * space of the element the returned ref goes on (below the screen's top
 * bar, which can run down over it).
 */
export function useRiderShot(shot: RiderShot): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (el) setMenuShot(shot, () => spaceOf(el));
  }, [el, shot]);
  return setEl;
}

/** A space shorter than this (of the window's height) is no room for a rider: they stand in the default place. */
const MIN_SPACE = 0.3;

/** The free space of `el` on screen, below its screen's top bar and tabs (null once it has left the page, or when the
 * layout leaves it no room, as narrow windows stack the panels). */
function spaceOf(el: HTMLElement): ScreenBox | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  // Below the top bar, and below the main menu's tabs where they run over the space.
  let top = r.top;
  for (const bar of el.closest(".screen")?.querySelectorAll(".topbar, .menu-tabs") ?? []) {
    const b = bar.getBoundingClientRect();
    if (b.right > r.left && b.left < r.right) top = Math.max(top, b.bottom);
  }
  if ((r.bottom - top) / innerHeight < MIN_SPACE) return null;
  return {
    left: r.left / innerWidth,
    right: r.right / innerWidth,
    top: top / innerHeight,
    bottom: r.bottom / innerHeight,
  };
}
