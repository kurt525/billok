import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authMock, beginMock, rateMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  beginMock: vi.fn(),
  rateMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: vi.fn().mockResolvedValue('owner') }));
vi.mock('@/server/lib/owner-passkey-revocation', () => ({
  beginOwnerPasskeyRevocation: beginMock,
  OWNER_REVOKE_BINDING_COOKIE: 'billok-owner-key-revoke',
}));
vi.mock('@/server/lib/webauthn-registration', () => ({
  newWebAuthnBindingSecret: () => 'b'.repeat(43),
}));
vi.mock('@/server/lib/webauthn-relying-party', () => ({
  readBillokWebAuthnRelyingParty: () => ({ origin: 'https://billok.ru' }),
  WEBAUTHN_CHALLENGE_TTL_MS: 300_000,
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateMock }));
import { POST } from './route';

const request = (targetId: unknown = 'lost-key', cookie = '') =>
  new Request('https://billok.ru/api/webauthn/owner/revoke/start', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ targetId }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner-1' } });
  beginMock.mockResolvedValue({ challenge: 'q'.repeat(43) });
  rateMock.mockReturnValue({ allowed: true });
});

describe('Issue #1 6.8.2.2: owner-only signed-revoke start API', () => {
  it('issues a private short-lived browser binding, not a login ticket', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).options.challenge).toBe('q'.repeat(43));
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        targetId: 'lost-key',
        bindingSecret: 'b'.repeat(43),
      }),
    );
    expect(response.headers.get('set-cookie')).toMatch(/billok-owner-key-revoke=/);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=strict/i);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/);
  });
  it('rejects missing session and impersonation without touching a credential', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request('lost-key', 'sharetab-impersonate=anything'))).status).toBe(403);
    expect(beginMock).not.toHaveBeenCalled();
  });
  it('blocks non-strings, invalid target and throttled requests', async () => {
    expect((await POST(request(null))).status).toBe(403);
    expect(beginMock).not.toHaveBeenCalled();
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(request())).status).toBe(429);
    expect(beginMock).not.toHaveBeenCalled();
  });
  it('fails closed when the owner account or other server invariant is rejected', async () => {
    beginMock.mockRejectedValueOnce(new Error('not owner'));
    expect((await POST(request())).status).toBe(403);
  });
});
