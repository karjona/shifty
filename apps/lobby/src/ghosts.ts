// Time trials: tickets for a run alone, the runs race servers report, each
// player's best per course and season with its ghost, and the boards.
//
// A ghost (version 1) is the server's recording of a run. Integers are
// little-endian:
//
//   0   u8   version (1)
//   1   u8   course
//   2   u8   season
//   3   u8   frame_ticks (2: a frame every 2 sim ticks)
//   4   u32  finish_ticks (race ticks at the finish, > 0)
//   8   u16  frames (ceil(finish_ticks / frame_ticks) + 1)
//   10  u8   n, the split count (1-64)
//   11  n × u32 split ticks (non-decreasing, the last at the finish)
//       u8   look_len (0-64), then the rider's appearance bytes
//       `frames` frames: a varint mask (< 2^16), then one varint per set
//       bit (a zigzag-coded i32 residual)
//
// Varints are LEB128. The frames end the blob exactly. The lobby only walks
// them to check the count; clients decode the values.
import { and, asc, count, eq, lt, or, sql } from "drizzle-orm";
import { openDb, type Db } from "./db/client.ts";
import { player, timeTrialBest, timeTrialRun } from "./db/schema.ts";
import { databaseUrl, type Env } from "./env.ts";
import { formatHandle } from "./handles.ts";
import { isRecord } from "./json.ts";
import { type Racer, pickServer } from "./matches.ts";
import { type RiderClaims, loadRiderClaims } from "./riders.ts";
import { type JoinTicket, b64urlDecode, b64urlEncode, mintTicket, roomId } from "./tickets.ts";

export const GHOST_VERSION = 1;
/** Sim ticks per ghost frame (the sim runs at 60 Hz). */
export const FRAME_TICKS = 2;
export const TICKS_PER_SECOND = 60;
export const GHOST_MAX_BYTES = 131_072;
const MAX_SPLITS = 64;
const MAX_LOOK = 64;
/** Highest course id a time trial may name. */
export const MAX_COURSE = 31;
export const SEASONS = 4;
/** How many rows a board shows. */
export const BOARD_TOP = 10;

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

export interface Trial {
  course: number;
  season: number;
}

/** A course and season to race or look up, checked. */
export function parseTrial(v: { course?: unknown; season?: unknown }): Trial | null {
  const course = int(v.course, 0, MAX_COURSE);
  const season = int(v.season, 0, SEASONS - 1);
  return course === null || season === null ? null : { course, season };
}

const queryNumber = (s: string | undefined) => (s !== undefined && /^\d{1,2}$/u.test(s) ? Number(s) : null);

/** A course and season from query strings (`?course=0&season=2`). */
export function trialQuery(course: string | undefined, season: string | undefined): Trial | null {
  return parseTrial({ course: queryNumber(course), season: queryNumber(season) });
}

/** A time trial: the player alone on a race server, every run reported back. */
export async function startTimeTrial(env: Env, racer: Racer, course: number, season: number): Promise<JoinTicket> {
  const server = await pickServer(env);
  const { db, close } = openDb(databaseUrl(env));
  let rider: RiderClaims | undefined;
  try {
    rider = (await loadRiderClaims(db, [racer.userId])).get(racer.userId);
  } finally {
    await close();
  }
  return mintTicket(env.LOBBY_SIGNING_KEY, {
    server,
    room: roomId("t"),
    pid: racer.userId,
    name: racer.handle,
    event: "summer",
    bots: 0,
    rider,
    humans: 1,
    trial: { course, season },
  });
}

/** A finished run, as a race server reports it. */
export interface RunReport {
  /** The reporting race server's public address. */
  server: string;
  room: string;
  /** The attempt in that room, from 1. */
  run: number;
  pid: string;
  course: number;
  season: number;
  timeMs: number;
  /** The ghost, base64url without padding. */
  ghost: string;
}

/** Validates a run report body instead of trusting its shape. */
export function parseRun(v: unknown): RunReport | null {
  if (!isRecord(v)) return null;
  const run = int(v.run, 1, 65_535);
  const trial = parseTrial(v);
  const timeMs = int(v.timeMs, 1, 3_600_000);
  if (typeof v.server !== "string" || !/^[\w.[\]:-]{1,255}$/u.test(v.server)) return null;
  if (typeof v.room !== "string" || !/^[\w-]{1,64}$/u.test(v.room)) return null;
  if (typeof v.pid !== "string" || v.pid.length === 0 || v.pid.length > 255) return null;
  if (typeof v.ghost !== "string" || run === null || trial === null || timeMs === null) return null;
  return { server: v.server, room: v.room, run, pid: v.pid, ...trial, timeMs, ghost: v.ghost };
}

/** The ghost's bytes from base64url without padding, or null if it isn't that (or is too big). */
export function decodeGhost(s: string): Uint8Array<ArrayBuffer> | null {
  if (s.length === 0 || s.length > Math.ceil((GHOST_MAX_BYTES * 4) / 3)) return null;
  if (s.length % 4 === 1 || !/^[\w-]+$/u.test(s)) return null;
  try {
    return b64urlDecode(s);
  } catch {
    return null;
  }
}

export interface GhostInfo {
  finishTicks: number;
  frames: number;
  /** Race ticks at each split point; the last is the finish. */
  splits: number[];
}

/** A LEB128 varint of at most `maxBytes` bytes at `at`: its value and the offset after it. */
function varint(bytes: Uint8Array, at: number, maxBytes: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < maxBytes; i++) {
    const b = bytes[at + i];
    if (b === undefined) return null;
    value += (b & 0x7f) * 2 ** (7 * i);
    if (b < 0x80) return { value, next: at + i + 1 };
  }
  return null;
}

const bitCount = (mask: number) => {
  let n = 0;
  for (let m = mask; m > 0; m >>>= 1) n += m & 1;
  return n;
};

/** Walks `frames` frames from `at`: the offset after them, or null if one is cut short or malformed. */
function walkFrames(bytes: Uint8Array, at: number, frames: number): number | null {
  let pos = at;
  for (let f = 0; f < frames; f++) {
    const mask = varint(bytes, pos, 3);
    if (!mask || mask.value >= 2 ** 16) return null;
    pos = mask.next;
    for (let k = bitCount(mask.value); k > 0; k--) {
      const residual = varint(bytes, pos, 5);
      if (!residual || residual.value > 0xffff_ffff) return null;
      pos = residual.next;
    }
  }
  return pos;
}

/**
 * Checks a ghost against the run it records: what it says, or an error code
 * (`too_big`, `short`, `version`, `course`, `season`, `frame_ticks`,
 * `finish`, `time`, `frames`, `splits`, `look`, `frame`, `trailing`).
 */
export function checkGhost(
  bytes: Uint8Array,
  run: Pick<RunReport, "course" | "season" | "timeMs">,
): GhostInfo | string {
  if (bytes.length > GHOST_MAX_BYTES) return "too_big";
  const head = 11;
  if (bytes.length < head) return "short";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== GHOST_VERSION) return "version";
  if (bytes[1] !== run.course) return "course";
  if (bytes[2] !== run.season) return "season";
  if (bytes[3] !== FRAME_TICKS) return "frame_ticks";
  const finishTicks = view.getUint32(4, true);
  if (finishTicks === 0) return "finish";
  if (run.timeMs !== Math.floor((finishTicks * 1000) / TICKS_PER_SECOND)) return "time";
  const frames = view.getUint16(8, true);
  if (frames !== Math.ceil(finishTicks / FRAME_TICKS) + 1) return "frames";
  const n = view.getUint8(10);
  if (n < 1 || n > MAX_SPLITS) return "splits";
  let at = head;
  if (bytes.length < at + n * 4 + 1) return "short";
  const splits: number[] = [];
  for (let i = 0; i < n; i++, at += 4) {
    const t = view.getUint32(at, true);
    if (t > finishTicks || t < (splits.at(-1) ?? 0)) return "splits";
    splits.push(t);
  }
  if (splits.at(-1) !== finishTicks) return "splits";
  const lookLen = view.getUint8(at);
  if (lookLen > MAX_LOOK) return "look";
  at += 1 + lookLen;
  if (at > bytes.length) return "short";
  const end = walkFrames(bytes, at, frames);
  if (end === null) return "frame";
  if (end !== bytes.length) return "trailing";
  return { finishTicks, frames, splits };
}

/** A new ghost id: random and url-safe. */
const newGhostId = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

export const isGhostId = (s: string) => /^[\w-]{22}$/u.test(s);

export type StoreRunResult = { stored: false } | { stored: true; best: boolean };

/**
 * Keeps a checked run (once per room and attempt) and makes it the player's
 * best for its course and season if it is strictly faster. Runs of unknown
 * players are dropped.
 */
export async function storeRun(db: Db, run: RunReport, ghost: Uint8Array<ArrayBuffer>): Promise<StoreRunResult> {
  const [known] = await db.select({ userId: player.userId }).from(player).where(eq(player.userId, run.pid)).limit(1);
  if (!known) return { stored: false };
  return db.transaction(async (tx) => {
    const [kept] = await tx
      .insert(timeTrialRun)
      .values({
        room: run.room,
        run: run.run,
        userId: run.pid,
        course: run.course,
        season: run.season,
        timeMs: run.timeMs,
      })
      .onConflictDoNothing({ target: [timeTrialRun.room, timeTrialRun.run] })
      .returning({ id: timeTrialRun.id });
    if (!kept) return { stored: false } as const;
    const [best] = await tx
      .insert(timeTrialBest)
      .values({
        id: newGhostId(),
        userId: run.pid,
        course: run.course,
        season: run.season,
        timeMs: run.timeMs,
        ghost,
      })
      .onConflictDoUpdate({
        target: [timeTrialBest.userId, timeTrialBest.course, timeTrialBest.season],
        set: {
          id: sql`excluded.id`,
          timeMs: sql`excluded.time_ms`,
          ghost: sql`excluded.ghost`,
          setAt: sql`excluded.set_at`,
        },
        setWhere: sql`${timeTrialBest.timeMs} > excluded.time_ms`,
      })
      .returning({ id: timeTrialBest.id });
    return { stored: true, best: best !== undefined } as const;
  });
}

/** A best on a board, as read from the database. */
export interface BoardEntry {
  userId: string;
  name: string;
  tag: number;
  timeMs: number;
  setAt: Date;
  /** The ghost's id. */
  ghost: string;
}

export interface BoardRow {
  rank: number;
  handle: string;
  timeMs: number;
  ghost: string;
  me: boolean;
}

export interface Board extends Trial {
  /** How many players have a time on the board. */
  total: number;
  top: BoardRow[];
  /** The signed-in player's row, or null if they have no time on it. */
  mine: BoardRow | null;
}

/** Whether `a` ranks ahead of `b`: faster, or as fast and set earlier. */
export const ahead = (a: BoardEntry, b: BoardEntry) =>
  a.timeMs < b.timeMs || (a.timeMs === b.timeMs && a.setAt.getTime() < b.setAt.getTime());

const row = (e: BoardEntry, rank: number, me: string): BoardRow => ({
  rank,
  handle: formatHandle(e.name, e.tag),
  timeMs: e.timeMs,
  ghost: e.ghost,
  me: e.userId === me,
});

/**
 * A board from its best entries (any order) and the signed-in player's
 * entry with how many entries rank ahead of it. A rank is 1 + the entries
 * ahead of it.
 */
export function shapeBoard(
  trial: Trial,
  total: number,
  best: BoardEntry[],
  mine: { entry: BoardEntry; ahead: number } | null,
  me: string,
): Board {
  const sorted = best.toSorted((a, b) => (ahead(a, b) ? -1 : ahead(b, a) ? 1 : 0)).slice(0, BOARD_TOP);
  const top: BoardRow[] = [];
  for (const [i, e] of sorted.entries()) {
    const prev = sorted[i - 1];
    const rank = prev && !ahead(prev, e) ? (top[i - 1]?.rank ?? i + 1) : i + 1;
    top.push(row(e, rank, me));
  }
  const inTop = top.find((r) => r.me) ?? null;
  return {
    ...trial,
    total,
    top,
    mine: inTop ?? (mine ? row(mine.entry, mine.ahead + 1, me) : null),
  };
}

const onBoard = ({ course, season }: Trial) => and(eq(timeTrialBest.course, course), eq(timeTrialBest.season, season));

const entryColumns = {
  userId: timeTrialBest.userId,
  name: player.name,
  tag: player.tag,
  timeMs: timeTrialBest.timeMs,
  setAt: timeTrialBest.setAt,
  ghost: timeTrialBest.id,
};

/** The board of a course and season, as the signed-in player sees it. */
export async function loadBoard(db: Db, trial: Trial, userId: string): Promise<Board> {
  const [best, totals, own] = await Promise.all([
    db
      .select(entryColumns)
      .from(timeTrialBest)
      .innerJoin(player, eq(player.userId, timeTrialBest.userId))
      .where(onBoard(trial))
      .orderBy(asc(timeTrialBest.timeMs), asc(timeTrialBest.setAt), asc(timeTrialBest.id))
      .limit(BOARD_TOP),
    db.select({ n: count() }).from(timeTrialBest).where(onBoard(trial)),
    db
      .select(entryColumns)
      .from(timeTrialBest)
      .innerJoin(player, eq(player.userId, timeTrialBest.userId))
      .where(and(onBoard(trial), eq(timeTrialBest.userId, userId)))
      .limit(1),
  ]);
  const entry = own[0];
  let mine: { entry: BoardEntry; ahead: number } | null = null;
  if (entry) {
    const [before] = await db
      .select({ n: count() })
      .from(timeTrialBest)
      .where(
        and(
          onBoard(trial),
          or(
            lt(timeTrialBest.timeMs, entry.timeMs),
            and(eq(timeTrialBest.timeMs, entry.timeMs), lt(timeTrialBest.setAt, entry.setAt)),
          ),
        ),
      );
    mine = { entry, ahead: before?.n ?? 0 };
  }
  return shapeBoard(trial, totals[0]?.n ?? 0, best, mine, userId);
}

/** A ghost's bytes, or null if there is none with that id. */
export async function ghostBytes(db: Db, id: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const [found] = await db
    .select({ ghost: timeTrialBest.ghost })
    .from(timeTrialBest)
    .where(eq(timeTrialBest.id, id))
    .limit(1);
  return found?.ghost ?? null;
}
