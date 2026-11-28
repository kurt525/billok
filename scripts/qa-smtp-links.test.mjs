import assert from 'node:assert/strict';
import { test } from 'node:test';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { russianRegistrationVerificationEmail } from '../src/server/lib/email-verification-email.ts';
import { russianPasskeyRecoveryEmail } from '../src/server/lib/passkey-recovery-email.ts';
import { linksInMessage } from './qa-smtp-links.mjs';

async function compile(message) {
  const mail = new MailComposer({ from: 'noreply@billok.ru', to: 'test@mail.ru', ...message });
  return (await mail.compile().build()).toString('utf8');
}

test('QA mailbox finds confirmation links in actual Nodemailer MIME', async () => {
  const url = 'http://127.0.0.1:33589/verify-email?token=' + 'A'.repeat(43);
  const raw = await compile(russianRegistrationVerificationEmail(url));
  assert.deepEqual(linksInMessage(raw), [url]);
});

test('7.2: QA mailbox finds resent confirmation in actual Russian HTML+text MIME', async () => {
  const url = 'http://127.0.0.1:33589/verify-email?token=' + 'S'.repeat(43);
  const raw = await compile(russianRegistrationVerificationEmail(url, 'resend'));
  assert.match(raw, /multipart\/alternative/i);
  assert.deepEqual(linksInMessage(raw), [url]);
});

test('QA mailbox finds Passkey recovery links in actual Nodemailer MIME', async () => {
  const url = 'http://localhost:33589/recover-passkey?token=' + 'R'.repeat(43);
  const raw = await compile(russianPasskeyRecoveryEmail(url));
  assert.deepEqual(linksInMessage(raw), [url]);
});

test('7.2: Passkey recovery MIME preserves the visible fallback link without duplicate actions', async () => {
  const url = 'http://localhost:33589/recover-passkey?token=' + 'T'.repeat(43);
  const raw = await compile(russianPasskeyRecoveryEmail(url));
  assert.deepEqual(linksInMessage(raw), [url]);
});

test('QA mailbox accepts both confirmation and recovery links in a single batch without duplicates', () => {
  const confirmation = 'http://127.0.0.1:33589/verify-email?token=' + 'C'.repeat(43);
  const recovery = 'http://localhost:33589/recover-passkey?token=' + 'R'.repeat(43);
  const raw = confirmation + '\n' + recovery + '\n' + recovery;
  assert.deepEqual(linksInMessage(raw), [confirmation, recovery]);
});

test('QA mailbox ignores non-loopback hosts, malformed and missing tokens', () => {
  assert.deepEqual(linksInMessage('https://billok.ru/verify-email?token=' + 'C'.repeat(43)), []);
  assert.deepEqual(linksInMessage('https://billok.ru/recover-passkey?token=' + 'R'.repeat(43)), []);
  assert.deepEqual(linksInMessage('http://127.0.0.1:33589/verify-email?token=invalid'), []);
  assert.deepEqual(linksInMessage('http://localhost:33589/recover-passkey?token=short'), []);
});

test('QA mailbox finds email-change confirmation fragment, not a query token', async () => {
  const url = 'http://localhost:33589/settings#email-change=' + 'A'.repeat(43);
  const raw = await compile({
    subject: 'BillOK — смена почты',
    text: 'Откройте ссылку:\n\n' + url + '\n\nПодтвердите изменение.',
  });
  assert.deepEqual(linksInMessage(raw), [url]);
  assert.deepEqual(linksInMessage('https://billok.ru/settings#email-change=' + 'A'.repeat(43)), []);
});

test('QA mailbox decodes the complete single-part Russian confirmation with trailing MIME headers', async () => {
  const url = 'http://localhost:33589/settings#email-change=' + 'Q'.repeat(43);
  const raw = await compile({
    subject: 'BillOK — подтверждение нового адреса электронной почты',
    text: [
      'Для изменения электронной почты откройте ссылку в том же браузере, где подтвердили операцию ключом доступа.',
      url,
      'Ссылка действует 30 минут. Подтвердите изменение в настройках. Если вы не запрашивали смену, проигнорируйте письмо.',
    ].join('\n\n'),
  });
  assert.match(raw, /Content-Transfer-Encoding: base64/i);
  assert.deepEqual(linksInMessage(raw), [url]);
  assert.deepEqual(linksInMessage(raw.trimEnd()), [url]);
});
