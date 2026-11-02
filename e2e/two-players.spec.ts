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
      names(): Record<string, string>;
      setInput(v: { steer: number; throttle: number; buttons: number } | null): void;
      net: { lagMs: number; jitterMs: number; lossPct: number };
    };
  }
}

const joined = (p: Page) => p.waitForFunction(() => window.__shifty?.phase() === 1, null, { timeout: 20_000 });

async function openPlayer(page: Page, name: string, room: string, transport: string) {
  page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
  await page.goto(`/?name=${name}&room=${room}&bots=2&transport=${transport}`);
  await joined(page);
}

for (const transport of ["webtransport", "websocket"]) {
  test(`two players race in one room over ${transport}`, async ({ browser }, info) => {
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
    const bSeesA = await b.evaluate((s) => window.__shifty.riders().find((r) => r.slot === s)!, aSlot);
    expect(aSelf.speed).toBeGreaterThan(12);
    expect(Math.hypot(aSelf.x - bSeesA.x, aSelf.z - bSeesA.z)).toBeLessThan(6);

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

    await a.screenshot({ path: info.outputPath(`ana-${transport}.png`) });
    await b.screenshot({ path: info.outputPath(`bea-${transport}.png`) });
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
  await fifth.goto(`/?name=P5&room=${room}&transport=websocket`);
  await fifth.waitForFunction(() => window.__shifty?.phase() >= 2, null, { timeout: 20_000 });
  await expect(fifth.locator("#status")).toContainText("room is full");
});
