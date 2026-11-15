import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestRecovery, beginRecovery, finishRecovery, rateLimit, binding } = vi.hoisted(() => ({
  requestRecovery: vi.fn(),
  beginRecovery: vi.fn(),
  finishRecovery: vi.fn(),
  rateLimit: vi.fn(),
  binding: vi.fn(),
}));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/passkey-email-recovery', () => ({
  requestPasskeyRecovery: requestRecovery,
  beginPasskeyRecovery: beginRecovery,
  finishPasskeyRecovery: finishRecovery,
  PASSKEY_RECOVERY_BINDING_COOKIE: 'billok-passkey-recover',
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateLimit }));
vi.mock('@/server/lib/client-ip', () => ({ getClientIp: () => '198.51.100.12' }));
vi.mock('@/server/lib/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/server/lib/webauthn-registration', () => ({ newWebAuthnBindingSecret: binding }));
vi.mock('@/server/lib/webauthn-relying-party', () => ({
  readBillokWebAuthnRelyingParty: () => ({ origin: 'https://billok.ru' }),
  WEBAUTHN_CHALLENGE_TTL_MS: 300_000,
}));

import { POST as requestEmail } from './request/route';
import { POST as start } from './start/route';
import { POST as finish } from './finish/route';

const token = 'q'.repeat(43);
const cookieName = 'billok-passkey-recover';
const credential = { id: 'new-key', type: 'public-key', response: { clientDataJSON: 'a', attestationObject: 'b' } };
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://billok.ru/api/webauthn/recovery/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockReturnValue({ allowed: true });
  binding.mockReturnValue('b'.repeat(43));
  requestRecovery.mockResolvedValue({ requested: true });
  beginRecovery.mockResolvedValue({ challenge: token });
  finishRecovery.mockResolvedValue({ recovered: true });
});

describe('Issue #1 6.12.7: recovery endpoints are not a second authentication method', () => {
  it('public request is account-enumeration-safe and forbids redirect/ownerId/emailVerified injection', async () => {
    for (const body of [
      { email: 'owner@mail.ru', ownerId: 'another-account' },
      { email: 'owner@mail.ru', redirect: 'https://evil.invalid' },
      { email: 'owner@mail.ru', emailVerified: true },
      { email: 'owner@mail.ru', role: 'OWNER' },
      { ownerId: 'attacker' },
      {},
      null,
    ]) {
      const response = await requestEmail(post('request', body));
      expect(response.status).toBe(202);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(requestRecovery).not.toHaveBeenCalled();
    expect((await requestEmail(post('request', { email: 'OWNER@MAIL.RU' }))).status).toBe(202);
    expect(requestRecovery).toHaveBeenCalledWith(expect.objectContaining({ email: 'owner@mail.ru' }));
  });

  it('start accepts ONLY a valid one-time token and sets restricted, short-lived binding cookie', async () => {
    for (const body of [
      { token, userId: 'another-account' },
      { token, ownerId: 'attacker' },
      { token, redirect: 'https://evil.invalid' },
      { token: 'short' },
      { token: '' },
      null,
    ])
      expect((await start(post('start', body))).status).toBe(403);
    expect(beginRecovery).not.toHaveBeenCalled();

    const response = await start(post('start', { token }));
    expect(response.status).toBe(200);
    expect(beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ token }));
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(cookieName + '=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/webauthn/recovery');
    expect(setCookie).toContain('Max-Age=300');
    expect(setCookie).not.toContain('authjs.session');
  });

  it('finish rejects other accounts, other target keys, extra fields, and missing binding cookie', async () => {
    const withCookie = { cookie: cookieName + '=' + 'b'.repeat(43) };
    for (const body of [
      { token, credential, ownerId: 'attacker' },
      { token, credential, userId: 'other' },
      { token, credential, redirect: 'https://evil.invalid' },
      { token, credential, role: 'OWNER' },
      { token: 'bad', credential },
      { token, credential: null },
      { credential },
    ])
      expect((await finish(post('finish', body, withCookie))).status).toBe(403);
    expect((await finish(post('finish', { token, credential }))).status).toBe(403);
    expect(finishRecovery).not.toHaveBeenCalled();
    const response = await finish(post('finish', { token, credential }, withCookie));
    expect(response.status).toBe(200);
    expect(finishRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        token,
        bindingSecret: 'b'.repeat(43),
        response: credential,
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('set-cookie')).not.toContain('authjs.session');
  });

  it('all three endpoints reject HTML forms and excessive actual UTF-8 body sizes', async () => {
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await requestEmail(post('request', { email: 'owner@mail.ru' }, form))).status).toBe(202);
    expect((await start(post('start', { token }, form))).status).toBe(403);
    expect(
      (
        await finish(
          post(
            'finish',
            { token, credential },
            {
              ...form,
              cookie: cookieName + '=' + 'b'.repeat(43),
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect((await requestEmail(post('request', { email: 'owner@mail.ru', padding: 'x'.repeat(3000) }))).status).toBe(
      202,
    );
    expect((await start(post('start', { token, padding: 'x'.repeat(3000) }))).status).toBe(403);
    expect(
      (
        await finish(
          post(
            'finish',
            { token, credential, padding: 'x'.repeat(40_000) },
            {
              cookie: cookieName + '=' + 'b'.repeat(43),
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(beginRecovery).not.toHaveBeenCalled();
    expect(finishRecovery).not.toHaveBeenCalled();
  });

  it('a denied finish or expired link creates no Auth.js session or cookies', async () => {
    const withCookie = { cookie: cookieName + '=' + 'b'.repeat(43) };
    beginRecovery.mockRejectedValueOnce(new Error('expired'));
    expect((await start(post('start', { token }))).status).toBe(403);
    finishRecovery.mockRejectedValueOnce(new Error('consumed token'));
    const response = await finish(post('finish', { token, credential }, withCookie));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
