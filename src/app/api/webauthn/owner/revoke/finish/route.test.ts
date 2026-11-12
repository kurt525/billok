import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authMock, finishMock, rateMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  finishMock: vi.fn(),
  rateMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-passkey-revocation', () => ({
  finishOwnerPasskeyRevocation: finishMock,
  OWNER_REVOKE_BINDING_COOKIE: 'billok-owner-key-revoke',
}));
vi.mock('@/server/lib/webauthn-relying-party', () => ({
  readBillokWebAuthnRelyingParty: () => ({ origin: 'https://billok.ru' }),
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateMock }));
import { POST } from './route';

const request = (cookie = 'billok-owner-key-revoke=' + 'b'.repeat(43)) =>
  new Request('https://billok.ru/api/webauthn/owner/revoke/finish', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'signed-credential', type: 'public-key', response: {} }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner-1' } });
  finishMock.mockResolvedValue({ revoked: true, activeRemaining: 1 });
  rateMock.mockReturnValue({ allowed: true });
});

describe('Issue #1 6.8.2.2: no unsigned, anonymous or impersonated owner revocation', () => {
  it('requires the signed assertion, browser nonce and owner session', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, activeRemaining: 1 });
    expect(finishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        bindingSecret: 'b'.repeat(43),
        response: expect.objectContaining({ id: 'signed-credential' }),
      }),
    );
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });
  it('rejects missing session, missing binding and impersonated accounts', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request(''))).status).toBe(403);
    expect((await POST(request('sharetab-impersonate=other;billok-owner-key-revoke=' + 'b'.repeat(43)))).status).toBe(
      403,
    );
    expect(finishMock).not.toHaveBeenCalled();
  });
  it('refuses a replay rejected by the signing service; never trusts the browser result', async () => {
    finishMock.mockRejectedValueOnce(new Error('challenge used'));
    expect((await POST(request())).status).toBe(403);
  });
  it('rate limits before WebAuthn verification', async () => {
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(request())).status).toBe(429);
    expect(finishMock).not.toHaveBeenCalled();
  });
});
