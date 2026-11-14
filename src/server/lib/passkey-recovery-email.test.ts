import { describe, expect, it, vi } from 'vitest';

const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));
import { russianPasskeyRecoveryEmail, sendRussianPasskeyRecoveryEmail } from './passkey-recovery-email';

describe('Issue #1 6.8.1.3: separate email recovery, never email login', () => {
  it('clearly instructs the recipient to CREATE a key, then enter via signed WebAuthn', () => {
    const url = 'https://billok.ru/recover-passkey?token=secret';
    const message = russianPasskeyRecoveryEmail(url);
    expect(message.subject).toContain('Восстановление Passkey');
    expect(message.text).toContain(url);
    expect(message.text).toContain('30 минут');
    expect(message.text).toContain('не ссылка для входа');
    expect(message.html).toContain('нового Passkey');
    expect(message.html).toContain(url);
  });

  it('rejects unsafe origins and escapes URL markup', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://billok.ru/recover-passkey',
      'https://user:password@billok.ru/recover-passkey',
      'https://billok.ru/login?token=secret',
    ]) {
      expect(() => russianPasskeyRecoveryEmail(url)).toThrow();
    }
    const template = russianPasskeyRecoveryEmail('https://billok.ru/recover-passkey?token=abc&foo=<script>');
    expect(template.html).toContain('&amp;foo=');
    expect(template.html).toContain('&lt;script&gt;');
    expect(template.html).not.toContain('<script>');
  });

  it('uses configured SMTP and fails closed on partial deliveries', async () => {
    const options = {
      to: 'person@mail.ru',
      url: 'https://billok.ru/recover-passkey?token=abc',
      from: 'noreply@billok.ru',
      server: { host: 'smtp.example.ru', port: 465, secure: true },
    };
    sendMail.mockResolvedValueOnce({ accepted: [options.to], rejected: [], pending: [] });
    await sendRussianPasskeyRecoveryEmail(options);
    expect(createTransport).toHaveBeenCalledWith(options.server);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: options.to,
        subject: 'Восстановление Passkey для BillOK',
      }),
    );
    sendMail.mockResolvedValueOnce({ accepted: [], rejected: [options.to], pending: [] });
    await expect(sendRussianPasskeyRecoveryEmail(options)).rejects.toThrow();
  });
});
