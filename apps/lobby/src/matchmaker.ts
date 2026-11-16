// Matchmaking for the Tilt: players queue over a WebSocket; a race
// starts as soon as four are waiting, or when the first in line has waited
// long enough (bots fill the empty seats). One instance (named "gp").
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { isRecord } from "./json.ts";
import { FIELD, MAX_HUMANS, NoRaceServer, startMatch } from "./matches.ts";
import { TILT } from "@shifty/rider";
import type { JoinTicket } from "./tickets.ts";
import { type Away, QUEUE_AWAY_MS, closedOnPurpose, goneAway, keptFor, stillAway } from "./away.ts";

interface Queued {
  userId: string;
  handle: string;
  since: number;
}

export type MatchServerMsg =
  | { t: "queued"; players: number; waitedSecs: number; startsInSecs: number }
  | { t: "ticket"; ticket: JoinTicket }
  | { t: "error"; error: "no_server" };

const DEFAULT_WAIT_SECS = 20;

function queuedOf(ws: WebSocket): Queued | null {
  const q: unknown = ws.deserializeAttachment();
  return isRecord(q) && typeof q.userId === "string" && typeof q.handle === "string" && typeof q.since === "number"
    ? { userId: q.userId, handle: q.handle, since: q.since }
    : null;
}
const TICK_MS = 1000;

export class Matchmaker extends DurableObject<Env> {
  /** A tick is starting races (awaiting the database): don't start them twice. */
  private ticking = false;

  private waitMs(): number {
    const secs = Number(this.env.MATCH_WAIT_SECS ?? DEFAULT_WAIT_SECS);
    return (Number.isFinite(secs) && secs >= 0 ? secs : DEFAULT_WAIT_SECS) * 1000;
  }

  private queue(except?: WebSocket): { ws: WebSocket; q: Queued }[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .flatMap((ws) => {
        const q = queuedOf(ws);
        return q ? [{ ws, q }] : [];
      })
      .toSorted((a, b) => a.q.since - b.q.since);
  }

  override async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get("x-shifty-user");
    const handle = decodeURIComponent(request.headers.get("x-shifty-handle") ?? "");
    if (!userId || !handle) return new Response("unauthorized", { status: 401 });
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const pair = new WebSocketPair();
    const now = Date.now();
    // Back within the grace of a drop: their place in line, as it was.
    const dropped = await this.dropped();
    let since = keptFor(dropped, userId, now, QUEUE_AWAY_MS) ?? now;
    await this.ctx.storage.put(
      "dropped",
      dropped.filter((d) => d.userId !== userId),
    );
    for (const { ws, q } of this.queue()) {
      if (q.userId === userId) {
        since = q.since;
        ws.close(4000, "replaced");
      }
    }
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ userId, handle, since } satisfies Queued);
    await this.tick();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Starts every race it can, tells the rest how long they wait. */
  private async tick(): Promise<void> {
    if (this.ticking) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      return;
    }
    this.ticking = true;
    try {
      await this.matchUp();
    } finally {
      this.ticking = false;
    }
  }

  private async matchUp(): Promise<void> {
    const now = Date.now();
    let queue = this.queue();
    while (queue.length > 0) {
      const full = queue.length >= MAX_HUMANS;
      const waited = now - queue[0]!.q.since >= this.waitMs();
      if (!full && !waited) break;
      const group = queue.slice(0, MAX_HUMANS);
      queue = queue.slice(group.length);
      // oxlint-disable-next-line eslint/no-await-in-loop
      await this.startRace(group);
    }
    for (const { ws, q } of queue) {
      const msg: MatchServerMsg = {
        t: "queued",
        players: queue.length,
        waitedSecs: Math.floor((now - q.since) / 1000),
        startsInSecs: Math.max(0, Math.ceil((queue[0]!.q.since + this.waitMs() - now) / 1000)),
      };
      ws.send(JSON.stringify(msg));
    }
    if (queue.length > 0) await this.ctx.storage.setAlarm(now + TICK_MS);
  }

  private async startRace(group: { ws: WebSocket; q: Queued }[]): Promise<void> {
    let tickets: Map<string, JoinTicket>;
    try {
      ({ tickets } = await startMatch(
        this.env,
        "matchmaking",
        TILT,
        group.map(({ q }) => ({ userId: q.userId, handle: q.handle })),
        FIELD,
      ));
    } catch (e) {
      if (!(e instanceof NoRaceServer)) throw e;
      for (const { ws } of group) {
        ws.send(JSON.stringify({ t: "error", error: "no_server" } satisfies MatchServerMsg));
        ws.close(4002, "no race server");
      }
      return;
    }
    for (const { ws, q } of group) {
      const ticket = tickets.get(q.userId);
      if (ticket) ws.send(JSON.stringify({ t: "ticket", ticket } satisfies MatchServerMsg));
      ws.close(1000, "matched");
    }
  }

  override async alarm(): Promise<void> {
    await this.tick();
  }

  override async webSocketMessage(): Promise<void> {
    // Nothing to say while queued; the socket only has to stay open.
  }

  /** Players whose socket dropped, with their place in line, kept a while (see away.ts). */
  private async dropped(): Promise<Away<number>[]> {
    const list = (await this.ctx.storage.get<Away<number>[]>("dropped")) ?? [];
    const queued = new Set(this.queue().map(({ q }) => q.userId));
    return stillAway(list, queued, Date.now(), QUEUE_AWAY_MS);
  }

  override async webSocketClose(ws: WebSocket, code = 1006): Promise<void> {
    // A drop (not a cancel, nor a match) keeps their place a while for their screen to come back.
    const q = queuedOf(ws);
    if (q && !closedOnPurpose(code) && !this.queue(ws).some((o) => o.q.userId === q.userId)) {
      await this.ctx.storage.put("dropped", goneAway(await this.dropped(), q.userId, q.since, Date.now()));
    }
    // Leaving the queue: the others' wait doesn't change.
    if (this.queue(ws).length === 0) await this.ctx.storage.deleteAlarm();
  }
}
