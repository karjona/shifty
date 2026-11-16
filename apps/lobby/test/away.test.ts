import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUEUE_AWAY_MS,
  ROOM_AWAY_MS,
  type RoomMember,
  closedOnPurpose,
  goneAway,
  keptFor,
  nextExpiry,
  shownMembers,
  stillAway,
} from "../src/away.ts";

const T0 = 1_000_000_000;
const ana: RoomMember = { userId: "ana", handle: "Ana#0001", ready: true, joinedAt: T0, look: "AAEC" };
const bernat: RoomMember = { userId: "bernat", handle: "Bernat#0002", ready: false, joinedAt: T0 + 5, look: "" };

void test("a member whose socket drops stays in the room, marked away, until they're back or the grace runs out", () => {
  const away = goneAway([], "ana", ana, T0 + 1000);
  const during = shownMembers([bernat], away, T0 + 1000 + ROOM_AWAY_MS - 1);
  assert.deepEqual(during, [
    { userId: "ana", handle: "Ana#0001", ready: true, look: "AAEC", away: true },
    { userId: "bernat", handle: "Bernat#0002", ready: false, look: "" },
  ]);
  // Ana's screen reconnects: one Ana, here, in her old place.
  assert.deepEqual(
    shownMembers([bernat, ana], away, T0 + 2000).map((m) => [m.userId, m.away ?? false]),
    [
      ["ana", false],
      ["bernat", false],
    ],
  );
  assert.deepEqual(
    shownMembers([bernat], away, T0 + 1000 + ROOM_AWAY_MS).map((m) => m.userId),
    ["bernat"],
  );
});

void test("what a dropped player left behind is theirs again within the grace, and only then", () => {
  const away = goneAway(goneAway([], "ana", 42, T0), "bernat", 7, T0 + 10);
  assert.equal(keptFor(away, "ana", T0 + QUEUE_AWAY_MS - 1, QUEUE_AWAY_MS), 42);
  assert.equal(keptFor(away, "ana", T0 + QUEUE_AWAY_MS, QUEUE_AWAY_MS), null);
  assert.equal(keptFor(away, "carla", T0, QUEUE_AWAY_MS), null);
  // Dropping again replaces the earlier entry.
  const again = goneAway(away, "ana", 43, T0 + 100);
  assert.equal(again.filter((a) => a.userId === "ana").length, 1);
  assert.equal(keptFor(again, "ana", T0 + 100, QUEUE_AWAY_MS), 43);
});

void test("those back, or gone too long, drop out of the list; the next to run out sets the alarm", () => {
  const away = goneAway(goneAway([], "ana", 1, T0), "bernat", 2, T0 + 5000);
  assert.deepEqual(
    stillAway(away, new Set(["ana"]), T0 + 6000, ROOM_AWAY_MS).map((a) => a.userId),
    ["bernat"],
  );
  assert.deepEqual(
    stillAway(away, new Set(), T0 + ROOM_AWAY_MS + 1, ROOM_AWAY_MS).map((a) => a.userId),
    ["bernat"],
  );
  assert.equal(nextExpiry(away, ROOM_AWAY_MS), T0 + ROOM_AWAY_MS);
  assert.equal(nextExpiry([], ROOM_AWAY_MS), null);
});

void test("a page closing its socket is leaving on purpose; drops and pages going away keep the place", () => {
  assert.equal(closedOnPurpose(1000), true);
  assert.equal(closedOnPurpose(1005), true);
  for (const code of [1001, 1006, 1011, 4000]) assert.equal(closedOnPurpose(code), false, String(code));
});
