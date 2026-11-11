import { describe, expect, it } from 'vitest';
import { SYSTEM_INVITE_TTL_MS, activeSystemInviteWindow } from './system-invite-lifetime';

describe('Issue #1 6.2: invitation expiry boundary', () => {
  it('treats the created-at seven-day boundary as expired, even if a legacy expiry is missing or much later', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    const window = activeSystemInviteWindow(now);
    expect(SYSTEM_INVITE_TTL_MS).toBe(604_800_000);
    expect(window).toEqual({
      createdAt: { gt: new Date('2026-11-04T12:00:00.000Z') },
      expiresAt: { gt: now },
    });
    const accepted = (createdAt: Date, expiresAt: Date | null) =>
      expiresAt !== null && expiresAt > window.expiresAt.gt && createdAt > window.createdAt.gt;
    expect(accepted(new Date('2026-11-04T12:00:00.000Z'), new Date('2027-11-11T12:00:00.000Z'))).toBe(false);
    expect(accepted(new Date('2026-11-10T12:00:00.000Z'), null)).toBe(false);
    expect(accepted(new Date('2026-11-10T12:00:00.000Z'), now)).toBe(false);
    expect(accepted(new Date('2026-11-10T12:00:00.000Z'), new Date('2026-11-17T12:00:00.000Z'))).toBe(true);
  });
});
