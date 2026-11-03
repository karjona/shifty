// The lobby Worker: accounts (Better Auth), player profiles, menu content,
// and starting races (single player, private rooms, matchmaking). Race
// servers report in here too (heartbeats, results).
import { Hono, type Context } from "hono";
import { type Auth, createAuth } from "./auth.ts";
import { menuContent } from "./content.ts";
import { type Db, openDb } from "./db/client.ts";
import { databaseUrl, type Env } from "./env.ts";
import { isLocale, pickLocale } from "./locale.ts";
import { devMailbox } from "./mail.ts";
import { NoRaceServer, startSingle } from "./matches.ts";
import { CARDS, type Card, claimHandle, getPlayer, setCard, TITLES, type Title, view } from "./players.ts";
import { parseReport, storeReport } from "./results.ts";
import { isRoomCode, newRoomCode } from "./rooms.ts";
import type { ServerInfo } from "./servers.ts";
import { isEventChoice } from "./tickets.ts";

export { Matchmaker } from "./matchmaker.ts";
export { RoomLobby } from "./rooms.ts";
export { ServerRegistry } from "./servers.ts";

type App = { Bindings: Env; Variables: { db: Db; auth: Auth } };
type Ctx = Context<App>;

const app = new Hono<App>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal" }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Race servers authenticate with the shared secret, not a session.
const raceServer = async (c: Ctx): Promise<boolean> => {
  const got = new TextEncoder().encode(c.req.header("authorization") ?? "");
  const want = new TextEncoder().encode(`Bearer ${c.env.RACE_SERVER_SECRET}`);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
};

app.post("/api/servers/heartbeat", async (c) => {
  if (!(await raceServer(c))) return c.json({ error: "unauthorized" }, 401);
  const b: unknown = await c.req.json().catch(() => null);
  if (typeof b !== "object" || b === null) return c.json({ error: "bad_request" }, 400);
  const o = b as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  if (typeof o.addr !== "string" || !/^[\w.[\]:-]{1,255}$/u.test(o.addr)) return c.json({ error: "bad_addr" }, 400);
  const info: ServerInfo = {
    addr: o.addr,
    region: typeof o.region === "string" ? o.region.slice(0, 32) : "unknown",
    certHash: typeof o.certHash === "string" ? o.certHash.slice(0, 64) : null,
    rooms: num(o.rooms),
    humans: num(o.humans),
    draining: o.draining === true,
  };
  await c.env.SERVERS.get(c.env.SERVERS.idFromName("all")).heartbeat(info);
  return c.json({ ok: true });
});

// Everything below talks to Postgres: one pool per request.
app.use("/api/*", async (c, next) => {
  const { db, close } = openDb(databaseUrl(c.env));
  c.set("db", db);
  c.set("auth", createAuth(c.env, db, (p) => c.executionCtx.waitUntil(p)));
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

app.post("/api/servers/results", async (c) => {
  if (!(await raceServer(c))) return c.json({ error: "unauthorized" }, 401);
  const report = parseReport(await c.req.json().catch(() => null));
  if (!report) return c.json({ error: "bad_request" }, 400);
  return c.json({ stored: await storeReport(c.var.db, report) });
});

app.on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// Our own endpoints only take requests from the game's own pages.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  const unsafe = c.req.method !== "GET" || c.req.header("upgrade") === "websocket";
  if (unsafe && origin !== new URL(c.env.BETTER_AUTH_URL).origin) return c.json({ error: "bad_origin" }, 403);
  await next();
});

const session = (c: Ctx) => c.var.auth.api.getSession({ headers: c.req.raw.headers });

/** The signed-in player with a handle, or an error response. */
async function requirePlayer(c: Ctx) {
  const s = await session(c);
  if (!s) return { error: c.json({ error: "unauthorized" }, 401) } as const;
  const row = await getPlayer(c.var.db, s.user.id);
  if (!row) return { error: c.json({ error: "no_handle" }, 409) } as const;
  return { user: s.user, player: view(row) } as const;
}

app.get("/api/me", async (c) => {
  const s = await session(c);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  const row = await getPlayer(c.var.db, s.user.id);
  return c.json({
    user: { id: s.user.id, email: s.user.email, image: s.user.image ?? null, name: s.user.name },
    player: row ? view(row) : null,
  });
});

app.post("/api/me/handle", async (c) => {
  const s = await session(c);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  const body: unknown = await c.req.json().catch(() => null);
  const name = typeof body === "object" && body !== null ? (body as { name?: unknown }).name : null;
  if (typeof name !== "string" || name.length > 200) return c.json({ error: "chars" }, 400);
  const res = await claimHandle(c.var.db, s.user.id, name);
  if (!res.ok) return c.json({ error: res.problem }, res.problem === "cooldown" ? 429 : 400);
  return c.json({ player: view(res.player) });
});

app.patch("/api/me/card", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const body = (await c.req.json().catch(() => null)) as { title?: unknown; card?: unknown } | null;
  const title = body?.title ?? p.player.title;
  const card = body?.card ?? p.player.card;
  if (!TITLES.includes(title as Title) || !CARDS.includes(card as Card)) return c.json({ error: "bad_request" }, 400);
  const row = await setCard(c.var.db, p.user.id, title as Title, card as Card);
  return row ? c.json({ player: view(row) }) : c.json({ error: "no_handle" }, 409);
});

app.get("/api/content", async (c) => {
  const q = c.req.query("locale");
  const locale = isLocale(q) ? q : pickLocale(c.req.header("accept-language"));
  const content = await menuContent(c.var.db, locale);
  c.header("cache-control", "public, max-age=60");
  return c.json({ locale, ...content });
});

app.post("/api/play/single", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const body = (await c.req.json().catch(() => null)) as { event?: unknown } | null;
  const event = body?.event ?? "gp";
  if (!isEventChoice(event)) return c.json({ error: "bad_request" }, 400);
  try {
    const ticket = await startSingle(c.env, { userId: p.user.id, handle: p.player.handle }, event);
    return c.json({ ticket });
  } catch (e) {
    if (e instanceof NoRaceServer) return c.json({ error: "no_server" }, 503);
    throw e;
  }
});

app.post("/api/rooms", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const body = (await c.req.json().catch(() => null)) as { event?: unknown; bots?: unknown } | null;
  const event = body?.event ?? "gp";
  const bots = typeof body?.bots === "number" ? body.bots : 3;
  if (!isEventChoice(event)) return c.json({ error: "bad_request" }, 400);
  for (let i = 0; i < 8; i++) {
    const code = newRoomCode();
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (await c.env.ROOMS.get(c.env.ROOMS.idFromName(code)).create(code, p.user.id, event, bots)) {
      return c.json({ code });
    }
  }
  return c.json({ error: "internal" }, 500);
});

app.get("/api/rooms/:code", async (c) => {
  const code = c.req.param("code").toUpperCase();
  if (!isRoomCode(code)) return c.json({ error: "no_room" }, 404);
  const exists = await c.env.ROOMS.get(c.env.ROOMS.idFromName(code)).exists();
  return exists ? c.json({ code }) : c.json({ error: "no_room" }, 404);
});

/** Hands a WebSocket upgrade to a Durable Object, with the player's identity. */
async function forwardSocket(c: Ctx, stub: { fetch(r: Request): Promise<Response> }) {
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "expected_websocket" }, 426);
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const headers = new Headers({ upgrade: "websocket" });
  headers.set("x-shifty-user", p.user.id);
  headers.set("x-shifty-handle", encodeURIComponent(p.player.handle));
  for (const h of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"]) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  return stub.fetch(new Request("https://lobby.internal/ws", { headers }));
}

app.get("/api/rooms/:code/ws", async (c) => {
  const code = c.req.param("code").toUpperCase();
  if (!isRoomCode(code)) return c.json({ error: "no_room" }, 404);
  return forwardSocket(c, c.env.ROOMS.get(c.env.ROOMS.idFromName(code)));
});

app.get("/api/matchmaking/ws", (c) => forwardSocket(c, c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName("gp"))));

app.get("/api/dev/mailbox", (c) => {
  if (c.env.DEV_MAILBOX !== "1") return c.notFound();
  return c.json({ code: devMailbox(c.req.query("email") ?? "") });
});

export default app;
