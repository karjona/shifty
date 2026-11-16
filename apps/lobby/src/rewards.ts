// Credits for racing. Online races pay by finishing place, plus style (trick
// points, capped) and a bonus for finishing a Tilt. A disqualified rider is
// paid last place's credits and no style. Matchmaking
// always pays (even when bots fill the seats); a private room pays only
// races with two or more people in them; single player never pays. Rewards
// are tuned so a full Tilt earns about a fifth of an average item.
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { ledger, match, matchPlayer, player, raceResult } from "./db/schema.ts";
import type { ResultReport } from "./results.ts";

/** Credits by finishing place (1st to 8th). */
export const PLACE_CREDITS = [100, 85, 72, 62, 54, 47, 41, 36] as const;
/** Trick points per credit, and the most style pays in one race. */
export const STYLE_POINTS_PER_CREDIT = 25;
export const STYLE_CAP = 80;
/** For finishing the last race of a Tilt. */
export const GRAND_PRIX_BONUS = 80;

export interface Payout {
  userId: string;
  delta: number;
  reason: "race" | "style" | "grand_prix";
  ref: string;
}

export interface MatchInfo {
  id: string;
  mode: string;
  event: string;
}

/**
 * What a race report pays, and to whom (players of the match only). `known`
 * are the match's players; `planLength` is how many races its plan has.
 */
export function payouts(report: ResultReport, m: MatchInfo, known: Set<string>, planLength: number): Payout[] {
  const humans = report.entries.filter((e) => e.pid !== null).length;
  if (m.mode === "room" && humans < 2) return [];
  if (m.mode !== "room" && m.mode !== "matchmaking") return [];
  const ref = `${m.id}:${report.round}:${report.event}`;
  const lastOfGrandPrix = m.event === "gp" && report.event === planLength - 1;
  const out: Payout[] = [];
  const last = PLACE_CREDITS[Math.min(report.entries.length, PLACE_CREDITS.length) - 1] ?? 0;
  for (const e of report.entries) {
    if (!e.pid || !known.has(e.pid)) continue;
    const place = e.disqualified ? last : (PLACE_CREDITS[e.place - 1] ?? 0);
    out.push({ userId: e.pid, delta: place, reason: "race", ref });
    const style = e.disqualified ? 0 : Math.min(STYLE_CAP, Math.floor(e.trickPoints / STYLE_POINTS_PER_CREDIT));
    if (style > 0) out.push({ userId: e.pid, delta: style, reason: "style", ref });
    if (lastOfGrandPrix) out.push({ userId: e.pid, delta: GRAND_PRIX_BONUS, reason: "grand_prix", ref });
  }
  return out;
}

/** Pays out once per reason and race: a retried report pays nothing more. */
export async function pay(db: Db, list: Payout[]): Promise<number> {
  let paid = 0;
  for (const p of list) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const done = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(ledger)
        .values({ userId: p.userId, delta: p.delta, reason: p.reason, ref: p.ref })
        .onConflictDoNothing()
        .returning({ id: ledger.id });
      if (rows.length === 0) return false;
      await tx
        .update(player)
        .set({ credits: sql`${player.credits} + ${p.delta}` })
        .where(sql`${player.userId} = ${p.userId}`);
      return true;
    });
    if (done) paid += p.delta;
  }
  return paid;
}

const PAID_REASONS: readonly Payout["reason"][] = ["race", "style", "grand_prix"];

/** What a match paid a player so far, as the ledger has it. */
export interface MatchPay {
  /** `room` or `matchmaking`. */
  mode: string;
  /** The races of the match whose results the lobby has (0-based, in the plan). */
  reported: number[];
  /** Every payout, by race of the plan. */
  paid: { event: number; reason: Payout["reason"]; delta: number }[];
  /** The player's credits now. */
  credits: number;
  /** The player's best place on the circuit asked about, in the matches before this one, never a disqualification (null: none). */
  bestBefore: number | null;
}

/**
 * What a match paid one of its players (null: no such match, or not
 * theirs), and their best place on `course` before it.
 */
export async function matchPay(db: Db, matchId: string, userId: string, course?: number): Promise<MatchPay | null> {
  const [m] = await db
    .select({ mode: match.mode })
    .from(match)
    .innerJoin(matchPlayer, and(eq(matchPlayer.matchId, match.id), eq(matchPlayer.userId, userId)))
    .where(eq(match.id, matchId))
    .limit(1);
  if (!m) return null;
  const prefix = `${matchId}:`;
  const [results, rows, [me]] = await Promise.all([
    db
      .select({ event: raceResult.eventIndex })
      .from(raceResult)
      .where(and(eq(raceResult.matchId, matchId), eq(raceResult.userId, userId))),
    db
      .select({ reason: ledger.reason, delta: ledger.delta, ref: ledger.ref })
      .from(ledger)
      .where(and(eq(ledger.userId, userId), sql`left(${ledger.ref}, ${prefix.length}) = ${prefix}`)),
    db.select({ credits: player.credits }).from(player).where(eq(player.userId, userId)).limit(1),
  ]);
  const [best] =
    course === undefined
      ? []
      : await db
          .select({ place: sql<number | null>`min(${raceResult.place})` })
          .from(raceResult)
          .where(
            and(
              eq(raceResult.userId, userId),
              eq(raceResult.course, course),
              ne(raceResult.matchId, matchId),
              eq(raceResult.disqualified, false),
            ),
          );
  const paid = rows.flatMap((r) => {
    const event = Number(r.ref.slice(prefix.length).split(":")[1]);
    const reason = PAID_REASONS.find((x) => x === r.reason);
    return reason && Number.isInteger(event) ? [{ event, reason, delta: r.delta }] : [];
  });
  return {
    mode: m.mode,
    reported: [...new Set(results.map((r) => r.event))].toSorted((a, b) => a - b),
    paid: paid.toSorted((a, b) => a.event - b.event),
    credits: me?.credits ?? 0,
    bestBefore: best?.place ?? null,
  };
}
