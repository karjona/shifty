// A player's rider: what they look like and wear, their setups, the items
// they own and their credits. The lobby is the only place these change;
// join tokens carry them (signed) to the race server.
import {
  type Appearance,
  type Item,
  type Kit,
  type Outfits,
  SLOTS,
  SPORTS,
  STARTER,
  type Setups,
  defaultSetups,
  encodeAppearance,
  item,
  kitProblem,
  parseLook,
  parseSetup,
  setupBytes,
  toBase64Url,
} from "@shifty/rider";
import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { inventory, ledger, player } from "./db/schema.ts";
import { isRecord } from "./json.ts";

const STARTER_IDS = new Set(STARTER.map((i) => i.id));

export interface RiderView {
  /** Null until the player has made their rider. */
  appearance: Appearance | null;
  setups: Setups;
  credits: number;
  /** Every item the player can wear (starter kit included). */
  owned: string[];
}

export async function ownedItems(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db.select({ item: inventory.item }).from(inventory).where(eq(inventory.userId, userId));
  return new Set([...STARTER_IDS, ...rows.map((r) => r.item)]);
}

type PlayerRow = typeof player.$inferSelect;

export async function riderView(db: Db, row: PlayerRow): Promise<RiderView> {
  const owned = await ownedItems(db, row.userId);
  return {
    appearance: row.appearance ?? null,
    setups: row.setups ?? defaultSetups(),
    credits: row.credits,
    owned: [...owned],
  };
}

/** Parses an untrusted appearance; null with a reason if it isn't one this player can wear. */
export function parseAppearance(v: unknown, owns: (id: string) => boolean): Appearance | string {
  if (!isRecord(v)) return "bad_request";
  const look = parseLook(v.look);
  if (!look) return "bad_look";
  if (!isRecord(v.outfits)) return "bad_outfit";
  const outfits: Outfits = { summer: {}, winter: {} };
  for (const sport of SPORTS) {
    const raw = v.outfits[sport];
    if (!isRecord(raw)) return "bad_outfit";
    const kit: Kit = {};
    for (const slot of SLOTS[sport]) {
      const id = raw[slot];
      if (id === undefined || id === null) continue;
      if (typeof id !== "string") return "bad_outfit";
      kit[slot] = id;
    }
    if (Object.keys(raw).some((k) => !(SLOTS[sport] as readonly string[]).includes(k))) return "bad_outfit";
    if (kitProblem(sport, kit, look.body, owns)) return "bad_outfit";
    outfits[sport] = kit;
  }
  return { look, outfits };
}

export function parseSetups(v: unknown): Setups | null {
  if (!isRecord(v)) return null;
  const out = defaultSetups();
  for (const sport of SPORTS) {
    const s = parseSetup(v[sport]);
    if (!s) return null;
    out[sport] = s;
  }
  return out;
}

export async function saveAppearance(db: Db, userId: string, a: Appearance): Promise<PlayerRow | null> {
  const [row] = await db.update(player).set({ appearance: a }).where(eq(player.userId, userId)).returning();
  return row ?? null;
}

export async function saveSetups(db: Db, userId: string, s: Setups): Promise<PlayerRow | null> {
  const [row] = await db.update(player).set({ setups: s }).where(eq(player.userId, userId)).returning();
  return row ?? null;
}

export type BuyResult = { ok: true; credits: number } | { ok: false; error: "unknown" | "owned" | "free" | "credits" };

/**
 * Buys an item: the credits and the item change together or not at all,
 * and the balance can never go below zero.
 */
export async function buy(db: Db, userId: string, id: string): Promise<BuyResult> {
  const it: Item | undefined = item(id);
  if (!it) return { ok: false, error: "unknown" };
  if (it.price === 0) return { ok: false, error: "free" };
  return db.transaction(async (tx) => {
    const [had] = await tx
      .select({ item: inventory.item })
      .from(inventory)
      .where(and(eq(inventory.userId, userId), eq(inventory.item, id)))
      .limit(1);
    if (had) return { ok: false, error: "owned" } as const;
    const [paid] = await tx
      .update(player)
      .set({ credits: sql`${player.credits} - ${it.price}` })
      .where(and(eq(player.userId, userId), gte(player.credits, it.price)))
      .returning({ credits: player.credits });
    if (!paid) return { ok: false, error: "credits" } as const;
    await tx.insert(inventory).values({ userId, item: id, source: "shop" });
    await tx.insert(ledger).values({ userId, delta: -it.price, reason: "purchase", ref: id });
    return { ok: true, credits: paid.credits } as const;
  });
}

/** What a join token carries about the rider: appearance bytes and setups per sport. */
export interface RiderClaims {
  look: string;
  setups: number[][];
}

export function riderClaims(row: Pick<PlayerRow, "appearance" | "setups"> | null): RiderClaims {
  const setups = row?.setups ?? defaultSetups();
  return {
    look: row?.appearance ? toBase64Url(encodeAppearance(row.appearance)) : "",
    setups: SPORTS.map((s) => setupBytes(setups[s])),
  };
}

/** Rider claims for several players at once. */
export async function loadRiderClaims(db: Db, userIds: string[]): Promise<Map<string, RiderClaims>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: player.userId, appearance: player.appearance, setups: player.setups })
    .from(player)
    .where(inArray(player.userId, userIds));
  return new Map(rows.map((r) => [r.userId, riderClaims(r)]));
}

/** The player's latest earnings (newest first), for "you earned" notes after a race. */
export async function recentEarnings(db: Db, userId: string, limit = 20) {
  const rows = await db
    .select({ id: ledger.id, delta: ledger.delta, reason: ledger.reason, ref: ledger.ref, at: ledger.createdAt })
    .from(ledger)
    .where(and(eq(ledger.userId, userId), gt(ledger.delta, 0)))
    .orderBy(desc(ledger.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, delta: r.delta, reason: r.reason, ref: r.ref, at: r.at.getTime() }));
}
