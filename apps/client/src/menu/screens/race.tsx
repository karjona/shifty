// A race from the menus: the race takes the screen and the controller;
// Start / Esc (or the button in the corner, or the browser's back) opens
// the race menu over it (online races don't pause). A Tilt ends on its
// podium. A time trial starts over from the race menu or its results.
import { useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Engine } from "../../game/engine.ts";
import type { PodiumData } from "../../game/podium.ts";
import { RaceSession } from "../../game/race.ts";
import { useT } from "../../i18n/index.ts";
import { type PendingRace, fetchMe, meQuery, takePendingRace } from "../api.ts";
import { toast } from "../toast.tsx";
import { useAction, useAutoFocus, useDevice } from "../hooks.ts";
import { MenuIcon } from "../icons.tsx";
import { nav, pointing } from "../nav.ts";
import { touchSettings } from "../../touch/device.ts";
import { Button, Glyph } from "../ui.tsx";
import { PodiumScreen } from "./podium.tsx";
import { VERSION } from "../../version.ts";

/** `sim::Phase::Results`. */
const RESULTS = 3;
/** `sim::Phase`: the race waits on the grid, then its intro runs. */
const BEFORE_COUNTDOWN = new Set([0, 4]);

export function RaceScreen() {
  const t = useT();
  const navigate = useNavigate();
  const hudRef = useRef<HTMLDivElement>(null);
  const [race] = useState<PendingRace | null>(() => takePendingRace());
  /** The race server runs another release: this page must reload first. */
  const outdated = race !== null && race.ticket.version !== VERSION;
  const [session, setSession] = useState<RaceSession | null>(null);
  const [menu, setMenu] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<{
    racePhase: number;
    sport: "jetski" | "snow";
    watching: boolean;
    touch: boolean;
  } | null>(null);
  const { device } = useDevice();
  const [podium, setPodium] = useState<PodiumData | null>(null);
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
  const planOver = useEffectEvent((data: PodiumData | null) => (data ? setPodium(data) : back()));

  useEffect(() => {
    const hud = hudRef.current;
    if (!race || !hud) {
      void navigate({ to: "/play" });
      return undefined;
    }
    if (outdated) return undefined;
    let s: RaceSession | null = null;
    let live = true;
    void Engine.get().then((engine) => {
      if (!live) return;
      s = new RaceSession({
        ticket: race.ticket,
        hud,
        status: setStatus,
        onJoin: (ok) => setFailed(!ok),
        onOver: (data) => planOver(data),
        trial: race.trial,
      });
      engine.show(s);
      setSession(s);
    });
    return () => {
      live = false;
      const stage = s;
      if (stage) void Engine.get().then((engine) => engine.hide(stage));
    };
  }, [race, navigate, outdated]);

  // What the race is up to, for the help (a few times a second is plenty).
  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => {
      const { phase, racePhase, sport, watching } = session.state;
      setView(phase === 1 ? { racePhase, sport, watching, touch: session.state.device === "touch" } : null);
    }, 250);
    return () => clearInterval(id);
  }, [session]);

  /** A time trial's results: retry or leave. */
  const trial = race?.trial !== undefined;
  const trialResults = trial && view?.racePhase === RESULTS && !menu;
  const retry = () => {
    session?.retry();
    setMenu(false);
  };

  // The controller drives the rider; only Start (or Esc) reaches the menus.
  useEffect(() => {
    nav.setEnabled(menu || failed || outdated || podium !== null || trialResults);
    session?.setPaused(menu);
    return () => nav.setEnabled(true);
  }, [menu, failed, outdated, podium, session, trialResults]);

  useAction("menu", () => setMenu((m) => !m), !outdated && podium === null);
  useAction("play", retry, trialResults);
  // The browser's back (a swipe in from the screen's edge on a phone) opens the race menu instead of leaving.
  useBlocker({
    shouldBlockFn: ({ action }) => {
      if (action === "PUSH" || action === "REPLACE") return false;
      setMenu(true);
      return true;
    },
    disabled: outdated || failed || podium !== null,
    enableBeforeUnload: false,
  });
  useAction(
    "back",
    () => (failed || outdated || trialResults ? back() : setMenu(false)),
    menu || failed || outdated || trialResults,
  );
  useAutoFocus();

  if (podium) return <PodiumScreen data={podium} onDone={back} />;

  if (outdated)
    return (
      <div className="screen race-screen">
        <div className="race-menu" data-nav-scope="">
          <div className="panel">
            <h2 className="panel-title">{t.race.updated.title}</h2>
            <p>{t.race.updated.body}</p>
            <Button kind="primary" onClick={() => location.reload()} autoFocus>
              {t.race.updated.reload}
            </Button>
            <Button glyph="back" onClick={back}>
              {t.race.leave}
            </Button>
          </div>
        </div>
      </div>
    );

  return (
    <div className="screen race-screen">
      <div ref={hudRef} className="race-hud" />
      {status && <div className="race-status">{status}</div>}
      {view && (BEFORE_COUNTDOWN.has(view.racePhase) || menu) && (
        <div className={`race-help ${menu ? "in-menu" : ""}`}>
          <b>{t.race.controls}</b>
          {(view.touch
            ? t.race.helpTouch[view.sport === "jetski" && touchSettings().gas === "hold" ? "jetskiHold" : view.sport]
            : t.race.help[view.sport]
          ).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
      {trialResults && (
        <div className="trial-actions" data-nav-scope="">
          <Button kind="primary" glyph="play" onClick={retry} autoFocus>
            {t.trial.retry}
          </Button>
          <Button glyph="back" onClick={back}>
            {t.race.leave}
          </Button>
        </div>
      )}
      {!menu && !failed && (
        <div className="race-menu-hint">
          {view?.watching && !trialResults && (
            <button type="button" tabIndex={-1} className="race-camera" onClick={() => session?.nextCamera()}>
              <Glyph action="play" />
              {t.race.camera}
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            className="race-menu-button"
            aria-label={t.race.menu}
            onClick={() => setMenu(true)}
          >
            {pointing(device) ? <MenuIcon /> : <Glyph action="menu" />}
          </button>
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
            {!failed && trial && <Button onClick={retry}>{t.trial.retry}</Button>}
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
