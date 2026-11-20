import { describe, expect, test } from 'vitest';
import { isSafeInternalPath, normalizeCallbackPath, stripLocalePrefix } from './locale-paths';
import { defaultLocale, locales, routing } from '@/i18n/routing';

describe('Russian-only BillOK routing', () => {
  test('one Russian locale with no public language prefix', () => {
    expect(locales).toEqual(['ru']);
    expect(defaultLocale).toBe('ru');
    expect(routing.localePrefix).toBe('never');
    expect(routing.localeDetection).toBe(false);
  });

  test('strips only the internal Russian prefix, preserving tokens, query and hashes', () => {
    expect(stripLocalePrefix('/ru/split/secure-token/claim?view=receipt')).toBe(
      '/split/secure-token/claim?view=receipt',
    );
    expect(stripLocalePrefix('/ru/invite/secure-token#details')).toBe('/invite/secure-token#details');
    expect(stripLocalePrefix('/ru')).toBe('/');
    expect(stripLocalePrefix('/ru?next=1')).toBe('/?next=1');
    expect(stripLocalePrefix('/russian/invite/secure-token')).toBe('/russian/invite/secure-token');
    expect(stripLocalePrefix('/split/secure-token')).toBe('/split/secure-token');
  });

  test('does not migrate unsupported ShareTab language routes to Russian links', () => {
    for (const foreign of [
      '/en/split/token',
      '/es/login',
      '/de/groups/123',
      '/pt-BR/split/token',
      '/zh-CN/invite/token',
    ]) {
      expect(stripLocalePrefix(foreign)).toBe(foreign);
      expect(normalizeCallbackPath(foreign)).toBe('/dashboard');
    }
  });

  test('normalizes canonical Passkey callbacks without touching guest secrets', () => {
    expect(normalizeCallbackPath('/dashboard?x=1')).toBe('/dashboard?x=1');
    expect(normalizeCallbackPath('/ru/groups/id-123?x=1')).toBe('/groups/id-123?x=1');
    expect(normalizeCallbackPath('/ru/split/private-token?tab=1')).toBe('/split/private-token?tab=1');
    expect(normalizeCallbackPath('/invite/secret-123#details')).toBe('/invite/secret-123#details');
  });

  test('rejects external or malformed redirect targets', () => {
    for (const value of [null, 'https://evil.example', '//evil.example', '/\\evil.example', 'relative']) {
      expect(isSafeInternalPath(value)).toBe(false);
      expect(normalizeCallbackPath(value)).toBe('/dashboard');
    }
  });
});
