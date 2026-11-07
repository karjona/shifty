import assert from "node:assert/strict";
import { test } from "node:test";
import { ITEMS, STARTER, defaultOutfits, defaultAppearance } from "@shifty/rider";
import { GRAND_PRIX_BONUS, PLACE_CREDITS, STYLE_CAP, payouts } from "../src/rewards.ts";
import { type ResultReport, parseReport } from "../src/results.ts";
import { checkAppearance, parseSetups } from "../src/riders.ts";

const report = (entries: ResultReport["entries"], event = 0): ResultReport => ({
  room: "m_1",
  round: 1,
  event,
  eventCount: null,
  course: event,
  conditions: null,
  entries,
});
const entry = (pid: string | null, place: number, trickPoints = 0) => ({
  pid,
  place,
  timeMs: 90_000,
  trickPoints,
  gpPoints: null,
});

void test("matchmaking pays by place and style, even against bots", () => {
  const r = report([entry("a", 1, 5000), entry(null, 2), entry(null, 3)]);
  const p = payouts(r, { id: "m_1", mode: "matchmaking", event: "summer" }, new Set(["a"]), 1);
  assert.deepEqual(
    p.map((x) => [x.reason, x.delta]),
    [
      ["race", PLACE_CREDITS[0]],
      ["style", STYLE_CAP],
    ],
  );
});

void test("a private room pays only with two or more people in the race", () => {
  const alone = report([entry("a", 1), entry(null, 2)]);
  const pair = report([entry("a", 2), entry("b", 1)]);
  const m = { id: "m_1", mode: "room", event: "summer" };
  assert.deepEqual(payouts(alone, m, new Set(["a"]), 1), []);
  assert.equal(payouts(pair, m, new Set(["a", "b"]), 1).length, 2);
});

void test("the last race of a Tilt pays the bonus; strangers and other modes get nothing", () => {
  const m = { id: "m_1", mode: "matchmaking", event: "gp" };
  const first = payouts(report([entry("a", 1)], 0), m, new Set(["a"]), 2);
  const last = payouts(report([entry("a", 1), entry("x", 2)], 1), m, new Set(["a"]), 2);
  assert.ok(!first.some((p) => p.reason === "grand_prix"));
  assert.deepEqual(
    last.filter((p) => p.reason === "grand_prix").map((p) => [p.userId, p.delta]),
    [["a", GRAND_PRIX_BONUS]],
  );
  assert.deepEqual(payouts(report([entry("a", 1)]), { id: "s", mode: "single", event: "gp" }, new Set(["a"]), 2), []);
});

void test("an average Tilt earns about a fifth of an average item", () => {
  const mid = (PLACE_CREDITS[3] + PLACE_CREDITS[4]) / 2;
  const perGrandPrix = 2 * (mid + 40) + GRAND_PRIX_BONUS;
  const priced = ITEMS.filter((i) => i.price > 0);
  const average = priced.reduce((s, i) => s + i.price, 0) / priced.length;
  const grandPrix = average / perGrandPrix;
  assert.ok(grandPrix > 4 && grandPrix < 6, `an item takes ${grandPrix.toFixed(1)} Tilts`);
});

void test("a rider can only wear what they own, in the right slots", () => {
  const owned = new Set(STARTER.map((i) => i.id));
  const owns = (id: string) => owned.has(id);
  const a = defaultAppearance();
  assert.deepEqual(checkAppearance(a, owns), a);
  const shop = { ...a, outfits: { ...a.outfits, summer: { ...a.outfits.summer, vest: "summer.vest.race.orange" } } };
  assert.equal(checkAppearance(shop, owns), "bad_outfit");
  const beard = { ...a, look: { ...a.look, body: "female", facialHair: 2 }, outfits: defaultOutfits("female") };
  assert.equal(checkAppearance(beard, owns), "bad_look");
  const extra = { ...a, outfits: { ...a.outfits, winter: { ...a.outfits.winter, cape: "x" } } };
  assert.equal(checkAppearance(extra, owns), "bad_outfit");
  assert.equal(parseSetups({ summer: { speed: 6, handling: 2, stability: 2, tricks: 2 } }), null);
  assert.ok(
    parseSetups({
      summer: { speed: 6, handling: 2, stability: 2, tricks: 2 },
      winter: { speed: 3, handling: 3, stability: 3, tricks: 3 },
    }),
  );
});

void test("race reports carry the plan's length and the race's conditions", () => {
  const base = { room: "m_1", round: 1, event: 3, course: 1, entries: [] };
  assert.deepEqual(parseReport({ ...base, eventCount: 4, conditions: { season: 3, weather: 4, turns: 0, time: 80 } }), {
    ...base,
    eventCount: 4,
    conditions: { season: 3, weather: 4, turns: 0, time: 80 },
  });
  assert.deepEqual(parseReport(base), { ...base, eventCount: null, conditions: null });
  assert.equal(parseReport({ ...base, conditions: { season: 4, weather: 0, turns: 0, time: 72 } }), null);
  assert.equal(parseReport({ ...base, eventCount: 0 }), null);
});
