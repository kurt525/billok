import { describe, expect, it } from 'vitest';
import { hashPasswordResetToken, preparePasswordResetLink } from './password-reset-token';
import { russianPasswordResetEmail } from './password-reset-email';

describe('isolated password reset tokens and links', () => {
  it('produces an HTTPS-only 43-character token, stores a digest, and expires after 30 minutes', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const created = preparePasswordResetLink('https://billok.ru', now);
    const url = new URL(created.url);
    const token = url.searchParams.get('token')!;
    expect(url.pathname).toBe('/reset-password');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.tokenHash).toEqual(hashPasswordResetToken(token));
    expect(created.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.expiresAt).toEqual(new Date('2026-11-01T12:30:00Z'));
    expect(preparePasswordResetLink('https://billok.ru', now).tokenHash).not.toEqual(created.tokenHash);
  });

  it('rejects untrusted link origins and formats Russian email safely', () => {
    expect(() => preparePasswordResetLink('http://billok.ru')).toThrow();
    expect(() => preparePasswordResetLink('https://billok.ru.evil.com/abc')).toThrow();
    const message = russianPasswordResetEmail('https://billok.ru/reset-password?token=abc');
    expect(message.subject).toContain('BillOK');
    expect(message.text).toContain('30 минут');
    expect(message.html).toContain('Восстановление пароля');
    expect(() => russianPasswordResetEmail('javascript:alert(1)')).toThrow();
  });
});
