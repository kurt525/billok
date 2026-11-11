import { describe, expect, test } from 'vitest';
import { readRegistrationEmailConfig } from './auth-config';

describe('mandatory BillOK registration confirmation email configuration', () => {
  const complete = {
    NEXTAUTH_URL: 'https://billok.ru',
    EMAIL_SERVER_HOST: 'smtp.reg.ru',
    EMAIL_SERVER_PORT: '465',
    EMAIL_SERVER_USER: 'noreply@billok.ru',
    EMAIL_SERVER_PASSWORD: 'not-a-real-secret',
    EMAIL_FROM: 'BillOK <noreply@billok.ru>',
  };

  test('accepts the configured sender with encrypted SMTP on 465 or mandatory STARTTLS on 587', () => {
    expect(readRegistrationEmailConfig(complete)).toEqual({
      siteOrigin: 'https://billok.ru',
      from: complete.EMAIL_FROM,
      server: {
        host: 'smtp.reg.ru',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: complete.EMAIL_SERVER_USER, pass: complete.EMAIL_SERVER_PASSWORD },
      },
    });
    expect(readRegistrationEmailConfig({ ...complete, EMAIL_SERVER_PORT: '587' }).server).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  test('rejects missing SMTP credentials, invalid sender, insecure origin and malformed transport without leaking secrets', () => {
    const badConfigurations = [
      { EMAIL_SERVER_HOST: '' },
      { EMAIL_SERVER_HOST: 'not a hostname' },
      { EMAIL_SERVER_PORT: 'NaN' },
      { EMAIL_SERVER_PORT: '70000' },
      { EMAIL_SERVER_USER: '' },
      { EMAIL_SERVER_PASSWORD: ' ' },
      { EMAIL_FROM: 'Other <someone@elsewhere.com>' },
      { NEXTAUTH_URL: 'http://billok.ru' },
      { NEXTAUTH_URL: 'https://login:secret@billok.ru' },
      { NEXTAUTH_URL: 'https://billok.ru/redirect' },
    ];
    for (const changed of badConfigurations) {
      expect(() => readRegistrationEmailConfig({ ...complete, ...changed })).toThrow(
        'Не настроена безопасная отправка подтверждения почты BillOK',
      );
    }
    expect(() => readRegistrationEmailConfig({})).toThrow(
      'Не настроена безопасная отправка подтверждения почты BillOK',
    );
  });
});
