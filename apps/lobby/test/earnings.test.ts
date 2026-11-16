// What a match paid each of its players, as the end of a race shows it: on
// a throwaway database (made from the dev or CI Postgres, dropped
// afterwards), from race reports stored the way race servers send them.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { ensureDatabase } from "../../../scripts/dev-db.ts";
import { type DbHandle, openDb } from "../src/db/client.ts";
import { match, matchPlayer, player, user } from "../src/db/schema.ts";
import { type ResultReport, storeReport } from "../src/results.ts";
import { GRAND_PRIX_BONUS, PLACE_CREDITS, matchPay } from "../src/rewards.ts";

const testDb = `shifty_test_${randomBytes(4).toString("hex")}`;
let adminUrl = "";
let handle: DbHandle;

before(async () => {
  adminUrl = await ensureDatabase();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${testDb}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${testDb}`;
  handle = openDb(url.toString());
  await migrate(handle.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "../drizzle") });
});

after(async () => {
  await handle?.close();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${testDb} with (force)`);
  await admin.end();
});

async function makePlayer(id: string, credits = 0): Promise<void> {
  await handle.db.insert(user).values({ id, name: id, email: `${id}@example.com` });
  await handle.db.insert(player).values({ userId: id, name: id, nameKey: id, tag: 1, credits });
}

async function makeMatch(id: string, mode: string, event: string, players: string[]): Promise<void> {
  await handle.db.insert(match).values({ id, mode, event, server: "localhost:4433" });
  await handle.db.insert(matchPlayer).values(players.map((userId) => ({ matchId: id, userId })));
}

const entry = (pid: string | null, place: number, trickPoints = 0) => ({
  pid,
  place,
  timeMs: 90_000,
  trickPoints,
  gpPoints: null,
});

const report = (room: string, event: number, eventCount: number, entries: ResultReport["entries"]): ResultReport => ({
  room,
  round: 1,
  event,
  eventCount,
  course: 0,
  conditions: null,
  entries,
});

void test("a Tilt in matchmaking shows each race's pay and the bonus as they come in", async () => {
  await makePlayer("ana", 100);
  await makePlayer("bea");
  const id = "m_tilt";
  await makeMatch(id, "matchmaking", "gp", ["ana", "bea"]);
  const empty = await matchPay(handle.db, id, "ana");
  assert.deepEqual(empty, { mode: "matchmaking", reported: [], paid: [], credits: 100, bestBefore: null });

  await storeReport(handle.db, report(id, 0, 2, [entry("ana", 2, 300), entry("bea", 1)]));
  const first = await matchPay(handle.db, id, "ana");
  assert.deepEqual(first?.reported, [0]);
  assert.deepEqual(first?.paid, [
    { event: 0, reason: "race", delta: PLACE_CREDITS[1] },
    { event: 0, reason: "style", delta: 12 },
  ]);

  await storeReport(handle.db, report(id, 1, 2, [entry("ana", 1), entry("bea", 2)]));
  const last = await matchPay(handle.db, id, "ana");
  assert.deepEqual(last?.reported, [0, 1]);
  assert.deepEqual(
    last?.paid.filter((p) => p.event === 1).map((p) => [p.reason, p.delta]),
    [
      ["race", PLACE_CREDITS[0]],
      ["grand_prix", GRAND_PRIX_BONUS],
    ],
  );
  const total = (last?.paid ?? []).reduce((s, p) => s + p.delta, 0);
  assert.equal(last?.credits, 100 + total);
  // Retried reports pay nothing more.
  await storeReport(handle.db, report(id, 1, 2, [entry("ana", 1), entry("bea", 2)]));
  assert.equal((await matchPay(handle.db, id, "ana"))?.credits, 100 + total);
});

void test("a private room raced alone is reported but pays nothing; strangers see nothing", async () => {
  await makePlayer("cai");
  const id = "m_alone";
  await makeMatch(id, "room", "race", ["cai"]);
  await storeReport(handle.db, report(id, 0, 1, [entry("cai", 1, 900), entry(null, 2)]));
  assert.deepEqual(await matchPay(handle.db, id, "cai"), {
    mode: "room",
    reported: [0],
    paid: [],
    credits: 0,
    bestBefore: null,
  });
  assert.equal(await matchPay(handle.db, id, "ana"), null);
  assert.equal(await matchPay(handle.db, "m_nothing", "cai"), null);
});

void test("your best place on a circuit counts the matches before this one", async () => {
  await makePlayer("dan");
  await makeMatch("m_first", "room", "race", ["dan"]);
  await makeMatch("m_second", "room", "race", ["dan"]);
  await storeReport(handle.db, report("m_first", 0, 1, [entry("dan", 4), entry(null, 1)]));
  await storeReport(handle.db, report("m_second", 0, 1, [entry("dan", 2), entry(null, 1)]));
  assert.equal((await matchPay(handle.db, "m_second", "dan", 0))?.bestBefore, 4);
  assert.equal((await matchPay(handle.db, "m_second", "dan", 1))?.bestBefore, null);
});
