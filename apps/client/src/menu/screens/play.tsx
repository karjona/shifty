// Mode select, at the country club: time trial and single player (solo),
// rooms and matchmaking (online). Your rider stands on the terrace; party
// members will join you there.
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { setClubRider, setClubRiders } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { parseJoinTicket } from "../../net/transport.ts";
import { CIRCUITS, type PlanRequest, SEASONS, TILT, circuit } from "@shifty/rider";
import {
  ApiError,
  createRoom,
  lobbySocket,
  meQuery,
  type Mode,
  playSingle,
  roomExists,
  setPendingRace,
} from "../api.ts";
import { PlusIcon, SlidersIcon } from "../icons.tsx";
import { PlanPickers, seasonSports } from "../plan.tsx";
import { useLoading } from "../busy.tsx";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { toast } from "../toast.tsx";
import { Button, Hints, Modal, Panel, Picker, Spinner, TabBar, TextField } from "../ui.tsx";
import { TopBar } from "./common.tsx";
import { SetupEditor } from "./setup.tsx";

export type { Mode };
const route = getRouteApi("/play");
export function ModeSelect() {
  useBackdrop("club");
  const t = useT();
  const navigate = useNavigate();
  const { mode = "single" } = route.useSearch();
  const [plan, setPlan] = useState<PlanRequest>(TILT);
  const [bots, setBots] = useState(3);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [searching, setSearching] = useState(false);
  const [tuning, setTuning] = useState(false);
  useLoading(busy);
  const { data: me } = useSuspenseQuery(meQuery);
  const appearance = me?.rider?.appearance ?? null;
  useEffect(() => setClubRiders(1), []);
  useEffect(() => {
    if (appearance) setClubRider(appearance, clubSport(plan));
  }, [appearance, plan]);
  useAutoFocus();
  useAction("back", () => void navigate({ to: "/" }), !joining && !searching && !tuning);

  const setMode = (m: Mode) => void navigate({ to: "/play", search: { mode: m }, replace: true });

  const fail = (e: unknown) => {
    toast(e instanceof ApiError && e.code === "no_server" ? t.common.noServer : t.common.error, "error");
  };

  const play = async () => {
    if (busy) return;
    if (mode === "trial") {
      toast(t.common.soon);
      return;
    }
    if (mode === "matchmaking") {
      setSearching(true);
      return;
    }
    setBusy(true);
    try {
      if (mode === "single") {
        const ticket = await playSingle(plan);
        setPendingRace({ ticket, back: { to: "/play", search: { mode: "single" } } });
        await navigate({ to: "/race" });
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
              { id: "trial", label: t.play.modes.trial, tag: t.common.soonTag },
              { id: "single", label: t.play.modes.single },
              { id: "room", label: t.play.modes.room },
              { id: "matchmaking", label: t.play.modes.matchmaking },
            ]}
          />
          <Panel key={mode} className="mode-panel" title={t.play.modes[mode]}>
            <p>{t.play.about[mode]}</p>
            {mode === "single" && <PlanPickers plan={plan} onChange={setPlan} full={false} />}
            {mode === "room" && (
              <>
                <PlanPickers plan={plan} onChange={setPlan} full={false} />
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
              disabled={busy || mode === "trial"}
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
          <li key={s}>
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
      <form className="stack" onSubmit={(e) => void submit(e)}>
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

/** Waiting in the matchmaking queue; the lobby sends a ticket when a race starts. */
function Searching({ onClose }: { onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [status, setStatus] = useState<{ players: number; startsInSecs: number } | null>(null);
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
    if (msg.t === "queued") {
      setStatus({ players: Number(get("players")) || 1, startsInSecs: Number(get("startsInSecs")) || 0 });
    } else if (msg.t === "ticket") {
      done.current = true;
      setPendingRace({
        ticket: parseJoinTicket(get("ticket")),
        back: { to: "/play", search: { mode: "matchmaking" } },
      });
      void navigate({ to: "/race" });
    } else if (msg.t === "error") {
      done.current = true;
      toast(get("error") === "no_server" ? t.common.noServer : t.common.error, "error");
      onClose();
    }
  });
  const onSocketClose = useEffectEvent(() => {
    if (!done.current) onClose();
  });
  useEffect(() => {
    const ws = lobbySocket("/api/matchmaking/ws");
    ws.addEventListener("message", (e) => onMessage(e.data));
    ws.addEventListener("close", () => onSocketClose());
    return () => {
      done.current = true;
      ws.close();
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
        {status && (
          <div>
            <p>{t.play.queued(status.players)}</p>
            <p className="muted">{t.play.startsIn(status.startsInSecs)}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
