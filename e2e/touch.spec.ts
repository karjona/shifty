// A phone held sideways: the race puts up the touch controls, the left
// thumb's stick steers and leans, the right thumb holds a button and slides
// to another, and the jetski's gas is on by itself. Real touches through
// Chromium's DevTools protocol. Drawing is off (`render=0`).
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

type Point = [id: number, x: number, y: number];

test("the touch controls drive the rider", async ({ page }) => {
  await page.goto("/?name=Thumbs&bots=0&render=0");
  await page.waitForFunction(() => window.__shifty?.phase() === 1, null, { timeout: 30_000 });
  // Up for the countdown and the race (not the intro).
  await expect.poll(() => page.evaluate(() => window.__shifty.touchControls()), { timeout: 30_000 }).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
  const fan = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".touch-button")].map((b) => {
        const r = b.getBoundingClientRect();
        return [b.dataset.key ?? "", [r.left + r.width / 2, r.top + r.height / 2] as const];
      }),
    ),
  );
  const [trickX, trickY] = fan.trick!;
  const [rollX, rollY] = fan.roll!;
  const input = () => page.evaluate(() => window.__shifty.input());

  // Nothing touched: the gas is on, nothing else.
  await expect.poll(input).toMatchObject({ steer: 0, lean: 0, throttle: 1, buttons: 0 });

  // The left thumb comes down and pushes right and up: steer right, lean forward.
  await touch("touchStart", [[1, 200, 260]]);
  await touch("touchMove", [[1, 260, 230]]);
  await expect.poll(async () => (await input())?.steer ?? 0).toBeGreaterThan(0.8);
  expect((await input())?.lean ?? 0).toBeGreaterThan(0.3);

  // The right thumb holds Trick, then slides to Roll without lifting.
  await touch("touchStart", [
    [1, 260, 230],
    [2, trickX, trickY],
  ]);
  await expect.poll(async () => (await input())?.buttons).toBe(1);
  await touch("touchMove", [
    [1, 260, 230],
    [2, rollX, rollY],
  ]);
  await expect.poll(async () => (await input())?.buttons).toBe(2);

  // Both thumbs off: back to straight ahead, gas on.
  await touch("touchEnd", []);
  await expect.poll(input).toMatchObject({ steer: 0, lean: 0, throttle: 1, buttons: 0 });
});
