import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authMock, addMock, rateMock, fingerprintMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  addMock: vi.fn(),
  rateMock: vi.fn(),
  fingerprintMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: vi.fn().mockResolvedValue('owner') }));
vi.mock('@/server/lib/owner-passkey-add', () => ({
  beginAdditionalOwnerPasskey: addMock,
  OWNER_ADD_BINDING_COOKIE: 'billok-owner-passkey-add',
}));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  ownerSessionFingerprint: fingerprintMock,
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

const request = (body: unknown, cookie = 'authjs.session-token=owner-jwt') =>
  new Request('https://billok.ru/api/webauthn/owner/add/start', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  rateMock.mockReturnValue({ allowed: true });
  fingerprintMock.mockReturnValue('a'.repeat(64));
  addMock.mockResolvedValue({ challenge: 'q'.repeat(43) });
});
describe('6.10.2.3: additional Passkey start requires signed ADD approval', () => {
  it('passes an unmodified owner session fingerprint and token to the protected service', async () => {
    const response = await POST(request({ approvalToken: 'p'.repeat(43) }));
    expect(response.status).toBe(200);
    expect((await response.json()).options.challenge).toBe('q'.repeat(43));
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        sessionHash: 'a'.repeat(64),
        approvalToken: 'p'.repeat(43),
        bindingSecret: 'b'.repeat(43),
      }),
    );
    expect(response.headers.get('set-cookie')).toMatch(/billok-owner-passkey-add=/u);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/u);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=strict/iu);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/u);
  });
  it('rejects anonymous, impersonated and missing session fingerprint', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(request({ approvalToken: 'p'.repeat(43) }))).status).toBe(403);
    expect(
      (
        await POST(
          request({ approvalToken: 'p'.repeat(43) }, 'authjs.session-token=owner-jwt;sharetab-impersonate=other'),
        )
      ).status,
    ).toBe(403);
    fingerprintMock.mockImplementationOnce(() => {
      throw new Error('not logged in');
    });
    expect((await POST(request({ approvalToken: 'p'.repeat(43) }))).status).toBe(403);
    expect(addMock).not.toHaveBeenCalled();
  });
  it('fails closed when signed ADD proof is missing or revoked', async () => {
    addMock.mockRejectedValue(new Error('missing ADD proof'));
    expect((await POST(request({ approvalToken: null }))).status).toBe(403);
    expect((await POST(request({ approvalToken: 'x'.repeat(43) }))).status).toBe(403);
  });
  it('rate limits owner and caller IP before any registration', async () => {
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(request({ approvalToken: 'p'.repeat(43) }))).status).toBe(429);
    expect(addMock).not.toHaveBeenCalled();
  });
});
