import { describe, expect, it } from 'vitest';
import { assertDisposableQaDatabase } from '../../scripts/qa-fixture-database';

const qaUrl = 'postgresql://billokqa:test-only@127.0.0.1:55000/billokqa';

describe('synthetic fixture database isolation (Issue 6.14.4)', () => {
  it.each([qaUrl, 'postgres://billokqa:local-only@localhost:5432/billokqa'])(
    'accepts explicitly opted-in disposable PostgreSQL: %s',
    (DATABASE_URL) => {
      expect(assertDisposableQaDatabase({ DATABASE_URL, BILLOK_QA_FIXTURES: '1' })).toBe(DATABASE_URL);
    },
  );

  it('does not allow seed data without an explicit QA opt-in', () => {
    expect(() => assertDisposableQaDatabase({ DATABASE_URL: qaUrl })).toThrow(/opt-in/);
    expect(() => assertDisposableQaDatabase({ DATABASE_URL: qaUrl, BILLOK_QA_FIXTURES: 'true' })).toThrow(/opt-in/);
  });

  it.each([
    'postgresql://billokqa:test@db.example.com:5432/billokqa',
    'postgresql://billokqa:test@127.0.0.1:5432/billok',
    'postgresql://production:test@127.0.0.1:5432/billokqa',
    'postgresql://billokqa:test@127.0.0.1:5432/billokqa?schema=public',
    'https://billokqa:test@127.0.0.1:5432/billokqa',
    'postgresql://billokqa:test@127.0.0.1:5432/billokqa#other',
    '',
  ])('rejects a non-disposable or modified database URL', (DATABASE_URL) => {
    expect(() => assertDisposableQaDatabase({ DATABASE_URL, BILLOK_QA_FIXTURES: '1' })).toThrow();
  });
});
