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
      riders(
        remote?: "interpolated" | "predicted",
      ): { slot: number; x: number; y: number; z: number; speed: number; isMe: boolean }[];
      names(): Record<string, string>;
      setInput(v: { steer: number; throttle: number; buttons: number } | null): void;
      net: { lagMs: number; jitterMs: number; lossPct: number };
    };
  }
}

const joined = (p: Page) => p.waitForFunction(() => window.__shifty?.phase() === 1, null, { timeout: 20_000 });

async function openPlayer(page: Page, name: string, room: string, transport: string) {
  page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
  // Netcode tests skip drawing: CI has no GPU, and software rendering two
  // pages at a few fps would measure the renderer, not the netcode.
  await page.goto(`/?name=${name}&room=${room}&bots=2&transport=${transport}&render=0`);
  await joined(page);
}

for (const transport of ["webtransport", "websocket"]) {
  test(`two players race in one room over ${transport}`, async ({ browser }) => {
    const room = `e2e-${transport}-${Date.now()}`;
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await openPlayer(a, "Ana", room, transport);
    await openPlayer(b, "Bea", room, transport);

    expect(await a.evaluate(() => window.__shifty.transport)).toBe(transport);
    // Both humans and both bots are in the roster, on both screens.
    await expect
      .poll(() => a.evaluate(() => Object.values(window.__shifty.names()).toSorted()))
      .toEqual(["Ana", "Bea", "🤖 Bot 7", "🤖 Bot 8"]);
    await expect.poll(() => b.evaluate(() => window.__shifty.riders().length)).toBe(4);

    // Ana drives; Bea sees her move to where the server says she is.
    await a.evaluate(() => window.__shifty.setInput({ steer: 0.2, throttle: 1, buttons: 0 }));
    await a.waitForTimeout(3000);
    const aSlot = await a.evaluate(() => window.__shifty.slot());
    const aSelf = await a.evaluate(() => window.__shifty.riders().find((r) => r.isMe)!);
    expect(aSelf.speed).toBeGreaterThan(12);
    // In Bea's browser, at one instant: Ana drawn ~100 ms in the past
    // (interpolated) vs Ana predicted to "now". They must agree closely.
    const seen = await b.evaluate((s) => {
      const find = (mode: "interpolated" | "predicted") => window.__shifty.riders(mode).find((r) => r.slot === s)!;
      return { past: find("interpolated"), now: find("predicted") };
    }, aSlot);
    expect(Math.hypot(seen.past.x - seen.now.x, seen.past.z - seen.now.z)).toBeLessThan(6);
    // Across browsers (read at slightly different times): same neighbourhood.
    expect(Math.hypot(aSelf.x - seen.now.x, aSelf.z - seen.now.z)).toBeLessThan(15);

    // Riders stay on the water.
    expect(Math.abs(aSelf.y)).toBeLessThan(2);

    // Prediction holds: almost no corrections on a clean network.
    const stats = await a.evaluate(() => window.__shifty.stats());
    expect(stats.snapshots).toBeGreaterThan(60);
    expect(stats.mispredictions).toBeLessThan(stats.snapshots * 0.1);
    expect(stats.lastSnapshotBytes).toBeLessThan(1200);

    // Now with a bad network on Ana's side: 150 ms extra RTT, 20 ms jitter, 3% loss.
    await a.evaluate(() => Object.assign(window.__shifty.net, { lagMs: 150, jitterMs: 20, lossPct: 3 }));
    await a.evaluate(() => window.__shifty.setInput({ steer: -0.3, throttle: 1, buttons: 0 }));
    await a.waitForTimeout(4000);
    const bad = await a.evaluate(() => window.__shifty.stats());
    expect(bad.rttMs).toBeGreaterThan(120);
    expect(bad.inputLead).toBeGreaterThanOrEqual(1);
    expect(await a.evaluate(() => window.__shifty.phase())).toBe(1);
  });
}

test("a fifth human is turned away (4 humans max)", async ({ browser }) => {
  const room = `e2e-full-${Date.now()}`;
  const pages: Page[] = [];
  // Join one by one so the four seats fill before the fifth player arrives.
  for (const name of ["P1", "P2", "P3", "P4"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const p = await (await browser.newContext()).newPage();
    // oxlint-disable-next-line eslint/no-await-in-loop
    await openPlayer(p, name, room, "websocket");
    pages.push(p);
  }
  const fifth = await (await browser.newContext()).newPage();
  await fifth.goto(`/?name=P5&room=${room}&transport=websocket&render=0`);
  await fifth.waitForFunction(() => window.__shifty?.phase() >= 2, null, { timeout: 20_000 });
  await expect(fifth.locator("#status")).toContainText("room is full");
});

test("the world renders", async ({ page }, info) => {
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  await page.goto(`/?name=Painter&room=e2e-render-${Date.now()}&bots=2&scale=0.5`);
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
