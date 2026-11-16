// Who hosts a room right now. The player who made the room hosts it; while
// they are away (racing the room's race, on their way back from it, or just
// gone a moment) nobody takes it from them. Once they have been away a
// while with the room's race over, the earliest member still in the room
// stands in, until they come back.

/** A started race counts as running (members can rejoin it) this long. */
export const RACE_TTL_MS = 30 * 60_000;
/** The host keeps the room this long after leaving it, or after the room's race ended. */
export const HOST_GRACE_MS = 90_000;

export interface HostState {
  hostId: string;
  /** When the room was made (ms): its host is on their way in. */
  createdAt: number;
  /** When the host's last socket closed (ms; absent while they are in the room). */
  hostAway?: number;
  /** When the room learned its last race was over (ms). */
  raceEndedAt?: number;
  race: { userIds: string[]; at: number } | null;
}

/** The host now: `present` are the members in the room, earliest first. */
export function actingHost(s: HostState, present: readonly string[], now: number): string {
  if (present.includes(s.hostId)) return s.hostId;
  const racing = s.race !== null && now - s.race.at < RACE_TTL_MS && s.race.userIds.includes(s.hostId);
  if (racing) return s.hostId;
  const since = Math.max(s.createdAt, s.hostAway ?? 0, s.raceEndedAt ?? 0);
  if (now - since < HOST_GRACE_MS) return s.hostId;
  return present[0] ?? s.hostId;
}
