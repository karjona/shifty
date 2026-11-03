// The menus against the real lobby: sign up with an email code, pick a
// handle, and get into races (single player, a private room with a friend,
// matchmaking). Drawing is off (`render=0`): these test the flow, not the
// renderer.
import { type Browser, expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

/** A new player: signs up with an email code and picks a handle. Returns the handle. */
async function signUp(browser: Browser, name: string): Promise<{ page: Page; handle: string }> {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
  await page.goto("/?render=0");
  await page.waitForURL(/\/login/u);
  const email = `${name.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /send me a code/iu }).click();
  // Dev mail: the lobby keeps the last code per address for tests.
  let code: string | null = null;
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/dev/mailbox?email=${encodeURIComponent(email)}`);
      const body: unknown = await res.json();
      code = typeof body === "object" && body && "code" in body && typeof body.code === "string" ? body.code : null;
      return code;
    })
    .not.toBeNull();
  await page.getByLabel("Code").fill(code ?? "");
  await page.getByRole("button", { name: /^log in$/iu }).click();
  await page.waitForURL(/\/welcome/u);
  await page.getByLabel("Rider name").fill(name);
  await page.getByRole("button", { name: /let's ride/iu }).click();
  const title = page.locator(".login-card .panel-title");
  await expect(title).toHaveText(new RegExp(`^${name}#\\d{4}$`, "u"));
  const handle = (await title.textContent()) ?? "";
  await page.getByRole("button", { name: /let's ride/iu }).click();
  await page.waitForURL((u) => u.pathname === "/");
  return { page, handle };
}

const joinedRace = (p: Page) => p.waitForFunction(() => window.__shifty?.phase() === 1, null, { timeout: 30_000 });

test("sign up, pick a handle and race the Grand Prix against bots", async ({ browser }) => {
  const { page, handle } = await signUp(browser, "Ana");
  await expect(page.locator(".social-card")).toContainText(handle.split("#")[0]!);
  // Play (P), then Play again on the mode select: single player is the default.
  await page.keyboard.press("p");
  await page.waitForURL(/\/play/u);
  await page.keyboard.press("p");
  await page.waitForURL(/\/race/u);
  await joinedRace(page);
  // A Grand Prix: two races, summer then winter.
  await expect.poll(() => page.evaluate(() => window.__shifty.race().eventCount)).toBe(2);
  await expect.poll(() => page.evaluate(() => Object.values(window.__shifty.names()))).toContain(handle);
  // The race menu takes you back to the mode select.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /leave the race/iu }).click();
  await page.waitForURL(/\/play/u);
});

test("two friends race in a private room", async ({ browser }) => {
  const a = await signUp(browser, "Bea");
  const b = await signUp(browser, "Cai");
  await a.page.goto("/play?mode=room&render=0");
  await a.page.getByRole("button", { name: /create a room/iu }).click();
  await a.page.waitForURL(/\/room\/[A-Z0-9]{6}$/u);
  const code = a.page.url().split("/").pop()!;
  await expect(a.page.locator(".members")).toContainText(a.handle);

  await b.page.goto("/play?mode=room&render=0");
  await b.page.getByRole("button", { name: /join a room/iu }).click();
  await b.page.getByLabel("Room code").fill(code);
  await b.page.getByRole("button", { name: /^join$/iu }).click();
  await b.page.waitForURL(new RegExp(`/room/${code}$`, "u"));
  await expect(a.page.locator(".members")).toContainText(b.handle);

  // Everyone has to be ready before the host can start.
  await b.page.getByRole("button", { name: /i'm ready/iu }).click();
  await expect(a.page.locator(".members")).toContainText("Ready");
  await a.page.getByRole("button", { name: /start the race/iu }).click();
  await Promise.all([a.page.waitForURL(/\/race/u), b.page.waitForURL(/\/race/u)]);
  await Promise.all([joinedRace(a.page), joinedRace(b.page)]);
  await expect
    .poll(() => a.page.evaluate(() => Object.values(window.__shifty.names())))
    .toEqual(expect.arrayContaining([a.handle, b.handle]));
});

test("matchmaking puts two riders in the same race", async ({ browser }) => {
  const a = await signUp(browser, "Dua");
  const b = await signUp(browser, "Eli");
  await Promise.all(
    [a.page, b.page].map(async (p) => {
      await p.goto("/play?mode=matchmaking&render=0");
      await p.getByRole("button", { name: /find a race/iu }).click();
    }),
  );
  // Fewer than four: the race starts once the first in line has waited (10 s in dev).
  await Promise.all([
    a.page.waitForURL(/\/race/u, { timeout: 40_000 }),
    b.page.waitForURL(/\/race/u, { timeout: 40_000 }),
  ]);
  await Promise.all([joinedRace(a.page), joinedRace(b.page)]);
  await expect
    .poll(() => b.page.evaluate(() => Object.values(window.__shifty.names())))
    .toEqual(expect.arrayContaining([a.handle, b.handle]));
});
