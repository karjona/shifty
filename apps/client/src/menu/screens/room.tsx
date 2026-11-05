// A private room at the club: the code to share, who's in, the host's
// settings, ready-up, and the start. The room lives in the lobby; this
// screen is a WebSocket to it.
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { setClubRiders } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { type JoinTicket, parseJoinTicket } from "../../net/transport.ts";
import { type EventChoice, lobbySocket, meQuery, setPendingRace } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { toast } from "../toast.tsx";
import { Button, Hints, Panel, Picker, Spinner } from "../ui.tsx";
import { TopBar } from "./common.tsx";

const route = getRouteApi("/room/$code");
const EVENTS: EventChoice[] = ["gp", "summer", "winter"];

type RoomMessage =
  | { t: "state"; room: RoomState }
  | { t: "ticket"; ticket: JoinTicket }
  | { t: "error"; error: string };

/** A message from the room, checked. */
function parseRoomMessage(data: unknown): RoomMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(String(data));
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null || !("t" in m)) return null;
  const get = (k: string): unknown => Reflect.get(m, k);
  if (m.t === "ticket") return { t: "ticket", ticket: parseJoinTicket(get("ticket")) };
  if (m.t === "error") return { t: "error", error: String(get("error")) };
  if (m.t !== "state") return null;
  const event = get("event");
  const members = get("members");
  const racing = get("racing");
  return {
    t: "state",
    room: {
      code: String(get("code")),
      hostId: String(get("hostId")),
      event: event === "summer" || event === "winter" ? event : "gp",
      bots: Number(get("bots")) || 0,
      members: (Array.isArray(members) ? (members as unknown[]) : []).flatMap((x) =>
        typeof x === "object" && x !== null
          ? [
              {
                userId: String(Reflect.get(x, "userId")),
                handle: String(Reflect.get(x, "handle")),
                ready: Reflect.get(x, "ready") === true,
              },
            ]
          : [],
      ),
      racing: (Array.isArray(racing) ? (racing as unknown[]) : []).map(String),
    },
  };
}

interface RoomState {
  code: string;
  hostId: string;
  event: EventChoice;
  bots: number;
  members: { userId: string; handle: string; ready: boolean }[];
  racing: string[];
}

export function RoomScreen() {
  useBackdrop("club");
  const t = useT();
  const navigate = useNavigate();
  const { code } = route.useParams();
  const me = useSuspenseQuery(meQuery).data?.user.id ?? null;
  const [room, setRoom] = useState<RoomState | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const leaving = useRef(false);
  useAutoFocus();

  const leave = () => {
    leaving.current = true;
    ws.current?.close();
    void navigate({ to: "/play", search: { mode: "room" } });
  };
  useAction("back", leave);

  const onMessage = useEffectEvent((socket: WebSocket, data: unknown) => {
    const m = parseRoomMessage(data);
    if (m?.t === "state") {
      setRoom(m.room);
      setClubRiders(m.room.members.length);
    } else if (m?.t === "ticket") {
      leaving.current = true;
      setPendingRace({ ticket: m.ticket, back: { to: "/room/$code", params: { code } } });
      socket.close();
      void navigate({ to: "/race" });
    } else if (m?.t === "error") {
      const msg =
        m.error === "full"
          ? t.room.full
          : m.error === "not_ready"
            ? t.room.notReadyError
            : m.error === "no_server"
              ? t.common.noServer
              : t.common.error;
      toast(msg, "error");
    }
  });
  const onClose = useEffectEvent((closeCode: number) => {
    if (leaving.current) return;
    toast(closeCode === 4001 ? t.room.full : t.room.gone, "error");
    void navigate({ to: "/play", search: { mode: "room" } });
  });
  useEffect(() => {
    leaving.current = false;
    const socket = lobbySocket(`/api/rooms/${encodeURIComponent(code)}/ws`);
    ws.current = socket;
    socket.addEventListener("message", (e) => onMessage(socket, e.data));
    socket.addEventListener("close", (e) => onClose(e.code));
    return () => {
      leaving.current = true;
      socket.close();
    };
  }, [code]);

  const send = (msg: object) => ws.current?.send(JSON.stringify(msg));
  const host = room !== null && me !== null && room.hostId === me;
  const mine = room?.members.find((m) => m.userId === me);
  const start = () => send({ t: "start" });
  // The ready (or start) button waits for the room; it takes the focus once it's here.
  const loaded = room !== null;
  useEffect(() => {
    if (loaded) document.querySelector<HTMLElement>(".room .actions .btn-primary")?.focus();
  }, [loaded]);
  useAction("play", () => (host ? start() : send({ t: "ready", ready: !mine?.ready })), room !== null);

  return (
    <div className="screen room">
      <TopBar title={t.room.title(code)} kicker={t.play.club} />
      <main className="mode-body">
        <div className="party" aria-hidden="true" />
        <div className="mode-side">
          <Panel className="mode-panel" title={t.room.title(code)}>
            {!room ? (
              <p className="muted">
                <Spinner /> {t.room.connecting}
              </p>
            ) : (
              <>
                <p className="room-code">{code}</p>
                <p className="muted small">{t.room.share}</p>
                <ul className="members">
                  {room.members.map((m) => (
                    <li key={m.userId}>
                      <b>{m.handle}</b>
                      {m.userId === room.hostId ? (
                        <span className="badge">{t.room.host}</span>
                      ) : (
                        <span className={`badge ${m.ready ? "ok" : ""}`}>
                          {m.ready ? t.room.ready : t.room.notReady}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {host ? (
                  <>
                    <Picker<EventChoice>
                      label={t.room.event}
                      options={EVENTS.map((e) => ({ value: e, label: t.play.events[e] }))}
                      value={room.event}
                      onChange={(event) => send({ t: "settings", event, bots: room.bots })}
                    />
                    <Picker
                      label={t.room.bots}
                      options={[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))}
                      value={room.bots}
                      onChange={(bots) => send({ t: "settings", event: room.event, bots })}
                    />
                  </>
                ) : (
                  <p className="muted">
                    {t.play.events[room.event]} · {t.room.bots}: {room.bots}
                    <br />
                    {t.room.waiting}
                  </p>
                )}
                {me && room.racing.includes(me) && (
                  <Button onClick={() => send({ t: "rejoin" })}>{t.room.rejoin}</Button>
                )}
              </>
            )}
          </Panel>
          <footer className="actions">
            <Button kind="ghost" glyph="back" onClick={leave}>
              {t.room.leave}
            </Button>
            {host ? (
              <Button kind="primary" glyph="play" className="play-button big" onClick={start} autoFocus>
                {t.room.start}
              </Button>
            ) : (
              <Button
                kind="primary"
                glyph="play"
                className="play-button big"
                onClick={() => send({ t: "ready", ready: !mine?.ready })}
                disabled={!room}
                autoFocus
              >
                {mine?.ready ? t.room.notReady : t.room.imReady}
              </Button>
            )}
          </footer>
        </div>
      </main>
      <Hints
        items={[
          ["confirm", t.common.select],
          ["play", host ? t.room.start : t.room.ready],
          ["back", t.room.leave],
        ]}
      />
    </div>
  );
}
