import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CIRCUITS,
  DAYLIGHT,
  NOON,
  SEASONS,
  cleanSpec,
  conditionsFixture,
  namedTime,
  parsePlan,
  timeOf,
  weathersIn,
} from "../src/index.ts";

void test("the tables match the sim's (crates/sim/src/conditions.rs renders the same fixture)", () => {
  const fixture = readFileSync(new URL("conditions.txt", import.meta.url), "utf8");
  assert.equal(conditionsFixture(), fixture);
});

void test("circuit ids are unique and named", () => {
  assert.equal(new Set(CIRCUITS.map((c) => c.id)).size, CIRCUITS.length);
  assert.equal(new Set(CIRCUITS.map((c) => c.key)).size, CIRCUITS.length);
});

void test("named times run in order through each season's daylight", () => {
  for (const s of SEASONS) {
    assert.equal(timeOf(s, "dawn"), DAYLIGHT[s][0]);
    assert.equal(timeOf(s, "noon"), NOON);
    assert.equal(timeOf(s, "dusk"), DAYLIGHT[s][1]);
    assert.equal(namedTime(s, timeOf(s, "afternoon")), "afternoon");
  }
  assert.ok(!weathersIn("summer").includes("snow"));
  assert.ok(weathersIn("winter").includes("snow"));
});

void test("plan requests keep only what fits", () => {
  assert.deepEqual(parsePlan({ tilt: true, race: { course: 1 } }), { tilt: true });
  assert.equal(parsePlan({ tilt: "yes" }), null);
  assert.equal(parsePlan(null), null);
  assert.deepEqual(parsePlan({ tilt: false }), { tilt: false, race: {} });
  // The mountain has no summer; summer has no snow; nobody races at night.
  assert.deepEqual(cleanSpec({ course: 1, season: 0, weather: 6, time: 3 }), { course: 1, weather: 6, time: 3 });
  assert.deepEqual(cleanSpec({ season: 0, weather: 6, time: 3 }), { season: 0, time: DAYLIGHT.summer[0] });
  assert.deepEqual(cleanSpec({ course: 99, season: 2, weather: 5, turns: 1, time: 72 }), {
    season: 2,
    weather: 5,
    turns: 1,
    time: 72,
  });
  assert.deepEqual(cleanSpec({ course: 0.5, season: -1, weather: "rain" }), {});
});
