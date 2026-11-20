import { describe, expect, test } from 'vitest';
import { formatRussianDate, formatRussianTime } from './ru-format';

describe('Russian dates and times', () => {
  test('formats calendar dates day-first independently of browser language', () => {
    expect(formatRussianDate('2026-10-24T15:07:09.000Z', 'UTC')).toBe('24.10.2026');
  });

  test('formats server log times with 24-hour clock and seconds', () => {
    expect(formatRussianTime('2026-10-24T15:07:09.000Z', 'UTC')).toBe('15:07:09');
    expect(formatRussianTime('2026-10-24T01:02:03.000Z', 'UTC')).toBe('01:02:03');
  });
});
