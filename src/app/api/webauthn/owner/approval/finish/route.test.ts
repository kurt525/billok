import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, finishMock, rateMock, sessionFingerprintMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  finishMock: vi.fn(),
  rateMock: vi.fn(),
  sessionFingerprintMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: vi.fn().mockResolvedValue('owner') }));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  finishOwnerPasskeyActionApproval: finishMock,
  ownerSessionFingerprint: sessionFingerprintMock,
  OWNER_APPROVAL_BINDING_COOKIE: 'billok-owner-approval',
}));
vi.mock('@/server/lib/webauthn-relying-party', () => ({
  readBillokWebAuthnRelyingParty: () => ({ origin: 'https://billok.ru' }),
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateMock }));
import { POST } from './route';

const createRequest = (cookie = 'authjs.session-token=owner;billok-owner-approval=' + 'b'.repeat(43)) =>
  new Request('https://billok.ru/api/webauthn/owner/approval/finish', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'signed-credential', type: 'public-key', response: {} }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  finishMock.mockResolvedValue({ approvalToken: 'p'.repeat(43), expiresInSeconds: 120 });
  rateMock.mockReturnValue({ allowed: true });
  sessionFingerprintMock.mockReturnValue('a'.repeat(64));
});

describe('Issue #1 6.10.2.2: approval/finish does not mutate keys or create a session', () => {
  it('issues only a short-lived approval for verified Auth.js session + browser nonce', async () => {
    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approvalToken: 'p'.repeat(43),
      expiresInSeconds: 120,
    });
    expect(finishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        sessionHash: 'a'.repeat(64),
        bindingSecret: 'b'.repeat(43),
        response: expect.objectContaining({ id: 'signed-credential' }),
      }),
    );
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/u);
  });
  it('rejects missing session, missing nonce and impersonation', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(createRequest())).status).toBe(403);
    expect((await POST(createRequest('authjs.session-token=owner'))).status).toBe(403);
    expect(
      (
        await POST(
          createRequest(
            'authjs.session-token=owner;sharetab-impersonate=somebody;' + 'billok-owner-approval=' + 'b'.repeat(43),
          ),
        )
      ).status,
    ).toBe(403);
    expect(finishMock).not.toHaveBeenCalled();
  });
  it('fails closed after consumed WebAuthn challenge or changed session', async () => {
    finishMock.mockRejectedValueOnce(new Error('consumed'));
    expect((await POST(createRequest())).status).toBe(403);
    sessionFingerprintMock.mockImplementationOnce(() => {
      throw new Error('not bound');
    });
    expect((await POST(createRequest())).status).toBe(403);
  });
  it('rate limits before requesting WebAuthn verification', async () => {
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(createRequest())).status).toBe(429);
    expect(finishMock).not.toHaveBeenCalled();
  });
});
