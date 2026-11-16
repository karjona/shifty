// A race from the menus: the race takes the screen and the controller;
// Start / Esc (or the button in the corner, or the browser's back) opens
// the race menu over it (online races don't pause), and leaving asks first
// when it costs something. The last race's results move on by themselves,
// or by Continue; then what comes after the race (wrapup.tsx) takes the
// screen, over the race still running on television, or over a Tilt's
// podium once the ceremony has played. Play again starts a single player
// race straight from there, through the season card. A time trial is a
// session of laps: a lap starts over from the race menu or with Y / △ / P,
// and the session ends on the same panel when the player leaves it (Leave
// asks nothing) or the room closes it. Problems (the race server turning the ticket
// down, going away, another release) get the same panel, with a way out.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Engine } from "../../game/engine.ts";
import { type RaceEnd, RaceSession, type Trouble, readPlan } from "../../game/race.ts";
import { SeasonCard } from "../../game/season-change.ts";
import { useT } from "../../i18n/index.ts";
import {
  ApiError,
  type PendingRace,
  forgetRace,
  leftMatch,
  fetchBoard,
  meQuery,
  nextSession,
  playSingle,
  playTimeTrial,
  raceMode,
  setRequeue,
  takePendingRace,
} from "../api.ts";
import { useAction, useAutoFocus, useDevice } from "../hooks.ts";
import { MenuIcon } from "../icons.tsx";
import { nav, pointing } from "../nav.ts";
import { Button, Glyph } from "../ui.tsx";
import { RaceControls } from "./controls.tsx";
import { PodiumScreen } from "./podium.tsx";
import { type EndAction, TroublePanel, type TrialSummary, WrapUp, useTroubleText } from "./wrapup.tsx";
import { VERSION } from "../../version.ts";
import { devParams } from "../../dev-params.ts";

/** `sim::Phase`. */
const GRID = 0;
const COUNTDOWN = 1;
const RACING = 2;
const RESULTS = 3;
/** `sim::Phase`: the race waits on the grid, then its intro runs. */
const BEFORE_COUNTDOWN = new Set([0, 4]);
/** The last race's results show Continue after this long (ms), so a button held from the race doesn't skip them. */
const CONTINUE_AFTER_MS = 2000;
/** A time trial session's panel comes up this long (ms) after it ends. */
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
  // The player's account stays at hand through the race, for the menus after it.
  useQuery(meQuery);
  const again = (race: PendingRace, card: SeasonCard) => setRun((r) => ({ race, card, key: r.key + 1 }));
  return <RaceRun key={run.key} race={run.race} card={run.card} onAgain={again} />;
}

/** What the race is up to, for the screen (a few times a second is plenty). */
interface View {
  racePhase: number;
  sport: "jetski" | "snow";
  watching: boolean;
  device: "keyboard" | "gamepad" | "touch";
  /** This race's course is on screen, nothing covering it. */
  onShow: boolean;
  finalResults: boolean;
  eventIndex: number;
  eventCount: number;
  trouble: Trouble | null;
}

/** What leaving costs now (null: nothing worth asking about). */
type Cost = "tilt" | "race" | null;

/** Where the race's controls stand: at the right while the grid waits, low at the left through the countdown. */
type ControlsSpot = "waiting" | "countdown";

/**
 * Where the controls stand as a race starts, read every frame so they come
 * and go with the race's phase: while the grid waits (the title card has
 * the left), and through the countdown's numbers (the HUD's "Get ready"
 * crosses the whole screen); never over a season card, the intro, or the
 * race once it is on.
 */
function useControlsSpot(session: RaceSession | null, shown: boolean): ControlsSpot | null {
  const [spot, setSpot] = useState<ControlsSpot | null>(null);
  useEffect(() => {
    if (!session || !shown) return undefined;
    let frame = 0;
    const read = () => {
      const st = session.state;
      const on = st.phase === 1 && st.trouble === null && st.onShow;
      setSpot(
        !on
          ? null
          : st.racePhase === GRID
            ? "waiting"
            : st.racePhase === COUNTDOWN && st.countdown > 0 && st.countdown <= 3
              ? "countdown"
              : null,
      );
      frame = requestAnimationFrame(read);
    };
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, [session, shown]);
  return session && shown ? spot : null;
}

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

  // Out of a race the browser's back doesn't come back to it: every way out replaces it,
  // and a reload doesn't either.
  const back = () => {
    forgetRace();
    if (!race) {
      void navigate({ to: "/play", replace: true });
      return;
    }
    if (race.back.to === "/room/$code") void navigate({ to: "/room/$code", params: race.back.params, replace: true });
    else void navigate({ to: "/play", search: race.back.search, replace: true });
  };
  const goBack = useEffectEvent(() => back());
  const planOver = useEffectEvent((data: RaceEnd) => {
    forgetRace();
    setMenu(false);
    setConfirm(null);
    setEnd(data);
  });

  useEffect(() => {
    const hud = hudRef.current;
    if (!race || !hud) {
      void card?.hide();
      void navigate({ to: "/play", replace: true });
      return undefined;
    }
    if (outdated) {
      void card?.hide();
      // A race kept through a reload, from an earlier release: nothing to go back to.
      if (race.rejoin) goBack();
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
        // Dev: `?autopilot=1` (or `miss`) rides menu races with the bot's inputs too, as it does the quick race.
        autopilot:
          import.meta.env.DEV && (devParams.get("autopilot") === "miss" ? "miss" : devParams.get("autopilot") === "1"),
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
              device: st.device,
              onShow: st.onShow,
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
  const controls = useControlsSpot(session, !menu && end === null);
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

  // A time trial session's end: its panel comes up a moment after, with your rank on the board once it's in.
  useEffect(() => {
    if (!trialResults || !session) return undefined;
    let live = true;
    const id = setTimeout(() => {
      const run = session.trialEnd();
      const tr = session.trialRace();
      const conditions = session.state.conditions;
      if (!run || !tr || !conditions) return;
      const summary: TrialSummary = { ...run, course: tr.course, conditions, rank: null };
      setTrialPanel(summary);
      if (run.practice || run.best === 0) return;
      void fetchBoard(tr.course, tr.season)
        .then((b) => {
          if (live && b.mine) setTrialPanel({ ...summary, rank: { rank: b.mine.rank, total: b.total } });
        })
        .catch(() => {});
    }, TRIAL_PANEL_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [trialResults, session]);

  /** A time trial: the lap under way starts over from the countdown. */
  const retry = () => {
    session?.retry();
    setMenu(false);
  };

  /** Single player: the same pick again, straight in, through the season card. */
  const playAgain = async () => {
    if (!race || busy) return;
    setBusy(true);
    setError(null);
    try {
      const kept = mode === "trial" ? (session?.trialRace() ?? race.trial) : undefined;
      const trialRace = kept && nextSession(kept);
      const ticket = trialRace ? await playTimeTrial(trialRace) : await playSingle(race.plan ?? { tilt: true });
      const first = readPlan(ticket.token)[0];
      const next = new SeasonCard(first?.conditions.season ?? "summer", true, first?.course ?? null);
      next.loading = true;
      await new Promise((resolve) => setTimeout(resolve, CARD_FADE_MS));
      onAgain({ ...race, ticket, ...(trialRace ? { trial: trialRace } : {}) }, next);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "no_server" ? t.common.noServer : t.common.error);
      setBusy(false);
    }
  };

  const changeMode = () => {
    forgetRace();
    void navigate({ to: "/play", search: { mode }, replace: true });
  };
  const mainMenu = () => {
    forgetRace();
    void navigate({ to: "/", replace: true });
  };
  /** Leaving on purpose (confirmed where it costs something): the match isn't offered back. */
  const quit = () => {
    if (race && online) leftMatch(race.ticket.room);
    back();
  };
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
    if (trial) {
      // A time trial session costs nothing to leave: it ends on its panel.
      session?.leaveSession();
      setMenu(false);
    } else if (cost && confirm === null) setConfirm(cost);
    else quit();
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

  if (outdated && !race?.rejoin)
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
      {/* A finger's thumbs are on the labelled buttons through the countdown. */}
      {view && controls && !(controls === "countdown" && view.device === "touch") && (
        <RaceControls sport={view.sport} device={view.device} className={controls} />
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
          {trial && !trialResults && view !== null && (view.racePhase === COUNTDOWN || view.racePhase === RACING) && (
            <button type="button" tabIndex={-1} className="race-camera race-retry" onClick={retry}>
              <Glyph action="play" />
              {t.trial.retry}
            </button>
          )}
          {view?.watching && !trial && (
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
        <div className="race-menu with-controls" data-nav-scope="">
          {view && <RaceControls sport={view.sport} device={view.device} />}
          <div className="panel">
            <h2 className="panel-title">{t.race.menu}</h2>
            <Button kind="primary" glyph="back" onClick={() => setMenu(false)} autoFocus>
              {t.race.resume}
            </Button>
            {trial && <Button onClick={retry}>{t.trial.retry}</Button>}
            <Button onClick={leave}>{trial ? t.trial.leave : t.race.leave}</Button>
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
            <Button kind="danger" onClick={quit}>
              {t.race.leaving.leave}
            </Button>
          </div>
        </div>
      )}
      {trouble && <Problem trouble={trouble} back={back} room={mode === "room"} rejoin={race?.rejoin === true} />}
      {endShown && end && wrapUp({ kind: "race", end })}
      {trialShown && trialPanel && wrapUp({ kind: "trial", trial: trialPanel })}
    </div>
  );
}

/**
 * What went wrong, and the way back (a room's: where its race can be
 * rejoined while it runs). Coming back to a race (`rejoin`), a turned-down
 * ticket means the way back in is closed.
 */
function Problem({
  trouble,
  back,
  room,
  rejoin,
}: {
  trouble: Trouble;
  back: () => void;
  room: boolean;
  rejoin: boolean;
}) {
  const t = useT();
  const text = useTroubleText(trouble);
  const closed = rejoin && trouble.kind === "rejected" && trouble.reason !== "version" && trouble.reason !== "full";
  const { title, body } = closed ? t.race.trouble.rejoin : text;
  const version = trouble.kind === "rejected" && trouble.reason === "version";
  const backAction: EndAction = { label: room ? t.end.backToRoom : t.common.back, run: back, glyph: "back" };
  return (
    <TroublePanel
      title={title}
      body={body}
      actions={version ? [{ label: t.race.updated.reload, run: () => location.reload() }, backAction] : [backAction]}
      back={backAction}
    />
  );
}
