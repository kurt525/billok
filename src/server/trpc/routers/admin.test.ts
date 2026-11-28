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
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  ownerBootstrap: {
    findUnique: vi.fn().mockResolvedValue({ userId: 'admin-1', completedAt: new Date() }),
  },
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
    groupBy: vi.fn(),
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
  securityEvent: { findMany: vi.fn().mockResolvedValue([]) },
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
    updateMany: vi.fn(),
  },
  activityLog: {
    findMany: vi.fn().mockResolvedValue([]),
  },
};

vi.mock('@/server/db', () => ({ db: mockDb }));
const { proofConfirmation } = vi.hoisted(() => ({ proofConfirmation: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/server/lib/owner-passkey-action-approval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/owner-passkey-action-approval')>()),
  consumeOwnerPasskeyActionProof: proofConfirmation,
}));

vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { deleteExpiredSplits, countUnusedReceipts, deleteUnusedReceipts } = vi.hoisted(() => ({
  deleteExpiredSplits: vi.fn(),
  countUnusedReceipts: vi.fn(),
  deleteUnusedReceipts: vi.fn(),
}));
vi.mock('@/server/lib/receipt-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/receipt-cleanup')>()),
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

    await logAdminAction(mockDb as never, 'admin-1', 'UNUSED_RECEIPTS_CLEANED' as never, null, null);

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'UNUSED_RECEIPTS_CLEANED',
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
    expect(procedures).not.toContain('cleanupOrphans');
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
    expect(procedures).not.toContain('getGlobalActivity');
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

async function callerAs(session: { user: { id: string; email: string } } | null, impersonating: unknown = null) {
  const { adminRouter } = await import('./admin');
  const ctx = {
    session,
    db: mockDb,
    headers: new Headers({ cookie: 'authjs.session-token=mock-' + (session?.user.id ?? 'anonymous') }),
    impersonating,
  };
  return adminRouter.createCaller(ctx as unknown as Parameters<typeof adminRouter.createCaller>[0]);
}

describe('Issue #1 6.12.1: immutable owner ID, never ADMIN_EMAIL authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
    mockDb.ownerBootstrap.findUnique.mockResolvedValue({
      userId: 'admin-1',
      completedAt: new Date('2026-11-13T00:00:00Z'),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  test('real owner is authorized even if ADMIN_EMAIL is unset or points elsewhere', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'ordinary@example.com');
    const api = await callerAs(adminSession);
    mockDb.adminAuditLog.findMany.mockResolvedValue([]);
    await expect(api.getAuditLog({ limit: 1 })).resolves.toMatchObject({ items: [] });
    expect(mockDb.ownerBootstrap.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { userId: true, completedAt: true },
    });
    vi.stubEnv('ADMIN_EMAIL', '');
    await expect(api.getAuditLog({ limit: 1 })).resolves.toMatchObject({ items: [] });
  });

  test('ordinary registered user with matching ADMIN_EMAIL is never an owner', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'ordinary@example.com');
    const api = await callerAs({ user: { id: 'ordinary-1', email: 'ordinary@example.com' } });
    await expect(api.getAuditLog({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.listUsers({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.findMany).not.toHaveBeenCalled();
  });

  test('unfinished, missing or replaced bootstrap ID fails closed for all admin requests', async () => {
    const api = await callerAs(adminSession);
    for (const bootstrap of [
      null,
      { userId: 'admin-1', completedAt: null },
      { userId: 'new-owner-id', completedAt: new Date() },
    ]) {
      mockDb.ownerBootstrap.findUnique.mockResolvedValueOnce(bootstrap);
      await expect(api.getAuditLog({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  test('all sensitive tRPC actions reject an owner whose email is unverified or whose account is suspended', async () => {
    const api = await callerAs(adminSession);
    for (const state of [
      { emailVerified: null, suspendedAt: null, isPlaceholder: false, sessionSecurityVersion: 0 },
      { emailVerified: new Date(), suspendedAt: new Date(), isPlaceholder: false, sessionSecurityVersion: 0 },
      { emailVerified: new Date(), suspendedAt: null, isPlaceholder: true, sessionSecurityVersion: 0 },
      { emailVerified: new Date(), suspendedAt: null, isPlaceholder: false, sessionSecurityVersion: -1 },
    ]) {
      mockDb.user.findUnique.mockResolvedValue(state);
      await expect(api.getAuditLog({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.createSystemInvite({ expiresInDays: 7, approvalToken: 'b'.repeat(43) })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(api.ownerRegisteredUsers({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mockDb.adminAuditLog.findMany).not.toHaveBeenCalled();
    expect(mockDb.systemInvite.create).not.toHaveBeenCalled();
  });

  test('signed impersonation context cannot restore owner access through adminId or adminEmail', async () => {
    const { adminRouter } = await import('./admin');
    const ctx = {
      session: adminSession,
      db: mockDb,
      headers: new Headers(),
      impersonating: {
        adminId: 'admin-1',
        adminEmail: 'admin@example.com',
        targetId: 'ordinary-1',
        targetEmail: 'ordinary@example.com',
      },
    };
    const api = adminRouter.createCaller(ctx as unknown as Parameters<typeof adminRouter.createCaller>[0]);
    await expect(api.getAuditLog({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.adminAuditLog.findMany).not.toHaveBeenCalled();
  });
});

describe('TASK-BILLOK-010: journal pagination and access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
    mockDb.ownerBootstrap.findUnique.mockResolvedValue({ userId: 'admin-1', completedAt: new Date() });
  });
  afterEach(() => {
    mockDb.adminAuditLog.findMany.mockReset().mockResolvedValue([]);
  });

  test('three inclusive cursor pages remain stable across a newly inserted event and tied timestamps', async () => {
    const rows = Array.from({ length: 43 }, (_, index) => ({
      id: String(index).padStart(3, '0'),
      action: 'INVITE_CREATED',
      targetId: null,
      metadata: null,
      createdAt: new Date('2026-11-28T12:00:00.000Z'),
      admin: { id: 'admin-1', name: 'Тестовый владелец', email: 'admin@mail.ru' },
    }));
    const ordered = [...rows].reverse();
    mockDb.adminAuditLog.findMany.mockImplementation(
      async (args: { take: number; cursor?: { id: string }; orderBy: unknown; skip?: number }) => {
        expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
        expect(args.skip).toBeUndefined();
        const start = args.cursor ? ordered.findIndex((row) => row.id === args.cursor?.id) : 0;
        expect(start).toBeGreaterThanOrEqual(0);
        return ordered.slice(start, start + args.take);
      },
    );
    const api = await callerAs(adminSession);
    const first = await api.getAuditLog({ limit: 20 });
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe('022');
    ordered.unshift({ ...rows[0]!, id: 'new', createdAt: new Date('2026-11-29T12:00:00.000Z') });
    const second = await api.getAuditLog({ limit: 20, cursor: first.nextCursor! });
    expect(second.items[0]?.id).toBe('022');
    expect(second.nextCursor).toBe('002');
    const third = await api.getAuditLog({ limit: 20, cursor: second.nextCursor! });
    expect(third.nextCursor).toBeUndefined();
    const seen = [...first.items, ...second.items, ...third.items].map((row) => row.id);
    expect(seen).toEqual([...rows].reverse().map((row) => row.id));
    expect(new Set(seen).size).toBe(43);
  });

  test('rejects invalid limits and excessively long cursor', async () => {
    const api = await callerAs(adminSession);
    await expect(api.getAuditLog({ limit: 1.5 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.getAuditLog({ limit: 101 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.getAuditLog({ cursor: 'x'.repeat(129) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.adminAuditLog.findMany).not.toHaveBeenCalled();
  });

  test('both journals deny ordinary users and unauthenticated guests, owner may read', async () => {
    for (const [session, code] of [
      [{ user: { id: 'ordinary-1', email: 'ordinary@mail.ru' } }, 'FORBIDDEN'],
      [null, 'UNAUTHORIZED'],
    ] as const) {
      const api = await callerAs(session);
      await expect(api.getAuditLog({ limit: 20 })).rejects.toMatchObject({ code });
      await expect(api.getSecurityEvents({ limit: 20 })).rejects.toMatchObject({ code });
    }
    expect(mockDb.adminAuditLog.findMany).not.toHaveBeenCalled();
    expect(mockDb.securityEvent.findMany).not.toHaveBeenCalled();
    const owner = await callerAs(adminSession);
    await expect(owner.getAuditLog({ limit: 20 })).resolves.toMatchObject({ items: [] });
    await expect(owner.getSecurityEvents({ limit: 20 })).resolves.toMatchObject({ items: [] });
  });
});

describe('admin group totals in group currency', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
    mockDb.group.findMany.mockResolvedValue([
      {
        id: 'g-rub',
        name: 'Ужин',
        currency: 'RUB',
        archivedAt: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        _count: { members: 2, expenses: 2, settlements: 0 },
        activityLogs: [],
      },
    ]);
    mockDb.group.count.mockResolvedValue(1);
    mockDb.expense.count.mockResolvedValue(2);
    mockDb.settlement.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('sums stored RUB kopecks and never requests legacy conversion columns', async () => {
    mockDb.expense.groupBy.mockResolvedValue([
      {
        groupId: 'g-rub',
        currency: 'RUB',
        _sum: { amount: 10001 },
      },
    ]);
    const api = await callerAs(adminSession);
    const result = await api.listGroups({ limit: 20 });
    expect(result.groups[0]).toMatchObject({ currency: 'RUB', totalAmount: 10001 });
    expect(mockDb.expense.groupBy).toHaveBeenCalledWith({
      by: ['groupId', 'currency'],
      where: { groupId: { in: ['g-rub'] } },
      _sum: { amount: true },
    });
  });

  test('keeps legacy foreign-currency amounts out of RUB group totals', async () => {
    mockDb.expense.groupBy.mockResolvedValue([
      {
        groupId: 'g-rub',
        currency: 'RUB',
        _sum: { amount: 10001 },
      },
      {
        groupId: 'g-rub',
        currency: 'EUR',
        _sum: { amount: 1000 },
      },
    ]);
    const api = await callerAs(adminSession);
    const result = await api.listGroups({ limit: 20 });
    expect(result.groups[0]).toMatchObject({ currency: 'RUB', totalAmount: null });
  });
});

describe('registration mode', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
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
    expect(await api.setRegistrationMode({ mode, approvalToken: 'b'.repeat(43) })).toEqual({ mode });
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

  test('6.12.4.4: all registration mode writes require Passkey; no JWT-only API bypass', async () => {
    const api = await callerAs(adminSession);
    for (const mode of ['open', 'invite-only', 'closed'] as const) {
      await expect(api.setRegistrationMode({ mode } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(proofConfirmation).not.toHaveBeenCalled();
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('6.12.4.4: mode change consumes proof for exact selected mode before writing and audit', async () => {
    const api = await callerAs(adminSession);
    await api.setRegistrationMode({ mode: 'closed', approvalToken: 'b'.repeat(43) });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'admin-1');
    expect(proofConfirmation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        userId: 'admin-1',
        action: 'REGISTRATION_MODE_UPDATE',
        targetId: 'registration-mode:v1:closed',
        approvalToken: 'b'.repeat(43),
        sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(proofConfirmation.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDb.systemSetting.upsert.mock.invocationCallOrder[0]!,
    );
    expect(mockDb.systemSetting.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDb.adminAuditLog.create.mock.invocationCallOrder[0]!,
    );
  });

  test('6.12.4.4: wrong mode, session, consumed, expired proof never changes registration', async () => {
    const api = await callerAs(adminSession);
    for (const failure of ['wrong mode', 'wrong session', 'consumed', 'expired']) {
      proofConfirmation.mockRejectedValueOnce(new Error(failure));
      await expect(api.setRegistrationMode({ mode: 'invite-only', approvalToken: 'b'.repeat(43) })).rejects.toThrow(
        failure,
      );
    }
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('refuses to save a mode ShareTab does not know', async () => {
    const api = await callerAs(adminSession);
    await expect(
      api.setRegistrationMode({ mode: 'everyone' as 'open', approvalToken: 'b'.repeat(43) }),
    ).rejects.toMatchObject({
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
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
    mockDb.group.findUnique.mockResolvedValue({ id: 'g1', name: 'Trip' });
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.receipt.findMany.mockResolvedValue([{ id: 'r1' }]);
    mockDb.guestSplit.findMany.mockResolvedValue([]);
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'p1' }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('deletes the group, orphaned receipt rows and placeholder members', async () => {
    const api = await callerAs(adminSession);
    await expect(api.deleteGroup({ groupId: 'g1' })).resolves.toEqual({ deleted: true, groupId: 'g1' });

    expect(mockDb.$transaction).toHaveBeenCalled();
    expect(mockDb.group.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
    expect(mockDb.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(mockDb.user.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { in: ['p1'] }, isPlaceholder: true }),
    });
  });
});

// #265: expired splits go with the receipts only they used (receipt-cleanup.test.ts),
// in batches so a backlog doesn't make one long transaction
describe('cleanupExpiredSplits', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
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
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    { claiming: 0, finalized: 0, unused: 0 },
    { claiming: 1, finalized: 0, unused: 0 },
    { claiming: 0, finalized: 1, unused: 0 },
    { claiming: 3, finalized: 5, unused: 2 },
    { claiming: 2, finalized: 5, unused: 2 },
  ])('counts all manual split statuses in one snapshot: %j', async ({ claiming, finalized, unused }) => {
    mockDb.guestSplit.groupBy.mockResolvedValue([
      ...(claiming ? [{ status: 'CLAIMING', _count: { _all: claiming } }] : []),
      ...(finalized ? [{ status: 'FINALIZED', _count: { _all: finalized } }] : []),
    ]);
    countUnusedReceipts.mockResolvedValue({ count: unused });
    const api = await callerAs(adminSession);
    await expect(api.getStorageStats()).resolves.toEqual({
      receiptCount: claiming + finalized,
      claimingCount: claiming,
      finalizedCount: finalized,
      unusedReceiptCount: unused,
    });
    expect(mockDb.guestSplit.groupBy).toHaveBeenCalledExactlyOnceWith({ by: ['status'], _count: { _all: true } });
    expect(countUnusedReceipts).toHaveBeenCalledWith(mockDb);
    expect(mockDb.receipt.count).not.toHaveBeenCalled();
    expect(mockDb.receipt.findMany).not.toHaveBeenCalled();
  });

  test('does not present a failed aggregation as zero receipts', async () => {
    mockDb.guestSplit.groupBy.mockRejectedValueOnce(new Error('database query failed'));
    countUnusedReceipts.mockResolvedValue({ count: 0 });
    const api = await callerAs(adminSession);
    await expect(api.getStorageStats()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  test('system info no longer issues a redundant SELECT 1', async () => {
    const api = await callerAs(adminSession);
    const info = await api.getSystemHealth();
    expect(info).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      commitSha: expect.any(String),
      release: expect.objectContaining({
        taskId: expect.stringMatching(/^TASK-BILLOK-\d{3,}$/),
        taskTitle: expect.any(String),
        pullRequest: expect.any(Number),
      }),
      deployedAt: null,
      serverStartTime: expect.any(String),
      uptime: expect.any(Number),
    });
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.ownerBootstrap.findUnique).toHaveBeenCalled();
  });

  test('statistics and system info are restricted to the verified owner', async () => {
    const api = await callerAs({ user: { id: 'user-1', email: 'user@mail.ru' } });
    await expect(api.getStorageStats()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.getSystemHealth()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.groupBy).not.toHaveBeenCalled();
    expect(countUnusedReceipts).not.toHaveBeenCalled();
  });

  test('anonymous and impersonated sessions cannot access system information or statistics', async () => {
    const anonymous = await callerAs(null);
    await expect(anonymous.getStorageStats()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonymous.getSystemHealth()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const impersonated = await callerAs(adminSession, { userId: 'admin-1' });
    await expect(impersonated.getStorageStats()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(impersonated.getSystemHealth()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.groupBy).not.toHaveBeenCalled();
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

describe('Issue #1 6.2: seven-day admin invitations, revocation and usage history', () => {
  const code = 'invite-secret-to-deliver';
  const approvalToken = 'b'.repeat(43);
  // Relative to test execution: a fixed November 2026 date expired while CI kept running.
  // Preserve the strict seven-day window without changing the production invitation guard.
  const createdAt = new Date(Date.now() - 86_400_000);
  const expiresAt = new Date(createdAt.getTime() + 7 * 86_400_000);
  const usedAt = new Date(createdAt.getTime() + 3_600_000);
  const invite = {
    id: 'invite-1',
    code,
    label: 'Для Анны',
    createdAt,
    expiresAt,
    usedAt: null,
    usedById: null,
    revokedAt: null,
    reservedById: null,
    reservedUntil: null,
    usedBy: null,
  };

  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
    mockDb.systemInvite.create.mockResolvedValue(invite);
    mockDb.systemInvite.findUnique.mockResolvedValue(invite);
    mockDb.systemInvite.findMany.mockResolvedValue([invite]);
    mockDb.systemInvite.updateMany.mockResolvedValue({ count: 1 });
    mockDb.adminAuditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('admin creates a code for manual delivery; exactly seven days, transactional audit without the secret', async () => {
    mockDb.systemInvite.create.mockImplementationOnce(async ({ data }) => ({ ...invite, expiresAt: data.expiresAt }));
    const api = await callerAs(adminSession);
    const before = Date.now();
    const result = await api.createSystemInvite({ label: 'Для Анны', approvalToken });
    const after = Date.now();
    expect(result).toEqual({ id: 'invite-1', code, label: 'Для Анны', expiresAt: expect.any(Date) });
    expect(mockDb.$transaction).toHaveBeenCalled();
    const create = mockDb.systemInvite.create.mock.calls.at(-1)![0];
    expect(create.data.label).toBe('Для Анны');
    expect(create.data.expiresAt).toBeInstanceOf(Date);
    expect(create.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(create.data.expiresAt.getTime()).toBeLessThanOrEqual(after + 7 * 86_400_000);
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'INVITE_CREATED',
        targetId: invite.id,
        metadata: { label: 'Для Анны', expiresAt: create.data.expiresAt.toISOString() },
      },
    });
    expect(JSON.stringify(mockDb.adminAuditLog.create.mock.calls)).not.toContain(code);
    expect(await api.createSystemInvite({ label: 'Другой', expiresInDays: 7, approvalToken })).toHaveProperty(
      'code',
      code,
    );
  });

  test('admin cannot create timeless, 365-day, zero-day or malformed invites', async () => {
    const api = await callerAs(adminSession);
    for (const invalid of [
      { expiresInDays: 365 },
      { expiresInDays: 0 },
      { expiresInDays: null },
      { label: ' ' },
      { label: 'x'.repeat(101) },
      { expiresInDays: 7, allowMultiple: true },
    ]) {
      await expect(api.createSystemInvite({ ...(invalid as object), approvalToken } as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(mockDb.systemInvite.create).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('list is admin-only and distinguishes active, reserved, used, expired and revoked; usage date and recipient persist', async () => {
    const api = await callerAs(adminSession);
    const now = new Date();
    const later = new Date(now.getTime() + 86_400_000);
    const earlier = new Date(now.getTime() - 86_400_000);
    mockDb.systemInvite.findMany.mockResolvedValue([
      { ...invite, id: 'active', expiresAt: later },
      { ...invite, id: 'reserved', expiresAt: later, reservedById: 'pending-user', reservedUntil: later },
      {
        ...invite,
        id: 'used',
        usedAt,
        usedById: 'verified-user',
        usedBy: { id: 'verified-user', name: 'Анна', email: 'anna@example.ru' },
      },
      { ...invite, id: 'expired', expiresAt: earlier },
      { ...invite, id: 'revoked', revokedAt: earlier },
    ]);
    const result = await api.listSystemInvites();
    expect(result.map(({ id, isActive, isReserved, canRevoke }) => ({ id, isActive, isReserved, canRevoke }))).toEqual([
      { id: 'active', isActive: true, isReserved: false, canRevoke: true },
      { id: 'reserved', isActive: false, isReserved: true, canRevoke: true },
      { id: 'used', isActive: false, isReserved: false, canRevoke: false },
      { id: 'expired', isActive: false, isReserved: false, canRevoke: false },
      { id: 'revoked', isActive: false, isReserved: false, canRevoke: false },
    ]);
    expect(result[2]).toMatchObject({
      usedAt,
      usedBy: { name: 'Анна', email: 'anna@example.ru' },
    });
  });

  test('revocation of an unused or reserved code is atomic and audited without leaking the code', async () => {
    const api = await callerAs(adminSession);
    const result = await api.revokeSystemInvite({ inviteId: invite.id, approvalToken });
    expect(result).toEqual({ revoked: true });
    expect(mockDb.$transaction).toHaveBeenCalled();
    expect(mockDb.systemInvite.updateMany).toHaveBeenCalledWith({
      where: {
        id: invite.id,
        revokedAt: null,
        usedAt: null,
        usedById: null,
        createdAt: { gt: expect.any(Date) },
        expiresAt: { gt: expect.any(Date) },
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'INVITE_REVOKED',
        targetId: invite.id,
        metadata: { revokedAt: expect.any(String) },
      },
    });
    expect(JSON.stringify(mockDb.adminAuditLog.create.mock.calls)).not.toContain(code);
  });

  test('used, revoked, expired or concurrently consumed code cannot be revoked again', async () => {
    const api = await callerAs(adminSession);
    for (const row of [
      { ...invite, usedAt, usedById: 'verified-user' },
      { ...invite, revokedAt: new Date() },
      { ...invite, expiresAt: new Date(Date.now() - 1000) },
    ]) {
      mockDb.systemInvite.findUnique.mockResolvedValueOnce(row);
      await expect(api.revokeSystemInvite({ inviteId: invite.id, approvalToken })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(mockDb.systemInvite.updateMany).not.toHaveBeenCalled();
    mockDb.systemInvite.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(api.revokeSystemInvite({ inviteId: invite.id, approvalToken })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('6.12.4.3: both mutations reject a JWT without a one-time Passkey token', async () => {
    const api = await callerAs(adminSession);
    await expect(api.createSystemInvite({ label: 'Для Анны' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.revokeSystemInvite({ inviteId: invite.id } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.systemInvite.create).not.toHaveBeenCalled();
    expect(mockDb.systemInvite.updateMany).not.toHaveBeenCalled();
    expect(proofConfirmation).not.toHaveBeenCalled();
  });

  test('6.12.4.3: grants only canonical 7-day creation label and the exact revoke id', async () => {
    const { systemInviteCreateApprovalTarget } = await import('@/lib/system-invite-approval-target');
    const api = await callerAs(adminSession);
    await api.createSystemInvite({ label: ' Для Анны ', approvalToken });
    expect(proofConfirmation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        userId: 'admin-1',
        action: 'SYSTEM_INVITE_CREATE',
        targetId: systemInviteCreateApprovalTarget('Для Анны'),
        sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        approvalToken,
      }),
    );
    const createLockOrder = mockDb.$queryRawUnsafe.mock.invocationCallOrder[0]!;
    const proofOrder = proofConfirmation.mock.invocationCallOrder[0]!;
    const createOrder = mockDb.systemInvite.create.mock.invocationCallOrder[0]!;
    expect(createLockOrder).toBeLessThan(proofOrder);
    expect(proofOrder).toBeLessThan(createOrder);
    expect(mockDb.systemInvite.create.mock.calls[0]![0].data.label).toBe('Для Анны');
    proofConfirmation.mockClear();
    await api.revokeSystemInvite({ inviteId: invite.id, approvalToken });
    expect(proofConfirmation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        userId: 'admin-1',
        action: 'SYSTEM_INVITE_REVOKE',
        targetId: invite.id,
        sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        approvalToken,
      }),
    );
    expect(mockDb.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT id FROM "SystemInvite" WHERE id = $1 FOR UPDATE',
      invite.id,
    );
  });

  test('6.12.4.3: another action/label/invite/session or a replay cannot commit an invite', async () => {
    const api = await callerAs(adminSession);
    for (const reason of [
      'wrong action',
      'different label',
      'different invite',
      'different session',
      'expired',
      'replay',
    ]) {
      proofConfirmation.mockRejectedValueOnce(new Error(reason));
      await expect(api.createSystemInvite({ label: 'Для Анны', approvalToken })).rejects.toThrow(reason);
    }
    expect(mockDb.systemInvite.create).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
    proofConfirmation.mockRejectedValueOnce(new Error('wrong invite target'));
    await expect(api.revokeSystemInvite({ inviteId: invite.id, approvalToken })).rejects.toThrow('wrong invite target');
    expect(mockDb.systemInvite.updateMany).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('6.12.4.3: a consumed permission cannot be reused for two create or revoke writes', async () => {
    const api = await callerAs(adminSession);
    let consumed = false;
    proofConfirmation.mockImplementation(async () => {
      if (consumed) throw new Error('already consumed');
      consumed = true;
    });
    await api.createSystemInvite({ label: 'Для Анны', approvalToken });
    await expect(api.createSystemInvite({ label: 'Для Анны', approvalToken })).rejects.toThrow('already consumed');
    expect(mockDb.systemInvite.create).toHaveBeenCalledTimes(1);
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledTimes(1);
    consumed = false;
    await api.revokeSystemInvite({ inviteId: invite.id, approvalToken });
    await expect(api.revokeSystemInvite({ inviteId: invite.id, approvalToken })).rejects.toThrow('already consumed');
    expect(mockDb.systemInvite.updateMany).toHaveBeenCalledTimes(1);
  });

  test('regular account cannot create, list or revoke a system invite, even knowing an id', async () => {
    const api = await callerAs({ user: { id: 'ordinary-user', email: 'guest@example.ru' } });
    await expect(api.createSystemInvite({ label: 'Для Анны', approvalToken })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(api.listSystemInvites()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.revokeSystemInvite({ inviteId: invite.id, approvalToken })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDb.systemInvite.create).not.toHaveBeenCalled();
    expect(mockDb.systemInvite.updateMany).not.toHaveBeenCalled();
  });
});

describe('Issue 6.12.4.4: public announcement is a value-scoped privileged setting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Older invitation replay tests replace this mock implementation.
    proofConfirmation.mockReset().mockResolvedValue(undefined);
    mockDb.user.findUnique.mockResolvedValue({
      email: 'admin@mail.ru',
      suspendedAt: null,
      emailVerified: new Date(),
      isPlaceholder: false,
      sessionSecurityVersion: 0,
    });
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
  });
  afterEach(() => vi.unstubAllEnvs());

  test('cannot save or clear public content with only a JWT', async () => {
    const api = await callerAs(adminSession);
    await expect(api.setAnnouncement({ message: 'Не подписано' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api.setAnnouncement({ message: '' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
    expect(mockDb.systemSetting.deleteMany).not.toHaveBeenCalled();
    expect(proofConfirmation).not.toHaveBeenCalled();
  });

  test('a 500-character announcement has an exact signed fingerprint and atomic audit', async () => {
    const { announcementApprovalTarget } = await import('@/lib/admin-setting-approval-target');
    const message = 'Русский текст '.repeat(40).slice(0, 500);
    const api = await callerAs(adminSession);
    await api.setAnnouncement({ message, approvalToken: 'b'.repeat(43) });
    expect(proofConfirmation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: 'OWNER_SETTING_UPDATE',
        targetId: await announcementApprovalTarget(message),
        userId: 'admin-1',
        sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(mockDb.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'announcement' },
      update: { value: message },
      create: { key: 'announcement', value: message },
    });
    expect(proofConfirmation.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDb.systemSetting.upsert.mock.invocationCallOrder[0]!,
    );
    expect(mockDb.systemSetting.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDb.adminAuditLog.create.mock.invocationCallOrder[0]!,
    );
  });

  test('clearing announcement consumes its own separate one-time permission', async () => {
    const { announcementApprovalTarget } = await import('@/lib/admin-setting-approval-target');
    const api = await callerAs(adminSession);
    await api.setAnnouncement({ message: '', approvalToken: 'b'.repeat(43) });
    expect(proofConfirmation).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: 'OWNER_SETTING_UPDATE',
        targetId: await announcementApprovalTarget(''),
      }),
    );
    expect(mockDb.systemSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'announcement' } });
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'ANNOUNCEMENT_SET', metadata: { message: null } },
    });
  });

  test('rejects wrong target/session and repeated token without writing setting or audit', async () => {
    const api = await callerAs(adminSession);
    for (const reason of ['wrong target', 'different action', 'wrong session', 'already used']) {
      proofConfirmation.mockRejectedValueOnce(new Error(reason));
      await expect(api.setAnnouncement({ message: 'Тест', approvalToken: 'b'.repeat(43) })).rejects.toThrow(reason);
    }
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
    expect(mockDb.systemSetting.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });
});
