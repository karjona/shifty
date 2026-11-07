import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BoardEntry,
  GHOST_MAX_BYTES,
  checkGhost,
  decodeGhost,
  parseRun,
  parseTrial,
  shapeBoard,
  trialQuery,
} from "../src/ghosts.ts";
import { b64urlEncode } from "../src/tickets.ts";

const varint = (out: number[], v: number) => {
  let x = v;
  while (x >= 0x80) {
    out.push((x % 0x80) | 0x80);
    x = Math.floor(x / 0x80);
  }
  out.push(x);
};
const zigzag = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const u32 = (out: number[], v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

interface Spec {
  course?: number;
  season?: number;
  finishTicks?: number;
  frames?: number;
  splits?: number[];
  look?: number[];
  /** Raw bytes of every frame; by default a full first frame, then small ones. */
  body?: number[];
}

/** A version 1 ghost blob. */
function ghost(spec: Spec = {}): Uint8Array {
  const finishTicks = spec.finishTicks ?? 5401;
  const frames = spec.frames ?? Math.ceil(finishTicks / 2) + 1;
  const splits = spec.splits ?? [1800, 3600, finishTicks];
  const look = spec.look ?? [1, 0, 2, 3, 4];
  const out = [1, spec.course ?? 0, spec.season ?? 0, 2];
  u32(out, finishTicks);
  out.push(frames & 0xff, frames >>> 8, splits.length);
  for (const s of splits) u32(out, s);
  out.push(look.length, ...look);
  if (spec.body) {
    out.push(...spec.body);
  } else {
    for (let f = 0; f < frames; f++) {
      if (f === 0) {
        varint(out, 0xffff);
        for (let k = 0; k < 16; k++) varint(out, zigzag(k * 100_000 - 700_000));
      } else if (f % 3 === 0) {
        varint(out, 0);
      } else {
        varint(out, 0b1000_0000_0000_0101);
        for (const v of [-3, 2, 140]) varint(out, zigzag(v));
      }
    }
  }
  return Uint8Array.from(out);
}

const msAt = (ticks: number) => Math.floor((ticks * 1000) / 60);
const run = { course: 0, season: 0, timeMs: msAt(5401) };

void test("a ghost that matches its run is accepted", () => {
  assert.deepEqual(checkGhost(ghost(), run), { finishTicks: 5401, frames: 2702, splits: [1800, 3600, 5401] });
  const snow = ghost({ course: 1, season: 2, finishTicks: 5400, splits: [5400], look: [] });
  assert.deepEqual(checkGhost(snow, { course: 1, season: 2, timeMs: 90_000 }), {
    finishTicks: 5400,
    frames: 2701,
    splits: [5400],
  });
});

/** A ghost `crates/protocol/src/ghost.rs` encodes, byte for byte. */
const RUST_GHOST = Uint8Array.from(
  "0101020205000000040002030000000500000002090882028008020f8010ff07ff1fa610800201c0027f02"
    .match(/../gu)
    ?.map((h) => Number.parseInt(h, 16)) ?? [],
);

void test("the race server's ghosts pass", () => {
  const rust = { course: 1, season: 2, timeMs: 83 };
  assert.deepEqual(checkGhost(RUST_GHOST, rust), { finishTicks: 5, frames: 4, splits: [3, 5] });
  assert.deepEqual([...RUST_GHOST.subarray(19, 22)], [2, 9, 8]);
  assert.equal(checkGhost(RUST_GHOST, { ...rust, timeMs: 84 }), "time");
  assert.equal(checkGhost(RUST_GHOST, { ...rust, course: 0 }), "course");
});

void test("a ghost that doesn't match its run is refused", () => {
  assert.equal(checkGhost(ghost(), { ...run, timeMs: run.timeMs + 1 }), "time");
  assert.equal(checkGhost(ghost({ course: 1 }), run), "course");
  assert.equal(checkGhost(ghost({ season: 3 }), run), "season");
  assert.equal(checkGhost(ghost({ frames: 2701 }), run), "frames");
  const wrongVersion = ghost();
  wrongVersion[0] = 2;
  assert.equal(checkGhost(wrongVersion, run), "version");
  const wrongStep = ghost();
  wrongStep[3] = 1;
  assert.equal(checkGhost(wrongStep, run), "frame_ticks");
  assert.equal(checkGhost(ghost({ finishTicks: 0, frames: 1, splits: [0] }), { ...run, timeMs: 0 }), "finish");
});

void test("a ghost's bytes must walk out exactly", () => {
  const ok = ghost();
  assert.equal(checkGhost(Uint8Array.from([...ok, 0]), run), "trailing");
  assert.equal(checkGhost(ok.subarray(0, ok.length - 1), run), "frame");
  assert.equal(checkGhost(ok.subarray(0, 9), run), "short");
  assert.equal(checkGhost(ghost({ look: Array.from({ length: 65 }, () => 7) }), run), "look");
  assert.equal(checkGhost(new Uint8Array(GHOST_MAX_BYTES + 1), run), "too_big");
  const few = { finishTicks: 4, splits: [4] };
  const t4 = { ...run, timeMs: msAt(4) };
  assert.equal(typeof checkGhost(ghost({ ...few, body: [0, 0, 0] }), t4), "object");
  // A mask of 2^16 and a six-byte residual are malformed.
  assert.equal(checkGhost(ghost({ ...few, body: [0x80, 0x80, 0x04, 0, 0] }), t4), "frame");
  assert.equal(checkGhost(ghost({ ...few, body: [1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0, 0] }), t4), "frame");
  assert.equal(checkGhost(ghost({ ...few, body: [1, 0xff, 0xff, 0xff, 0xff, 0x1f, 0, 0] }), t4), "frame");
  assert.equal(typeof checkGhost(ghost({ ...few, body: [1, 0xff, 0xff, 0xff, 0xff, 0x0f, 0, 0] }), t4), "object");
});

void test("a ghost's splits climb to the finish", () => {
  assert.equal(checkGhost(ghost({ splits: [] }), run), "splits");
  assert.equal(checkGhost(ghost({ splits: [3600, 1800, 5401] }), run), "splits");
  assert.equal(checkGhost(ghost({ splits: [1800, 3600] }), run), "splits");
  assert.equal(checkGhost(ghost({ splits: [1800, 5402] }), run), "splits");
  assert.equal(checkGhost(ghost({ splits: Array.from({ length: 65 }, () => 5401) }), run), "splits");
  assert.equal(typeof checkGhost(ghost({ splits: [1800, 1800, 5401, 5401] }), run), "object");
});

void test("ghosts travel as base64url without padding", () => {
  const bytes = ghost();
  assert.deepEqual(decodeGhost(b64urlEncode(bytes)), bytes);
  assert.equal(decodeGhost(""), null);
  assert.equal(decodeGhost("AAAA="), null);
  assert.equal(decodeGhost("AA+A"), null);
  assert.equal(decodeGhost("AAAAA"), null);
  assert.equal(decodeGhost("A".repeat(200_000)), null);
});

const body = {
  server: "eu1.4shifty.gg:4433",
  room: "t_abc123",
  run: 3,
  pid: "user_1",
  course: 0,
  season: 0,
  timeMs: 123_450,
  ghost: "AQAA",
};

void test("run reports are checked before they are trusted", () => {
  assert.deepEqual(parseRun(body), body);
  assert.equal(parseRun(null), null);
  assert.equal(parseRun([body]), null);
  for (const bad of [
    { run: 0 },
    { run: 65_536 },
    { run: 1.5 },
    { course: 32 },
    { course: -1 },
    { season: 4 },
    { timeMs: "123450" },
    { timeMs: 0 },
    { ghost: 7 },
    { pid: "" },
    { pid: undefined },
    { server: "eu1 4shifty.gg" },
    { room: "t/abc" },
  ])
    assert.equal(parseRun({ ...body, ...bad }), null, JSON.stringify(bad));
});

void test("a time trial names a course and a season", () => {
  assert.deepEqual(parseTrial({ course: 31, season: 3 }), { course: 31, season: 3 });
  assert.equal(parseTrial({ course: 32, season: 0 }), null);
  assert.equal(parseTrial({ course: 0, season: "0" }), null);
  assert.equal(parseTrial({}), null);
  assert.deepEqual(trialQuery("1", "2"), { course: 1, season: 2 });
  assert.equal(trialQuery("1", undefined), null);
  assert.equal(trialQuery("1.0", "2"), null);
  assert.equal(trialQuery("-1", "2"), null);
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 0, 0, s));
const entry = (userId: string, timeMs: number, setAt = at(0)): BoardEntry => ({
  userId,
  name: `Rider ${userId}`,
  tag: 42,
  timeMs,
  setAt,
  ghost: `g_${userId}`,
});

void test("a board ranks by time, ties to whoever set it first", () => {
  const board = shapeBoard(
    { course: 0, season: 1 },
    4,
    [entry("c", 91_000), entry("a", 90_000, at(5)), entry("b", 90_000, at(2)), entry("d", 91_000)],
    null,
    "nobody",
  );
  assert.deepEqual(
    board.top.map((r) => [r.rank, r.handle, r.timeMs, r.ghost]),
    [
      [1, "Rider b#0042", 90_000, "g_b"],
      [2, "Rider a#0042", 90_000, "g_a"],
      [3, "Rider c#0042", 91_000, "g_c"],
      [3, "Rider d#0042", 91_000, "g_d"],
    ],
  );
  assert.equal(board.mine, null);
  assert.equal(board.total, 4);
  assert.equal(board.course, 0);
  assert.equal(board.season, 1);
});

void test("a board shows the top ten, and your own row from outside it", () => {
  const all = Array.from({ length: 12 }, (_, i) => entry(`p${i}`, 80_000 + i * 100));
  const outside = shapeBoard({ course: 0, season: 0 }, 30, all, { entry: entry("me", 99_000), ahead: 24 }, "me");
  assert.equal(outside.top.length, 10);
  assert.deepEqual(
    outside.top.map((r) => r.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.ok(outside.top.every((r) => !r.me));
  assert.deepEqual(outside.mine, { rank: 25, handle: "Rider me#0042", timeMs: 99_000, ghost: "g_me", me: true });

  const inside = shapeBoard({ course: 0, season: 0 }, 12, all, { entry: entry("p3", 80_300), ahead: 3 }, "p3");
  assert.deepEqual(inside.mine, { rank: 4, handle: "Rider p3#0042", timeMs: 80_300, ghost: "g_p3", me: true });
  assert.deepEqual(
    inside.top.filter((r) => r.me).map((r) => r.rank),
    [4],
  );
});
