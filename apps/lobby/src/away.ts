// Members whose socket dropped (a network blip, a page that reloads) are
// kept a while for their screen to reconnect: a room shows them as still
// there and keeps their place; the matchmaking queue keeps their place in
// line. Leaving on purpose (a close with code 1000, or a `leave` message)
// lets go at once.

/** A room keeps a dropped member this long (ms). */
export const ROOM_AWAY_MS = 30_000;
/** The matchmaking queue keeps a dropped player's place this long (ms). */
export const QUEUE_AWAY_MS = 20_000;

/** A socket closed on purpose: the player meant to go. */
export const closedOnPurpose = (code: number): boolean => code === 1000;

/** Someone gone since `at` (ms), and what is kept for them. */
export interface Away<T> {
  userId: string;
  at: number;
  kept: T;
}

/** The list with `userId` gone since `now` (an earlier entry for them is replaced). */
export function goneAway<T>(list: readonly Away<T>[], userId: string, kept: T, now: number): Away<T>[] {
  return [...list.filter((a) => a.userId !== userId), { userId, at: now, kept }];
}

/** Those still away at `now`: back (in `present`) or gone longer than `grace` drop out. */
export function stillAway<T>(
  list: readonly Away<T>[],
  present: ReadonlySet<string>,
  now: number,
  grace: number,
): Away<T>[] {
  return list.filter((a) => !present.has(a.userId) && now - a.at < grace);
}

/** What was kept for `userId`, if they are still within `grace` of going. */
export function keptFor<T>(list: readonly Away<T>[], userId: string, now: number, grace: number): T | null {
  const a = list.find((x) => x.userId === userId);
  return a && now - a.at < grace ? a.kept : null;
}

/** When the next of them runs out (ms), or null if nobody is away. */
export function nextExpiry<T>(list: readonly Away<T>[], grace: number): number | null {
  return list.length === 0 ? null : Math.min(...list.map((a) => a.at + grace));
}

/** A room's member, as the room keeps them (`look`: their appearance bytes, base64url, as the lobby has them). */
export interface RoomMember {
  userId: string;
  handle: string;
  ready: boolean;
  joinedAt: number;
  look: string;
}

/** A member as the room shows them: `away` while their screen reconnects. */
export interface ShownMember {
  userId: string;
  handle: string;
  ready: boolean;
  look: string;
  away?: true;
}

/** The room's members at `now`: those connected, and those still within the grace of a drop, earliest first. */
export function shownMembers(
  connected: readonly RoomMember[],
  away: readonly Away<RoomMember>[],
  now: number,
): ShownMember[] {
  const here = new Set(connected.map((m) => m.userId));
  const rows = [
    ...connected.map((m) => ({ m, gone: false })),
    ...stillAway(away, here, now, ROOM_AWAY_MS).map((a) => ({ m: a.kept, gone: true })),
  ];
  return rows
    .toSorted((a, b) => a.m.joinedAt - b.m.joinedAt)
    .map(({ m, gone }) => {
      const out: ShownMember = { userId: m.userId, handle: m.handle, ready: m.ready, look: m.look };
      if (gone) out.away = true;
      return out;
    });
}
