// Starting races: pick a race server, record the match (online modes) and
// sign each player's join ticket.
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { type Db, openDb } from "./db/client.ts";
import { match, matchPlayer } from "./db/schema.ts";
import { databaseUrl, type Env } from "./env.ts";
import type { ServerInfo } from "./servers.ts";
import { type RiderClaims, loadRiderClaims } from "./riders.ts";
import { type PlanRequest, TILT } from "@shifty/rider";
import { type JoinTicket, mintTicket, planName, planSeed, roomId } from "./tickets.ts";
import { VERSION } from "./version.ts";

/** Riders in a race; bots fill the seats humans don't take. */
export const FIELD = 8;
export const MAX_HUMANS = 4;

export interface Racer {
  userId: string;
  handle: string;
}

export class NoRaceServer extends Error {
  constructor() {
    super("no race server is available");
  }
}

export async function pickServer(env: Env) {
  const server = await env.SERVERS.get(env.SERVERS.idFromName("all")).pick(VERSION);
  if (!server) throw new NoRaceServer();
  return server;
}

/** A private race against bots: the Tilt, or one race with its circuit and conditions picked or drawn. Not recorded. */
export async function startSingle(env: Env, racer: Racer, plan: PlanRequest): Promise<JoinTicket> {
  const server = await pickServer(env);
  const { db, close } = openDb(databaseUrl(env));
  let rider: RiderClaims | undefined;
  try {
    rider = (await loadRiderClaims(db, [racer.userId])).get(racer.userId);
  } finally {
    await close();
  }
  return mintTicket(env.LOBBY_SIGNING_KEY, {
    server,
    room: roomId("s"),
    pid: racer.userId,
    name: racer.handle,
    plan,
    seed: planSeed(),
    bots: FIELD - 1,
    rider,
    humans: 1,
  });
}

/** A started match: its tickets, and the seed its plan is drawn with (rejoin tickets carry it too). */
export interface Started {
  tickets: Map<string, JoinTicket>;
  seed: number;
}

/** An online race (private room or matchmaking): recorded, results kept. */
export async function startMatch(
  env: Env,
  mode: "room" | "matchmaking",
  plan: PlanRequest,
  racers: Racer[],
  bots: number,
): Promise<Started> {
  const server = await pickServer(env);
  const room = roomId("m");
  const seed = planSeed();
  const { db, close } = openDb(databaseUrl(env));
  let riders: Map<string, RiderClaims>;
  try {
    // Riders and setups are locked for the whole match: rejoins get the same.
    riders = await loadRiderClaims(
      db,
      racers.map((r) => r.userId),
    );
    await db.insert(match).values({ id: room, mode, event: planName(plan), server: server.addr });
    await db.insert(matchPlayer).values(
      racers.map((r) => ({
        matchId: room,
        userId: r.userId,
        look: riders.get(r.userId)?.look ?? null,
        setups: riders.get(r.userId)?.setups ?? null,
      })),
    );
  } finally {
    await close();
  }
  const tickets = new Map<string, JoinTicket>();
  for (const r of racers) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const ticket = await mintTicket(env.LOBBY_SIGNING_KEY, {
      server,
      room,
      pid: r.userId,
      name: r.handle,
      plan,
      seed,
      bots: Math.max(0, Math.min(bots, FIELD - racers.length)),
      rider: riders.get(r.userId),
      humans: racers.length,
    });
    tickets.set(r.userId, ticket);
  }
  return { tickets, seed };
}

/** A matchmaking race counts as under way (and can be rejoined) this long after it started, at most. */
const LIVE_MS = 30 * 60_000;

/**
 * The matchmaking race a player is still in (its plan not over, started
 * lately, its race server up among `servers`), with a ticket back into it.
 * The ticket only seats the player in the race's room if it still runs.
 */
export async function liveMatch(
  db: Db,
  signingKey: string,
  servers: ServerInfo[],
  racer: Racer,
  nowMs = Date.now(),
): Promise<{ match: string; ticket: JoinTicket } | null> {
  const [m] = await db
    .select({ id: match.id, server: match.server, look: matchPlayer.look, setups: matchPlayer.setups })
    .from(match)
    .innerJoin(matchPlayer, and(eq(matchPlayer.matchId, match.id), eq(matchPlayer.userId, racer.userId)))
    .where(and(eq(match.mode, "matchmaking"), isNull(match.endedAt), gt(match.createdAt, new Date(nowMs - LIVE_MS))))
    .orderBy(desc(match.createdAt))
    .limit(1);
  const server = m ? servers.find((s) => s.addr === m.server && !s.draining) : undefined;
  if (!m || !server) return null;
  const [{ humans } = { humans: 1 }] = await db
    .select({ humans: count() })
    .from(matchPlayer)
    .where(eq(matchPlayer.matchId, m.id));
  const ticket = await mintTicket(
    signingKey,
    {
      server: { addr: server.addr, version: server.version, certHashes: server.certHashes },
      room: m.id,
      pid: racer.userId,
      name: racer.handle,
      plan: TILT,
      seed: 0,
      bots: Math.max(0, FIELD - humans),
      rider: { look: m.look ?? "", setups: m.setups ?? [] },
      humans,
      rejoin: true,
    },
    nowMs,
  );
  return { match: m.id, ticket };
}

/** Whether the last race of a match's plan has finished. */
export async function matchEnded(env: Env, matchId: string): Promise<boolean> {
  const { db, close } = openDb(databaseUrl(env));
  try {
    const [row] = await db.select({ endedAt: match.endedAt }).from(match).where(eq(match.id, matchId)).limit(1);
    return row?.endedAt != null;
  } finally {
    await close();
  }
}

/** The rider a player entered a match with (for rejoin tickets). */
export async function matchRider(env: Env, matchId: string, userId: string) {
  const { db, close } = openDb(databaseUrl(env));
  try {
    const [row] = await db
      .select({ look: matchPlayer.look, setups: matchPlayer.setups })
      .from(matchPlayer)
      .where(and(eq(matchPlayer.matchId, matchId), eq(matchPlayer.userId, userId)))
      .limit(1);
    return row ? { look: row.look ?? "", setups: row.setups ?? [] } : undefined;
  } finally {
    await close();
  }
}
