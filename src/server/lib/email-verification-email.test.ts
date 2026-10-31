import { describe, expect, it } from 'vitest';
import { russianRegistrationVerificationEmail } from './email-verification-email';

describe('registration email confirmation message', () => {
  const url = 'https://billok.ru/verify-email?token=personal-one-time-token';

  it('has Russian subject, plain text, HTML and a visible thirty-minute expiry', () => {
    const message = russianRegistrationVerificationEmail(url);
    expect(message.subject).toBe('Подтвердите электронную почту для BillOK');
    expect(message.text).toContain('Для завершения регистрации');
    expect(message.text).toContain(url);
    expect(message.html).toContain('Подтвердить почту');
    expect(message.html).toContain(url);
    expect(message.text).toContain('30 минут');
    expect(message.html).toContain('30 минут');
    expect(message.text).toContain('только один раз');
    expect(message.html).toContain('только один раз');
    expect(message.text + message.html).not.toMatch(/ShareTab|Sign in|Click here|Verify email/i);
  });

  it('escapes markup when the confirmation link contains reserved characters', () => {
    const message = russianRegistrationVerificationEmail('https://billok.ru/verify-email?x="><script>&y=1');
    expect(message.html).toContain('&quot;');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('&amp;y=1');
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('href="https://billok.ru/verify-email?x="');
  });

  it('rejects untrusted protocols and credentials in the confirmation link', () => {
    expect(() => russianRegistrationVerificationEmail('javascript:alert(1)')).toThrow('Недопустимая ссылка');
    expect(() => russianRegistrationVerificationEmail('http://billok.ru/verify-email?token=secret')).toThrow(
      'Недопустимая ссылка',
    );
    expect(() => russianRegistrationVerificationEmail('https://user:pass@billok.ru/verify-email')).toThrow(
      'Недопустимая ссылка',
    );
    expect(russianRegistrationVerificationEmail('http://localhost:3000/verify-email?token=test').text).toContain(
      '30 минут',
    );
  });
});
