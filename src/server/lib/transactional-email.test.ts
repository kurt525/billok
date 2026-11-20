import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransport, sendMail, close } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { sendBillokTransactionalEmail } from './transactional-email';

const input = {
  from: 'BillOK <noreply@billok.ru>',
  to: 'owner@mail.ru',
  server: { host: 'mail.hosting.reg.ru', port: 465, secure: true },
  message: { subject: 'Проверка BillOK', text: 'Текст', html: '<p>Текст</p>' },
  errorMessage: 'Сервер не принял письмо',
};

beforeEach(() => {
  vi.clearAllMocks();
  createTransport.mockReturnValue({ sendMail, close });
  sendMail.mockResolvedValue({ accepted: [input.to], rejected: [], pending: [] });
});

describe('7.4: independent BillOK transactional email transport', () => {
  it('uses a single SMTP module with text and HTML, then closes the transport', async () => {
    await sendBillokTransactionalEmail(input);
    expect(createTransport).toHaveBeenCalledExactlyOnceWith(input.server);
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      from: input.from,
      to: input.to,
      subject: input.message.subject,
      text: input.message.text,
      html: input.message.html,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('also supports text-only security alerts with no HTML fallback', async () => {
    const message = { subject: 'BillOK — событие безопасности', text: 'Операция отклонена' };
    await sendBillokTransactionalEmail({ ...input, message });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining(message));
    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('html');
  });

  it('retains bounded owner security alert SMTP timeouts', async () => {
    const timeouts = { connectionTimeout: 4_000, greetingTimeout: 4_000, socketTimeout: 6_000 };
    await sendBillokTransactionalEmail({ ...input, timeouts });
    expect(createTransport).toHaveBeenCalledWith({ ...input.server, ...timeouts });
  });

  it('fails closed on rejected, pending, missing or different accepted recipients', async () => {
    for (const delivery of [
      { accepted: [], rejected: [input.to], pending: [] },
      { accepted: [input.to], rejected: [], pending: [input.to] },
      { accepted: ['other@mail.ru'], rejected: [], pending: [] },
      { accepted: undefined, rejected: [], pending: [] },
    ]) {
      sendMail.mockResolvedValueOnce(delivery);
      await expect(sendBillokTransactionalEmail(input)).rejects.toThrow(input.errorMessage);
    }
    expect(close).toHaveBeenCalledTimes(4);
  });

  it('does not swallow SMTP authentication or network failure', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(sendBillokTransactionalEmail(input)).rejects.toThrow('SMTP failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('never enables Magic Link through SMTP or bypasses REG.RU config in the admin router', () => {
    const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    const auth = source('src/server/auth.ts');
    const sender = source('src/server/lib/transactional-email.ts');
    const admin = source('src/server/trpc/routers/admin.ts');
    const audit = source('src/server/lib/security-event-audit.ts');
    expect(auth).toContain("id: 'passkey'");
    expect(auth).not.toContain('sendVerificationRequest');
    expect(auth).not.toMatch(/next-auth\/providers\/(?:nodemailer|email|google|oidc)/u);
    expect(sender).not.toContain('next-auth');
    expect(sender).not.toContain('signIn(');
    expect(admin).toContain('readRegistrationEmailConfig(process.env)');
    expect(admin).toContain('sendBillokTransactionalEmail(');
    expect(admin).not.toContain('nodemailer.createTransport(');
    expect(audit).not.toContain('nodemailer.createTransport(');
    for (const path of ['email-verification-email.ts', 'passkey-recovery-email.ts']) {
      const file = source('src/server/lib/' + path);
      expect(file).toContain('sendBillokTransactionalEmail(');
      expect(file).not.toContain('nodemailer.createTransport(');
    }
    const before = admin.indexOf('sendTestEmail:');
    const after = admin.indexOf('// ─── Storage', before);
    const handler = admin.slice(before, after);
    expect(handler).not.toContain('process.env.EMAIL_SERVER_HOST');
    expect(handler).not.toMatch(/html:[\s\S]*ctx\.user\.email/);
  });
});
