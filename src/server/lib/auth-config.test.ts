import { describe, expect, test } from 'vitest';
import { readRegistrationEmailConfig } from './auth-config';

describe('mandatory BillOK registration confirmation email configuration', () => {
  const complete = {
    NEXTAUTH_URL: 'https://billok.ru',
    EMAIL_SERVER_HOST: 'mail.hosting.reg.ru',
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
        host: 'mail.hosting.reg.ru',
        port: 465,
        secure: true,
        requireTLS: false,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        auth: { user: complete.EMAIL_SERVER_USER, pass: complete.EMAIL_SERVER_PASSWORD },
      },
    });
    expect(readRegistrationEmailConfig({ ...complete, EMAIL_SERVER_PORT: '587' }).server).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  test('accepts ONLY explicitly isolated, loopback QA SMTP with a disposable database', () => {
    const qa = {
      NEXTAUTH_URL: 'http://localhost:33117',
      DATABASE_URL: 'postgresql://billokqa:billokqa_local_only@127.0.0.1:33118/billokqa',
      BILLOK_QA_FIXTURES: '1',
      BILLOK_QA_WEBAUTHN_LOOPBACK: '1',
      BILLOK_QA_SMTP_PORT: '33119',
      EMAIL_SERVER_HOST: '127.0.0.1',
      EMAIL_SERVER_PORT: '33119',
      EMAIL_SERVER_USER: 'billok-qa',
      EMAIL_SERVER_PASSWORD: 'qa-local-only',
      EMAIL_FROM: 'noreply@billok.ru',
    };
    expect(readRegistrationEmailConfig(qa).server).toMatchObject({
      host: '127.0.0.1',
      port: 33119,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    });
    for (const override of [
      { BILLOK_QA_FIXTURES: '' },
      { BILLOK_QA_WEBAUTHN_LOOPBACK: '' },
      { DATABASE_URL: 'postgresql://billokqa:billokqa_local_only@127.0.0.1:33118/production' },
      { DATABASE_URL: 'postgresql://billokqa:billokqa_local_only@192.168.1.10:33118/billokqa' },
      { EMAIL_SERVER_HOST: '0.0.0.0' },
      { EMAIL_SERVER_PORT: '465' },
      { EMAIL_SERVER_USER: 'noreply@billok.ru' },
      { EMAIL_FROM: 'BillOK <noreply@billok.ru>' },
      { NEXTAUTH_URL: 'https://billok.ru' },
    ]) {
      expect(() => readRegistrationEmailConfig({ ...qa, ...override })).toThrow(
        'Не настроена безопасная отправка подтверждения почты BillOK',
      );
    }
  });

  test('rejects missing SMTP credentials, invalid sender, insecure origin and malformed transport without leaking secrets', () => {
    const badConfigurations = [
      { EMAIL_SERVER_HOST: '' },
      { EMAIL_SERVER_HOST: 'not a hostname' },
      { EMAIL_SERVER_HOST: 'smtp.reg.ru' },
      { EMAIL_SERVER_HOST: 'mail.evil.ru' },
      { EMAIL_SERVER_HOST: '127.0.0.1' },
      { EMAIL_SERVER_PORT: '25' },
      { EMAIL_SERVER_PORT: '2525' },
      { EMAIL_SERVER_USER: 'another@billok.ru' },
      { EMAIL_SERVER_USER: 'noreply@billok.ru ' },
      { NEXTAUTH_URL: 'http://localhost:3000' },
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
