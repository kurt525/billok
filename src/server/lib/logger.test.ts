import { afterEach, describe, expect, test, vi } from 'vitest';
import { getRecentLogs, logger } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Issue 3.25.4.3: log redaction without bearer or population counters', () => {
  test('masks raw share and personal links in stdout, nested objects, URLs and admin buffer', () => {
    const secret = 'a'.repeat(42) + 'g';
    const sealed = 'v1.' + 'b'.repeat(95);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = getRecentLogs().latestId;
    logger.warn('guest.invalid ' + secret, {
      personToken: secret,
      shareToken: secret,
      authorization: 'Bearer ' + secret,
      nested: { requestKey: 'private-request-key', url: '/split/' + secret + '?token=short-secret' },
      error: new Error('Failed to verify ' + sealed + ' ' + secret),
      harmless: { status: 'refused', retries: 2 },
    });
    const entries = getRecentLogs({ afterId: before }).entries;
    expect(entries).toHaveLength(1);
    const output = JSON.stringify(entries) + JSON.stringify(warn.mock.calls);
    for (const sensitive of [secret, sealed, 'private-request-key', 'short-secret']) {
      expect(output).not.toContain(sensitive);
    }
    expect(entries[0]?.data).toMatchObject({
      personToken: '[REDACTED]',
      shareToken: '[REDACTED]',
      nested: { requestKey: '[REDACTED]' },
      harmless: { status: 'refused', retries: 2 },
    });
    expect(output).toContain('[REDACTED]');
  });

  test('redacts unknown secrets in arrays and cyclic objects without leaking input references', () => {
    const token = 'c'.repeat(42) + 'w';
    const object: Record<string, unknown> = { tokens: [token], note: 'Bearer ' + token };
    object.self = object;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = getRecentLogs().latestId;
    logger.warn('guest.security', object);
    const entry = getRecentLogs({ afterId: before }).entries[0]!;
    const output = JSON.stringify(entry) + JSON.stringify(warn.mock.calls);
    expect(output).not.toContain(token);
    expect(output).toContain('[Circular]');
    expect(entry.data?.tokens).toBe('[REDACTED]');
  });
});
