// Game profiles: the handle, and the social card (title and background).
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { player } from "./db/schema.ts";
import {
  checkName,
  cleanName,
  formatHandle,
  nameKey,
  type NameProblem,
  RENAME_COOLDOWN_MS,
  randomTag,
} from "./handles.ts";

export const TITLES = ["rookie", "local", "regular", "all_seasons"] as const;
export const CARDS = ["bay", "peaks", "sunset", "night"] as const;
export type Title = (typeof TITLES)[number];
export type Card = (typeof CARDS)[number];

export interface PlayerView {
  name: string;
  tag: number;
  handle: string;
  title: string;
  card: string;
  /** When the name may change again (ms since epoch); 0 = now. */
  renameAt: number;
}

type Row = typeof player.$inferSelect;

export function view(row: Row, now = Date.now()): PlayerView {
  const renameAt = row.nameChangedAt.getTime() + RENAME_COOLDOWN_MS;
  return {
    name: row.name,
    tag: row.tag,
    handle: formatHandle(row.name, row.tag),
    title: row.title,
    card: row.card,
    renameAt: renameAt > now ? renameAt : 0,
  };
}

export async function getPlayer(db: Db, userId: string): Promise<Row | null> {
  const [row] = await db.select().from(player).where(eq(player.userId, userId)).limit(1);
  return row ?? null;
}

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && e.code === UNIQUE_VIOLATION;

export const isTitle = (v: unknown): v is Title => typeof v === "string" && (TITLES as readonly string[]).includes(v);
export const isCard = (v: unknown): v is Card => typeof v === "string" && (CARDS as readonly string[]).includes(v);

export type ClaimResult = { ok: true; player: Row } | { ok: false; problem: NameProblem | "cooldown" | "taken" };

/**
 * Gives the user this name, with a free tag (the current one if it is free
 * for the new name). A new name is allowed once a week; changing only the
 * case or accents of the current one is always allowed.
 */
export async function claimHandle(db: Db, userId: string, raw: string, now = new Date()): Promise<ClaimResult> {
  const problem = checkName(raw);
  if (problem) return { ok: false, problem };
  const name = cleanName(raw);
  const key = nameKey(name);
  const current = await getPlayer(db, userId);
  const sameName = current?.nameKey === key;
  if (current && !sameName && current.nameChangedAt.getTime() + RENAME_COOLDOWN_MS > now.getTime()) {
    return { ok: false, problem: "cooldown" };
  }
  const tags = [current?.tag ?? randomTag(), ...Array.from({ length: 40 }, randomTag)];
  for (const tag of tags) {
    try {
      if (!current) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const [row] = await db.insert(player).values({ userId, name, nameKey: key, tag }).returning();
        if (row) return { ok: true, player: row };
      } else {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const [row] = await db
          .update(player)
          .set({ name, nameKey: key, tag, ...(sameName ? {} : { nameChangedAt: now }) })
          .where(eq(player.userId, userId))
          .returning();
        if (row) return { ok: true, player: row };
      }
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return { ok: false, problem: "taken" };
}

export async function setCard(db: Db, userId: string, title: Title, card: Card): Promise<Row | null> {
  const [row] = await db.update(player).set({ title, card }).where(eq(player.userId, userId)).returning();
  return row ?? null;
}
