// Invite codes: making, reading and using them. The sign-up gate that
// spends them is in invites.ts.
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { invite } from "./db/schema.ts";

/** Letters and digits that can't be mistaken for each other (no 0/O, 1/I/L). */
export const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 8;
const CODE = new RegExp(`^[${INVITE_ALPHABET}]{${LENGTH}}$`, "u");

/** A new random code, like `K7Q2XM9P`. */
export function newInviteCode(): string {
  // Bytes at or above the last whole multiple of the alphabet are skipped, so
  // every character is equally likely.
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  let code = "";
  while (code.length < LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(LENGTH))) {
      if (b < limit && code.length < LENGTH) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
    }
  }
  return code;
}

/** The code as stored, from what a player typed (any case, spaces and dashes); null if it can't be one. */
export function normalizeInviteCode(input: string): string | null {
  const code = input.toUpperCase().replaceAll(/[\s-]/gu, "");
  return CODE.test(code) ? code : null;
}

/** How a code is shown: `K7Q2-XM9P`. */
export const formatInviteCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const usableNow = () =>
  and(lt(invite.uses, invite.maxUses), or(isNull(invite.expiresAt), gt(invite.expiresAt, new Date())));

/** Whether the code exists and has a use left. */
export async function inviteUsable(db: Db, code: string): Promise<boolean> {
  const rows = await db
    .select({ code: invite.code })
    .from(invite)
    .where(and(eq(invite.code, code), usableNow()))
    .limit(1);
  return rows.length > 0;
}

/** Takes one use of the code; false if it is unknown, used up or expired. */
export async function takeInvite(db: Db, code: string): Promise<boolean> {
  const rows = await db
    .update(invite)
    .set({ uses: sql`${invite.uses} + 1` })
    .where(and(eq(invite.code, code), usableNow()))
    .returning({ code: invite.code });
  return rows.length > 0;
}

export interface NewInvites {
  count: number;
  /** Accounts each code can make. */
  uses: number;
  /** Days until the codes expire; null for never. */
  days: number | null;
  note: string | null;
}

/** Makes `count` codes and returns them. */
export async function createInvites(db: Db, { count, uses, days, note }: NewInvites): Promise<string[]> {
  const expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const codes = Array.from({ length: count }, newInviteCode);
  await db.insert(invite).values(codes.map((code) => ({ code, note, maxUses: uses, expiresAt })));
  return codes;
}

/** Every code, newest first. */
export async function listInvites(db: Db) {
  return db.select().from(invite).orderBy(desc(invite.createdAt));
}
