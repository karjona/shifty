// A private room at the club: the code to share, who's in, the host's
// settings, ready-up, and the start. The room lives in the lobby; this
// screen is a WebSocket to it.
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { setClubRiders } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { type JoinTicket, parseJoinTicket } from "../../net/transport.ts";
import { type PlanRequest, TILT, parsePlan } from "@shifty/rider";
import { lobbySocket, meQuery, roomExists, setPendingRace } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { toast } from "../toast.tsx";
import { PlanPickers, PlanRows } from "../plan.tsx";
import { Button, Handle, Hints, Panel, Picker } from "../ui.tsx";
import { useLoading } from "../busy.tsx";
import { TopBar } from "./common.tsx";

const route = getRouteApi("/room/$code");
/** How many times a dropped room socket comes back before giving up. */
const RECONNECTS = 4;

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
  const members = get("members");
  const racing = get("racing");
  return {
    t: "state",
    room: {
      code: String(get("code")),
      hostId: String(get("hostId")),
      plan: parsePlan(get("plan")) ?? TILT,
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
  plan: PlanRequest;
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
  const queryClient = useQueryClient();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const leaving = useRef(false);
  useAutoFocus();
  useLoading(room === null || reconnecting, reconnecting ? t.room.reconnecting : t.room.connecting);

  const leave = () => {
    leaving.current = true;
    ws.current?.close();
    void navigate({ to: "/play", search: { mode: "room" } });
  };
  useAction("back", leave);

  // Whether you were ready when the socket dropped: a reconnect says so again.
  const ready = useRef<{ was: boolean; back: boolean }>({ was: false, back: false });
  const onMessage = useEffectEvent((socket: WebSocket, data: unknown) => {
    const m = parseRoomMessage(data);
    if (m?.t === "state") {
      const mineNow = m.room.members.find((x) => x.userId === me);
      if (ready.current.back && ready.current.was && mineNow && !mineNow.ready && m.room.hostId !== me) {
        socket.send(JSON.stringify({ t: "ready", ready: true }));
      }
      ready.current = { was: mineNow?.ready ?? false, back: false };
      setRoom(m.room);
      setClubRiders(m.room.members.length);
    } else if (m?.t === "ticket") {
      leaving.current = true;
      setPendingRace({ ticket: m.ticket, back: { to: "/room/$code", params: { code } } });
      socket.close();
      void navigate({ to: "/race", replace: true });
    } else if (m?.t === "error") {
      const msg =
        m.error === "full"
          ? t.room.full
          : m.error === "not_ready"
            ? t.room.notReadyError
            : m.error === "no_server"
              ? t.common.noServer
              : m.error === "over"
                ? t.room.raceOver
                : t.common.error;
      toast(msg, "error");
    }
  });
  const giveUp = useEffectEvent((closeCode: number, gone: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    const why =
      closeCode === 4001 ? t.room.full : closeCode === 4000 ? t.room.elsewhere : gone ? t.room.gone : t.room.lost;
    toast(why, "error");
    void navigate({ to: "/play", search: { mode: "room" } });
  });
  const checkSession = useEffectEvent(() => void queryClient.refetchQueries({ queryKey: meQuery.queryKey }));
  // A dropped socket comes back a few times, waiting longer each time, while the room still exists.
  useEffect(() => {
    leaving.current = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const socket = lobbySocket(`/api/rooms/${encodeURIComponent(code)}/ws`);
      ws.current = socket;
      socket.addEventListener("message", (e) => {
        tries = 0;
        setReconnecting(false);
        onMessage(socket, e.data);
      });
      socket.addEventListener("close", (e) => {
        if (leaving.current || ws.current !== socket) return;
        if (e.code === 4000 || e.code === 4001 || tries >= RECONNECTS) {
          giveUp(e.code, false);
          return;
        }
        setReconnecting(true);
        ready.current.back = true;
        checkSession();
        timer = setTimeout(
          () =>
            void roomExists(code).then(
              (exists) => {
                if (leaving.current) return;
                if (exists) {
                  tries++;
                  connect();
                } else {
                  giveUp(e.code, true);
                }
              },
              () => {
                if (leaving.current) return;
                tries++;
                connect();
              },
            ),
          500 * 2 ** tries,
        );
      });
    };
    connect();
    return () => {
      leaving.current = true;
      clearTimeout(timer);
      ws.current?.close();
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
          <Panel className="mode-panel" label={t.room.title(code)}>
            <p className="room-code">{code}</p>
            <p className="muted small">{t.room.share}</p>
            {room && (
              <>
                <ul className="members">
                  {room.members.map((m) => (
                    <li key={m.userId} className={m.userId === me ? "me" : undefined}>
                      <Handle handle={m.handle} />
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
                    <PlanPickers
                      plan={room.plan}
                      onChange={(plan) => send({ t: "settings", plan, bots: room.bots })}
                      fields="all"
                    />
                    <Picker
                      label={t.room.bots}
                      options={[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))}
                      value={room.bots}
                      onChange={(bots) => send({ t: "settings", plan: room.plan, bots })}
                    />
                  </>
                ) : (
                  <>
                    <PlanRows plan={room.plan} bots={room.bots} />
                    <p className="muted">{t.room.waiting}</p>
                  </>
                )}
                {me && room.racing.includes(me) && (
                  <Button onClick={() => send({ t: "rejoin" })}>{t.room.rejoin}</Button>
                )}
              </>
            )}
          </Panel>
          <footer className="actions">
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
                {mine?.ready ? t.room.notYet : t.room.imReady}
              </Button>
            )}
          </footer>
        </div>
      </main>
      <Hints
        items={[
          ["confirm", t.common.select],
          ["play", host ? t.room.start : mine?.ready ? t.room.notYet : t.room.imReady],
          ["back", t.room.leave],
        ]}
      />
    </div>
  );
}
