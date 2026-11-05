// A race from the menus: the race takes the screen and the controller;
// Start / Esc opens the race menu over it (online races don't pause).
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Engine } from "../../game/engine.ts";
import { RaceSession } from "../../game/race.ts";
import { useT } from "../../i18n/index.ts";
import { type PendingRace, fetchMe, meQuery, takePendingRace } from "../api.ts";
import { toast } from "../toast.tsx";
import { useAction, useAutoFocus } from "../hooks.ts";
import { nav } from "../nav.ts";
import { Button, Glyph } from "../ui.tsx";

/** `sim::Phase::Results`. */
const RESULTS = 3;

export function RaceScreen() {
  const t = useT();
  const navigate = useNavigate();
  const hudRef = useRef<HTMLDivElement>(null);
  const [race] = useState<PendingRace | null>(() => takePendingRace());
  const [session, setSession] = useState<RaceSession | null>(null);
  const [menu, setMenu] = useState(false);
  const [status, setStatus] = useState(t.race.connecting);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<{ racePhase: number; sport: "jetski" | "snow" } | null>(null);
  const queryClient = useQueryClient();
  const credits = useRef<number | null>(queryClient.getQueryData(meQuery.queryKey)?.rider?.credits ?? null);
  const phaseNow = view?.racePhase ?? null;

  // When a race's results come up, tell the player what it paid (the
  // race server reports to the lobby as the race ends).
  useEffect(() => {
    if (phaseNow !== RESULTS) return undefined;
    const id = setTimeout(() => {
      void fetchMe().then((me) => {
        if (!me) return;
        queryClient.setQueryData(meQuery.queryKey, me);
        const now = me.rider?.credits ?? null;
        if (now !== null && credits.current !== null && now > credits.current)
          toast(t.shop.earned(now - credits.current));
        credits.current = now;
      });
    }, 2500);
    return () => clearTimeout(id);
  }, [phaseNow, queryClient, t]);

  const back = () => {
    if (!race) {
      void navigate({ to: "/play" });
      return;
    }
    if (race.back.to === "/room/$code") void navigate({ to: "/room/$code", params: race.back.params });
    else void navigate({ to: "/play", search: race.back.search });
  };

  useEffect(() => {
    const hud = hudRef.current;
    if (!race || !hud) {
      void navigate({ to: "/play" });
      return undefined;
    }
    let s: RaceSession | null = null;
    let live = true;
    void Engine.get().then((engine) => {
      if (!live) return;
      s = new RaceSession({
        ticket: race.ticket,
        hud,
        status: setStatus,
        onJoin: (ok) => setFailed(!ok),
      });
      engine.show(s);
      setSession(s);
    });
    return () => {
      live = false;
      const stage = s;
      if (stage) void Engine.get().then((engine) => engine.hide(stage));
    };
  }, [race, navigate]);

  // What the race is up to, for the help (a few times a second is plenty).
  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => {
      const { phase, racePhase, sport } = session.state;
      setView(phase === 1 ? { racePhase, sport } : null);
    }, 250);
    return () => clearInterval(id);
  }, [session]);

  // The controller drives the rider; only Start (or Esc) reaches the menus.
  useEffect(() => {
    nav.setEnabled(menu || failed);
    session?.setPaused(menu);
    return () => nav.setEnabled(true);
  }, [menu, failed, session]);

  useAction("menu", () => setMenu((m) => !m));
  useAction("back", () => (failed ? back() : setMenu(false)), menu || failed);
  useAutoFocus();

  return (
    <div className="screen race-screen">
      <div ref={hudRef} className="race-hud" />
      {status && <div className="race-status">{status}</div>}
      {view && (view.racePhase === 0 || menu) && (
        <div className={`race-help ${menu ? "in-menu" : ""}`}>
          <b>{t.race.controls}</b>
          {t.race.help[view.sport].map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
      {!menu && !failed && (
        <div className="race-menu-hint">
          <Glyph action="menu" />
        </div>
      )}
      {(menu || failed) && (
        <div className="race-menu" data-nav-scope="">
          <div className="panel">
            <h2 className="panel-title">{t.race.menu}</h2>
            {!failed && (
              <Button kind="primary" glyph="back" onClick={() => setMenu(false)} autoFocus>
                {t.race.resume}
              </Button>
            )}
            <Button glyph={failed ? "back" : undefined} onClick={back} autoFocus={failed}>
              {t.race.leave}
            </Button>
            {!failed && <p className="muted small">{t.race.noPause}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
