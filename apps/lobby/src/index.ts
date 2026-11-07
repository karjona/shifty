// The lobby Worker: accounts (Better Auth), player profiles, menu content,
// and starting races (single player, time trials, private rooms,
// matchmaking). Race servers report in here too (heartbeats, results, time
// trial runs).
import { Hono, type Context } from "hono";
import { type Auth, createAuth } from "./auth.ts";
import { menuContent } from "./content.ts";
import { type Db, openRequestDb } from "./db/client.ts";
import { databaseUrl, type Env } from "./env.ts";
import {
  checkGhost,
  decodeGhost,
  ghostBytes,
  isGhostId,
  loadBoard,
  parseRun,
  parseTrial,
  startTimeTrial,
  storeRun,
  trialQuery,
} from "./ghosts.ts";
import { jsonBody } from "./json.ts";
import { isLocale, pickLocale } from "./locale.ts";
import { devMailbox } from "./mail.ts";
import { NoRaceServer, startSingle } from "./matches.ts";
import { claimHandle, getPlayer, isCard, isTitle, setCard, view } from "./players.ts";
import { parseReport, storeReport } from "./results.ts";
import {
  buy,
  ownedItems,
  checkAppearance,
  parseSetups,
  recentEarnings,
  riderView,
  saveAppearance,
  saveSetups,
} from "./riders.ts";
import { isRoomCode, newRoomCode } from "./rooms.ts";
import type { ServerInfo } from "./servers.ts";
import { isEventChoice } from "./tickets.ts";
import { VERSION } from "./version.ts";

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

app.get("/api/health", async (c) => {
  const servers = await c.env.SERVERS.get(c.env.SERVERS.idFromName("all")).live();
  return c.json({
    ok: true,
    version: VERSION,
    raceServers: servers.map(({ version, draining }) => ({ version, draining })),
  });
});

// Race servers authenticate with the shared secret, not a session.
const raceServer = async (c: Ctx): Promise<boolean> => {
  const got = new TextEncoder().encode(c.req.header("authorization") ?? "");
  const want = new TextEncoder().encode(`Bearer ${c.env.RACE_SERVER_SECRET}`);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
};

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

app.post("/api/servers/heartbeat", async (c) => {
  if (!(await raceServer(c))) return c.json({ error: "unauthorized" }, 401);
  const o = await jsonBody(c.req.raw);
  if (typeof o.addr !== "string" || !/^[\w.[\]:-]{1,255}$/u.test(o.addr)) return c.json({ error: "bad_addr" }, 400);
  const info: ServerInfo = {
    addr: o.addr,
    region: typeof o.region === "string" ? o.region.slice(0, 32) : "unknown",
    version: typeof o.version === "string" ? o.version.slice(0, 32) : "",
    certHashes: Array.isArray(o.certHashes)
      ? (o.certHashes as unknown[])
          .filter((h): h is string => typeof h === "string")
          .slice(0, 4)
          .map((h) => h.slice(0, 64))
      : [],
    rooms: count(o.rooms),
    humans: count(o.humans),
    draining: o.draining === true,
  };
  await c.env.SERVERS.get(c.env.SERVERS.idFromName("all")).heartbeat(info);
  return c.json({ ok: true });
});

// Everything below talks to Postgres: one pool per request.
app.use("/api/*", async (c, next) => {
  const { db, background, finish } = openRequestDb(databaseUrl(c.env), (p) => c.executionCtx.waitUntil(p));
  c.set("db", db);
  c.set("auth", createAuth(c.env, db, background));
  try {
    await next();
  } finally {
    finish();
  }
});

app.post("/api/servers/results", async (c) => {
  if (!(await raceServer(c))) return c.json({ error: "unauthorized" }, 401);
  const report = parseReport(await c.req.json().catch((): unknown => null));
  if (!report) return c.json({ error: "bad_request" }, 400);
  return c.json({ stored: await storeReport(c.var.db, report) });
});

app.post("/api/servers/runs", async (c) => {
  if (!(await raceServer(c))) return c.json({ error: "unauthorized" }, 401);
  const run = parseRun(await c.req.json().catch((): unknown => null));
  if (!run) return c.json({ error: "bad_request" }, 400);
  const servers = await c.env.SERVERS.get(c.env.SERVERS.idFromName("all")).live();
  if (!servers.some((s) => s.addr === run.server)) return c.json({ error: "unknown_server" }, 403);
  const ghost = decodeGhost(run.ghost);
  if (!ghost) return c.json({ error: "bad_run", reason: "base64" }, 400);
  const checked = checkGhost(ghost, run);
  if (typeof checked === "string") return c.json({ error: "bad_run", reason: checked }, 400);
  return c.json(await storeRun(c.var.db, run, ghost));
});

app.on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// Our own endpoints only take requests from the game's own pages.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  const unsafe = c.req.method !== "GET" || c.req.header("upgrade") === "websocket";
  if (unsafe && origin !== new URL(c.env.BETTER_AUTH_URL).origin) return c.json({ error: "bad_origin" }, 403);
  return next();
});

// Our endpoints read the session from the database, not the cookie cache,
// so a deleted or banned account is out at once.
const session = (c: Ctx) =>
  c.var.auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true } });

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
  if (!s) return c.json({ user: null, player: null, rider: null });
  const row = await getPlayer(c.var.db, s.user.id);
  return c.json({
    user: { id: s.user.id, email: s.user.email, image: s.user.image ?? null, name: s.user.name },
    player: row ? view(row) : null,
    rider: row ? await riderView(c.var.db, row) : null,
  });
});

app.put("/api/me/rider", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const owned = await ownedItems(c.var.db, p.user.id);
  const appearance = checkAppearance(await jsonBody(c.req.raw), (id) => owned.has(id));
  if (typeof appearance === "string") return c.json({ error: appearance }, 400);
  const row = await saveAppearance(c.var.db, p.user.id, appearance);
  return row ? c.json({ rider: await riderView(c.var.db, row) }) : c.json({ error: "no_handle" }, 409);
});

app.put("/api/me/setups", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const setups = parseSetups(await jsonBody(c.req.raw));
  if (!setups) return c.json({ error: "bad_setup" }, 400);
  const row = await saveSetups(c.var.db, p.user.id, setups);
  return row ? c.json({ rider: await riderView(c.var.db, row) }) : c.json({ error: "no_handle" }, 409);
});

app.post("/api/shop/buy", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const { item } = await jsonBody(c.req.raw);
  if (typeof item !== "string" || item.length > 80) return c.json({ error: "unknown" }, 400);
  const res = await buy(c.var.db, p.user.id, item);
  if (!res.ok) return c.json({ error: res.error }, res.error === "credits" ? 402 : 400);
  const row = await getPlayer(c.var.db, p.user.id);
  return c.json({ rider: row ? await riderView(c.var.db, row) : null });
});

app.get("/api/me/earnings", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  return c.json({ earnings: await recentEarnings(c.var.db, p.user.id) });
});

app.post("/api/me/handle", async (c) => {
  const s = await session(c);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  const { name } = await jsonBody(c.req.raw);
  if (typeof name !== "string" || name.length > 200) return c.json({ error: "chars" }, 400);
  const res = await claimHandle(c.var.db, s.user.id, name);
  if (!res.ok) return c.json({ error: res.problem }, res.problem === "cooldown" ? 429 : 400);
  return c.json({ player: view(res.player) });
});

app.patch("/api/me/card", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const body = await jsonBody(c.req.raw);
  const title = body.title ?? p.player.title;
  const card = body.card ?? p.player.card;
  if (!isTitle(title) || !isCard(card)) return c.json({ error: "bad_request" }, 400);
  const row = await setCard(c.var.db, p.user.id, title, card);
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
  const event = (await jsonBody(c.req.raw)).event ?? "gp";
  if (!isEventChoice(event)) return c.json({ error: "bad_request" }, 400);
  try {
    const ticket = await startSingle(c.env, { userId: p.user.id, handle: p.player.handle }, event);
    return c.json({ ticket });
  } catch (e) {
    if (e instanceof NoRaceServer) return c.json({ error: "no_server" }, 503);
    throw e;
  }
});

app.post("/api/play/time-trial", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const trial = parseTrial(await jsonBody(c.req.raw));
  if (!trial) return c.json({ error: "bad_request" }, 400);
  try {
    const racer = { userId: p.user.id, handle: p.player.handle };
    return c.json({ ticket: await startTimeTrial(c.env, racer, trial.course, trial.season) });
  } catch (e) {
    if (e instanceof NoRaceServer) return c.json({ error: "no_server" }, 503);
    throw e;
  }
});

app.get("/api/time-trial/board", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const trial = trialQuery(c.req.query("course"), c.req.query("season"));
  if (!trial) return c.json({ error: "bad_request" }, 400);
  return c.json(await loadBoard(c.var.db, trial, p.user.id));
});

app.get("/api/time-trial/ghosts/:id", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const id = c.req.param("id");
  const ghost = isGhostId(id) ? await ghostBytes(c.var.db, id) : null;
  if (!ghost) return c.json({ error: "no_ghost" }, 404);
  return c.body(ghost, 200, {
    "content-type": "application/octet-stream",
    "cache-control": "private, max-age=31536000, immutable",
  });
});

app.post("/api/rooms", async (c) => {
  const p = await requirePlayer(c);
  if ("error" in p) return p.error;
  const body = await jsonBody(c.req.raw);
  const event = body.event ?? "gp";
  const bots = typeof body.bots === "number" ? body.bots : 3;
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
