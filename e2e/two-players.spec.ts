import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __shifty: {
      phase(): number;
      slot(): number;
      transport: string;
      renderer: string;
      stats(): {
        snapshots: number;
        mispredictions: number;
        lastSnapshotBytes: number;
        rttMs: number;
        inputLead: number;
      };
      riders(): { slot: number; x: number; y: number; z: number; speed: number; isMe: boolean }[];
      race(): { phase: number; laps: number; racers: number };
      names(): Record<string, string>;
      setInput(v: { steer?: number; throttle?: number; lean?: number; buttons?: number } | null): void;
      net: { lagMs: number; jitterMs: number; lossPct: number };
    };
  }
}

const joined = (p: Page) => p.waitForFunction(() => window.__shifty?.phase() === 1, null, { timeout: 20_000 });

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
  // The first player in starts a warm-up before the race on the oval.
  const race = await a.evaluate(() => window.__shifty.race());
  expect(race.phase).toBe(0);
  expect(race.laps).toBe(3);

  // Ana drives down the first straight; Bea draws her in the present
  // (predicted), so both screens agree on where Ana is right now.
  await a.evaluate(() => window.__shifty.setInput({ steer: 0.02, throttle: 1, buttons: 0 }));
  await a.waitForTimeout(3000);
  const aSlot = await a.evaluate(() => window.__shifty.slot());
  const [aSelf, bSeesA] = await Promise.all([
    a.evaluate(() => window.__shifty.riders().find((r) => r.isMe)!),
    b.evaluate((s) => window.__shifty.riders().find((r) => r.slot === s)!, aSlot),
  ]);
  expect(aSelf.speed).toBeGreaterThan(8);
  expect(Math.hypot(aSelf.x - bSeesA.x, aSelf.z - bSeesA.z)).toBeLessThan(5);

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

test("a fifth human is turned away (4 humans max)", async ({ browser }) => {
  const room = `e2e-full-${Date.now()}`;
  const pages: Page[] = [];
  // Join one by one so the four seats fill before the fifth player arrives.
  for (const name of ["P1", "P2", "P3", "P4"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const p = await (await browser.newContext()).newPage();
    // oxlint-disable-next-line eslint/no-await-in-loop
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
  // Without a GPU (CI runners, E2E_SOFTWARE_GL) the full sea water is too
  // slow to draw in time; the basic water still checks the whole renderer.
  const water = process.env.CI || process.env.E2E_SOFTWARE_GL ? "&water=basic" : "";
  await page.goto(`/?name=Painter&room=e2e-render-${Date.now()}&bots=2&scale=0.5${water}`);
  await joined(page);
  await page.evaluate(() => window.__shifty.setInput({ steer: 0.3, throttle: 1, buttons: 0 }));
  await page.waitForTimeout(2000);
  expect(["webgpu", "webgl2"]).toContain(await page.evaluate(() => window.__shifty.renderer));
  // The screen shows a scene, not a blank clear colour: count colours in a
  // real screenshot (GPU canvases can't be read back after compositing).
  const png = await page.screenshot({ path: info.outputPath("world.png") });
  const distinctColours = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 36;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, 64, 36);
    const px = ctx.getImageData(0, 0, 64, 36).data;
    const seen = new Set<number>();
    for (let i = 0; i < px.length; i += 4)
      seen.add(((px[i] ?? 0) >> 4) | (((px[i + 1] ?? 0) >> 4) << 4) | (((px[i + 2] ?? 0) >> 4) << 8));
    return seen.size;
  }, png.toString("base64"));
  expect(distinctColours).toBeGreaterThan(8);
});
