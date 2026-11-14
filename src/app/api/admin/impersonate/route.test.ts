import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { verifyAndParse } from '@/server/lib/signed-cookie';

const { authMock, ownerCheck, findUser, audit, getToken, cookiesMock, state } = vi.hoisted(() => ({
  authMock: vi.fn(),
  ownerCheck: vi.fn(),
  findUser: vi.fn(),
  audit: vi.fn(),
  getToken: vi.fn(),
  cookiesMock: vi.fn(),
  state: { impersonation: null as string | null, removed: false },
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: { user: { findUnique: findUser } } }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: ownerCheck }));
vi.mock('@/server/trpc/routers/admin', () => ({ logAdminAction: audit }));
vi.mock('next-auth/jwt', () => ({ getToken }));
vi.mock('next/headers', () => ({ cookies: cookiesMock }));

const authSecret = 'test-auth-secret-for-admin-impersonation-12345678';
const owner = 'owner-id';
const target = 'regular-user-id';
const nonce = 'b'.repeat(42) + 'g';

function request(body: unknown, method: 'POST' | 'DELETE' = 'POST') {
  return new Request('https://billok.ru/api/admin/impersonate', {
    method,
    headers: { cookie: 'authjs.session-token=verified-jwt', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', authSecret);
  state.impersonation = null;
  state.removed = false;
  authMock.mockResolvedValue({ user: { id: owner, email: 'owner@example.ru', name: 'Владелец' } });
  ownerCheck.mockResolvedValue(owner);
  findUser.mockResolvedValue({ id: target, name: 'Анна', email: 'anna@example.ru' });
  getToken.mockResolvedValue({ id: owner, sessionSecurityValid: true, impersonationSessionNonce: nonce });
  cookiesMock.mockImplementation(async () => ({
    get: (name: string) =>
      name === 'sharetab-impersonate' && state.impersonation ? { value: state.impersonation } : undefined,
    set: (_name: string, value: string) => {
      state.impersonation = value;
    },
    delete: () => {
      state.removed = true;
      state.impersonation = null;
    },
  }));
  audit.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('Issue 6.12.3: privileged impersonation REST boundary', () => {
  test('only the real owner can create a mode cookie bound to the current Passkey session', async () => {
    const { POST, DELETE } = await import('./route');
    const started = await POST(request({ userId: target }));
    expect(started.status).toBe(200);
    expect(state.impersonation).toBeTruthy();
    const signed = verifyAndParse<{
      adminId: string;
      adminEmail: string;
      targetId: string;
      sessionBinding: string;
    }>(state.impersonation!);
    expect(signed).toMatchObject({
      adminId: owner,
      targetId: target,
      adminEmail: 'owner@example.ru',
      sessionBinding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const previousCookie = state.impersonation!;
    expect((await POST(request({ userId: 'second-target' }))).status).toBe(403);
    expect(state.impersonation).toBe(previousCookie);
    const ended = await DELETE(request(null, 'DELETE'));
    expect(ended.status).toBe(200);
    expect(state.removed).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.anything(), owner, 'IMPERSONATION_ENDED', target, expect.anything());
    expect(authMock).toHaveBeenCalledTimes(3);
    expect(ownerCheck).toHaveBeenCalledWith(expect.anything(), owner);
  });

  test('wrong/legacy/revoked JWT, forged role fields and self-impersonation are rejected', async () => {
    const { POST } = await import('./route');
    for (const body of [{ userId: target, adminId: owner }, { userId: target, isAdmin: true }, { userId: owner }]) {
      const reply = await POST(request(body));
      expect(reply.ok).toBe(false);
    }
    getToken.mockResolvedValueOnce({ id: owner, sessionSecurityValid: false, impersonationSessionNonce: nonce });
    expect((await POST(request({ userId: target }))).status).toBe(403);
    getToken.mockResolvedValueOnce({ id: 'attacker', sessionSecurityValid: true, impersonationSessionNonce: nonce });
    expect((await POST(request({ userId: target }))).status).toBe(403);
    getToken.mockResolvedValueOnce({ id: owner, sessionSecurityValid: true });
    expect((await POST(request({ userId: target }))).status).toBe(403);
    expect(state.impersonation).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  test('a replayed cookie from another login is cleared without granting target authority or issuing a session', async () => {
    const { POST, DELETE } = await import('./route');
    expect((await POST(request({ userId: target }))).status).toBe(200);
    const saved = state.impersonation;
    getToken.mockResolvedValue({
      id: owner,
      sessionSecurityValid: true,
      impersonationSessionNonce: 'c'.repeat(42) + 'w',
    });
    expect((await DELETE(request(null, 'DELETE'))).status).toBe(200);
    expect(state.removed).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1); // start only; stolen/stale signed mode cannot issue end audit
    expect(saved).toBeTruthy();
    expect(state.impersonation).toBeNull();
  });

  test('owner-only export refuses an impersonated request before any data is accessed', async () => {
    state.impersonation = 'signed-impersonation-present';
    const { GET } = await import('../export/route');
    const response = await GET();
    expect(response.status).toBe(403);
    expect(findUser).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
