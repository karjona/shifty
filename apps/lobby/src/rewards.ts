// Credits for racing. Online races pay by finishing place, plus style (trick
// points, capped) and a bonus for finishing a Tilt. Matchmaking
// always pays (even when bots fill the seats); a private room pays only
// races with two or more people in them; single player never pays. Rewards
// are tuned so a full Tilt earns about a fifth of an average item.
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { ledger, player } from "./db/schema.ts";
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
  for (const e of report.entries) {
    if (!e.pid || !known.has(e.pid)) continue;
    out.push({ userId: e.pid, delta: PLACE_CREDITS[e.place - 1] ?? 0, reason: "race", ref });
    const style = Math.min(STYLE_CAP, Math.floor(e.trickPoints / STYLE_POINTS_PER_CREDIT));
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
