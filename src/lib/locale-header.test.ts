import { describe, test, expect } from 'vitest';
import { localeFromHeader } from './locale-header';

describe('localeFromHeader (Russian-only BillOK)', () => {
  test('accepts Russian from the current app', () => {
    expect(localeFromHeader('ru')).toBe('ru');
  });

  test('overrides outdated browser, user, and API language values with Russian', () => {
    for (const code of [null, '', 'en', 'de', 'pt-BR', 'zh-CN', 'xx', 'ru-RU']) {
      expect(localeFromHeader(code)).toBe('ru');
    }
  });
});
