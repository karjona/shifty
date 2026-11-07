// The menus' side of the loading sign (see loading.ts): up while a screen
// waits for something (once it takes long enough to notice).
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { SIGN_AFTER_MS, holdLoading } from "../loading.ts";

/** Holds the loading sign up while `on` (once it takes long enough to notice), saying `label` ("Loading…" without one). */
export function useLoading(on: boolean, label = ""): void {
  useEffect(() => (on ? holdLoading(label ? () => label : null, SIGN_AFTER_MS) : undefined), [on, label]);
}

/** Puts the loading sign up while the router waits for a screen. */
export function Busy() {
  useLoading(useRouterState({ select: (s) => s.status === "pending" }));
  return null;
}
