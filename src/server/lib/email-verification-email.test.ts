import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransport, sendMail } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import {
  russianRegistrationVerificationEmail,
  sendRussianRegistrationVerificationEmail,
} from './email-verification-email';

beforeEach(() => {
  vi.clearAllMocks();
  createTransport.mockReturnValue({ sendMail });
  sendMail.mockResolvedValue({ accepted: ['member@example.ru'], rejected: [], pending: [] });
});

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

describe('BillOK registration confirmation delivery', () => {
  const options = {
    to: 'member@example.ru',
    url: 'https://billok.ru/verify-email?token=one-time-token',
    from: 'BillOK <noreply@billok.ru>',
    server: { host: 'smtp.example.test', port: 587, secure: false, requireTLS: true },
  };

  it('sends Russian plain-text and HTML through the supplied SMTP transport', async () => {
    await sendRussianRegistrationVerificationEmail(options);
    expect(createTransport).toHaveBeenCalledWith(options.server);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: options.from,
        to: options.to,
        subject: 'Подтвердите электронную почту для BillOK',
        text: expect.stringContaining(options.url),
        html: expect.stringContaining('Подтвердить почту'),
      }),
    );
  });

  it('fails for rejected, pending and undelivered recipients', async () => {
    for (const result of [
      { accepted: [], rejected: [options.to], pending: [] },
      { accepted: [], rejected: [], pending: [options.to] },
      { accepted: ['another@example.ru'], rejected: [], pending: [] },
    ]) {
      sendMail.mockResolvedValueOnce(result);
      await expect(sendRussianRegistrationVerificationEmail(options)).rejects.toThrow('Не удалось отправить письмо');
    }
  });

  it('propagates SMTP failures and rejects invalid links before sending', async () => {
    sendMail.mockRejectedValueOnce(new Error('Transport unavailable'));
    await expect(sendRussianRegistrationVerificationEmail(options)).rejects.toThrow('Transport unavailable');
    await expect(sendRussianRegistrationVerificationEmail({ ...options, url: 'javascript:alert(1)' })).rejects.toThrow(
      'Недопустимая ссылка',
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
