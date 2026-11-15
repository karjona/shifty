// A race from the menus: the race takes the screen and the controller;
// Start / Esc (or the button in the corner, or the browser's back) opens
// the race menu over it (online races don't pause), and leaving asks first
// when it costs something. The last race's results move on by themselves,
// or by Continue; then what comes after the race (wrapup.tsx) takes the
// screen, over the race still running on television, or over a Tilt's
// podium once the ceremony has played. Play again starts a single player
// race straight from there, through the season card. A time trial ends on
// the same panel, with Retry. Problems (the race server turning the ticket
// down, going away, another release) get the same panel, with a way out.
import { useNavigate } from "@tanstack/react-router";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Engine } from "../../game/engine.ts";
import { SEASONS } from "@shifty/rider";
import { type RaceEnd, RaceSession, type Trouble, readPlan } from "../../game/race.ts";
import { SeasonCard } from "../../game/season-change.ts";
import { useT } from "../../i18n/index.ts";
import { ApiError, type PendingRace, playSingle, raceMode, setRequeue, takePendingRace } from "../api.ts";
import { useAction, useAutoFocus, useDevice } from "../hooks.ts";
import { MenuIcon } from "../icons.tsx";
import { nav, pointing } from "../nav.ts";
import { touchSettings } from "../../touch/device.ts";
import { Button, Glyph } from "../ui.tsx";
import { PodiumScreen } from "./podium.tsx";
import { type EndAction, TroublePanel, type TrialSummary, WrapUp, useTroubleText } from "./wrapup.tsx";
import { VERSION } from "../../version.ts";

/** `sim::Phase`. */
const COUNTDOWN = 1;
const RACING = 2;
const RESULTS = 3;
/** `sim::Phase`: the race waits on the grid, then its intro runs. */
const BEFORE_COUNTDOWN = new Set([0, 4]);
/** The last race's results show Continue after this long (ms), so a button held from the race doesn't skip them. */
const CONTINUE_AFTER_MS = 2000;
/** A time trial's run gets this long (ms) on the finish before its panel comes up. */
const TRIAL_PANEL_MS = 1200;
/** The season card's fade in (see `.season-change` in menu.css). */
const CARD_FADE_MS = 900;

/** The race on screen, and the card that covers its start when it follows another (Play again). */
interface Run {
  race: PendingRace | null;
  card: SeasonCard | null;
  key: number;
}

export function RaceScreen() {
  const [run, setRun] = useState<Run>(() => ({ race: takePendingRace(), card: null, key: 0 }));
  const again = (race: PendingRace, card: SeasonCard) => setRun((r) => ({ race, card, key: r.key + 1 }));
  return <RaceRun key={run.key} race={run.race} card={run.card} onAgain={again} />;
}

/** What the race is up to, for the screen (a few times a second is plenty). */
interface View {
  racePhase: number;
  sport: "jetski" | "snow";
  watching: boolean;
  touch: boolean;
  finalResults: boolean;
  eventIndex: number;
  eventCount: number;
  trouble: Trouble | null;
}

/** What leaving costs now (null: nothing worth asking about). */
type Cost = "tilt" | "race" | null;

function RaceRun({
  race,
  card,
  onAgain,
}: {
  race: PendingRace | null;
  card: SeasonCard | null;
  onAgain: (race: PendingRace, card: SeasonCard) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const hudRef = useRef<HTMLDivElement>(null);
  /** The race server runs another release: this page must reload first. */
  const outdated = race !== null && race.ticket.version !== VERSION;
  const mode = race ? raceMode(race) : "single";
  const online = mode === "room" || mode === "matchmaking";
  const [session, setSession] = useState<RaceSession | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<Cost>(null);
  const [view, setView] = useState<View | null>(null);
  const [end, setEnd] = useState<RaceEnd | null>(null);
  /** A Tilt's ceremony is over: what comes after it takes the screen. */
  const [afterPodium, setAfterPodium] = useState(false);
  const [continueShown, setContinueShown] = useState(false);
  const [trialPanel, setTrialPanel] = useState<TrialSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { device } = useDevice();

  const back = () => {
    if (!race) {
      void navigate({ to: "/play" });
      return;
    }
    if (race.back.to === "/room/$code") void navigate({ to: "/room/$code", params: race.back.params });
    else void navigate({ to: "/play", search: race.back.search });
  };
  const planOver = useEffectEvent((data: RaceEnd) => {
    setMenu(false);
    setConfirm(null);
    setEnd(data);
  });

  useEffect(() => {
    const hud = hudRef.current;
    if (!race || !hud) {
      void card?.hide();
      void navigate({ to: "/play" });
      return undefined;
    }
    if (outdated) {
      void card?.hide();
      return undefined;
    }
    let s: RaceSession | null = null;
    let live = true;
    void Engine.get().then((engine) => {
      if (!live) return;
      s = new RaceSession({
        ticket: race.ticket,
        hud,
        status: () => {},
        onOver: (data) => planOver(data),
        trial: race.trial,
        card: card ?? undefined,
      });
      engine.show(s);
      setSession(s);
    });
    return () => {
      live = false;
      const stage = s;
      if (stage) void Engine.get().then((engine) => engine.hide(stage));
    };
  }, [race, card, navigate, outdated]);

  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => {
      const st = session.state;
      setView(
        st.phase === 1 || st.trouble
          ? {
              racePhase: st.racePhase,
              sport: st.sport,
              watching: st.watching,
              touch: st.device === "touch",
              finalResults: st.finalResults,
              eventIndex: st.eventIndex,
              eventCount: st.eventCount,
              trouble: st.trouble,
            }
          : null,
      );
    }, 250);
    return () => clearInterval(id);
  }, [session]);

  const trouble = end ? null : (view?.trouble ?? null);
  const trial = race?.trial !== undefined;
  const trialResults = trial && view?.racePhase === RESULTS && trouble === null;
  const finalResults = (view?.finalResults ?? false) && end === null && trouble === null;

  // The last race's results: Continue shows after a beat.
  useEffect(() => {
    if (!finalResults) return undefined;
    const id = setTimeout(() => setContinueShown(true), CONTINUE_AFTER_MS);
    return () => {
      clearTimeout(id);
      setContinueShown(false);
    };
  }, [finalResults]);

  // A time trial's run: its panel comes up a moment after the finish, and goes with a retry.
  useEffect(() => {
    if (!trialResults || !session) return undefined;
    const id = setTimeout(() => {
      const run = session.trialEnd();
      const tr = race?.trial;
      if (!run || !tr) return;
      setTrialPanel({
        course: tr.course,
        season: SEASONS[tr.season] ?? "summer",
        ticks: run.ticks,
        hz: run.hz,
        ghosts: run.ghosts,
        callout: run.callout,
        name: run.name,
      });
    }, TRIAL_PANEL_MS);
    return () => clearTimeout(id);
  }, [trialResults, session, race]);

  const retry = () => {
    session?.retry();
    setMenu(false);
    setTrialPanel(null);
  };

  /** Single player: the same pick again, straight in, through the season card. */
  const playAgain = async () => {
    if (!race || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ticket = await playSingle(race.plan ?? { tilt: true });
      const first = readPlan(ticket.token)[0];
      const next = new SeasonCard(first?.conditions.season ?? "summer", true, first?.course ?? null);
      next.loading = true;
      await new Promise((resolve) => setTimeout(resolve, CARD_FADE_MS));
      onAgain({ ...race, ticket }, next);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "no_server" ? t.common.noServer : t.common.error);
      setBusy(false);
    }
  };

  const changeMode = () => void navigate({ to: "/play", search: { mode } });
  const mainMenu = () => void navigate({ to: "/" });
  const toRoom = () => back();

  // What leaving costs now: a Tilt under way, or a race you are still in.
  const cost: Cost =
    trial || end || !view || trouble
      ? null
      : view.eventCount > 1 && (view.eventIndex > 0 || !BEFORE_COUNTDOWN.has(view.racePhase))
        ? "tilt"
        : (view.racePhase === COUNTDOWN || view.racePhase === RACING) && !view.watching
          ? "race"
          : null;
  const leave = () => {
    if (cost && confirm === null) setConfirm(cost);
    else back();
  };

  const endShown = end !== null && (end.podium === null || afterPodium);
  const trialShown = trialResults && trialPanel !== null;
  const panels = menu || trouble !== null || outdated || end !== null || trialShown;

  // The television keeps the riders clear of the panel.
  useEffect(() => {
    if (!session) return undefined;
    if (!endShown && !trialShown) {
      session.setPanel(null);
      return undefined;
    }
    const place = () => {
      const left = document.querySelector(".race-screen .end-panel")?.getBoundingClientRect().left;
      session.setPanel(left === undefined ? null : left / innerWidth);
    };
    const id = requestAnimationFrame(place);
    addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(id);
      removeEventListener("resize", place);
    };
  }, [session, endShown, trialShown]);

  // The controller drives the rider; only Start (or Esc) reaches the menus (and Continue, on the last results).
  useEffect(() => {
    nav.setEnabled(panels || continueShown);
    session?.setPaused(menu);
    return () => nav.setEnabled(true);
  }, [panels, continueShown, menu, session]);

  useAction("menu", () => setMenu((m) => !m), !outdated && end === null && !trialShown && trouble === null);
  // The browser's back (a swipe in from the screen's edge on a phone) opens the race menu instead of leaving.
  useBlocker({
    shouldBlockFn: ({ action }) => {
      if (action === "PUSH" || action === "REPLACE") return false;
      setMenu(true);
      return true;
    },
    disabled: outdated || trouble !== null || end !== null || trialShown,
    enableBeforeUnload: false,
  });
  useAction(
    "back",
    () => {
      if (confirm) setConfirm(null);
      else setMenu(false);
    },
    menu,
  );
  useAutoFocus();

  const actions = (): { list: EndAction[]; back: EndAction } => {
    const changeAction: EndAction = { label: t.end.changeMode, run: changeMode };
    const menuAction: EndAction = { label: t.end.mainMenu, run: mainMenu };
    if (mode === "trial")
      return {
        list: [{ label: t.trial.retry, run: retry, glyph: "play" }, changeAction, menuAction],
        back: changeAction,
      };
    if (mode === "room") {
      const toRoomAction: EndAction = { label: t.end.backToRoom, run: toRoom, glyph: "play" };
      return { list: [toRoomAction, changeAction, menuAction], back: toRoomAction };
    }
    const again: EndAction =
      mode === "matchmaking"
        ? {
            label: t.end.findRace,
            run: () => {
              setRequeue();
              changeMode();
            },
            glyph: "play",
          }
        : { label: t.end.again, run: () => void playAgain(), glyph: "play" };
    return { list: [again, changeAction, menuAction], back: changeAction };
  };

  const wrapUp = (summary: Parameters<typeof WrapUp>[0]["summary"]) => {
    const { list, back: backAction } = actions();
    return (
      <WrapUp
        summary={summary}
        mode={mode}
        match={online && race ? race.ticket.room : null}
        actions={list}
        back={backAction}
        busy={busy}
        error={error}
      />
    );
  };

  if (outdated)
    return (
      <div className="screen race-screen">
        <TroublePanel
          title={t.race.updated.title}
          body={t.race.updated.body}
          actions={[
            { label: t.race.updated.reload, run: () => location.reload() },
            { label: t.common.back, run: back },
          ]}
          back={{ label: t.common.back, run: back }}
        />
      </div>
    );

  if (end?.podium)
    return (
      <PodiumScreen data={end.podium} onContinue={() => setAfterPodium(true)}>
        {afterPodium && wrapUp({ kind: "race", end })}
      </PodiumScreen>
    );

  return (
    <div className={`screen race-screen${endShown || trialShown ? " wrapped" : ""}`}>
      <div ref={hudRef} className="race-hud" />
      {view && trouble === null && !endShown && !trialShown && (BEFORE_COUNTDOWN.has(view.racePhase) || menu) && (
        <Help view={view} inMenu={menu} />
      )}
      {!menu && trouble === null && !endShown && !trialShown && (
        <div className="race-menu-hint">
          {continueShown && (
            <button
              type="button"
              data-nav=""
              data-nav-autofocus=""
              className="race-continue"
              onClick={() => session?.moveOnFromResults()}
            >
              {!pointing(device) && <Glyph action="confirm" />}
              {t.end.continue}
            </button>
          )}
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
      {menu && !confirm && (
        <div className="race-menu" data-nav-scope="">
          <div className="panel">
            <h2 className="panel-title">{t.race.menu}</h2>
            <Button kind="primary" glyph="back" onClick={() => setMenu(false)} autoFocus>
              {t.race.resume}
            </Button>
            {trial && <Button onClick={retry}>{t.trial.retry}</Button>}
            <Button onClick={leave}>{t.race.leave}</Button>
            {online && <p className="muted small">{t.race.noPause}</p>}
          </div>
        </div>
      )}
      {menu && confirm && (
        <div className="race-menu" data-nav-scope="">
          <div className="panel leave-confirm">
            <h2 className="panel-title">{confirm === "tilt" ? t.race.leaving.tilt : t.race.leaving.race}</h2>
            <p>
              {confirm === "tilt"
                ? online
                  ? t.race.leaving.tiltOnline
                  : t.race.leaving.tiltSingle
                : online
                  ? t.race.leaving.raceOnline
                  : t.race.leaving.raceSingle}
            </p>
            <Button kind="primary" glyph="back" onClick={() => setConfirm(null)} autoFocus>
              {t.race.leaving.stay}
            </Button>
            <Button kind="danger" onClick={back}>
              {t.race.leaving.leave}
            </Button>
          </div>
        </div>
      )}
      {trouble && <Problem trouble={trouble} back={back} />}
      {endShown && end && wrapUp({ kind: "race", end })}
      {trialShown && trialPanel && wrapUp({ kind: "trial", trial: trialPanel })}
    </div>
  );
}

/** The controls, while the race waits to start and in the race menu. */
function Help({ view, inMenu }: { view: View; inMenu: boolean }) {
  const t = useT();
  const lines = view.touch
    ? t.race.helpTouch[view.sport === "jetski" && touchSettings().gas === "hold" ? "jetskiHold" : view.sport]
    : t.race.help[view.sport];
  return (
    <div className={`race-help ${inMenu ? "in-menu" : ""}`}>
      <b>{t.race.controls}</b>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

/** What went wrong, and the way back. */
function Problem({ trouble, back }: { trouble: Trouble; back: () => void }) {
  const t = useT();
  const { title, body } = useTroubleText(trouble);
  const version = trouble.kind === "rejected" && trouble.reason === "version";
  const backAction: EndAction = { label: t.common.back, run: back, glyph: "back" };
  return (
    <TroublePanel
      title={title}
      body={body}
      actions={version ? [{ label: t.race.updated.reload, run: () => location.reload() }, backAction] : [backAction]}
      back={backAction}
    />
  );
}
