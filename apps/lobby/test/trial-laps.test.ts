// Time trial laps as race servers report them, kept and ranked on a
// throwaway database (made from the dev or CI Postgres, dropped
// afterwards): a clean lap ranks, a lap of another revision never does, and
// a best of an older revision gives way to the next lap whatever its time.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { ensureDatabase } from "../../../scripts/dev-db.ts";
import { type DbHandle, openDb } from "../src/db/client.ts";
import { player, timeTrialBest, user } from "../src/db/schema.ts";
import { type RunReport, loadBoard, storeRun, unranked } from "../src/ghosts.ts";

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

async function makePlayer(id: string, tag: number): Promise<void> {
  await handle.db.insert(user).values({ id, name: id, email: `${id}@example.com` });
  await handle.db.insert(player).values({ userId: id, name: id, nameKey: id, tag });
}

let runs = 0;
const lap = (pid: string, timeMs: number, over: Partial<RunReport> = {}): RunReport => ({
  server: "localhost:4433",
  room: "t_laps",
  run: ++runs,
  pid,
  course: 0,
  season: 0,
  revision: 1,
  weather: 0,
  timeMs,
  ghost: "",
  ...over,
});
const bytes = (n: number) => Uint8Array.from([2, 0, 0, 1, n]);

/** Stores a lap the way the lobby takes it from a race server: only if it can rank. */
async function report(run: RunReport, ghost = bytes(run.run)) {
  if (unranked(run)) return { stored: false } as const;
  return storeRun(handle.db, run, ghost);
}

void test("clean laps rank by time; a lap of another revision or in practice weather never does", async () => {
  await makePlayer("ana", 1);
  await makePlayer("bea", 2);
  assert.deepEqual(await report(lap("ana", 40_000)), { stored: true, best: true });
  assert.deepEqual(await report(lap("ana", 41_000)), { stored: true, best: false });
  const bea = lap("bea", 39_500);
  assert.deepEqual(await report(bea), { stored: true, best: true });
  // A retried report is kept once.
  assert.deepEqual(await report(bea), { stored: false });
  assert.deepEqual(await report(lap("ana", 30_000, { revision: 0 })), { stored: false });
  assert.deepEqual(await report(lap("ana", 30_000, { weather: 4 })), { stored: false });
  const board = await loadBoard(handle.db, { course: 0, season: 0 }, "ana");
  assert.deepEqual(
    board.top.map((r) => [r.rank, r.handle, r.timeMs]),
    [
      [1, "bea#0002", 39_500],
      [2, "ana#0001", 40_000],
    ],
  );
  assert.equal(board.mine?.rank, 2);
});

void test("a best of an older revision ranks nowhere, and the next clean lap replaces it", async () => {
  await makePlayer("cai", 3);
  // A best from before revisions: faster than anything since, and unranked.
  await handle.db.insert(timeTrialBest).values({
    id: "old_cai_best_0000000000",
    userId: "cai",
    course: 2,
    season: 1,
    timeMs: 20_000,
    ghost: Uint8Array.from([1, 2, 0]),
  });
  const old = await loadBoard(handle.db, { course: 2, season: 1 }, "cai");
  assert.equal(old.total, 0);
  assert.equal(old.mine, null);
  // The next lap replaces it, though slower.
  const next = lap("cai", 45_000, { course: 2, season: 1 });
  assert.deepEqual(await report(next), { stored: true, best: true });
  const now = await loadBoard(handle.db, { course: 2, season: 1 }, "cai");
  assert.deepEqual(
    now.top.map((r) => [r.handle, r.timeMs]),
    [["cai#0003", 45_000]],
  );
  assert.notEqual(now.mine?.ghost, "old_cai_best_0000000000");
  // From then on only faster laps do.
  assert.deepEqual(await report(lap("cai", 46_000, { course: 2, season: 1 })), { stored: true, best: false });
  assert.deepEqual(await report(lap("cai", 44_000, { course: 2, season: 1 })), { stored: true, best: true });
});
