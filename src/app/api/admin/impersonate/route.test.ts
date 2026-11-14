import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { verifyAndParse } from '@/server/lib/signed-cookie';

const {
  authMock,
  ownerCheck,
  findUser,
  audit,
  writeAudit,
  proof,
  fingerprint,
  lock,
  transaction,
  getToken,
  cookiesMock,
  state,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  ownerCheck: vi.fn(),
  findUser: vi.fn(),
  audit: vi.fn(),
  writeAudit: vi.fn(),
  proof: vi.fn(),
  fingerprint: vi.fn(),
  lock: vi.fn(),
  transaction: vi.fn(),
  getToken: vi.fn(),
  cookiesMock: vi.fn(),
  state: { impersonation: null as string | null, removed: false },
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
const txMock = {
  user: { findUnique: findUser },
  $queryRawUnsafe: lock,
  adminAuditLog: { create: writeAudit },
};
vi.mock('@/server/db', () => ({
  db: { ...txMock, $transaction: transaction },
}));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  ownerSessionFingerprint: fingerprint,
  consumeOwnerPasskeyActionProof: proof,
}));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: ownerCheck }));
vi.mock('@/server/trpc/routers/admin', () => ({ logAdminAction: audit }));
vi.mock('next-auth/jwt', () => ({ getToken }));
vi.mock('next/headers', () => ({ cookies: cookiesMock }));

const authSecret = 'test-auth-secret-for-admin-impersonation-12345678';
const owner = 'owner-id';
const target = 'regular-user-id';
const nonce = 'b'.repeat(42) + 'g';

const passkeyProof = 'b'.repeat(43);
const approved = (userId: string) => ({ userId, approvalToken: passkeyProof });

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
  lock.mockResolvedValue([{ id: owner }]);
  writeAudit.mockResolvedValue({ id: 'audit-start' });
  proof.mockResolvedValue(undefined);
  fingerprint.mockReturnValue('a'.repeat(64));
  transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(txMock));
});
afterEach(() => vi.unstubAllEnvs());

describe('Issue 6.12.3: privileged impersonation REST boundary', () => {
  test('only the real owner can create a mode cookie bound to the current Passkey session', async () => {
    const { POST, DELETE } = await import('./route');
    const started = await POST(request(approved(target)));
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
    expect((await POST(request(approved('second-target')))).status).toBe(403);
    expect(state.impersonation).toBe(previousCookie);
    const ended = await DELETE(request(null, 'DELETE'));
    expect(ended.status).toBe(200);
    expect(state.removed).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.anything(), owner, 'IMPERSONATION_ENDED', target, expect.anything());
    expect(authMock).toHaveBeenCalledTimes(3);
    expect(proof).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ action: 'IMPERSONATE', targetId: target, sessionHash: 'a'.repeat(64) }),
    );
    expect(writeAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'IMPERSONATION_STARTED', targetId: target }),
    });
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
    expect((await POST(request(approved(target)))).status).toBe(200);
    const saved = state.impersonation;
    getToken.mockResolvedValue({
      id: owner,
      sessionSecurityValid: true,
      impersonationSessionNonce: 'c'.repeat(42) + 'w',
    });
    expect((await DELETE(request(null, 'DELETE'))).status).toBe(200);
    expect(state.removed).toBe(true);
    expect(writeAudit).toHaveBeenCalledTimes(1); // signed START is transactional
    expect(audit).not.toHaveBeenCalled(); // stale cookie cannot issue END audit
    expect(saved).toBeTruthy();
    expect(state.impersonation).toBeNull();
  });

  test('6.12.4.5: JWT-only impersonation cannot create cookie or audit', async () => {
    const { POST } = await import('./route');
    expect((await POST(request({ userId: target }))).status).toBe(400);
    expect((await POST(request({ userId: target, approvalToken: 'bad' }))).status).toBe(400);
    expect(state.impersonation).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('6.12.4.5: wrong action, target, session, expired and replayed proof cannot impersonate', async () => {
    const { POST } = await import('./route');
    for (const reason of ['wrong action', 'wrong target', 'wrong session', 'expired', 'replayed']) {
      proof.mockRejectedValueOnce(new Error(reason));
      const response = await POST(request(approved(target)));
      expect(response.status).toBe(403);
      expect(state.impersonation).toBeNull();
    }
    expect(writeAudit).not.toHaveBeenCalled();
    expect(lock.mock.calls.slice(0, 2)).toEqual([
      ['SELECT id FROM "User" WHERE id = $1 FOR UPDATE', owner],
      ['SELECT id FROM "User" WHERE id = $1 FOR UPDATE', target],
    ]);
  });

  test('6.12.4.5: audit failure rolls back impersonation; owner cannot enter as itself', async () => {
    const { POST } = await import('./route');
    writeAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await POST(request(approved(target)))).status).toBe(403);
    expect(state.impersonation).toBeNull();
    expect((await POST(request(approved(owner)))).status).toBe(400);
    expect(state.impersonation).toBeNull();
  });

  test('owner-only export refuses an impersonated request before any data is accessed', async () => {
    state.impersonation = 'signed-impersonation-present';
    const { GET, POST } = await import('../export/route');
    expect((await GET()).status).toBe(405);
    const response = await POST(
      new Request('https://billok.ru/api/admin/export', {
        method: 'POST',
        headers: { cookie: 'authjs.session-token=verified-jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ approvalToken: passkeyProof }),
      }),
    );
    expect(response.status).toBe(403);
    expect(findUser).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
