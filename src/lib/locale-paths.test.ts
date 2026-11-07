import { describe, expect, test } from 'vitest';
import {
  hasLocalePrefix,
  isSafeInternalPath,
  isSupportedLocale,
  normalizeCallbackPath,
  stripLocalePrefix,
  withLocalePrefix,
} from './locale-paths';
import { defaultLocale, locales, routing } from '@/i18n/routing';

describe('Russian-only BillOK routing', () => {
  test('one locale, no language prefix, no language negotiation', () => {
    expect(locales).toEqual(['ru']);
    expect(defaultLocale).toBe('ru');
    expect(routing.localePrefix).toBe('never');
    expect(routing.localeDetection).toBe(false);
    expect(isSupportedLocale('ru')).toBe(true);
    expect(isSupportedLocale('en')).toBe(false);
  });

  test('migrates old shared guest receipt links while preserving tokens and query strings', () => {
    expect(hasLocalePrefix('/en/split/token-123/claim?view=receipt')).toBe(true);
    expect(stripLocalePrefix('/en/split/token-123/claim?view=receipt')).toBe('/split/token-123/claim?view=receipt');
    expect(stripLocalePrefix('/ru/invite/secure-token#details')).toBe('/invite/secure-token#details');
    expect(stripLocalePrefix('/pt-BR/groups/old-group')).toBe('/groups/old-group');
    expect(stripLocalePrefix('/split/token-123')).toBe('/split/token-123');
    expect(hasLocalePrefix('/english/split')).toBe(false);
  });

  test('never generates a locale-selectable browser address', () => {
    expect(withLocalePrefix('/dashboard?x=1', 'ru')).toBe('/dashboard?x=1');
    expect(withLocalePrefix('/en/login?callbackUrl=%2Fgroups', 'ru')).toBe('/login?callbackUrl=%2Fgroups');
    expect(normalizeCallbackPath('/es/split/private-token?tab=1', 'ru')).toBe('/split/private-token?tab=1');
    expect(normalizeCallbackPath('/dashboard', 'ru')).toBe('/dashboard');
  });

  test('rejects external or malformed redirect targets', () => {
    for (const value of [null, 'https://evil.example', '//evil.example', '/\\evil.example', 'relative']) {
      expect(isSafeInternalPath(value)).toBe(false);
      expect(normalizeCallbackPath(value, 'ru')).toBe('/dashboard');
    }
  });
});
