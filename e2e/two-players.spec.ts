import { expect, test, type Page } from "@playwright/test";
import { decodePng, distinctColours } from "./png.ts";

const joined = (p: Page) => p.waitForFunction(() => window.__shifty?.phase() === 1, null, { timeout: 20_000 });
/** The race is on: past the grid, the intro and the countdown (`sim::Phase::Racing`). */
const racing = (p: Page) => p.waitForFunction(() => window.__shifty.race().phase === 2, null, { timeout: 30_000 });

/**
 * How far Bea's view of Ana is from where Ana really is, in metres (on the
 * ground plane). Two pages can't be read at the same instant, and at racing
 * speed a few hundred milliseconds between reads is metres, so Ana is read
 * before and after Bea, and Bea's view is measured to that stretch.
 */
async function seenGap(a: Page, b: Page, slot: number) {
  const self = () => a.evaluate(() => window.__shifty.riders().find((r) => r.isMe)!);
  const before = await self();
  const seen = await b.evaluate((s) => window.__shifty.riders().find((r) => r.slot === s)!, slot);
  const after = await self();
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((seen.x - before.x) * dx + (seen.z - before.z) * dz) / len2)) : 0;
  return { self: before, gap: Math.hypot(seen.x - (before.x + t * dx), seen.z - (before.z + t * dz)) };
}

async function openPlayer(page: Page, name: string, room: string) {
  page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
  // Netcode tests skip drawing: CI has no GPU, and software rendering two
  // pages at a few fps would measure the renderer, not the netcode.
  await page.goto(`/?name=${name}&room=${room}&bots=2&render=0`);
  await joined(page);
}

test("two players race in one room", async ({ browser }) => {
  const room = `e2e-race-${Date.now()}`;
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openPlayer(a, "Ana", room);
  await openPlayer(b, "Bea", room);

  expect(await a.evaluate(() => window.__shifty.transport)).toBe("webtransport");
  // Both humans and both bots are in the roster, on both screens.
  await expect
    .poll(() => a.evaluate(() => Object.values(window.__shifty.names()).toSorted()))
    .toEqual(["Ana", "Bea", "🤖 Bot 7", "🤖 Bot 8"]);
  await expect.poll(() => b.evaluate(() => window.__shifty.riders().length)).toBe(4);
  // Everyone lines up on the grid; once every screen is ready, the intro
  // and the countdown run (riders held still), then the race on the oval.
  const race = await a.evaluate(() => window.__shifty.race());
  expect([0, 4, 1]).toContain(race.phase);
  expect(race.laps).toBe(3);
  await Promise.all([racing(a), racing(b)]);

  // Ana drives down the first straight; Bea draws her in the present
  // (predicted), so both screens agree on where Ana is right now.
  await a.evaluate(() => window.__shifty.setInput({ steer: 0.02, throttle: 1, buttons: 0 }));
  await a.waitForTimeout(3000);
  const aSlot = await a.evaluate(() => window.__shifty.slot());
  const { self: aSelf, gap } = await seenGap(a, b, aSlot);
  expect(aSelf.speed).toBeGreaterThan(8);
  expect(gap).toBeLessThan(5);

  // Riders stay on (or just above) the water, even on big swells.
  expect(Math.abs(aSelf.y)).toBeLessThan(8);

  // Prediction holds: almost no corrections on a clean network.
  const stats = await a.evaluate(() => window.__shifty.stats());
  expect(stats.snapshots).toBeGreaterThan(60);
  expect(stats.mispredictions).toBeLessThan(stats.snapshots * 0.1);
  expect(stats.lastSnapshotBytes).toBeLessThan(1200);

  // Now with a bad network on Ana's side: 150 ms extra RTT, 20 ms jitter, 3% loss.
  await a.evaluate(() => Object.assign(window.__shifty.net, { lagMs: 150, jitterMs: 20, lossPct: 3 }));
  await a.evaluate(() => window.__shifty.setInput({ steer: -0.1, throttle: 1, buttons: 0 }));
  await a.waitForTimeout(4000);
  const bad = await a.evaluate(() => window.__shifty.stats());
  expect(bad.rttMs).toBeGreaterThan(120);
  expect(bad.inputLead).toBeGreaterThanOrEqual(1);
  expect(await a.evaluate(() => window.__shifty.phase())).toBe(1);
});

test("two players ride the winter mountain", async ({ browser }) => {
  const room = `e2e-snow-${Date.now()}`;
  const open = async (name: string) => {
    const p = await (await browser.newContext()).newPage();
    p.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
    await p.goto(`/?name=${name}&room=${room}&bots=2&event=snow&render=0`);
    await joined(p);
    return p;
  };
  const a = await open("Ana");
  const b = await open("Bea");
  expect(await a.evaluate(() => window.__shifty.sport())).toBe("snow");
  await Promise.all([racing(a), racing(b)]);
  const top = await a.evaluate(() => window.__shifty.riders().find((r) => r.isMe)!);

  // Ana tucks down the start ramp; Bea sees her where she is.
  await a.evaluate(() => window.__shifty.setInput({ steer: 0, lean: 1, buttons: 0 }));
  await a.waitForTimeout(6000);
  const aSlot = await a.evaluate(() => window.__shifty.slot());
  const { self: aSelf, gap } = await seenGap(a, b, aSlot);
  expect(aSelf.z - top.z).toBeGreaterThan(30);
  expect(top.y - aSelf.y).toBeGreaterThan(10);
  expect(aSelf.speed).toBeGreaterThan(10);
  expect(gap).toBeLessThan(5);

  const stats = await a.evaluate(() => window.__shifty.stats());
  expect(stats.mispredictions).toBeLessThan(stats.snapshots * 0.1);
  expect(stats.lastSnapshotBytes).toBeLessThan(1200);
});

test("a fifth human is turned away (4 humans max)", async ({ browser }) => {
  const room = `e2e-full-${Date.now()}`;
  const pages: Page[] = [];
  // Join one by one so the four seats fill before the fifth player arrives.
  for (const name of ["P1", "P2", "P3", "P4"]) {
    const p = await (await browser.newContext()).newPage();
    await openPlayer(p, name, room);
    pages.push(p);
  }
  const fifth = await (await browser.newContext()).newPage();
  await fifth.goto(`/?name=P5&room=${room}&render=0`);
  await fifth.waitForFunction(() => window.__shifty?.phase() >= 2, null, { timeout: 20_000 });
  await expect(fifth.locator("#status")).toContainText("room is full");
});

test("the world renders", async ({ page }, info) => {
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  // Without a GPU (CI runners, E2E_SOFTWARE_GL) every frame is drawn on the
  // CPU: the basic water at a quarter of the resolution keeps frames short
  // and still checks the whole renderer, and the test gets more time
  // (shared CI runners draw slowly and unevenly).
  const software = Boolean(process.env.CI || process.env.E2E_SOFTWARE_GL);
  test.slow(software, "drawn without a GPU");
  const view = software ? "&scale=0.25&water=basic" : "&scale=0.5";
  await page.goto(`/?name=Painter&room=e2e-render-${Date.now()}&bots=2${view}`);
  await joined(page);
  expect(["webgpu", "webgl2"]).toContain(await page.evaluate(() => window.__shifty.renderer));
  await page.evaluate(() => window.__shifty.setInput({ steer: 0.3, throttle: 1, buttons: 0 }));
  // The course loads behind its season card first.
  await page.waitForFunction(() => window.__shifty.ready(), null, { timeout: software ? 90_000 : 30_000 });
  await page.waitForTimeout(2000);
  // The screen shows a scene, not a blank clear colour: count colours in a
  // real screenshot (GPU canvases can't be read back after compositing),
  // here in Node, not in the page that is busy drawing.
  const png = await page.screenshot({ path: info.outputPath("world.png") });
  expect(distinctColours(decodePng(png))).toBeGreaterThan(8);
});
