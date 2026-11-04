// Mode select, at the country club: time trial and single player (solo),
// rooms and matchmaking (online). Your rider stands on the terrace; party
// members will join you there.
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { setClubRider, setClubRiders } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { parseJoinTicket } from "../../net/transport.ts";
import {
  ApiError,
  createRoom,
  type EventChoice,
  lobbySocket,
  meQuery,
  type Mode,
  playSingle,
  roomExists,
  setPendingRace,
} from "../api.ts";
import { PlusIcon } from "../icons.tsx";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { toast } from "../toast.tsx";
import { Button, Hints, Modal, Panel, Picker, Spinner, TabBar, TextField } from "../ui.tsx";
import { TopBar } from "./common.tsx";
import { SetupEditor } from "./setup.tsx";

export type { Mode };
const route = getRouteApi("/play");
const EVENTS: EventChoice[] = ["gp", "summer", "winter"];

export function ModeSelect() {
  useBackdrop("club");
  const t = useT();
  const navigate = useNavigate();
  const { mode = "single" } = route.useSearch();
  const [event, setEvent] = useState<EventChoice>("gp");
  const [bots, setBots] = useState(3);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [searching, setSearching] = useState(false);
  const [tuning, setTuning] = useState(false);
  const { data: me } = useSuspenseQuery(meQuery);
  const appearance = me?.rider?.appearance ?? null;
  useEffect(() => setClubRiders(1), []);
  useEffect(() => {
    if (appearance) setClubRider(appearance, event === "winter" ? "winter" : "summer");
  }, [appearance, event]);
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
        const ticket = await playSingle(event);
        setPendingRace({ ticket, back: { to: "/play", search: { mode: "single" } } });
        await navigate({ to: "/race" });
      } else {
        const code = await createRoom(event, bots);
        await navigate({ to: "/room/$code", params: { code } });
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  useAction("play", () => void play(), !joining && !searching);

  const eventPicker = (
    <Picker<EventChoice>
      label={t.room.event}
      options={EVENTS.map((e) => ({ value: e, label: t.play.events[e] }))}
      value={event}
      onChange={setEvent}
    />
  );

  return (
    <div className="screen mode-select">
      <TopBar>
        <h1 className="screen-title">{t.play.title}</h1>
      </TopBar>
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
      <main className="mode-body">
        <div className="party">
          <Button kind="ghost" className="party-add" onClick={() => toast(t.play.partySoon)}>
            <PlusIcon />
            {t.play.party}
          </Button>
        </div>
        <Panel className="mode-panel" title={t.play.modes[mode]}>
          <p className="muted">{t.play.about[mode]}</p>
          {mode === "trial" && <p className="soon-badge">{t.common.soon}</p>}
          {mode === "single" && (
            <>
              {eventPicker}
              <p className="muted small">{t.play.eventAbout[event]}</p>
            </>
          )}
          {mode === "room" && (
            <>
              {eventPicker}
              <Picker
                label={t.room.bots}
                options={[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))}
                value={bots}
                onChange={setBots}
              />
              <Button onClick={() => setJoining(true)}>{t.play.joinRoom}</Button>
            </>
          )}
          {mode === "matchmaking" && <p className="muted small">{t.play.eventAbout.gp}</p>}
        </Panel>
      </main>
      <footer className="mode-footer">
        <Button onClick={() => setTuning(true)}>{t.setup.open}</Button>
        <Button
          kind="primary"
          glyph="play"
          className="play-button big"
          onClick={() => void play()}
          disabled={busy || mode === "trial"}
          autoFocus
        >
          {mode === "room" ? t.play.createRoom : mode === "matchmaking" ? t.play.findRace : t.common.play}
        </Button>
      </footer>
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
