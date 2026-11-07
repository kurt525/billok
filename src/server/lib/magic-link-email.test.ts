import { beforeEach, describe, expect, test, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { russianSignInEmail, sendRussianSignInEmail } from './magic-link-email';

const server = { host: 'mail.example.test', port: 587 };

beforeEach(() => {
  vi.clearAllMocks();
  createTransport.mockReturnValue({ sendMail });
  sendMail.mockResolvedValue({ rejected: [], pending: [] });
});

describe('Russian BillOK magic-link email', () => {
  test('subject, body and fallback URL are Russian', () => {
    const message = russianSignInEmail('https://billok.ru/api/auth/callback?token=123');
    expect(message.subject).toBe('Ссылка для входа в BillOK');
    expect(message.text).toContain('Чтобы войти в BillOK');
    expect(message.html).toContain('Войти в BillOK');
    expect(message.text).not.toMatch(/ShareTab|Sign in|Verify|Click here/i);
    expect(message.html).not.toMatch(/ShareTab|Sign in|Verify|Click here/i);
  });

  test('escapes HTML attributes in the login link', () => {
    const { html } = russianSignInEmail('https://billok.ru/?a="x"&b=<y>');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;y&gt;');
    expect(html).not.toContain('href="https://billok.ru/?a="x"');
  });

  test('uses configured SMTP sender and recipient', async () => {
    await sendRussianSignInEmail({
      to: 'user@example.test',
      from: 'BillOK <noreply@billok.ru>',
      url: 'https://billok.ru/api/auth/callback?token=secret',
      server,
    });
    expect(createTransport).toHaveBeenCalledWith(server);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'BillOK <noreply@billok.ru>',
        to: 'user@example.test',
        subject: 'Ссылка для входа в BillOK',
      }),
    );
  });

  test('reports rejected recipients and SMTP failures', async () => {
    sendMail.mockResolvedValueOnce({ rejected: ['user@example.test'], pending: [] });
    const input = {
      to: 'user@example.test',
      from: 'BillOK <noreply@billok.ru>',
      url: 'https://billok.ru/test',
      server,
    };
    await expect(sendRussianSignInEmail(input)).rejects.toThrow('Не удалось отправить письмо');
    sendMail.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(sendRussianSignInEmail(input)).rejects.toThrow('SMTP failed');
  });
});
