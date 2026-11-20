/** 3.5: a heartbeat means a claim page is currently connected, not that a user joined. */
export const GUEST_PRESENCE_HEARTBEAT_MS = 15_000;
export const GUEST_PRESENCE_TTL_MS = 45_000;

export type GuestPresenceState = 'not-joined' | 'joined' | 'online' | 'offline';

/** A joined person stays joined when their device goes offline or closes the page. */
export function guestPresenceState(
  joined: boolean,
  lastSeenAt: Date | null | undefined,
  nowMs = Date.now(),
): GuestPresenceState {
  if (!joined) return 'not-joined';
  if (!lastSeenAt || !Number.isFinite(lastSeenAt.getTime())) return 'joined';
  return lastSeenAt.getTime() > nowMs - GUEST_PRESENCE_TTL_MS && lastSeenAt.getTime() <= nowMs + 5000
    ? 'online'
    : 'offline';
}
