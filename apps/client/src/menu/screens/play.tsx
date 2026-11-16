// Mode select, at the country club: time trial and single player (solo),
// rooms and matchmaking (online). Your rider stands on the terrace; party
// members will join you there.
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { setClubRider, setClubRiders } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { parseJoinTicket } from "../../net/transport.ts";
import { CIRCUITS, type PlanRequest, SEASONS, circuit } from "@shifty/rider";
import {
  ApiError,
  createRoom,
  liveRaceQuery,
  lobbySocket,
  meQuery,
  type Mode,
  playSingle,
  playTimeTrial,
  roomExists,
  setPendingRace,
  takeRequeue,
} from "../api.ts";
import { PlusIcon, SlidersIcon } from "../icons.tsx";
import { type Picks, keepPicks, lastPicks } from "../picks.ts";
import { PlanPickers, seasonSports } from "../plan.tsx";
import { useLoading } from "../busy.tsx";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { toast } from "../toast.tsx";
import { Button, Hints, Modal, Panel, Picker, Spinner, TabBar, TextField } from "../ui.tsx";
import { TopBar } from "./common.tsx";
import { SetupEditor } from "./setup.tsx";
import { type TrialChoice, TrialPanel } from "./trial.tsx";

export type { Mode };
const route = getRouteApi("/play");
export function ModeSelect() {
  useBackdrop("club");
  const t = useT();
  const navigate = useNavigate();
  const search = route.useSearch();
  const [picks, setPicks] = useState(lastPicks);
  const mode = search.mode ?? picks.mode;
  const plan = mode === "room" ? picks.room : picks.single;
  const bots = picks.bots;
  const keep = (change: Partial<Picks>) => setPicks(keepPicks(change));
  const setPlan = (p: PlanRequest) => keep(mode === "room" ? { room: p } : { single: p });
  const setBots = (n: number) => keep({ bots: n });
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  // Play again from the end of a matchmaking race goes straight back into the queue.
  const [searching, setSearching] = useState(() => mode === "matchmaking" && takeRequeue());
  const [tuning, setTuning] = useState(false);
  const [trial, setTrial] = useState<TrialChoice | null>(null);
  useLoading(busy);
  const pickTrial = useCallback((c: TrialChoice) => {
    setTrial(c);
    keepPicks({ trial: { course: c.course, season: SEASONS[c.season] ?? "summer" } });
  }, []);
  const { data: me } = useSuspenseQuery(meQuery);
  const appearance = me?.rider?.appearance ?? null;
  useEffect(() => setClubRiders(1), []);
  const sport = mode === "trial" ? (trial?.sport === "snow" ? "winter" : "summer") : null;
  useEffect(() => {
    if (appearance) setClubRider(appearance, sport ?? clubSport(plan));
  }, [appearance, plan, sport]);
  useAutoFocus();
  useAction("back", () => void navigate({ to: "/" }), !joining && !searching && !tuning);

  const setMode = (m: Mode) => void navigate({ to: "/play", search: { mode: m }, replace: true });
  // The mode on show is the one to come back to (a race's way back names it).
  useEffect(() => {
    if (mode !== lastPicks().mode) keepPicks({ mode });
  }, [mode]);

  const fail = (e: unknown) => {
    toast(e instanceof ApiError && e.code === "no_server" ? t.common.noServer : t.common.error, "error");
  };

  const play = async () => {
    if (busy) return;
    if (mode === "trial" && !trial?.race) return;
    if (mode === "matchmaking") {
      setSearching(true);
      return;
    }
    setBusy(true);
    try {
      if (mode === "trial" && trial?.race) {
        const ticket = await playTimeTrial(trial.course, trial.season);
        setPendingRace({ ticket, back: { to: "/play", search: { mode: "trial" } }, trial: trial.race });
        await navigate({ to: "/race", replace: true });
      } else if (mode === "single") {
        const ticket = await playSingle(plan);
        setPendingRace({ ticket, back: { to: "/play", search: { mode: "single" } }, plan });
        await navigate({ to: "/race", replace: true });
      } else {
        const code = await createRoom(plan, bots);
        await navigate({ to: "/room/$code", params: { code } });
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  useAction("play", () => void play(), !joining && !searching);

  return (
    <div className="screen mode-select">
      <TopBar title={t.play.title} kicker={t.play.club} />
      <LiveRace />
      <main className="mode-body">
        <div className="party">
          <Button kind="ghost" className="party-add" onClick={() => toast(t.play.partySoon)}>
            <PlusIcon />
            {t.play.party}
            <span className="badge">{t.common.soonTag}</span>
          </Button>
        </div>
        <div className="mode-side">
          <TabBar
            className="mode-tabs"
            value={mode}
            onChange={setMode}
            tabs={[
              { id: "trial", label: t.play.modes.trial },
              { id: "single", label: t.play.modes.single },
              { id: "room", label: t.play.modes.room },
              { id: "matchmaking", label: t.play.modes.matchmaking },
            ]}
          />
          {mode === "trial" ? (
            <TrialPanel label={t.play.modes.trial} initial={picks.trial} onChange={pickTrial} />
          ) : (
            <Panel key={mode} className="mode-panel" label={t.play.modes[mode]}>
              <p className="mode-about">{t.play.about[mode]}</p>
              {mode === "single" && <PlanPickers plan={plan} onChange={setPlan} fields="circuit" />}
              {mode === "room" && (
                <>
                  <PlanPickers plan={plan} onChange={setPlan} fields="event" />
                  <Picker
                    label={t.room.bots}
                    options={[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))}
                    value={bots}
                    onChange={setBots}
                  />
                </>
              )}
              {(mode === "single" || mode === "matchmaking") && <Races tilt={mode !== "single" || plan.tilt} />}
              {mode === "room" && (
                <>
                  <p className="muted">{plan.tilt ? t.play.eventAbout.gp : t.play.eventAbout.pick}</p>
                  <Button onClick={() => setJoining(true)}>{t.play.joinRoom}</Button>
                </>
              )}
            </Panel>
          )}
          <footer className="actions">
            <Button onClick={() => setTuning(true)}>
              <SlidersIcon />
              {t.setup.open}
            </Button>
            <Button
              kind="primary"
              glyph="play"
              className="play-button"
              onClick={() => void play()}
              disabled={busy || (mode === "trial" && !trial?.race)}
              autoFocus
            >
              {mode === "room" ? t.play.createRoom : mode === "matchmaking" ? t.play.findRace : t.common.play}
            </Button>
          </footer>
        </div>
      </main>
      <Hints
        items={[
          ["confirm", t.common.select],
          ["play", t.common.play],
          ["prev", t.common.tabs],
          ["back", t.common.back],
        ]}
      />
      {joining && <JoinRoom onClose={() => setJoining(false)} />}
      {searching && <Searching onClose={() => setSearching(false)} />}
      {tuning && <SetupEditor onClose={() => setTuning(false)} />}
    </div>
  );
}

/** A matchmaking race you are still in (you closed its tab): back into it. */
function LiveRace() {
  const t = useT();
  const navigate = useNavigate();
  const { data: live } = useQuery(liveRaceQuery);
  if (!live) return null;
  const rejoin = () => {
    setPendingRace({ ticket: live.ticket, back: { to: "/play", search: { mode: "matchmaking" } }, rejoin: true });
    void navigate({ to: "/race", replace: true });
  };
  return (
    <div className="panel live-race">
      <b>{t.play.liveRace}</b>
      <Button kind="primary" onClick={rejoin} autoFocus>
        {t.room.rejoin}
      </Button>
    </div>
  );
}

/** The sport the club's terrace dresses your rider for: a race on the snow, or the water. */
function clubSport(plan: PlanRequest): "summer" | "winter" {
  if (plan.tilt || plan.race.course === undefined) return "summer";
  return circuit(plan.race.course)?.sport === "snow" ? "winter" : "summer";
}

/** The races a plan runs, in order: a Tilt's seasons (its circuits are drawn), or one race. */
function Races({ tilt }: { tilt: boolean }) {
  const t = useT();
  if (!tilt) return <p className="muted">{t.play.eventAbout.race}</p>;
  // With fewer circuits than seasons, a Tilt is summer on the water, then winter on the mountain.
  const seasons = CIRCUITS.length >= SEASONS.length ? SEASONS : (["summer", "winter"] as const);
  return (
    <div className="races">
      <p className="muted">{t.play.eventAbout.gp}</p>
      <ol>
        {seasons.map((s, i) => (
          <li key={s} className={`season-${s}`}>
            <span className="num">{String(i + 1).padStart(2, "0")}</span>
            <b>{t.seasons[s]}</b>
            <span className="muted">
              {i === 0 || seasonSports(s).length === 1
                ? t.play.seasonSports.water
                : seasons.length < SEASONS.length
                  ? t.play.seasonSports.mountain
                  : t.play.seasonSports.either}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function JoinRoom({ onClose }: { onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    try {
      if (!(await roomExists(c))) {
        setError(t.play.noRoom);
        return;
      }
      await navigate({ to: "/room/$code", params: { code: c } });
    } catch {
      setError(t.common.error);
    }
  };
  return (
    <Modal title={t.play.joinRoom} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          label={t.play.roomCode}
          className="code-input"
          value={code}
          maxLength={6}
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value.toUpperCase().replaceAll(/[^A-Z0-9]/gu, ""))}
          error={error}
          autoFocus
        />
        <div className="row">
          <Button kind="ghost" glyph="back" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" kind="primary" disabled={code.length !== 6}>
            {t.play.join}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** How many times a dropped matchmaking socket comes back before giving up. */
const RECONNECTS = 3;

/** Waiting in the matchmaking queue; the lobby sends a ticket when a race starts. */
function Searching({ onClose }: { onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [status, setStatus] = useState<{ players: number; startsInSecs: number } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const done = useRef(false);
  const onMessage = useEffectEvent((data: unknown) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || !("t" in msg)) return;
    const get = (k: string): unknown => Reflect.get(msg, k);
    setReconnecting(false);
    if (msg.t === "queued") {
      setStatus({ players: Number(get("players")) || 1, startsInSecs: Number(get("startsInSecs")) || 0 });
    } else if (msg.t === "ticket") {
      done.current = true;
      setPendingRace({
        ticket: parseJoinTicket(get("ticket")),
        back: { to: "/play", search: { mode: "matchmaking" } },
      });
      void navigate({ to: "/race", replace: true });
    } else if (msg.t === "error") {
      done.current = true;
      toast(get("error") === "no_server" ? t.common.noServer : t.common.error, "error");
      onClose();
    }
  });
  const giveUp = useEffectEvent((closeCode: number) => {
    done.current = true;
    toast(closeCode === 4000 ? t.play.elsewhere : t.play.lost, "error");
    onClose();
  });
  // A dropped queue socket comes back a few times, waiting longer each time.
  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;
    const connect = () => {
      const ws = lobbySocket("/api/matchmaking/ws");
      socket = ws;
      ws.addEventListener("message", (e) => {
        tries = 0;
        onMessage(e.data);
      });
      ws.addEventListener("close", (e) => {
        if (done.current || socket !== ws) return;
        if (e.code === 4000 || tries >= RECONNECTS) {
          giveUp(e.code);
          return;
        }
        setReconnecting(true);
        timer = setTimeout(
          () => {
            tries++;
            connect();
          },
          500 * 2 ** tries,
        );
      });
    };
    connect();
    return () => {
      done.current = true;
      clearTimeout(timer);
      socket?.close(1000, "left");
    };
  }, []);
  return (
    <Modal
      title={t.play.searching}
      onClose={onClose}
      actions={
        <Button glyph="back" onClick={onClose} autoFocus>
          {t.common.cancel}
        </Button>
      }
    >
      <div className="searching">
        <Spinner />
        {status && !reconnecting ? (
          <div>
            <p>{t.play.queued(status.players)}</p>
            <p className="muted">{t.play.startsIn(status.startsInSecs)}</p>
          </div>
        ) : (
          <p className="muted">{reconnecting ? t.play.reconnecting : t.play.joining}</p>
        )}
      </div>
    </Modal>
  );
}
