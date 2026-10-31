import { describe, expect, it } from 'vitest';
import { hashEmailVerificationToken } from './email-verification-token';
import { prepareRegistrationVerificationLink } from './registration-verification-link';

describe('registration confirmation link', () => {
  it('builds unique URL-safe links but exposes only the digest for storage', () => {
    const now = new Date('2026-10-31T10:00:00.000Z');
    const first = prepareRegistrationVerificationLink('https://billok.ru', now);
    const second = prepareRegistrationVerificationLink('https://billok.ru/', now);
    const link = new URL(first.url);
    expect(link.origin).toBe('https://billok.ru');
    expect(link.pathname).toBe('/verify-email');
    expect([...link.searchParams.keys()]).toEqual(['token']);
    const token = link.searchParams.get('token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toBe(hashEmailVerificationToken(token!));
    expect(first.tokenHash).not.toBe(token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
    expect(first.url).not.toBe(second.url);
    expect(first.expiresAt.toISOString()).toBe('2026-10-31T10:30:00.000Z');
    expect(Object.keys(first).sort()).toEqual(['expiresAt', 'tokenHash', 'url']);
  });

  it('supports only local HTTP during self-hosted development', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      expect(prepareRegistrationVerificationLink(origin).url).toContain('/verify-email?token=');
    }
  });

  it('refuses insecure origins, redirects and embedded credentials', () => {
    for (const origin of [
      '',
      '/somewhere',
      'http://billok.ru',
      'javascript:alert(1)',
      'https://user:pass@billok.ru',
      'https://billok.ru?returnUrl=https://example.com',
      'https://billok.ru#fragment',
      'https://billok.ru/custom-path',
    ]) {
      expect(() => prepareRegistrationVerificationLink(origin)).toThrow('Не задан корректный адрес BillOK');
    }
  });
});
