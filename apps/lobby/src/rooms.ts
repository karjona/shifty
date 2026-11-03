// Private rooms: friends gather with a code, the host picks the event and
// the bots, everyone readies up and the host starts the race. One Durable
// Object per code; members are hibernatable WebSockets.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { FIELD, MAX_HUMANS, NoRaceServer, startMatch } from "./matches.ts";
import { type EventChoice, isEventChoice, type JoinTicket, mintTicket } from "./tickets.ts";

export interface RoomSettings {
  code: string;
  hostId: string;
  event: EventChoice;
  bots: number;
  createdAt: number;
  /** The race the room last started, while it may still be running. */
  race: { room: string; server: { addr: string; certHash: string | null }; userIds: string[]; at: number } | null;
}

interface Member {
  userId: string;
  handle: string;
  ready: boolean;
  joinedAt: number;
}

export type RoomClientMsg =
  | { t: "settings"; event: EventChoice; bots: number }
  | { t: "ready"; ready: boolean }
  | { t: "start" }
  | { t: "rejoin" };

export type RoomServerMsg =
  | {
      t: "state";
      code: string;
      hostId: string;
      event: EventChoice;
      bots: number;
      members: { userId: string; handle: string; ready: boolean }[];
      racing: string[];
    }
  | { t: "ticket"; ticket: JoinTicket }
  | { t: "error"; error: "not_host" | "not_ready" | "no_server" | "full" | "bad_message" };

/** Codes avoid look-alikes (0/O, 1/I). */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export const isRoomCode = (s: string) => s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));

export function newRoomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** An abandoned room is forgotten after this long. */
const EMPTY_TTL_MS = 10 * 60_000;
/** A started race counts as running (members can rejoin it) this long. */
const RACE_TTL_MS = 30 * 60_000;

const clampBots = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(FIELD - 1, Math.round(n))) : 3);

export class RoomLobby extends DurableObject<Env> {
  private settings: RoomSettings | null | undefined;

  private async load(): Promise<RoomSettings | null> {
    if (this.settings === undefined) this.settings = (await this.ctx.storage.get<RoomSettings>("settings")) ?? null;
    return this.settings;
  }

  private async save(s: RoomSettings): Promise<void> {
    this.settings = s;
    await this.ctx.storage.put("settings", s);
  }

  /** Creates the room; false if the code is already in use. */
  async create(code: string, hostId: string, event: EventChoice, bots: number): Promise<boolean> {
    if (await this.load()) return false;
    await this.save({ code, hostId, event, bots: clampBots(bots), createdAt: Date.now(), race: null });
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
    return true;
  }

  async exists(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  private sockets(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  private members(except?: WebSocket): Member[] {
    return this.sockets(except)
      .map((ws) => ws.deserializeAttachment() as Member)
      .toSorted((a, b) => a.joinedAt - b.joinedAt);
  }

  override async fetch(request: Request): Promise<Response> {
    const s = await this.load();
    if (!s) return new Response("no such room", { status: 404 });
    const userId = request.headers.get("x-shifty-user");
    const handle = decodeURIComponent(request.headers.get("x-shifty-handle") ?? "");
    if (!userId || !handle) return new Response("unauthorized", { status: 401 });
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // A second tab replaces the first.
    let joinedAt = Date.now();
    for (const ws of this.sockets()) {
      const m = ws.deserializeAttachment() as Member;
      if (m.userId === userId) {
        joinedAt = m.joinedAt;
        ws.close(4000, "replaced");
      }
    }
    const others = this.members().filter((m) => m.userId !== userId);
    this.ctx.acceptWebSocket(server);
    if (others.length >= MAX_HUMANS) {
      server.send(JSON.stringify({ t: "error", error: "full" } satisfies RoomServerMsg));
      server.close(4001, "room is full");
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ userId, handle, ready: false, joinedAt } satisfies Member);
    if (!others.some((m) => m.userId === s.hostId) && s.hostId !== userId && others.length === 0) {
      // Everyone left and someone came back: they host now.
      await this.save({ ...s, hostId: userId });
    }
    await this.ctx.storage.deleteAlarm();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(except?: WebSocket): void {
    const s = this.settings;
    if (!s) return;
    const race = s.race && Date.now() - s.race.at < RACE_TTL_MS ? s.race.userIds : [];
    const msg: RoomServerMsg = {
      t: "state",
      code: s.code,
      hostId: s.hostId,
      event: s.event,
      bots: s.bots,
      members: this.members(except).map(({ userId, handle, ready }) => ({ userId, handle, ready })),
      racing: race,
    };
    const text = JSON.stringify(msg);
    for (const ws of this.sockets(except)) ws.send(text);
  }

  private send(ws: WebSocket, msg: RoomServerMsg): void {
    ws.send(JSON.stringify(msg));
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const s = await this.load();
    if (!s || typeof data !== "string" || data.length > 1024) return;
    const me = ws.deserializeAttachment() as Member;
    let msg: RoomClientMsg;
    try {
      msg = JSON.parse(data) as RoomClientMsg;
    } catch {
      this.send(ws, { t: "error", error: "bad_message" });
      return;
    }
    const isHost = me.userId === s.hostId;
    switch (msg.t) {
      case "settings": {
        if (!isHost) return this.send(ws, { t: "error", error: "not_host" });
        if (!isEventChoice(msg.event)) return this.send(ws, { t: "error", error: "bad_message" });
        await this.save({ ...s, event: msg.event, bots: clampBots(msg.bots) });
        // New settings: everyone confirms again.
        for (const other of this.sockets()) {
          const m = other.deserializeAttachment() as Member;
          other.serializeAttachment({ ...m, ready: false });
        }
        break;
      }
      case "ready":
        ws.serializeAttachment({ ...me, ready: msg.ready === true });
        break;
      case "start":
        await this.start(ws, me, s);
        return;
      case "rejoin": {
        const race = s.race;
        if (!race || Date.now() - race.at > RACE_TTL_MS || !race.userIds.includes(me.userId)) return;
        const ticket = await mintTicket(this.env.LOBBY_SIGNING_KEY, {
          server: race.server,
          room: race.room,
          pid: me.userId,
          name: me.handle,
          event: s.event,
          bots: s.bots,
        });
        return this.send(ws, { t: "ticket", ticket });
      }
      default:
        return this.send(ws, { t: "error", error: "bad_message" });
    }
    this.broadcast();
  }

  private async start(ws: WebSocket, me: Member, s: RoomSettings): Promise<void> {
    if (me.userId !== s.hostId) return this.send(ws, { t: "error", error: "not_host" });
    const members = this.members();
    if (members.some((m) => m.userId !== s.hostId && !m.ready)) return this.send(ws, { t: "error", error: "not_ready" });
    let tickets: Map<string, JoinTicket>;
    try {
      tickets = await startMatch(
        this.env,
        "room",
        s.event,
        members.map((m) => ({ userId: m.userId, handle: m.handle })),
        s.bots,
      );
    } catch (e) {
      if (e instanceof NoRaceServer) return this.send(ws, { t: "error", error: "no_server" });
      throw e;
    }
    const first = tickets.values().next().value;
    if (!first) return;
    const server = { addr: new URL(first.webTransportUrl).host, certHash: first.certHash };
    await this.save({ ...s, race: { room: first.room, server, userIds: [...tickets.keys()], at: Date.now() } });
    for (const sock of this.sockets()) {
      const m = sock.deserializeAttachment() as Member;
      sock.serializeAttachment({ ...m, ready: false });
      const ticket = tickets.get(m.userId);
      if (ticket) this.send(sock, { t: "ticket", ticket });
    }
    this.broadcast();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const s = await this.load();
    if (!s) return;
    const left = ws.deserializeAttachment() as Member | null;
    const rest = this.members(ws);
    if (left && left.userId === s.hostId && rest.length > 0 && !rest.some((m) => m.userId === s.hostId)) {
      await this.save({ ...s, hostId: rest[0]!.userId });
    }
    if (rest.length === 0) await this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
    this.broadcast(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    if (this.sockets().length > 0) return;
    this.settings = null;
    await this.ctx.storage.deleteAll();
  }
}
