import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, dbMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  dbMock: {
    ownerBootstrap: { findUnique: vi.fn() },
    passkeyCredential: { count: vi.fn() },
  },
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({ db: dbMock }));

import { GET } from './route';

describe('Issue #1 6.3.2.2.2: first Passkey completes owner setup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { id: 'owner-1' } });
    dbMock.ownerBootstrap.findUnique.mockResolvedValue({
      userId: 'owner-1',
      completedAt: new Date('2026-11-12T00:00:00Z'),
    });
    dbMock.passkeyCredential.count.mockResolvedValue(1);
  });

  it('accepts one valid owner credential; two more are optional', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      firstKeyAdded: true,
      completed: true,
      activePasskeys: 1,
      optionalMaxPasskeys: 3,
    });
    expect(dbMock.passkeyCredential.count).toHaveBeenCalledWith({
      where: { userId: 'owner-1', revokedAt: null },
    });
  });

  it('does not mark incomplete registration done before the first key exists', async () => {
    dbMock.passkeyCredential.count.mockResolvedValueOnce(0);
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).completed).toBe(false);
  });

  it('rejects a request from a non-owner even with an active session', async () => {
    dbMock.ownerBootstrap.findUnique.mockResolvedValueOnce({ userId: 'someone-else', completedAt: new Date() });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(dbMock.passkeyCredential.count).not.toHaveBeenCalled();
  });

  it('does not disclose owner status to unauthenticated callers', async () => {
    authMock.mockResolvedValueOnce(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(dbMock.ownerBootstrap.findUnique).not.toHaveBeenCalled();
  });
});
