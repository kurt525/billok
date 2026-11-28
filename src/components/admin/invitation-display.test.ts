import { describe, expect, it } from 'vitest';
import { invitationDisplay } from './invitation-display';
import { createAuditDateFormatter } from './audit-log-format';

const createdAt = '2026-11-28T22:15:32.000Z';
const expiresAt = '2026-12-05T22:15:32.000Z';
const base = { createdAt, expiresAt, usedAt: null, revokedAt: null, isReserved: false, isActive: true };

describe('TASK-BILLOK-011: invitation presentation', () => {
  it('preserves all five server states and the original deadline', () => {
    const cases = [
      { input: base, status: 'active' },
      { input: { ...base, isReserved: true, isActive: false }, status: 'reserved' },
      { input: { ...base, usedAt: '2026-11-29T01:02:03.000Z', isActive: false }, status: 'used' },
      { input: { ...base, revokedAt: '2026-11-29T01:02:04.000Z', isActive: false }, status: 'revoked' },
      { input: { ...base, isActive: false }, status: 'expired' },
    ];
    for (const { input, status } of cases) {
      const shown = invitationDisplay(input);
      expect(shown.status).toBe(status);
      expect(shown.created?.toISOString()).toBe(createdAt);
      expect(shown.expiry?.toISOString()).toBe(expiresAt);
    }
    const both = invitationDisplay({
      ...base,
      usedAt: '2026-11-29T01:02:03.000Z',
      revokedAt: '2026-11-29T01:02:04.000Z',
    });
    expect(both.used?.toISOString()).toBe('2026-11-29T01:02:03.000Z');
    expect(both.revoked?.toISOString()).toBe('2026-11-29T01:02:04.000Z');
  });
  it('caps older deadlines at seven days without extending a shorter deadline', () => {
    expect(invitationDisplay({ ...base, expiresAt: '2027-01-01T00:00:00.000Z' }).expiry?.toISOString()).toBe(expiresAt);
    expect(invitationDisplay({ ...base, expiresAt: '2026-11-29T00:00:00.000Z' }).expiry?.toISOString()).toBe(
      '2026-11-29T00:00:00.000Z',
    );
  });
  it('does not invent missing or invalid dates or report invalid deadlines as active', () => {
    for (const invalid of [null, '', 'not-a-date', '2026-02-31T12:00:00.000Z', new Date(NaN)]) {
      const missing = invitationDisplay({ ...base, expiresAt: invalid });
      expect(missing.expiry).toBeNull();
      expect(missing.status).toBe('expired');
      expect(invitationDisplay({ ...base, createdAt: invalid }).expiry).toBeNull();
    }
    expect(invitationDisplay({ ...base, usedAt: 'bad' }).used).toBeNull();
    expect(invitationDisplay({ ...base, revokedAt: 'bad' }).revoked).toBeNull();
  });
  it('formats the same instant to seconds in each browser time zone', () => {
    const info = invitationDisplay(base);
    expect(createAuditDateFormatter('ru-RU', 'Europe/Moscow').full(info.created!)).toBe('29.11.2026, 01:15:32');
    expect(createAuditDateFormatter('ru-RU', 'UTC').full(info.created!)).toBe('28.11.2026, 22:15:32');
  });
});
