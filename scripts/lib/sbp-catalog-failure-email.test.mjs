import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  prepareSbpCatalogFailureEmail as prepare,
  sendSbpCatalogFailureEmail as send,
} from './sbp-catalog-failure-email.mjs';

const accepted = { firstReleasePublishedAndAccepted: true, catalogAutomationExplicitlyEnabled: true };
const failure = {
  publicationState: accepted,
  stage: 'ci',
  message: 'Mobile Chromium: failure',
  logUrl: 'https://github.com/kurt525/billok/actions/runs/40932219271',
};
const env = {
  BILLOK_SBP_ALERT_SMTP_HOST: 'mail.example.com',
  BILLOK_SBP_ALERT_SMTP_PORT: '587',
  BILLOK_SBP_ALERT_SMTP_USER: 'noreply@example.com',
  BILLOK_SBP_ALERT_SMTP_PASSWORD: 's3cr3t-that-must-never-leak',
  BILLOK_SBP_ALERT_FROM: 'noreply@example.com',
  BILLOK_SBP_ALERT_TO: 'owner@example.com',
};

describe('bank catalog error-only email, disabled until first accepted release', () => {
  it('always fails closed before deployment acceptance and explicit activation', async () => {
    assert.equal(prepare().allowed, false);
    assert.equal(prepare({ ...failure, publicationState: undefined }).allowed, false);
    assert.equal(
      prepare({ ...failure, publicationState: { ...accepted, catalogAutomationExplicitlyEnabled: false } }).allowed,
      false,
    );
    let calls = 0;
    const result = await send({
      ...failure,
      env,
      publicationState: { ...accepted, firstReleasePublishedAndAccepted: false },
      createTransport: () => {
        calls++;
        throw new Error('must never connect');
      },
    });
    assert.equal(result.sent, false);
    assert.equal(calls, 0);
  });
  it('does not prepare or send ordinary successful updates', async () => {
    for (const stage of ['success', 'none', '', undefined, null]) {
      assert.equal(prepare({ ...failure, stage }).allowed, false);
    }
    let calls = 0;
    const result = await send({
      ...failure,
      stage: 'success',
      env,
      createTransport: () => {
        calls++;
        throw new Error('must not connect');
      },
    });
    assert.equal(result.sent, false);
    assert.equal(calls, 0);
  });
  it('requires a trusted HTTPS log and strips control characters from the reason', () => {
    for (const logUrl of [
      'http://github.com/kurt525/billok/actions/runs/1',
      'https://evil.example/log',
      'https://github.com/other/billok/actions/runs/1',
      'https://github.com/kurt525/billok/actions/runs/1?token=x',
      '',
      undefined,
    ]) {
      assert.equal(prepare({ ...failure, logUrl }).allowed, false);
    }
    assert.equal(prepare({ ...failure, message: '' }).allowed, false);
    const result = prepare({ ...failure, message: 'Сбой\r\nBcc: external@example.com' });
    assert.equal(result.allowed, true);
    assert.match(result.text, /Сбой Bcc: external@example\.com/);
    assert.equal(result.text.includes('\r'), false);
  });
  it('sends one text-only failure email using protected SMTP configuration', async () => {
    const sent = [];
    const result = await send({
      ...failure,
      env,
      createTransport: (config) => {
        assert.deepEqual(config, {
          host: 'mail.example.com',
          port: 587,
          secure: false,
          requireTLS: true,
          auth: { user: env.BILLOK_SBP_ALERT_SMTP_USER, pass: env.BILLOK_SBP_ALERT_SMTP_PASSWORD },
        });
        return {
          sendMail: async (email) => {
            sent.push(email);
          },
        };
      },
    });
    assert.deepEqual(result, { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, env.BILLOK_SBP_ALERT_FROM);
    assert.equal(sent[0].to, env.BILLOK_SBP_ALERT_TO);
    assert.match(sent[0].text, /40932219271/);
    assert.equal(JSON.stringify(sent).includes(env.BILLOK_SBP_ALERT_SMTP_PASSWORD), false);
    assert.equal(Object.hasOwn(sent[0], 'html'), false);
  });
  it('refuses incomplete mail configuration without connecting or echoing secrets', async () => {
    let called = false;
    const result = await send({
      ...failure,
      env: { ...env, BILLOK_SBP_ALERT_SMTP_PASSWORD: '' },
      createTransport: () => {
        called = true;
        throw new Error('must not connect');
      },
    });
    assert.deepEqual(result, { sent: false, reason: 'Trusted VPS SMTP configuration is incomplete' });
    assert.equal(called, false);
  });
  it('supports only the documented failure stages', () => {
    for (const stage of ['registry', 'validation', 'ci', 'merge', 'deployment', 'rollback']) {
      assert.equal(prepare({ ...failure, stage }).allowed, true);
    }
  });
});
