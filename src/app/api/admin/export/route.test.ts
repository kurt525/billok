import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AppError } from '@/server/lib/app-error';

const { authMock, ownerCheck, cookiesMock, fingerprint, proof, lock, writeAudit, transaction, tx, models } = vi.hoisted(
  () => {
    const names = [
      'user',
      'group',
      'groupMember',
      'groupInvite',
      'expense',
      'expenseShare',
      'settlement',
      'receipt',
      'receiptItem',
      'activityLog',
      'guestSplit',
      'systemSetting',
      'systemInvite',
    ] as const;
    const models = Object.fromEntries(names.map((name) => [name, { findMany: vi.fn().mockResolvedValue([]) }]));
    const writeAudit = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const lock = vi.fn().mockResolvedValue([{ id: 'owner' }]);
    const tx = {
      ...models,
      $queryRawUnsafe: lock,
      adminAuditLog: { findMany: vi.fn().mockResolvedValue([]), create: writeAudit },
    };
    return {
      authMock: vi.fn(),
      ownerCheck: vi.fn(),
      cookiesMock: vi.fn(),
      fingerprint: vi.fn(),
      proof: vi.fn(),
      lock,
      writeAudit,
      transaction: vi.fn(),
      tx,
      models,
    };
  },
);
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: { ...tx, $transaction: transaction } }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner: ownerCheck }));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  ownerSessionFingerprint: fingerprint,
  consumeOwnerPasskeyActionProof: proof,
}));
vi.mock('next/headers', () => ({ cookies: cookiesMock }));

const token = 'p'.repeat(43);
function request(body: unknown = { approvalToken: token }) {
  return new Request('https://billok.ru/api/admin/export', {
    method: 'POST',
    headers: {
      cookie: 'authjs.session-token=verified-owner-jwt',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner', email: 'owner@mail.ru' } });
  ownerCheck.mockResolvedValue('owner');
  cookiesMock.mockResolvedValue({ get: vi.fn().mockReturnValue(undefined) });
  fingerprint.mockReturnValue('a'.repeat(64));
  proof.mockResolvedValue(undefined);
  lock.mockResolvedValue([{ id: 'owner' }]);
  writeAudit.mockResolvedValue({ id: 'audit-1' });
  for (const model of Object.values(models)) model.findMany.mockResolvedValue([]);
  tx.adminAuditLog.findMany.mockResolvedValue([]);
  transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));
});

describe('Issue 6.12.4.5: each administrative JSON export needs an exact one-time Passkey grant', () => {
  test('GET, anonymous and JWT-only POST never return data or inspect financial tables', async () => {
    const { GET, POST } = await import('./route');
    const oldGet = await GET();
    expect(oldGet.status).toBe(405);
    expect(oldGet.headers.get('allow')).toBe('POST');
    authMock.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request({}))).status).toBe(403);
    expect((await POST(request({ approvalToken: 'bad' }))).status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
    expect(models.user!.findMany).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('impersonation and a revoked owner are denied before any export', async () => {
    const { POST } = await import('./route');
    cookiesMock.mockResolvedValueOnce({ get: vi.fn().mockReturnValue({ value: 'active' }) });
    expect((await POST(request())).status).toBe(403);
    ownerCheck.mockRejectedValueOnce(new AppError('FORBIDDEN'));
    expect((await POST(request())).status).toBe(403);
    expect(proof).not.toHaveBeenCalled();
    expect(models.user!.findMany).not.toHaveBeenCalled();
  });

  test('fresh ADMIN_EXPORT proof must be consumed before reading even the first table; audit is atomic', async () => {
    const { POST } = await import('./route');
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('content-disposition')).toMatch(/^attachment; filename="billok-export-/u);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'owner');
    expect(proof).toHaveBeenCalledWith(tx, {
      userId: 'owner',
      action: 'ADMIN_EXPORT',
      targetId: 'all-data:v1',
      sessionHash: 'a'.repeat(64),
      approvalToken: token,
    });
    expect(proof.mock.invocationCallOrder[0]!).toBeLessThan(models.user!.findMany.mock.invocationCallOrder[0]!);
    expect(models.user!.findMany.mock.invocationCallOrder[0]!).toBeLessThan(writeAudit.mock.invocationCallOrder[0]!);
    expect(writeAudit).toHaveBeenCalledWith({
      data: { adminId: 'owner', action: 'EXPORT_CREATED', metadata: { tableCount: 14 } },
    });
    const data = await result.json();
    expect(data.exportedBy).toBe('owner@mail.ru');
    expect(data.data).toHaveProperty('users');
    expect(data.data).not.toHaveProperty('password');
  });

  test('a token for different target/action/session, expired or used cannot return data or record export', async () => {
    const { POST } = await import('./route');
    for (const reason of ['wrong target', 'wrong action', 'different session', 'expired', 'replay']) {
      proof.mockRejectedValueOnce(new AppError('FORBIDDEN')); // generic error: do not disclose target
      const response = await POST(request());
      expect(response.status, reason).toBe(403);
      expect(response.headers.get('content-disposition')).toBeNull();
    }
    expect(models.user!.findMany).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('if a table read or audit fails, nothing is downloaded and transaction does not complete', async () => {
    const { POST } = await import('./route');
    models.group!.findMany.mockRejectedValueOnce(new Error('database inaccessible'));
    const result = await POST(request());
    expect(result.status).toBe(500);
    expect(writeAudit).not.toHaveBeenCalled();
    writeAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await POST(request())).status).toBe(500);
  });

  test('6.12.6: streaming or oversized administrative body cannot reach DB or consume proof', async () => {
    const { POST } = await import('./route');
    const tooLarge = new Request('https://billok.ru/api/admin/export', {
      method: 'POST',
      headers: { cookie: 'authjs.session-token=verified-owner-jwt', 'content-type': 'application/json' },
      body: JSON.stringify({ approvalToken: token, injected: 'x'.repeat(513) }),
    });
    expect((await POST(tooLarge)).status).toBe(403);
    expect(models.user!.findMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('signed token cannot be replayed to obtain two exports', async () => {
    const { POST } = await import('./route');
    let consumed = false;
    proof.mockImplementation(async () => {
      if (consumed) throw new AppError('FORBIDDEN');
      consumed = true;
    });
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(403);
    expect(models.user!.findMany).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });
});
