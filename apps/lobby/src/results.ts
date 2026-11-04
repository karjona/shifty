// Race results reported by race servers. Only matches the lobby started are
// kept (not single player), and only for that match's players.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { match, matchPlayer, raceResult } from "./db/schema.ts";
import { isRecord } from "./json.ts";

export interface ResultReport {
  room: string;
  round: number;
  event: number;
  course: number;
  entries: {
    /** Account id; null for bots. */
    pid: string | null;
    place: number;
    timeMs: number | null;
    trickPoints: number;
    gpPoints: number | null;
  }[];
}

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** Validates a report body instead of trusting its shape. */
export function parseReport(v: unknown): ResultReport | null {
  if (!isRecord(v)) return null;
  const o = v;
  const round = int(o.round, 0, 32_767);
  const event = int(o.event, 0, 31);
  const course = int(o.course, 0, 255);
  if (typeof o.room !== "string" || round === null || event === null || course === null) return null;
  if (!Array.isArray(o.entries) || o.entries.length > 8) return null;
  const entries: ResultReport["entries"] = [];
  for (const x of o.entries as unknown[]) {
    if (!isRecord(x)) return null;
    const place = int(x.place, 1, 8);
    const trickPoints = int(x.trickPoints, 0, 1_000_000);
    if (place === null || trickPoints === null) return null;
    if (x.pid !== null && typeof x.pid !== "string") return null;
    entries.push({
      pid: x.pid,
      place,
      timeMs: x.timeMs === null ? null : int(x.timeMs, 0, 3_600_000),
      trickPoints,
      gpPoints: x.gpPoints === null ? null : int(x.gpPoints, 0, 10_000),
    });
  }
  return { room: o.room, round, event, course, entries };
}

export async function storeReport(db: Db, report: ResultReport): Promise<number> {
  const [m] = await db.select({ id: match.id }).from(match).where(eq(match.id, report.room)).limit(1);
  if (!m) return 0;
  const pids = report.entries.flatMap((e) => (e.pid ? [e.pid] : []));
  if (pids.length === 0) return 0;
  const players = await db
    .select({ userId: matchPlayer.userId })
    .from(matchPlayer)
    .where(and(eq(matchPlayer.matchId, m.id), inArray(matchPlayer.userId, pids)));
  const known = new Set(players.map((p) => p.userId));
  const rows = report.entries
    .filter((e) => e.pid && known.has(e.pid))
    .map((e) => ({
      matchId: m.id,
      round: report.round,
      eventIndex: report.event,
      course: report.course,
      userId: e.pid,
      place: e.place,
      timeMs: e.timeMs,
      trickPoints: e.trickPoints,
      gpPoints: e.gpPoints,
    }));
  if (rows.length === 0) return 0;
  await db.insert(raceResult).values(rows).onConflictDoNothing();
  return rows.length;
}
