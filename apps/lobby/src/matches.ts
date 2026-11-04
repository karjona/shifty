// Starting races: pick a race server, record the match (online modes) and
// sign each player's join ticket.
import { openDb } from "./db/client.ts";
import { match, matchPlayer } from "./db/schema.ts";
import { databaseUrl, type Env } from "./env.ts";
import { type EventChoice, type JoinTicket, mintTicket, roomId } from "./tickets.ts";

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
  const server = await env.SERVERS.get(env.SERVERS.idFromName("all")).pick();
  if (!server) throw new NoRaceServer();
  return server;
}

/** A private race against bots. Not recorded. */
export async function startSingle(env: Env, racer: Racer, event: EventChoice): Promise<JoinTicket> {
  const server = await pickServer(env);
  return mintTicket(env.LOBBY_SIGNING_KEY, {
    server,
    room: roomId("s"),
    pid: racer.userId,
    name: racer.handle,
    event,
    bots: FIELD - 1,
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
  try {
    await db.insert(match).values({ id: room, mode, event, server: server.addr });
    await db.insert(matchPlayer).values(racers.map((r) => ({ matchId: room, userId: r.userId })));
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
    });
    tickets.set(r.userId, ticket);
  }
  return tickets;
}
