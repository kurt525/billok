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
  renameOwnerPasskey: actionMock,
}));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  ownerSessionFingerprint: fingerprintMock,
}));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: rateMock }));
import { POST } from './route';

const payload = { targetId: 'key-1', label: 'Ноутбук', approvalToken: 'p'.repeat(43) };
const request = (body: unknown = payload, cookie = 'authjs.session-token=owner-jwt') =>
  new Request('https://billok.ru/api/webauthn/owner/manage/rename', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  fingerprintMock.mockReturnValue('a'.repeat(64));
  rateMock.mockReturnValue({ allowed: true });
  actionMock.mockResolvedValue({ renamed: true, label: 'Ноутбук' });
});
describe('Issue #1 6.10.2.4: rename requires exact owner and fresh signed proof', () => {
  it('accepts only the exact selected key, session fingerprint and proof', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ renamed: true, label: 'Ноутбук' });
    expect(actionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        sessionHash: 'a'.repeat(64),
        targetId: 'key-1',
        approvalToken: 'p'.repeat(43),
        label: 'Ноутбук',
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
  it('rate limits before evaluating signed management proof', async () => {
    rateMock.mockReturnValueOnce({ allowed: false });
    expect((await POST(request())).status).toBe(429);
    expect(actionMock).not.toHaveBeenCalled();
  });
});
