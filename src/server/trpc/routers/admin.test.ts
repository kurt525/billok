import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock next-auth (must come before other imports that transitively import it)
vi.mock('next-auth', () => ({
  default: vi.fn(),
}));
vi.mock('@auth/prisma-adapter', () => ({
  PrismaAdapter: vi.fn(),
}));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn(),
}));
vi.mock('next-auth/providers/google', () => ({
  default: vi.fn(),
}));
vi.mock('next-auth/providers/nodemailer', () => ({
  default: vi.fn(),
}));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Mock the auth module directly
vi.mock('@/server/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Mock Prisma client
const mockDb = {
  $queryRaw: vi.fn(),
  // Interactive transactions run their callback against the same mocks
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
  user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    update: vi.fn(),
  },
  group: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  groupMember: {
    findMany: vi.fn(),
  },
  guestSplit: {
    findMany: vi.fn(),
  },
  expense: {
    count: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
  },
  settlement: {
    count: vi.fn(),
  },
  receipt: {
    count: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
  },
  adminAuditLog: {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  systemSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  systemInvite: {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  activityLog: {
    findMany: vi.fn().mockResolvedValue([]),
  },
};

vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { removeReceiptFiles, deleteExpiredSplits, countUnusedReceipts, deleteUnusedReceipts } = vi.hoisted(() => ({
  removeReceiptFiles: vi.fn(),
  deleteExpiredSplits: vi.fn(),
  countUnusedReceipts: vi.fn(),
  deleteUnusedReceipts: vi.fn(),
}));
vi.mock('@/server/lib/receipt-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/receipt-cleanup')>()),
  removeReceiptFiles,
  deleteExpiredSplits,
  countUnusedReceipts,
  deleteUnusedReceipts,
}));
vi.mock('@/server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));
describe('adminProcedure authorization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
  });

  test('exports adminProcedure', async () => {
    const { adminProcedure } = await import('./admin');
    expect(adminProcedure).toBeDefined();
  });

  test('adminRouter is defined and has procedures', async () => {
    const { adminRouter } = await import('./admin');
    expect(adminRouter).toBeDefined();
    expect(adminRouter._def).toBeDefined();
  });

  test('router exports both adminRouter and adminProcedure', async () => {
    const mod = await import('./admin');
    expect(mod.adminRouter).toBeDefined();
    expect(mod.adminProcedure).toBeDefined();
  });
});

describe('logAdminAction helper', () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.adminAuditLog.create.mockClear();
  });

  test('logAdminAction is exported', async () => {
    const { logAdminAction } = await import('./admin');
    expect(logAdminAction).toBeDefined();
    expect(typeof logAdminAction).toBe('function');
  });

  test('logAdminAction creates an audit log entry', async () => {
    const { logAdminAction } = await import('./admin');
    mockDb.adminAuditLog.create.mockResolvedValue({
      id: 'test-id',
      adminId: 'admin-1',
      action: 'USER_DELETED',
      targetId: 'user-1',
      metadata: { email: 'test@test.com' },
    });

    await logAdminAction(mockDb as never, 'admin-1', 'USER_DELETED' as never, 'user-1', { email: 'test@test.com' });

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'USER_DELETED',
        targetId: 'user-1',
        metadata: { email: 'test@test.com' },
      },
    });
  });

  test('logAdminAction handles null metadata', async () => {
    const { logAdminAction } = await import('./admin');
    mockDb.adminAuditLog.create.mockResolvedValue({});

    await logAdminAction(mockDb as never, 'admin-1', 'ORPHANS_CLEANED' as never, null, null);

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'ORPHANS_CLEANED',
      },
    });
  });
});

describe('admin router procedures existence', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
  });

  test('router has all expected procedures', async () => {
    const { adminRouter } = await import('./admin');
    const procedures = Object.keys(adminRouter._def.procedures);

    // Original procedures
    expect(procedures).toContain('getSystemHealth');
    expect(procedures).toContain('listUsers');
    expect(procedures).toContain('deleteUser');
    expect(procedures).toContain('listGroups');
    expect(procedures).toContain('deleteGroup');
    expect(procedures).toContain('getStorageStats');
    expect(procedures).toContain('cleanupOrphans');
    expect(procedures).toContain('cleanupUnusedReceipts');

    // New procedures
    expect(procedures).toContain('getAuditLog');
    expect(procedures).toContain('suspendUser');
    expect(procedures).toContain('unsuspendUser');
    expect(procedures).toContain('getRegistrationMode');
    expect(procedures).toContain('setRegistrationMode');
    expect(procedures).toContain('createSystemInvite');
    expect(procedures).toContain('listSystemInvites');
    expect(procedures).toContain('revokeSystemInvite');
    expect(procedures).toContain('getAnnouncement');
    expect(procedures).toContain('setAnnouncement');
    expect(procedures).toContain('getVenmoEnabled');
    expect(procedures).toContain('setVenmoEnabled');
    expect(procedures).toContain('getGlobalActivity');
    expect(procedures).toContain('sendTestEmail');
    expect(procedures).toContain('getImpersonationStatus');
  });
});

describe('admin formatBytes helper', () => {
  test('admin router initializes without errors', async () => {
    const { adminRouter } = await import('./admin');
    expect(adminRouter).toBeTruthy();
  });
});

describe('listUsers input schema', () => {
  const originalEnv = process.env;
  let inputSchema: { parse: (v: unknown) => unknown };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
    const { adminRouter } = await import('./admin');
    const inputs = (adminRouter._def.procedures.listUsers as { _def: { inputs: { parse: (v: unknown) => unknown }[] } })
      ._def.inputs;
    inputSchema = inputs[0]!;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('accepts valid sortBy values', () => {
    for (const sortBy of ['name', 'email', 'groupCount', 'createdAt']) {
      expect(() => inputSchema.parse({ sortBy })).not.toThrow();
    }
  });

  test('rejects invalid sortBy values', () => {
    expect(() => inputSchema.parse({ sortBy: 'totalAmount' })).toThrow();
    expect(() => inputSchema.parse({ sortBy: 'bogus' })).toThrow();
  });

  test('accepts valid status filters', () => {
    for (const status of ['all', 'active', 'suspended', 'placeholder']) {
      expect(() => inputSchema.parse({ status })).not.toThrow();
    }
  });

  test('defaults to createdAt desc when no sort specified', () => {
    const result = inputSchema.parse({}) as { sortBy: string; sortDirection: string };
    expect(result.sortBy).toBe('createdAt');
    expect(result.sortDirection).toBe('desc');
  });

  test('limits search to 200 characters', () => {
    expect(() => inputSchema.parse({ search: 'a'.repeat(201) })).toThrow();
    expect(() => inputSchema.parse({ search: 'a'.repeat(200) })).not.toThrow();
  });

  test('enforces limit bounds and integer constraint', () => {
    expect(() => inputSchema.parse({ limit: 0 })).toThrow();
    expect(() => inputSchema.parse({ limit: 101 })).toThrow();
    expect(() => inputSchema.parse({ limit: 20.5 })).toThrow();
    expect(() => inputSchema.parse({ limit: 50 })).not.toThrow();
  });
});

describe('listGroups input schema', () => {
  const originalEnv = process.env;
  let inputSchema: { parse: (v: unknown) => unknown };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
    const { adminRouter } = await import('./admin');
    const inputs = (
      adminRouter._def.procedures.listGroups as { _def: { inputs: { parse: (v: unknown) => unknown }[] } }
    )._def.inputs;
    inputSchema = inputs[0]!;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('accepts valid sortBy values', () => {
    for (const sortBy of ['name', 'memberCount', 'expenseCount', 'createdAt']) {
      expect(() => inputSchema.parse({ sortBy })).not.toThrow();
    }
  });

  test('rejects computed column sort keys', () => {
    expect(() => inputSchema.parse({ sortBy: 'totalAmount' })).toThrow();
    expect(() => inputSchema.parse({ sortBy: 'lastActivity' })).toThrow();
  });

  test('accepts valid status filters', () => {
    for (const status of ['all', 'active', 'archived']) {
      expect(() => inputSchema.parse({ status })).not.toThrow();
    }
  });

  test('defaults to createdAt desc when no sort specified', () => {
    const result = inputSchema.parse({}) as { sortBy: string; sortDirection: string };
    expect(result.sortBy).toBe('createdAt');
    expect(result.sortDirection).toBe('desc');
  });
});

const adminSession = { user: { id: 'admin-1', email: 'admin@example.com' } };

async function callerAs(session: { user: { id: string; email: string } }) {
  const { adminRouter } = await import('./admin');
  const ctx = { session, db: mockDb, headers: new Headers(), impersonating: null };
  return adminRouter.createCaller(ctx as unknown as Parameters<typeof adminRouter.createCaller>[0]);
}

describe('registration mode', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each(['invite-only', 'closed'])('returns the stored %s setting', async (mode) => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: mode });
    const api = await callerAs(adminSession);
    expect(await api.getRegistrationMode()).toEqual({ mode });
  });

  test('reads an unrecognised stored setting as open, as sign-up does', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'something-else' });
    const api = await callerAs(adminSession);
    expect(await api.getRegistrationMode()).toEqual({ mode: 'open' });
  });

  test.each(['open', 'invite-only', 'closed'] as const)('saves the %s setting', async (mode) => {
    mockDb.systemSetting.upsert.mockResolvedValue({ key: 'registrationMode', value: mode });
    const api = await callerAs(adminSession);
    expect(await api.setRegistrationMode({ mode })).toEqual({ mode });
    expect(mockDb.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'registrationMode' },
      update: { value: mode },
      // A fresh install has no row yet.
      create: { key: 'registrationMode', value: mode },
    });
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'REGISTRATION_MODE_CHANGED', metadata: { mode } }) as unknown,
      }),
    );
  });

  test('refuses to save a mode ShareTab does not know', async () => {
    const api = await callerAs(adminSession);
    await expect(api.setRegistrationMode({ mode: 'everyone' as 'open' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
  });
});

// #265: deleting a group left its placeholder users and scanned receipts behind. The
// admin dashboard's delete removes them as the owner's does (groups.test.ts covers
// what's kept).
describe('deleteGroup', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    mockDb.group.findUnique.mockResolvedValue({ id: 'g1', name: 'Trip' });
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.receipt.findMany.mockResolvedValue([{ id: 'r1', imagePath: 'receipts/r1.jpg' }]);
    mockDb.guestSplit.findMany.mockResolvedValue([]);
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'p1' }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('deletes the group with its receipts and placeholder members, then the image files', async () => {
    const api = await callerAs(adminSession);
    await expect(api.deleteGroup({ groupId: 'g1' })).resolves.toEqual({ deleted: true, groupId: 'g1' });

    expect(mockDb.$transaction).toHaveBeenCalled();
    expect(mockDb.group.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
    expect(mockDb.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(mockDb.user.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { in: ['p1'] }, isPlaceholder: true }),
    });
    expect(removeReceiptFiles).toHaveBeenCalledWith(['receipts/r1.jpg']);
    expect(removeReceiptFiles.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockDb.group.delete.mock.invocationCallOrder[0]!,
    );
  });
});

// #265: expired splits go with the receipts only they used (receipt-cleanup.test.ts),
// in batches so a backlog doesn't make one long transaction
describe('cleanupExpiredSplits', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A batch comes back short when the background cleanup or a user deleted some of its
  // splits first, with more left after it, so only an empty batch means none are left
  test('deletes expired splits batch by batch until none are left', async () => {
    deleteExpiredSplits
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(498)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0);
    const api = await callerAs(adminSession);
    await expect(api.cleanupExpiredSplits()).resolves.toEqual({ deletedCount: 1001 });

    expect(deleteExpiredSplits).toHaveBeenCalledTimes(4);
    expect(deleteExpiredSplits).toHaveBeenCalledWith(mockDb, 500);
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'EXPIRED_SPLITS_CLEANED', metadata: { deletedCount: 1001 } },
    });
  });
});

// #312: receipts no group, expense or split uses stayed for good, with their image files
// (the queries are in receipt-cleanup.ts)
describe('unused receipts', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.stubEnv('UPLOAD_DIR', '/nonexistent-sharetab-uploads');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('storage stats count them, with their size', async () => {
    mockDb.receipt.count.mockResolvedValue(5);
    mockDb.receipt.findMany.mockResolvedValue([]);
    countUnusedReceipts.mockResolvedValue({ count: 2, bytes: 2048 });
    const api = await callerAs(adminSession);

    await expect(api.getStorageStats()).resolves.toMatchObject({
      receiptCount: 5,
      unusedReceiptCount: 2,
      unusedReceiptBytes: 2048,
      unusedReceiptBytesFormatted: '2 KB',
    });
    expect(countUnusedReceipts).toHaveBeenCalledWith(mockDb);
  });

  test('cleaning up deletes them in batches and records it in the audit log', async () => {
    deleteUnusedReceipts.mockResolvedValue(3);
    const api = await callerAs(adminSession);

    await expect(api.cleanupUnusedReceipts()).resolves.toEqual({ deletedCount: 3 });
    expect(deleteUnusedReceipts).toHaveBeenCalledWith(mockDb, 500);
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'UNUSED_RECEIPTS_CLEANED', metadata: { deletedCount: 3 } },
    });
  });

  test('with none to clean up, records nothing', async () => {
    deleteUnusedReceipts.mockResolvedValue(0);
    const api = await callerAs(adminSession);

    await expect(api.cleanupUnusedReceipts()).resolves.toEqual({ deletedCount: 0 });
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('a member who is not the admin is refused', async () => {
    const api = await callerAs({ user: { id: 'user-1', email: 'user@example.com' } });
    await expect(api.cleanupUnusedReceipts()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(deleteUnusedReceipts).not.toHaveBeenCalled();
  });
});
