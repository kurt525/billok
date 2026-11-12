import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authMock, finishMock, rateMock, fingerprintMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  finishMock: vi.fn(),
  rateMock: vi.fn(),
  fingerprintMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-passkey-add', () => ({
  finishAdditionalOwnerPasskey: finishMock,
  OWNER_ADD_BINDING_COOKIE: 'billok-owner-passkey-add',
}));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  ownerSessionFingerprint: fingerprintMock,
}));
vi.mock('@/server/lib/webauthn-relying-party', () => ({
  readBillokWebAuthnRelyingParty: () => ({ origin: 'https://billok.ru' }),
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateMock }));
import { POST } from './route';

const request = (
  cookie = 'authjs.session-token=owner-jwt;billok-owner-passkey-add=' + 'b'.repeat(43),
  body: unknown = { approvalToken: 'p'.repeat(43), response: { id: 'credential-new' } },
) =>
  new Request('https://billok.ru/api/webauthn/owner/add/finish', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  rateMock.mockReturnValue({ allowed: true });
  fingerprintMock.mockReturnValue('a'.repeat(64));
  finishMock.mockResolvedValue({ registered: true, activePasskeys: 2 });
});
describe('6.10.2.3: additional Passkey finish is not an auth bypass', () => {
  it('requires a real registration response plus proof and private browser cookie', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: true, activePasskeys: 2 });
    expect(finishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        sessionHash: 'a'.repeat(64),
        bindingSecret: 'b'.repeat(43),
        approvalToken: 'p'.repeat(43),
        response: { id: 'credential-new' },
      }),
    );
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/u);
  });
  it('rejects missing session, browser nonce, impersonation and unsigned response', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request('authjs.session-token=owner-jwt'))).status).toBe(403);
    expect(
      (
        await POST(
          request(
            'authjs.session-token=owner-jwt;sharetab-impersonate=other;' + 'billok-owner-passkey-add=' + 'b'.repeat(43),
          ),
        )
      ).status,
    ).toBe(403);
    expect((await POST(request(undefined, { approvalToken: 'p'.repeat(43) }))).status).toBe(403);
    expect(finishMock).not.toHaveBeenCalled();
  });
  it('fails closed when proof was already consumed, expired or violated third-key limit', async () => {
    finishMock.mockRejectedValue(new Error('proof revoked'));
    expect((await POST(request())).status).toBe(403);
  });
  it('rate limits before verifying registration attestation', async () => {
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(request())).status).toBe(429);
    expect(finishMock).not.toHaveBeenCalled();
  });
});
