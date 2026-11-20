import type { GuestPresenceState } from './guest-presence';

export type GuestPresencePerson = { id: string; hasJoined: boolean };
export type GuestPresenceEntry = { personId: string; status: GuestPresenceState };
export type GuestPresenceSummary = {
  invited: number;
  waiting: number;
  joined: number;
  online: number;
};

/**
 * 3.12: The counter measures DISTINCT invitees by server-assigned personId,
 * never browser device IDs, heartbeats, names, or number of opened tabs.
 * The receipt creator is not an invitee; do not count their page heartbeat.
 *
 * A joined person can be offline (or not yet have a heartbeat): joined is
 * cumulative, online is a subset with a fresh server-validated heartbeat.
 */
export function guestPresenceSummary(
  people: readonly GuestPresencePerson[],
  presence: readonly GuestPresenceEntry[],
  organizerPersonId?: string,
): GuestPresenceSummary {
  const stateById = new Map(presence.map(({ personId, status }) => [personId, status]));
  const unique = new Set<string>();
  let waiting = 0;
  let joined = 0;
  let online = 0;
  for (const person of people) {
    if (!person.id || person.id === organizerPersonId || unique.has(person.id)) continue;
    unique.add(person.id);
    const status = stateById.get(person.id);
    // An account-bound row may be allocated before its first device heartbeat,
    // so do not mistake the number of devices for joined participant count.
    if (person.hasJoined || (status !== undefined && status !== 'not-joined')) {
      joined++;
      if (status === 'online') online++;
    } else {
      waiting++;
    }
  }
  return { invited: unique.size, waiting, joined, online };
}
