import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authMock, actionMock, rateMock, fingerprintMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  actionMock: vi.fn(),
  rateMock: vi.fn(),
  fingerprintMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: vi.fn().mockResolvedValue('owner') }));
vi.mock('@/server/lib/owner-passkey-management', () => ({
  revokeApprovedOwnerPasskey: actionMock,
}));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  ownerSessionFingerprint: fingerprintMock,
}));
vi.mock('@/server/lib/owner-webauthn-burst', () => ({ allowOwnerWebAuthnRequest: rateMock }));
import { POST } from './route';

const payload = { targetId: 'key-1', approvalToken: 'p'.repeat(43) };
const request = (body: unknown = payload, cookie = 'authjs.session-token=owner-jwt') =>
  new Request('https://billok.ru/api/webauthn/owner/manage/revoke', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  fingerprintMock.mockReturnValue('a'.repeat(64));
  rateMock.mockReturnValue(true);
  actionMock.mockResolvedValue({ revoked: true, activeRemaining: 1 });
});
describe('Issue #1 6.10.2.4: revoke requires exact owner and fresh signed proof', () => {
  it('accepts only the exact selected key, session fingerprint and proof', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(rateMock).toHaveBeenCalledWith('owner', 'manage-revoke');
    expect(await response.json()).toEqual({ revoked: true, activeRemaining: 1 });
    expect(actionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        sessionHash: 'a'.repeat(64),
        targetId: 'key-1',
        approvalToken: 'p'.repeat(43),
      }),
    );
  });
  it('rejects missing session, impersonation and bad request fields before the mutation', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request(payload, 'authjs.session-token=owner-jwt;sharetab-impersonate=other'))).status).toBe(
      403,
    );
    expect((await POST(request({ approvalToken: 'p'.repeat(43) }))).status).toBe(403);
    expect(actionMock).not.toHaveBeenCalled();
  });
  it('requires Auth.js session fingerprint, refuses replayed proof and invalid target', async () => {
    fingerprintMock.mockImplementationOnce(() => {
      throw Error('bad cookie');
    });
    expect((await POST(request())).status).toBe(403);
    actionMock.mockRejectedValueOnce(new Error('replayed proof'));
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request({ ...payload, targetId: 42 }))).status).toBe(403);
  });
  it('short 2-second per-owner anti-flood only; no hourly quota or shared IP bucket', async () => {
    rateMock.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(429);
    expect(rateMock).toHaveBeenCalledWith('owner', 'manage-revoke');
    expect(actionMock).not.toHaveBeenCalled();
  });

  it('strictly rejects extra role/admin claims and malformed approval inputs before any DB mutation', async () => {
    for (const invalid of [
      { ...payload, adminId: 'admin-spoof' },
      { ...payload, userId: 'owner-spoof' },
      { ...payload, role: 'OWNER' },
      { ...payload, approvalToken: 'invalid' },
      { ...payload, targetId: '' },
      { ...payload, targetId: 'x'.repeat(129) },
      { ...payload, other: null },
      null,
      [],
    ]) {
      expect((await POST(request(invalid))).status).toBe(403);
    }
    expect(actionMock).not.toHaveBeenCalled();
  });
});
