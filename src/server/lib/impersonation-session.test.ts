import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { signPayload } from './signed-cookie';

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock('next-auth/jwt', () => ({ getToken }));
import {
  currentImpersonationSessionBinding,
  issueAuthSessionNonce,
  verifiedImpersonationSession,
} from './impersonation-session';

const secret = 'test-auth-secret-for-impersonation-session-binding-12345678';
const owner = 'immutable-owner-id';
const target = 'registered-user-id';

function request(name: 'authjs.session-token' | '__Secure-authjs.session-token' = 'authjs.session-token') {
  return new Request('https://billok.ru/api/trpc', { headers: { cookie: name + '=real-signed-jwt' } });
}
function cookie(binding: string, overrides: Record<string, unknown> = {}) {
  return signPayload(
    JSON.stringify({
      adminId: owner,
      adminEmail: 'owner@example.ru',
      targetId: target,
      targetName: 'Друг',
      targetEmail: 'friend@example.ru',
      sessionBinding: binding,
      startedAt: new Date().toISOString(),
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', secret);
  getToken.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('Issue 6.12.3: impersonation is bound to one Passkey login', () => {
  test('random nonces are 256-bit and independent; refresh preserves its fingerprint', async () => {
    const a = issueAuthSessionNonce();
    const b = issueAuthSessionNonce();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(Buffer.from(b, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    getToken.mockResolvedValue({ id: owner, sessionSecurityValid: true, impersonationSessionNonce: a });
    const first = await currentImpersonationSessionBinding(request(), owner);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await currentImpersonationSessionBinding(request(), owner)).toBe(first);
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ secret, cookieName: 'authjs.session-token' }));
    getToken.mockResolvedValue({ id: owner, sessionSecurityValid: true, impersonationSessionNonce: b });
    const second = await currentImpersonationSessionBinding(request('__Secure-authjs.session-token'), owner);
    expect(second).not.toBe(first);
    expect(getToken).toHaveBeenLastCalledWith(expect.objectContaining({ cookieName: '__Secure-authjs.session-token' }));
    expect(verifiedImpersonationSession(cookie(first!), owner, second!)).toBeNull();
    expect(verifiedImpersonationSession(cookie(first!), owner, first!)).toMatchObject({
      adminId: owner,
      targetId: target,
    });
  });

  test('fails closed on anonymous, invalid/revoked JWT, spoofed user, legacy login and ambiguous cookies', async () => {
    const nonce = issueAuthSessionNonce();
    getToken.mockResolvedValue({ id: owner, sessionSecurityValid: true, impersonationSessionNonce: nonce });
    expect(await currentImpersonationSessionBinding(request(), 'attacker')).toBeNull();
    for (const payload of [
      null,
      { id: owner, sessionSecurityValid: false, impersonationSessionNonce: nonce },
      { id: owner, sessionSecurityValid: true },
      { id: owner, sessionSecurityValid: true, impersonationSessionNonce: 'forged' },
    ]) {
      getToken.mockResolvedValueOnce(payload);
      expect(await currentImpersonationSessionBinding(request(), owner)).toBeNull();
    }
    const both = new Request('https://billok.ru/api/trpc', {
      headers: { cookie: 'authjs.session-token=a; __Secure-authjs.session-token=b' },
    });
    expect(await currentImpersonationSessionBinding(both, owner)).toBeNull();
    expect(await currentImpersonationSessionBinding(new Request('https://billok.ru/'), owner)).toBeNull();
  });

  test('signed cookie rejects changed target/admin, stale, future, malformed and another-session replay', async () => {
    const nonce = issueAuthSessionNonce();
    const another = issueAuthSessionNonce();
    const now = Date.now();
    expect(verifiedImpersonationSession(cookie(nonce), owner, nonce)).toMatchObject({ targetId: target });
    const variations: Record<string, unknown>[] = [
      { adminId: 'other-owner' },
      { targetId: owner },
      { targetId: '' },
      { targetName: 123 },
      { adminEmail: null },
      { startedAt: new Date(now - 3_600_000 - 1).toISOString() },
      { startedAt: new Date(now + 30_000).toISOString() },
      { startedAt: 'not-a-date' },
      { sessionBinding: another },
    ];
    for (const fields of variations) {
      expect(verifiedImpersonationSession(cookie(nonce, fields), owner, nonce, now), JSON.stringify(fields)).toBeNull();
    }
    expect(verifiedImpersonationSession(cookie(nonce).replace(target, 'foreign-user'), owner, nonce)).toBeNull();
  });
});
