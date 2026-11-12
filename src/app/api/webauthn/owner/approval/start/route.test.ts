import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, beginMock, rateMock, sessionFingerprintMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  beginMock: vi.fn(),
  rateMock: vi.fn(),
  sessionFingerprintMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: vi.fn().mockResolvedValue('owner') }));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  beginOwnerPasskeyActionApproval: beginMock,
  ownerSessionFingerprint: sessionFingerprintMock,
  OWNER_APPROVAL_BINDING_COOKIE: 'billok-owner-approval',
}));
vi.mock('@/server/lib/webauthn-registration', () => ({
  newWebAuthnBindingSecret: () => 'b'.repeat(43),
}));
vi.mock('@/server/lib/webauthn-relying-party', () => ({
  readBillokWebAuthnRelyingParty: () => ({ origin: 'https://billok.ru' }),
  WEBAUTHN_CHALLENGE_TTL_MS: 300_000,
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateMock }));
import { requireOwner } from '@/server/lib/owner-access';
import { POST } from './route';

const createRequest = (body: unknown, cookie = 'authjs.session-token=owner-session') =>
  new Request('https://billok.ru/api/webauthn/owner/approval/start', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  rateMock.mockReturnValue({ allowed: true });
  beginMock.mockResolvedValue({ challenge: 'q'.repeat(43), allowCredentials: [] });
  sessionFingerprintMock.mockReturnValue('a'.repeat(64));
});

describe('Issue #1 6.10.2.2: approval/start requires logged-in owner', () => {
  it('creates an HttpOnly browser nonce tied to one validated operation', async () => {
    const response = await POST(createRequest({ action: 'REVOKE', targetId: 'target-1' }));
    expect(response.status).toBe(200);
    expect((await response.json()).options.challenge).toBe('q'.repeat(43));
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        action: 'REVOKE',
        targetId: 'target-1',
        bindingSecret: 'b'.repeat(43),
        sessionHash: 'a'.repeat(64),
      }),
    );
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/u);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=strict/iu);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/u);
  });
  it('rejects anonymous/impersonated attempts and bad action without generating a challenge', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(createRequest({ action: 'ADD' }))).status).toBe(403);
    expect(
      (await POST(createRequest({ action: 'RENAME' }, 'authjs.session-token=owner-session; sharetab-impersonate=x')))
        .status,
    ).toBe(403);
    for (const action of ['LOGIN', 'EMAIL', 'OWNER_RESET', null]) {
      expect((await POST(createRequest({ action }))).status).toBe(403);
    }
    expect(beginMock).not.toHaveBeenCalled();
  });
  it('refuses account authorization failure before any privileged WebAuthn action', async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(new Error('suspended/placeholder owner'));
    const response = await POST(createRequest({ action: 'REVOKE', targetId: 'target-1' }));
    expect(response.status).toBe(403);
    expect(beginMock).not.toHaveBeenCalled();
    expect(rateMock).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated cookie and a rate-limited account', async () => {
    sessionFingerprintMock.mockImplementationOnce(() => {
      throw Error('no session');
    });
    expect((await POST(createRequest({ action: 'ADD' }))).status).toBe(403);
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(createRequest({ action: 'ADD' }))).status).toBe(429);
    expect(beginMock).not.toHaveBeenCalled();
  });
});
