// Starting races: pick a race server, record the match (online modes) and
// sign each player's join ticket.
import { and, eq } from "drizzle-orm";
import { openDb } from "./db/client.ts";
import { match, matchPlayer } from "./db/schema.ts";
import { databaseUrl, type Env } from "./env.ts";
import { type RiderClaims, loadRiderClaims } from "./riders.ts";
import { type EventChoice, type JoinTicket, mintTicket, roomId } from "./tickets.ts";
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

/** A private race against bots. Not recorded. */
export async function startSingle(env: Env, racer: Racer, event: EventChoice): Promise<JoinTicket> {
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
    event,
    bots: FIELD - 1,
    rider,
  });
}

/** An online race (private room or matchmaking): recorded, results kept. */
export async function startMatch(
  env: Env,
  mode: "room" | "matchmaking",
  event: EventChoice,
  racers: Racer[],
  bots: number,
): Promise<Map<string, JoinTicket>> {
  const server = await pickServer(env);
  const room = roomId("m");
  const { db, close } = openDb(databaseUrl(env));
  let riders: Map<string, RiderClaims>;
  try {
    // Riders and setups are locked for the whole match: rejoins get the same.
    riders = await loadRiderClaims(
      db,
      racers.map((r) => r.userId),
    );
    await db.insert(match).values({ id: room, mode, event, server: server.addr });
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
      event,
      bots: Math.max(0, Math.min(bots, FIELD - racers.length)),
      rider: riders.get(r.userId),
    });
    tickets.set(r.userId, ticket);
  }
  return tickets;
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
