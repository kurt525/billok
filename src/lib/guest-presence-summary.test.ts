import { describe, expect, test } from 'vitest';
import { guestPresenceSummary } from './guest-presence-summary';

const people = [
  { id: 'creator-id', hasJoined: true },
  { id: 'guest-a', hasJoined: true },
  { id: 'guest-b', hasJoined: false },
  { id: 'guest-c', hasJoined: true },
];

describe('Issue 3.12: unique invitee, joined and online counters', () => {
  test('creator is excluded; joined includes offline, online is only fresh presence', () => {
    expect(
      guestPresenceSummary(
        people,
        [
          { personId: 'creator-id', status: 'online' },
          { personId: 'guest-a', status: 'online' },
          { personId: 'guest-b', status: 'not-joined' },
          { personId: 'guest-c', status: 'offline' },
        ],
        'creator-id',
      ),
    ).toEqual({ invited: 3, waiting: 1, joined: 2, online: 1 });
  });

  test('two or more device records for the same person never inflate counters', () => {
    const duplicated = [
      { personId: 'guest-a', status: 'online' as const },
      { personId: 'guest-a', status: 'online' as const },
      { personId: 'guest-a', status: 'online' as const },
      { personId: 'guest-c', status: 'joined' as const },
    ];
    expect(guestPresenceSummary(people, duplicated, 'creator-id')).toEqual({
      invited: 3,
      waiting: 1,
      joined: 2,
      online: 1,
    });
  });

  test('a second unique guest joining moves only waiting to joined', () => {
    const next = people.map((person) => (person.id === 'guest-b' ? { ...person, hasJoined: true } : person));
    const presences = [
      { personId: 'guest-a', status: 'online' as const },
      { personId: 'guest-b', status: 'joined' as const },
      { personId: 'guest-c', status: 'offline' as const },
    ];
    expect(guestPresenceSummary(next, presences, 'creator-id')).toEqual({
      invited: 3,
      waiting: 0,
      joined: 3,
      online: 1,
    });
    expect(guestPresenceSummary(next, [...presences, { personId: 'guest-b', status: 'online' }], 'creator-id')).toEqual(
      { invited: 3, waiting: 0, joined: 3, online: 2 },
    );
  });

  test('changed names, deleted guests, and stale heartbeats never create phantom participants', () => {
    const reduced = [
      { id: 'guest-c', hasJoined: true, name: 'Илья' },
      { id: 'creator-id', hasJoined: true, name: 'Илья П.' },
      { id: 'guest-a', hasJoined: true, name: 'Алексей' },
    ];
    expect(
      guestPresenceSummary(
        reduced,
        [
          { personId: 'guest-b', status: 'online' },
          { personId: 'guest-c', status: 'offline' },
          { personId: 'guest-a', status: 'online' },
        ],
        'creator-id',
      ),
    ).toEqual({ invited: 2, waiting: 0, joined: 2, online: 1 });
  });

  test('legacy receipts and unclaimed slots have meaningful totals', () => {
    expect(guestPresenceSummary(people, [])).toEqual({
      invited: 4,
      waiting: 1,
      joined: 3,
      online: 0,
    });
    expect(guestPresenceSummary([{ id: 'creator-id', hasJoined: true }], [], 'creator-id')).toEqual({
      invited: 0,
      waiting: 0,
      joined: 0,
      online: 0,
    });
  });
});
