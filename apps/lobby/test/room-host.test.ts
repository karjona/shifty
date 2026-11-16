import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_GRACE_MS, RACE_TTL_MS, actingHost, type HostState } from "../src/room-host.ts";

const T0 = 1_000_000_000;
const MIN = 60_000;

function room(over: Partial<HostState> = {}): HostState {
  return { hostId: "ana", createdAt: T0, race: null, ...over };
}

void test("the host hosts while in the room, whoever else came first", () => {
  assert.equal(actingHost(room(), ["bernat", "ana"], T0 + 60 * MIN), "ana");
});

void test("the host keeps the room while racing its race, and guests back first don't take it", () => {
  const s = room({ hostAway: T0 + MIN, race: { userIds: ["ana", "bernat"], at: T0 + MIN } });
  // Bernat's screen closed its room socket last, and comes back first.
  assert.equal(actingHost(s, [], T0 + MIN + 1000), "ana");
  assert.equal(actingHost(s, ["bernat"], T0 + 8 * MIN), "ana");
  // The race is over: everyone comes back, the host a little after the others.
  const over = { ...s, race: null, raceEndedAt: T0 + 12 * MIN };
  assert.equal(actingHost(over, ["bernat"], T0 + 12 * MIN + 20_000), "ana");
  assert.equal(actingHost(over, ["bernat", "ana"], T0 + 12 * MIN + 30_000), "ana");
});

void test("a host who doesn't come back hands the room to the earliest member, until they return", () => {
  const s = room({ hostAway: T0 + MIN, race: null, raceEndedAt: T0 + 2 * MIN });
  assert.equal(actingHost(s, ["bernat", "carla"], T0 + 2 * MIN + HOST_GRACE_MS - 1), "ana");
  assert.equal(actingHost(s, ["bernat", "carla"], T0 + 2 * MIN + HOST_GRACE_MS + 1), "bernat");
  assert.equal(actingHost(s, ["bernat", "carla", "ana"], T0 + 30 * MIN), "ana");
});

void test("a race the host isn't in, or one long gone, doesn't hold the room for them", () => {
  const notIn = room({ hostAway: T0, race: { userIds: ["bernat"], at: T0 + MIN } });
  assert.equal(actingHost(notIn, ["carla"], T0 + 5 * MIN), "carla");
  const stale = room({ hostAway: T0, race: { userIds: ["ana"], at: T0 } });
  assert.equal(actingHost(stale, ["carla"], T0 + RACE_TTL_MS + 1), "carla");
});

void test("a guest who arrives before the host's room screen is in waits for the host", () => {
  assert.equal(actingHost(room(), ["bernat"], T0 + 5000), "ana");
  assert.equal(actingHost(room(), [], T0 + 5000), "ana");
});
