import assert from 'node:assert/strict';
import { test } from 'node:test';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { russianRegistrationVerificationEmail } from '../src/server/lib/email-verification-email.ts';
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

test('QA mailbox ignores non-loopback hosts, malformed and missing tokens', () => {
  assert.deepEqual(linksInMessage('https://billok.ru/verify-email?token=' + 'C'.repeat(43)), []);
  assert.deepEqual(linksInMessage('http://127.0.0.1:33589/verify-email?token=invalid'), []);
});
