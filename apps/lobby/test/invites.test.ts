// The sign-up gate end to end: Better Auth's real handler on a throwaway
// database (made from the dev or CI Postgres, dropped afterwards), one pool
// per request like the Worker, browsers as cookie jars, sign-in codes read
// from the dev mailbox.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { ensureDatabase } from "../../../scripts/dev-db.ts";
import { createAuth } from "../src/auth.ts";
import { type DbHandle, openDb, openRequestDb } from "../src/db/client.ts";
import { invite, inviteUse, user } from "../src/db/schema.ts";
import type { AuthEnv } from "../src/env.ts";
import { createInvites, formatInviteCode } from "../src/invite-codes.ts";
import { devMailbox } from "../src/mail.ts";

const ORIGIN = "http://localhost:5173";
const testDb = `shifty_test_${randomBytes(4).toString("hex")}`;
let adminUrl = "";
let testUrl = "";
let handle: DbHandle;

before(async () => {
  adminUrl = await ensureDatabase();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${testDb}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${testDb}`;
  testUrl = url.toString();
  handle = openDb(testUrl);
  await migrate(handle.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "../drizzle") });
});

after(async () => {
  await handle?.close();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${testDb} with (force)`);
  await admin.end();
});

/** A browser: its cookies and its IP address (rate limits count per IP). */
class Browser {
  cookies = new Map<string, string>();
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

function lobby(signups: "open" | "invite") {
  const env: AuthEnv = {
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_URL: ORIGIN,
    MAIL_MODE: "console",
    DEV_MAILBOX: "1",
    SIGNUPS: signups,
  };
  const pending: Promise<unknown>[] = [];

  async function call(browser: Browser, method: "GET" | "POST", path: string, body?: object) {
    const headers = new Headers({ origin: ORIGIN, "cf-connecting-ip": browser.ip });
    if (body) headers.set("content-type", "application/json");
    if (browser.cookies.size > 0) {
      headers.set("cookie", [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const init: RequestInit = { method, headers };
    if (body) init.body = JSON.stringify(body);
    const request = openRequestDb(testUrl, (p) => void pending.push(p));
    const res = await createAuth(env, request.db, request.background).handler(
      new Request(`${ORIGIN}/api/auth${path}`, init),
    );
    request.finish();
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (value === "" || /max-age=0\b/iu.test(cookie)) browser.cookies.delete(name);
      else browser.cookies.set(name, value);
    }
    await Promise.all(pending.splice(0));
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  /** Asks for a sign-in code; the code if one was emailed. */
  async function askCode(browser: Browser, email: string): Promise<string | null> {
    const res = await call(browser, "POST", "/email-otp/send-verification-otp", { email, type: "sign-in" });
    assert.equal(res.status, 200);
    return devMailbox(email);
  }

  /** Asks for a sign-in code that must be refused; the error code. */
  async function codeRefused(browser: Browser, email: string): Promise<string> {
    const res = await call(browser, "POST", "/email-otp/send-verification-otp", { email, type: "sign-in" });
    assert.equal(res.status, 403);
    assert.equal(devMailbox(email), null, "no code is emailed");
    return errorCode(res.body);
  }

  const signIn = (browser: Browser, email: string, otp: string) =>
    call(browser, "POST", "/sign-in/email-otp", { email, otp });

  return { call, askCode, codeRefused, signIn };
}

const newEmail = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.com`;

async function accountFor(email: string) {
  const [row] = await handle.db.select().from(user).where(eq(user.email, email));
  return row;
}

const errorCode = (body: unknown): string =>
  typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code.toLowerCase()
    : "";

void test("with sign-ups open, anyone can make an account", async () => {
  const { askCode, signIn } = lobby("open");
  const email = newEmail("open");
  const browser = new Browser();
  const otp = await askCode(browser, email);
  assert.ok(otp, "the code is emailed");
  assert.equal((await signIn(browser, email, otp)).status, 200);
  assert.ok(await accountFor(email));
});

void test("invite-only: an email without an account or an invite is told so, and gets nothing", async () => {
  const { codeRefused, signIn } = lobby("invite");
  const email = newEmail("stranger");
  const browser = new Browser();
  assert.equal(await codeRefused(browser, email), "no_account");
  assert.notEqual((await signIn(browser, email, "123456")).status, 200);
  assert.equal(await accountFor(email), undefined);
});

void test("a redeemed code lets one new player in, and records it", async () => {
  const { call, askCode, signIn } = lobby("invite");
  const [code = ""] = await createInvites(handle.db, { count: 1, uses: 1, days: 7, note: "test" });
  const browser = new Browser();
  assert.deepEqual((await call(browser, "GET", "/invite/status")).body, { required: true, redeemed: false });
  const typed = formatInviteCode(code).toLowerCase();
  assert.equal((await call(browser, "POST", "/invite/redeem", { code: typed })).status, 200);
  assert.deepEqual((await call(browser, "GET", "/invite/status")).body, { required: true, redeemed: true });

  const email = newEmail("invited");
  const otp = await askCode(browser, email);
  assert.ok(otp, "the code is emailed to someone carrying an invite");
  assert.equal((await signIn(browser, email, otp)).status, 200);

  const account = await accountFor(email);
  assert.ok(account);
  const [spent] = await handle.db.select().from(invite).where(eq(invite.code, code));
  assert.equal(spent?.uses, 1);
  const [use] = await handle.db.select().from(inviteUse).where(eq(inviteUse.userId, account.id));
  assert.equal(use?.code, code);
  assert.deepEqual(
    (await call(browser, "GET", "/invite/status")).body,
    { required: true, redeemed: false },
    "the browser forgets the code once it is used",
  );

  // Used up: the next player can't redeem it.
  const next = new Browser();
  const refused = await call(next, "POST", "/invite/redeem", { code });
  assert.equal(refused.status, 400);
  assert.equal(errorCode(refused.body), "invalid_invite");

  // The new player signs in again later without any code.
  const later = new Browser();
  const again = await askCode(later, email);
  assert.ok(again, "existing players always get their code");
  assert.equal((await signIn(later, email, again)).status, 200);
});

void test("the code is spent when the account is made: two players, one use", async () => {
  const { call, askCode, signIn } = lobby("invite");
  const [code = ""] = await createInvites(handle.db, { count: 1, uses: 1, days: null, note: null });
  const [first, second] = [new Browser(), new Browser()];
  const [a, b] = [newEmail("first"), newEmail("second")];
  for (const browser of [first, second]) {
    assert.equal((await call(browser, "POST", "/invite/redeem", { code })).status, 200);
  }
  const otpA = await askCode(first, a);
  const otpB = await askCode(second, b);
  assert.ok(otpA && otpB);
  assert.equal((await signIn(first, a, otpA)).status, 200);
  const late = await signIn(second, b, otpB);
  assert.equal(late.status, 403);
  assert.equal(errorCode(late.body), "invite_required");
  assert.equal(await accountFor(b), undefined);
});

void test("a code with uses left lets several players in", async () => {
  const { call, askCode, signIn } = lobby("invite");
  const [code = ""] = await createInvites(handle.db, { count: 1, uses: 3, days: null, note: "crew" });
  for (const who of ["one", "two", "three"]) {
    const browser = new Browser();
    const email = newEmail(who);
    assert.equal((await call(browser, "POST", "/invite/redeem", { code })).status, 200);
    const otp = await askCode(browser, email);
    assert.ok(otp);
    assert.equal((await signIn(browser, email, otp)).status, 200);
  }
  assert.equal((await call(new Browser(), "POST", "/invite/redeem", { code })).status, 400);
});

void test("expired and made-up codes are refused", async () => {
  const { call } = lobby("invite");
  const code = "EXP2XPRD";
  await handle.db.insert(invite).values({ code, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await call(new Browser(), "POST", "/invite/redeem", { code })).status, 400);
  assert.equal((await call(new Browser(), "POST", "/invite/redeem", { code: "NOPE-NOPE" })).status, 400);
  assert.equal((await call(new Browser(), "POST", "/invite/redeem", {})).status, 400);
});

void test("redeeming is rate limited per IP address", async () => {
  const { call } = lobby("invite");
  const browser = new Browser();
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await call(browser, "POST", "/invite/redeem", { code: "ZZZZ-ZZZZ" })).status);
  }
  assert.deepEqual(
    statuses.slice(0, 10),
    Array.from({ length: 10 }, () => 400),
  );
  assert.equal(statuses[10], 429);
});
