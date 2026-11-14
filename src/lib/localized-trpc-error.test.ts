import { describe, expect, test } from 'vitest';
import { localizedTrpcError } from './localized-trpc-error';

const fallback = 'Произошла ошибка. Попробуйте ещё раз.';

describe('localized tRPC user notifications', () => {
  test('preserves a server-translated domain error', () => {
    expect(
      localizedTrpcError(
        {
          message: 'Расход нельзя удалить, пока группа находится в архиве.',
          data: { code: 'FORBIDDEN' },
        },
        fallback,
      ),
    ).toBe('Расход нельзя удалить, пока группа находится в архиве.');
  });

  test('hides English browser network error', () => {
    expect(localizedTrpcError({ message: 'Failed to fetch' }, fallback)).toBe(fallback);
  });

  test('hides transport errors with missing or null codes', () => {
    expect(localizedTrpcError({ message: 'NetworkError', data: null }, fallback)).toBe(fallback);
    expect(localizedTrpcError({ message: 'fetch failed', data: { code: null } }, fallback)).toBe(fallback);
  });
});
