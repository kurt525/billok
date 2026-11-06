import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  receipt: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  groupMember: { findUnique: vi.fn() },
  guestPresence: { upsert: vi.fn(), groupBy: vi.fn() },
  guestSplit: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  // Interactive transactions run their callback against the same mocks.
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { removeReceiptFiles, deleteExpiredSplits } = vi.hoisted(() => ({
  removeReceiptFiles: vi.fn(),
  deleteExpiredSplits: vi.fn(),
}));
vi.mock('@/server/lib/receipt-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/receipt-cleanup')>()),
  removeReceiptFiles,
  deleteExpiredSplits,
}));

const { checkRateLimit, peekRateLimit } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  peekRateLimit: vi.fn(),
}));
// The token store's functions share the main ones' mocks: these tests check which key and limit a
// procedure uses, not which store it lands in (rate-limit.test.ts covers that)
vi.mock('@/server/lib/rate-limit', () => ({
  checkRateLimit,
  peekRateLimit,
  refundRateLimit: vi.fn(),
  checkTokenRateLimit: checkRateLimit,
  peekTokenRateLimit: peekRateLimit,
}));

type Session = { user: { id: string } } | null;

async function caller(session: Session = null) {
  const { guestRouter } = await import('./guest');
  const ctx = { session, db: mockDb, headers: new Headers(), impersonating: null };
  return guestRouter.createCaller(ctx as unknown as Parameters<typeof guestRouter.createCaller>[0]);
}

const signedIn: Session = { user: { id: 'user-1' } };

beforeEach(async () => {
  vi.clearAllMocks();
  checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  peekRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.guestPresence.groupBy.mockResolvedValue([]);
  mockDb.guestPresence.upsert.mockResolvedValue({ id: 'presence-1' });
  // New splits clear expired ones in the background
  deleteExpiredSplits.mockResolvedValue(0);
});

describe('AI provider setup (#280)', () => {
  test('no guest procedure exposes the AI provider setup', async () => {
    const { guestRouter } = await import('./guest');
    const names = Object.keys(guestRouter._def.procedures).filter((name) => /provider/i.test(name));
    expect(names, 'OCR and AI providers must not be exposed').toEqual([]);
  });
});

describe('BillOK participant display names: 1–40 chars per receipt', () => {
  const receiptData = { subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'RUB' };
  const items = [{ name: 'Чай', quantity: 1, unitPrice: 100, totalPrice: 100 }];
  const base = {
    createSplit: {
      receiptData,
      items,
      people: [{ name: 'Илья' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
    },
    createClaimSession: { receiptData, items, people: ['Илья'], creatorName: 'Илья', paidByName: 'Илья' },
    joinSession: { token: 'session', name: 'Илья' },
    editPersonName: {
      token: 'session',
      personToken: 'af5e8384-57ab-4e31-84b3-7bd8ff96fd1a',
      targetId: '12345678-1234-4123-8123-123456789abc',
      newName: 'Илья',
    },
  };
  type NameInput = (typeof base)[keyof typeof base];
  test.each([
    ['createSplit', 'people'],
    ['createClaimSession', 'creatorName'],
    ['createClaimSession', 'paidByName'],
    ['createClaimSession', 'people'],
    ['joinSession', 'name'],
    ['editPersonName', 'newName'],
  ] as const)('%s enforces the guest name limit on %s', async (operation, field) => {
    const { guestRouter } = await import('./guest');
    const procedure = guestRouter._def.procedures[operation] as {
      _def: { inputs: { parse: (input: unknown) => unknown }[] };
    };
    const schema = procedure._def.inputs[0]!;
    const makeInput = (name: string): NameInput => {
      const nameField = field === 'people' ? (operation === 'createSplit' ? [{ name }] : [name]) : name;
      return { ...base[operation], [field]: nameField } as NameInput;
    };
    expect(() => schema.parse(makeInput('Я'.repeat(40)))).not.toThrow();
    expect(() => schema.parse(makeInput('Я'.repeat(41)))).toThrow();
  });

  test('profile-name limit remains separate from the receipt participant limit', async () => {
    const { MAX_GUEST_NAME_LENGTH } = await import('@/lib/guest-name-limit');
    const { readFileSync } = await import('node:fs');
    expect(MAX_GUEST_NAME_LENGTH).toBe(40);
    expect(readFileSync('src/server/trpc/routers/auth.ts', 'utf8')).toContain(
      'name: z.string().trim().min(1).max(100).optional()',
    );
  });
});

describe('BillOK creation permissions', () => {
  const receiptData = { subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'RUB' };
  const items = [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100 }];
  type Api = Awaited<ReturnType<typeof caller>>;
  const operations = {
    createSplit: (api: Api) =>
      api.createSplit({
        receiptData,
        items,
        people: [{ name: 'Pat' }],
        assignments: [{ itemIndex: 0, personIndices: [0] }],
      }),
    createClaimSession: (api: Api) =>
      api.createClaimSession({ receiptData, items, creatorName: 'Pat', paidByName: 'Pat' }),
  };

  test.each(Object.keys(operations) as (keyof typeof operations)[])(
    '%s denies anonymous creation before writes and quotas',
    async (name) => {
      await expect(operations[name](await caller())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDb.$transaction).not.toHaveBeenCalled();
      expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    },
  );

  test.each(Object.keys(operations) as (keyof typeof operations)[])(
    '%s denies suspended and deleted accounts',
    async (name) => {
      mockDb.user.findUnique.mockResolvedValueOnce({ suspendedAt: new Date() });
      await expect(operations[name](await caller(signedIn))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      mockDb.user.findUnique.mockResolvedValueOnce(null);
      await expect(operations[name](await caller(signedIn))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockDb.$transaction).not.toHaveBeenCalled();
      expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
    },
  );

  test.each(Object.keys(operations) as (keyof typeof operations)[])(
    '%s assigns the split to the signed-in creator',
    async (name) => {
      mockDb.guestSplit.create.mockResolvedValue({ id: 's1', shareToken: 'tok' });
      await operations[name](await caller(signedIn));
      expect(mockDb.guestSplit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1' }),
      });
    },
  );
});

describe('new shared receipts use RUB exclusively', () => {
  const rubData = { merchantName: 'Ужин', subtotal: 505, tax: 0, tip: 0, total: 505 };
  const items = [{ name: 'Чай', quantity: 1, unitPrice: 505, totalPrice: 505 }];
  const create = {
    createSplit: (
      api: Awaited<ReturnType<typeof caller>>,
      receiptData: Omit<typeof rubData, 'tax' | 'tip'> & { tax?: number; tip?: number; currency?: string },
    ) =>
      api.createSplit({
        receiptData,
        items,
        people: [{ name: 'Анна' }],
        assignments: [{ itemIndex: 0, personIndices: [0] }],
      }),
    createClaimSession: (
      api: Awaited<ReturnType<typeof caller>>,
      receiptData: Omit<typeof rubData, 'tax' | 'tip'> & { tax?: number; tip?: number; currency?: string },
    ) => api.createClaimSession({ receiptData, items, creatorName: 'Анна', paidByName: 'Анна' }),
  };

  beforeEach(() => {
    mockDb.guestSplit.create.mockResolvedValue({ id: 's1', shareToken: 'share-1' });
  });

  test.each(Object.keys(create) as (keyof typeof create)[])(
    '%s defaults to RUB and preserves kopecks',
    async (name) => {
      await create[name](await caller(signedIn), rubData);
      expect(mockDb.guestSplit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          receiptData: expect.objectContaining({ total: 505, currency: 'RUB' }),
          items: expect.arrayContaining([expect.objectContaining({ totalPrice: 505 })]),
        }),
      });
    },
  );

  test.each(Object.keys(create) as (keyof typeof create)[])('%s normalizes rub to RUB', async (name) => {
    await create[name](await caller(signedIn), { ...rubData, currency: 'rub' });
    expect(mockDb.guestSplit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ receiptData: expect.objectContaining({ currency: 'RUB' }) }),
    });
  });

  test.each(Object.keys(create) as (keyof typeof create)[])('%s rejects USD and EUR before writing', async (name) => {
    const api = await caller(signedIn);
    for (const currency of ['USD', 'eur']) {
      await expect(create[name](api, { ...rubData, currency })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  test.each(Object.keys(create) as (keyof typeof create)[])(
    '%s refuses extra tax or shared tips at creation',
    async (name) => {
      const api = await caller(signedIn);
      const invalid = [
        { ...rubData, tax: 125, total: 630 },
        { ...rubData, tip: 75, total: 580 },
        { ...rubData, total: 580 },
      ];
      for (const receiptData of invalid) {
        await expect(create[name](api, receiptData)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      expect(mockDb.$transaction).not.toHaveBeenCalled();
      expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    },
  );

  test('createSplit rejects shared tipOverride, including zero', async () => {
    const api = await caller(signedIn);
    const base = {
      receiptData: rubData,
      items,
      people: [{ name: 'Анна' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
    };
    for (const tipOverride of [0, 100]) {
      await expect(
        api.createSplit({ ...base, tipOverride } as unknown as Parameters<typeof api.createSplit>[0]),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  test('finalization cannot impose a shared tip on a claim session', async () => {
    const api = await caller(signedIn);
    const request = {
      token: 'session',
      personId: 'aaaaaaaa-0000-4000-8000-000000000000',
      personToken: '11111111-1111-4111-8111-111111111111',
    };
    for (const tipOverride of [0, 250]) {
      await expect(
        api.finalizeSession({ ...request, tipOverride } as unknown as Parameters<typeof api.finalizeSession>[0]),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test.each(Object.keys(create) as (keyof typeof create)[])('%s defaults tax and shared tip to zero', async (name) => {
    const api = await caller(signedIn);
    await create[name](api, { merchantName: rubData.merchantName, subtotal: 505, total: 505 });
    expect(mockDb.guestSplit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        receiptData: expect.objectContaining({ total: 505, tax: 0, tip: 0 }),
      }),
    });
  });

  test('public links still read an already stored USD receipt without rewriting it', async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue({
      id: 'old-split',
      shareToken: 'old-link',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      status: 'FINALIZED',
      receiptData: { ...rubData, currency: 'USD' },
      items,
      people: [{ name: 'Анна' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      summary: [{ personIndex: 0, name: 'Анна', itemTotal: 505, tax: 0, tip: 0, total: 505 }],
      paidByIndex: 0,
      payerVenmoHandle: null,
      userId: null,
    });
    const result = await (await caller()).getSplit({ token: 'old-link' });
    expect(result.receiptData.currency).toBe('USD');
    expect(result.receiptData.total).toBe(505);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('BillOK private finalized history after guest link expiry', () => {
  const expired = () => ({
    id: 'archived-1',
    shareToken: 'archived-link',
    userId: 'user-1',
    status: 'FINALIZED',
    expiresAt: new Date(Date.now() - 86_400_000),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    receiptData: { merchantName: 'Ужин', subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'RUB' },
    items: [{ name: 'Блюдо', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    people: [{ name: 'Организатор', personToken: '11111111-1111-4111-8111-111111111111' }],
    assignments: [{ itemIndex: 0, personIndices: [0] }],
    summary: [{ personIndex: 0, name: 'Организатор', itemTotal: 1000, tax: 0, tip: 0, total: 1000 }],
    paidByIndex: 0,
    payerVenmoHandle: null,
  });

  beforeEach(() => mockDb.guestSplit.findUnique.mockResolvedValue(expired()));

  test('active creator reads an old finalized bill without writing or leaking identities', async () => {
    const view = await (await caller(signedIn)).getSplit({ token: 'archived-link' });
    expect(view).toMatchObject({
      isCreator: true,
      archivedCreatorView: true,
      receiptData: { total: 1000, currency: 'RUB' },
      items: [{ name: 'Блюдо', totalPrice: 1000 }],
      summary: [{ total: 1000 }],
    });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { suspendedAt: true },
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toContain('11111111-1111-4111-8111-111111111111');
  });

  test('anonymous guests and unrelated accounts cannot view an expired link', async () => {
    for (const session of [null, { user: { id: 'user-2' } }]) {
      await expect((await caller(session)).getSplit({ token: 'archived-link' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  test('deleted or suspended owner cannot use a stale session to read archived bills', async () => {
    for (const user of [{ suspendedAt: new Date() }, null]) {
      mockDb.user.findUnique.mockResolvedValueOnce(user);
      await expect((await caller(signedIn)).getSplit({ token: 'archived-link' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  });

  test('expired CLAIMING drafts never become available in private finalized history', async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...expired(), status: 'CLAIMING' });
    await expect((await caller(signedIn)).getSplit({ token: 'archived-link' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  test('a finalized share link not yet expired still works for guests', async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...expired(), expiresAt: new Date(Date.now() + 86_400_000) });
    const view = await (await caller()).getSplit({ token: 'archived-link' });
    expect(view.isCreator).toBe(false);
    expect(view.archivedCreatorView).toBe(false);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('share tokens longer than any real one (#208)', () => {
  // Share tokens are 25-character cuids; 64 leaves room and bounds the limiter keys built from them
  const long = 'x'.repeat(65);
  const personToken = '11111111-1111-4111-8111-111111111111';
  const calls: [string, (api: Awaited<ReturnType<typeof caller>>) => Promise<unknown>][] = [
    ['getSession', (api) => api.getSession({ token: long })],
    ['getSplit', (api) => api.getSplit({ token: long })],
    ['resumeSession', (api) => api.resumeSession({ token: long, personToken })],
    ['editPersonName', (api) => api.editPersonName({ token: long, personToken, targetId: pid(0), newName: 'X' })],
    ['removePerson', (api) => api.removePerson({ token: long, personToken, targetId: pid(0) })],
    ['splitClaimItem', (api) => api.splitClaimItem({ token: long, personToken, itemIndex: 0, splitQuantity: 1 })],
    ['claimItems', (api) => api.claimItems({ token: long, personToken, personId: pid(0), claimedItemIndices: [] })],
    ['finalizeSession', (api) => api.finalizeSession({ token: long, personToken, personId: pid(0) })],
  ];

  test.each(calls)('%s refuses it before any rate limit or database read', async (_name, call) => {
    await expect(call(await caller(signedIn))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(peekRateLimit).not.toHaveBeenCalled();
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('getReceiptItems refuses an oversized receipt id', async () => {
    const api = await caller(signedIn);
    await expect(api.getReceiptItems({ receiptId: long })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mockDb.receipt.findUnique).not.toHaveBeenCalled();
  });

  test('a signed-in caller gets the same for expireSession and setPayerVenmoHandle', async () => {
    const api = await caller(signedIn);
    await expect(api.expireSession({ token: long })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.setPayerVenmoHandle({ token: long, handle: 'someone' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('guest.joinSession rate limit', () => {
  test('refuses with TOO_MANY_REQUESTS before opening a transaction', async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
    const api = await caller();
    await expect(api.joinSession({ token: 'share-token', name: 'Alice', groupSize: 2 })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('rejects an oversized token before it reaches the rate limiter', async () => {
    const api = await caller();
    await expect(api.joinSession({ token: 'x'.repeat(65), name: 'Alice' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(peekRateLimit).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('opens the transaction when the join is within the limit', async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error('stop after the rate limit'));
    const api = await caller();
    await expect(api.joinSession({ token: 'share-token', name: 'Alice' })).rejects.toThrow('stop after the rate limit');
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });
});

const ALICE_TOKEN = '11111111-1111-4111-8111-111111111111';
const OTHER_TOKEN = '22222222-2222-4222-8222-222222222222';
const JOIN_KEY = '44444444-4444-4444-8444-444444444444';
// A save key Alice's device recorded with an earlier claim save
const ALICE_SAVE = { key: '77777777-7777-4777-8777-777777777777', hash: 'aaaaaaaaaaaaaaaa' };
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The stable id claimSession gives the person at this index (see withIds)
function pid(index: number) {
  return `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

type TestPerson = {
  id?: string;
  name: string;
  personToken?: string;
  accountUserId?: string;
  guestSlotNumber?: number;
  reservedOwner?: boolean;
  personalLinkReadyAt?: string;
  personalLinkRotation?: { requestKey: string; rotatedAt: string; count: number };
  paymentDeclaredAt?: string;
  paymentVerifiedAt?: string;
  groupSize?: number;
  tipCents?: number;
  join?: { key: string; name: string; expiresAt: number };
  saves?: { key: string; hash: string }[];
};

// People as saved since person ids exist: anyone without an id gets pid(their index)
function withIds(people: TestPerson[]) {
  return people.map((p, i) => ({ id: pid(i), ...p }));
}

// A person's record of the join that created them, still within its replay window
function liveJoin(normalizedName: string) {
  return { key: JOIN_KEY, name: normalizedName, expiresAt: Date.now() + 60_000 };
}

// A claim session whose people get ids (withIds), unless `legacy` asks for them as saved
// before person ids existed
function claimSession(
  people: TestPerson[],
  {
    legacy = false,
    ...overrides
  }: {
    status?: string;
    receiptData?: {
      subtotal: number;
      tax: number;
      tip: number;
      total: number;
      currency: string;
      roundingBalanced?: boolean;
      organizerPersonId?: string;
      guestSlotsMode?: boolean;
      guestCount?: number;
      partsApprovalHash?: string;
      knownPartsByItem?: Record<string, number>;
    };
    userId?: string | null;
    expiresAt?: Date;
    paidByIndex?: number;
    assignments?: { itemIndex: number; personIndices: number[]; partsByPersonId?: Record<string, number> }[];
    items?: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
    legacy?: boolean;
  } = {},
) {
  mockDb.guestSplit.findUnique.mockResolvedValue({
    id: 'gs1',
    shareToken: 'share-1',
    status: 'CLAIMING',
    expiresAt: new Date(Date.now() + 60_000),
    receiptId: null,
    receiptData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'USD' },
    items: [],
    people: legacy ? people : withIds(people),
    assignments: [],
    summary: null,
    paidByIndex: 0,
    payerVenmoHandle: null,
    userId: 'user-1',
    createdAt: new Date(),
    ...overrides,
  });
}

function savedPeople() {
  const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { people: unknown } } | undefined;
  return call?.data.people;
}

describe('guest.joinSession', () => {
  test('adds a new name with a fresh token', async () => {
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob' });
    expect(joined.personIndex).toBe(1);
    expect(joined.name).toBe('Bob');
    expect(joined.personToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(joined.personId).toMatch(UUID);
    expect(joined.personId).not.toBe(pid(0));
    expect(savedPeople()).toEqual([
      { id: pid(0), name: 'Host' },
      { id: joined.personId, name: 'Bob', personToken: joined.personToken, visualColorId: 1 },
    ]);
  });

  test("mints a new person's token itself and remembers the caller's join key for a day", async () => {
    claimSession([{ name: 'Host' }]);
    const before = Date.now();
    const joined = await (await caller()).joinSession({ token: 'share-1', name: ' Bob ', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(1);
    expect(joined.personToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(joined.personToken).not.toBe(JOIN_KEY);
    expect(savedPeople()).toEqual([
      { id: pid(0), name: 'Host' },
      {
        id: joined.personId,
        name: 'Bob',
        personToken: joined.personToken,
        visualColorId: 1,
        join: { key: JOIN_KEY, name: 'bob', expiresAt: expect.any(Number) },
      },
    ]);
    const { expiresAt } = (savedPeople() as { join?: { expiresAt: number } }[])[1]!.join!;
    expect(expiresAt - before).toBeGreaterThanOrEqual(DAY_MS);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(DAY_MS);
  });

  test('never gives a presented token that nobody holds to anyone', async () => {
    // e.g. the token of someone who was removed, still stored on their old device or in a leaked link
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob', personToken: OTHER_TOKEN });
    expect(joined.personToken).not.toBe(OTHER_TOKEN);
    const seeded = await (await caller()).joinSession({ token: 'share-1', name: 'Host', personToken: OTHER_TOKEN });
    expect(seeded.personToken).not.toBe(OTHER_TOKEN);
  });

  test('gives a pre-seeded name nobody has joined as yet to its first joiner', async () => {
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: ' host ', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(0);
    expect(joined.name).toBe('Host');
    // The seeded person keeps the id they already had
    expect(joined.personId).toBe(pid(0));
    expect(savedPeople()).toEqual([
      {
        id: pid(0),
        name: 'Host',
        personToken: joined.personToken,
        join: { key: JOIN_KEY, name: 'host', expiresAt: expect.any(Number) },
      },
    ]);
  });

  test('replaying a join whose response was lost returns the same person, rather than refusing the name', async () => {
    // The first join saved Bob under the caller's join key, but the response never arrived.
    // Someone has renamed Bob since; the replay still matches the name the join was made with.
    claimSession([{ name: 'Host' }, { name: 'Bobby', personToken: OTHER_TOKEN, join: liveJoin('bob') }]);
    expect(
      await (await caller()).joinSession({ token: 'share-1', name: 'BOB', joinKey: JOIN_KEY, groupSize: 3 }),
    ).toEqual({ personIndex: 1, personId: pid(1), personToken: OTHER_TOKEN, name: 'Bobby' });
    // A replay changes nothing, not even the group size
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a join key replayed with a different name, without revealing whose it is', async () => {
    claimSession([{ name: 'Host' }, { name: 'Bob', personToken: OTHER_TOKEN, join: liveJoin('bob') }]);
    const error = await (
      await caller()
    )
      .joinSession({ token: 'share-1', name: 'Carol', joinKey: JOIN_KEY })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).toContain('already used with a different name');
    // Retrying would resend the same key, so the message mustn't suggest it
    expect((error as Error).message).not.toMatch(/try again/i);
    expect((error as Error).message).not.toContain(OTHER_TOKEN);
    expect((error as Error).message).not.toContain('Bob');
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("a device's stored identity wins over a replayed join key for someone else", async () => {
    // Two tabs: tab A's join as Carol went through with a lost response; tab B then joined as
    // Bob and stored his token; tab A retries Carol, sending Bob's stored token and Carol's key
    claimSession([
      { name: 'Host' },
      { name: 'Carol', personToken: ALICE_TOKEN, join: liveJoin('carol') },
      { name: 'Bob', personToken: OTHER_TOKEN },
    ]);
    expect(
      await (
        await caller()
      ).joinSession({ token: 'share-1', name: 'Carol', joinKey: JOIN_KEY, personToken: OTHER_TOKEN }),
    ).toEqual({ personIndex: 2, personId: pid(2), personToken: OTHER_TOKEN, name: 'Bob' });
  });

  test('ignores an expired join key', async () => {
    const expired = { key: JOIN_KEY, name: 'bob', expiresAt: Date.now() - 1 };
    claimSession([{ name: 'Host' }, { name: 'Bob', personToken: OTHER_TOKEN, join: expired }]);
    // Same name: now just a taken name
    await expect(
      (await caller()).joinSession({ token: 'share-1', name: 'Bob', joinKey: JOIN_KEY }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Another name: a new person, with a new token
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Carol', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(2);
    expect(joined.personToken).not.toBe(OTHER_TOKEN);
  });

  test('a caller holding a token joins as that person under their current name, whatever name they typed', async () => {
    // Alice was renamed by someone else, and her device's resume failed, so she typed her old name
    claimSession([{ name: 'Host' }, { name: 'Alice S.', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      personId: pid(1),
      personToken: ALICE_TOKEN,
      name: 'Alice S.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("refuses a name someone already joined as when the caller doesn't present that person's token", async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    const error = await (await caller()).joinSession({ token: 'share-1', name: 'alice' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).not.toContain(ALICE_TOKEN);
    // The refusal says how to get back in as yourself
    expect((error as Error).message).toContain('personal link');
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a name someone already joined as when the caller presents a different token', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    const error = await (
      await caller()
    )
      .joinSession({ token: 'share-1', name: 'Alice', personToken: OTHER_TOKEN })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).not.toContain(ALICE_TOKEN);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('lets the holder of the token rejoin as that person', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      personId: pid(1),
      personToken: ALICE_TOKEN,
      name: 'Alice',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('updates the group size when the token holder rejoins with a new one', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 });
    expect(savedPeople()).toEqual([{ id: pid(0), name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 }]);
  });

  test('a replayed join on people saved before person ids existed saves their ids too', async () => {
    claimSession([{ name: 'Host' }, { name: 'Bob', personToken: OTHER_TOKEN, join: liveJoin('bob') }], {
      legacy: true,
    });
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob', joinKey: JOIN_KEY });
    const saved = savedPeople() as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(joined).toEqual({ personIndex: 1, personId: saved[1]!.id, personToken: OTHER_TOKEN, name: 'Bob' });
  });

  test("gives people saved before person ids existed their ids, and returns the caller's", async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], { legacy: true });
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN });
    const saved = savedPeople() as { id: string }[];
    expect(saved).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host' },
      { id: expect.stringMatching(UUID), name: 'Alice', personToken: ALICE_TOKEN },
    ]);
    expect(joined).toEqual({ personIndex: 1, personId: saved[1]!.id, personToken: ALICE_TOKEN, name: 'Alice' });
  });
});

describe('guest.resumeSession', () => {
  test("refuses with TOO_MANY_REQUESTS once the share token's resume budget is spent", async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
    await expect((await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(checkRateLimit).toHaveBeenCalledWith('guest-resume:share-1', 120, 60_000);
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('finds the person holding the token, under their current name', async () => {
    // Alice joined, then renamed herself; her device still has her token
    claimSession([{ name: 'Host' }, { name: 'Alice S.', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      personId: pid(1),
      name: 'Alice S.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    // Reads only the fields it needs, not the (possibly large) items and assignments
    expect(mockDb.guestSplit.findUnique).toHaveBeenCalledWith({
      where: { shareToken: 'share-1' },
      select: { id: true, expiresAt: true, people: true },
    });
  });

  test('returns null when nobody holds the token any more', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: OTHER_TOKEN }]);
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toBeNull();
  });

  test('reports a missing session as NOT_FOUND', async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue(null);
    await expect((await caller()).resumeSession({ token: 'nope', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('reports an expired session as NOT_FOUND', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }], { expiresAt: new Date(Date.now() - 1000) });
    await expect((await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Session expired',
    });
  });

  test('still finds the person once the session is finalized', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }], { status: 'FINALIZED' });
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 0,
      personId: pid(0),
      name: 'Alice',
    });
  });

  test("gives people saved before person ids existed their ids, and returns the caller's", async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], { legacy: true });
    const resumed = await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN });
    const saved = savedPeople() as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(resumed).toEqual({ personIndex: 1, personId: saved[1]!.id, name: 'Alice' });
  });
});

describe('Issue 3.5: independent short-lived device presence and organizer-only status', () => {
  const devA = 'a1111111-1111-4111-8111-111111111111';
  const devB = 'b2222222-2222-4222-8222-222222222222';
  function prepared(override: Record<string, unknown> = {}) {
    claimSession(
      [
        { name: 'Not joined' },
        { name: 'Joined', personToken: ALICE_TOKEN },
        { name: 'Online', personToken: OTHER_TOKEN },
        { name: 'Offline', personToken: D_TOKEN },
      ],
      {
        receiptData: {
          subtotal: 100,
          total: 100,
          tax: 0,
          tip: 0,
          currency: 'RUB',
          ...override,
        },
        userId: 'user-1',
      },
    );
  }

  test('only the holder of this joined person token can send a browser heartbeat', async () => {
    prepared();
    for (const input of [
      { token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN, deviceId: devA },
      { token: 'share-1', personId: pid(2), personToken: ALICE_TOKEN, deviceId: devA },
      { token: 'share-1', personId: pid(3), personToken: OTHER_TOKEN, deviceId: devA },
    ]) {
      await expect((await caller()).heartbeatPresence(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mockDb.guestPresence.upsert).not.toHaveBeenCalled();
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    await (
      await caller()
    ).heartbeatPresence({
      token: 'share-1',
      personId: pid(2),
      personToken: OTHER_TOKEN,
      deviceId: devA,
    });
    const write = mockDb.guestPresence.upsert.mock.calls[0]![0];
    expect(write.where.sessionId_personId_deviceId).toEqual({
      sessionId: 'gs1',
      personId: pid(2),
      deviceId: devA,
    });
    expect(write.create.lastSeenAt).toBeInstanceOf(Date);
    expect(write.update.lastSeenAt).toBeInstanceOf(Date);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('another browser has a separate device row and cannot erase the first browser', async () => {
    prepared();
    const api = await caller();
    for (const deviceId of [devA, devB]) {
      await api.heartbeatPresence({
        token: 'share-1',
        personId: pid(2),
        personToken: OTHER_TOKEN,
        deviceId,
      });
    }
    expect(mockDb.guestPresence.upsert).toHaveBeenCalledTimes(2);
    const keys = mockDb.guestPresence.upsert.mock.calls.map(
      ([query]) => query.where.sessionId_personId_deviceId.deviceId,
    );
    expect(keys).toEqual([devA, devB]);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('expired and finished receipts reject heartbeats, leaving all shares unchanged', async () => {
    prepared();
    claimSession([{ name: 'online', personToken: ALICE_TOKEN }], { status: 'FINALIZED' });
    await expect(
      (await caller()).heartbeatPresence({
        token: 'share-1',
        personId: pid(0),
        personToken: ALICE_TOKEN,
        deviceId: devA,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    claimSession([{ name: 'online', personToken: ALICE_TOKEN }], {
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      (await caller()).heartbeatPresence({
        token: 'share-1',
        personId: pid(0),
        personToken: ALICE_TOKEN,
        deviceId: devA,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.guestPresence.upsert).not.toHaveBeenCalled();
  });

  test('creator sees never joined / joined / online / offline separately, calculated from TTL', async () => {
    prepared();
    const now = Date.now();
    mockDb.guestPresence.groupBy.mockResolvedValue([
      { personId: pid(2), _max: { lastSeenAt: new Date(now - 2000) } },
      { personId: pid(3), _max: { lastSeenAt: new Date(now - 60_000) } },
    ]);
    const view = await (await caller(signedIn)).getSession({ token: 'share-1' });
    expect(view.presence).toEqual([
      { personId: pid(0), status: 'not-joined' },
      { personId: pid(1), status: 'joined' },
      { personId: pid(2), status: 'online' },
      { personId: pid(3), status: 'offline' },
    ]);
    expect(mockDb.guestPresence.groupBy).toHaveBeenCalledWith({
      by: ['personId'],
      where: { sessionId: 'gs1' },
      _max: { lastSeenAt: true },
    });
    expect(JSON.stringify(view.presence)).not.toContain(OTHER_TOKEN);
  });

  test('anonymous and registered non-organizers cannot see device-presence data', async () => {
    prepared();
    for (const session of [null, { user: { id: 'registered-payer' } }]) {
      const view = await (await caller(session)).getSession({ token: 'share-1' });
      expect(view.presence).toBeNull();
      expect(view.people[2]?.hasJoined).toBe(true);
    }
    expect(mockDb.guestPresence.groupBy).not.toHaveBeenCalled();
  });

  test('explicitly appointed co-organizer sees statuses without participant identity or email leaks', async () => {
    prepared({ finalizationOrganizerUserId: 'helper-account' });
    const view = await (await caller({ user: { id: 'helper-account' } })).getSession({ token: 'share-1' });
    expect(view.presence).toHaveLength(4);
    expect(view.isCreator).toBe(false);
    expect(JSON.stringify(view)).not.toContain('helper-account');
    expect(mockDb.guestPresence.groupBy).toHaveBeenCalledOnce();
  });
});

describe('guest.getSession people', () => {
  test('says which people have joined without exposing their tokens, join keys or save keys', async () => {
    claimSession([
      { name: 'Host' },
      { name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2, join: liveJoin('alice'), saves: [ALICE_SAVE] },
    ]);
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(session.people).toEqual([
      { id: pid(0), name: 'Host', groupSize: 1, hasJoined: false, isRegistered: false, tipCents: 0 },
      { id: pid(1), name: 'Alice', groupSize: 2, hasJoined: true, isRegistered: false, tipCents: 0 },
    ]);
    expect(JSON.stringify(session)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(session)).not.toContain(JOIN_KEY);
    expect(JSON.stringify(session)).not.toContain(ALICE_SAVE.key);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('gives people saved before person ids existed their ids once, and lists the saved ids', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], { legacy: true });
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(mockDb.guestSplit.update).toHaveBeenCalledOnce();
    const saved = savedPeople() as { id: string }[];
    expect(saved).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host' },
      { id: expect.stringMatching(UUID), name: 'Alice', personToken: ALICE_TOKEN },
    ]);
    expect(session.people.map((p) => p.id)).toEqual(saved.map((p) => p.id));
  });

  test('gives ids to the people of a finalized split saved before person ids existed', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], {
      legacy: true,
      status: 'FINALIZED',
    });
    const session = await (await caller()).getSession({ token: 'share-1' });
    const saved = savedPeople() as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(session.people.map((p) => p.id)).toEqual(saved.map((p) => p.id));
  });

  test('keeps the ids another request saved first', async () => {
    // The first read has no ids; by the time the transaction reads again, another request gave them
    const legacy = [{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }];
    claimSession(legacy, { legacy: true });
    const stored: unknown = await mockDb.guestSplit.findUnique();
    mockDb.guestSplit.findUnique.mockClear();
    mockDb.guestSplit.findUnique
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...(stored as object), people: withIds(legacy) });
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    expect(session.people.map((p) => p.id)).toEqual([pid(0), pid(1)]);
  });

  test("a finalized split's public result doesn't expose tokens, join keys or save keys either", async () => {
    claimSession(
      [{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN, join: liveJoin('alice'), saves: [ALICE_SAVE] }],
      { status: 'FINALIZED' },
    );
    const split = await (await caller()).getSplit({ token: 'share-1' });
    expect(split.people).toEqual([
      { name: 'Host', groupSize: 1, hasJoined: false, isRegistered: false },
      { name: 'Alice', groupSize: 1, hasJoined: true, isRegistered: false },
    ]);
    expect(JSON.stringify(split)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(split)).not.toContain(JOIN_KEY);
    expect(JSON.stringify(split)).not.toContain(ALICE_SAVE.key);
  });
});

describe('Issue 3.6.1: reserved owner name Илья, verified by account, not guest input', () => {
  const ownerAccount = { user: { id: 'billok-owner' } };
  const outsiderAccount = { user: { id: 'other-account' } };
  const ownerUser = { email: 'owner@example.com', name: 'Илья', suspendedAt: null };
  const nonOwner = { email: 'another@example.com', name: 'Илья', suspendedAt: null };
  const receiptData = { subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'RUB' };
  const items = [{ name: 'Чай', quantity: 1, unitPrice: 100, totalPrice: 100 }];

  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'owner@example.com');
    mockDb.user.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === 'billok-owner' ? ownerUser : nonOwner,
    );
    mockDb.guestSplit.create.mockResolvedValue({ id: 'fresh', shareToken: 'fresh-share' });
  });
  afterEach(() => vi.unstubAllEnvs());

  test('owner creating a receipt gets reserved name even if payer differs; creator is bound by account id', async () => {
    const created = await (
      await caller(ownerAccount)
    ).createClaimSession({
      receiptData,
      items,
      people: ['Сергей', 'Илья'],
      creatorName: 'Сергей',
      paidByName: 'Сергей',
      joinCreator: true,
    });
    const payload = mockDb.guestSplit.create.mock.calls[0]![0].data as {
      people: TestPerson[];
      receiptData: { organizerPersonId: string };
      paidByIndex: number;
    };
    expect(payload.people.map((p) => p.name)).toEqual(['Сергей', 'Илья']);
    expect(payload.people[1]).toMatchObject({
      id: payload.receiptData.organizerPersonId,
      name: 'Илья',
      accountUserId: 'billok-owner',
      reservedOwner: true,
      personToken: created.creator?.personToken,
    });
    expect(payload.paidByIndex).toBe(0);
    expect(created.creator?.name).toBe('Илья');
    // The account binding is never part of the public response.
    expect(JSON.stringify(created)).not.toContain('billok-owner');
  });

  test('an unjoined owner row cannot be taken by someone who merely enters Илья', async () => {
    claimSession([{ name: 'Илья', accountUserId: 'billok-owner', reservedOwner: true }, { name: 'Гость 1' }]);
    await expect(
      (await caller(outsiderAccount)).joinSession({
        token: 'share-1',
        name: ' ИЛЬЯ ',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    const actualOwner = await (await caller(ownerAccount)).joinSession({ token: 'share-1', name: 'Илья' });
    expect(actualOwner.name).toBe('Илья');
    expect(actualOwner.personIndex).toBe(0);
    expect((savedPeople() as TestPerson[])[0]?.accountUserId).toBe('billok-owner');
  });

  test('guest entered first: rename its label only, preserve ID, token, personal tip and all shares', async () => {
    claimSession(
      [
        { name: 'Создатель', personToken: OTHER_TOKEN },
        { name: ' илья ', personToken: ALICE_TOKEN, tipCents: 125, groupSize: 2 },
        { name: 'Илья (2)' },
      ],
      { items, assignments: [{ itemIndex: 0, personIndices: [1] }] },
    );
    const owner = await (await caller(ownerAccount)).joinSession({ token: 'share-1', name: ' ИЛЬЯ ' });
    expect(owner.name).toBe('Илья');
    expect(owner.personIndex).toBe(3);
    const people = savedPeople() as TestPerson[];
    expect(people[1]).toMatchObject({
      id: pid(1),
      name: 'Илья (3)',
      personToken: ALICE_TOKEN,
      tipCents: 125,
      groupSize: 2,
    });
    expect(people[3]).toMatchObject({ accountUserId: 'billok-owner', reservedOwner: true, name: 'Илья' });
    expect(new Set(people.map((p) => p.name.trim().toLocaleLowerCase('ru-RU'))).size).toBe(4);
    expect(mockDb.guestSplit.update.mock.calls[0]![0].data.assignments).toBeUndefined();
    expect(mockDb.guestSplit.update.mock.calls[0]![0].data.paidByIndex).toBeUndefined();
  });

  test('owner first: other users cannot claim or rename a different row to Илья', async () => {
    claimSession([
      { name: 'Илья', personToken: ALICE_TOKEN, accountUserId: 'billok-owner', reservedOwner: true },
      { name: 'Сергей', personToken: OTHER_TOKEN },
    ]);
    await expect((await caller()).joinSession({ token: 'share-1', name: ' иЛьЯ ' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'nameTaken',
    });
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        targetId: pid(1),
        newName: ' ИЛЬЯ ',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        targetId: pid(0),
        newName: 'Другое',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', messageKey: 'notParticipant' });
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        targetId: pid(0),
        newName: 'ИЛЬЯ',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', messageKey: 'notParticipant' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('reentry by the same owner account uses exactly the old row and token, with no needless write', async () => {
    claimSession([
      { name: 'Илья', personToken: ALICE_TOKEN, accountUserId: 'billok-owner', reservedOwner: true },
      { name: 'Гость 1' },
    ]);
    const result = await (await caller(ownerAccount)).joinSession({ token: 'share-1', name: 'Случайный текст' });
    expect(result).toEqual({ personIndex: 0, personId: pid(0), personToken: ALICE_TOKEN, name: 'Илья' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('another name Илья is allowed in a receipt with no participating owner', async () => {
    claimSession([{ name: 'Создатель' }], { userId: 'billok-owner' });
    const result = await (await caller(outsiderAccount)).joinSession({ token: 'share-1', name: 'Илья' });
    expect(result.name).toBe('Илья');
    expect((savedPeople() as TestPerson[])[1]?.accountUserId).toBeUndefined();
  });

  test('the name or ADMIN_EMAIL alone is not enough; a wrong account has no privilege', async () => {
    claimSession([{ name: 'Илья', personToken: ALICE_TOKEN }]);
    await expect((await caller(outsiderAccount)).joinSession({ token: 'share-1', name: 'Илья' })).rejects.toMatchObject(
      { code: 'CONFLICT', messageKey: 'joinNameTaken' },
    );
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('an ordinary guest cannot remove the owner bound to the reserved row', async () => {
    claimSession([
      { name: 'Илья', personToken: ALICE_TOKEN, accountUserId: 'billok-owner', reservedOwner: true },
      { name: 'Гость', personToken: OTHER_TOKEN },
    ]);
    await expect(
      (await caller()).removePerson({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        targetId: pid(0),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('public session never exposes the owner userId even if its row is account bound', async () => {
    claimSession([{ name: 'Илья', personToken: ALICE_TOKEN, accountUserId: 'billok-owner', reservedOwner: true }]);
    const result = await (await caller()).getSession({ token: 'share-1' });
    expect(JSON.stringify(result)).not.toContain('billok-owner');
    expect(result.people[0]?.name).toBe('Илья');
    expect(result.people[0]).not.toHaveProperty('accountUserId');
  });
});

describe('Issue 3.6: no two people share a display name inside one receipt', () => {
  const receiptData = { subtotal: 1001, tax: 0, tip: 0, total: 1001, currency: 'RUB' };
  const items = [{ name: 'Чай', quantity: 1, unitPrice: 1001, totalPrice: 1001 }];
  beforeEach(() => mockDb.guestSplit.create.mockResolvedValue({ id: 'fresh', shareToken: 'fresh-token' }));

  test.each([
    [' Алексей ', 'алексей'],
    ['Cafe\u0301', 'CAFÉ'],
    ['Ａｌｅｘ', 'alex'],
  ])('direct split refuses normalized collision: %s vs %s', async (first, second) => {
    await expect(
      (await caller(signedIn)).createSplit({
        receiptData,
        items,
        people: [{ name: first }, { name: second }],
        assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
        paidByIndex: 0,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  test('a different unique qualifier creates two separate people and assigned portions', async () => {
    await (
      await caller(signedIn)
    ).createSplit({
      receiptData,
      items,
      people: [{ name: 'Алексей' }, { name: 'Алексей П.' }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      paidByIndex: 0,
    });
    const created = mockDb.guestSplit.create.mock.calls[0]?.[0]?.data;
    expect((created?.people as { name: string }[]).map((p) => p.name)).toEqual(['Алексей', 'Алексей П.']);
    expect(created?.assignments).toEqual([{ itemIndex: 0, personIndices: [0, 1] }]);
  });

  test('a new receipt may reuse a name used in a different receipt', async () => {
    const api = await caller(signedIn);
    for (let i = 0; i < 2; i++) {
      await api.createSplit({
        receiptData,
        items,
        people: [{ name: 'Алексей' }],
        assignments: [{ itemIndex: 0, personIndices: [0] }],
        paidByIndex: 0,
      });
    }
    expect(mockDb.guestSplit.create).toHaveBeenCalledTimes(2);
  });

  test('pre-seeded Unicode-equivalent duplicate names cannot be claimed ambiguously', async () => {
    claimSession([{ name: 'Е\u0308ж' }, { name: 'ЁЖ' }]);
    await expect((await caller()).joinSession({ token: 'share-1', name: 'Ёж' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'nameTaken',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('joining a different name remains permitted and name collision is receipt-local', async () => {
    claimSession([{ name: 'Алексей', personToken: ALICE_TOKEN }]);
    await expect((await caller()).joinSession({ token: 'share-1', name: ' алексей ' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'joinNameTaken',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    const fresh = await (await caller()).joinSession({ token: 'share-1', name: 'Алексей П.' });
    expect(fresh.name).toBe('Алексей П.');
    expect(savedPeople()).toHaveLength(2);
  });

  test('renaming a joined diner to an equivalent name fails inside transaction, without writing', async () => {
    claimSession([
      { name: 'Алексей', personToken: ALICE_TOKEN },
      { name: 'Иван', personToken: OTHER_TOKEN },
    ]);
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        targetId: pid(1),
        newName: ' аЛеКсЕЙ ',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('Unicode composition normalizes saved display spelling without changing a guest identity', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    await (
      await caller()
    ).editPersonName({
      token: 'share-1',
      personToken: ALICE_TOKEN,
      targetId: pid(0),
      newName: ' Cafe\u0301 ',
    });
    expect((savedPeople() as { id: string; name: string; personToken: string }[])[0]).toEqual({
      id: pid(0),
      name: 'Café',
      personToken: ALICE_TOKEN,
    });
  });
});

describe('Issue 3.8.4: creator revokes and rotates a personal link without mutating the bill', () => {
  const readyAt = '2026-11-07T01:00:00.000Z';
  const data = {
    subtotal: 1200,
    tax: 0,
    tip: 0,
    total: 1200,
    currency: 'RUB',
    guestSlotsMode: true,
    guestCount: 2,
    organizerPersonId: pid(0),
    partsApprovalHash: 'original-approved',
  };
  const oldJoin = { key: JOIN_KEY, name: 'андрей', expiresAt: Date.now() + 60_000 };
  const savedKey = { key: '456e4567-e89b-42d3-a456-426614174083', hash: 'old-save-hash' };
  const people: TestPerson[] = [
    { name: 'Создатель', personToken: OTHER_TOKEN, accountUserId: 'user-1' },
    {
      name: 'Андрей',
      guestSlotNumber: 1,
      personToken: ALICE_TOKEN,
      personalLinkReadyAt: readyAt,
      tipCents: 175,
      paymentDeclaredAt: '2026-11-06T19:00:00.000Z',
      paymentVerifiedAt: '2026-11-06T19:05:00.000Z',
      join: oldJoin,
      saves: [savedKey],
    },
    { name: 'Гость 2', guestSlotNumber: 2, personToken: '33333333-3333-4333-8333-333333333333' },
  ];
  const requestKey = '123e4567-e89b-42d3-a456-426614174084';
  const request = { token: 'share-1', personId: pid(1), requestKey };
  beforeEach(() => {
    claimSession(people, {
      receiptData: data,
      paidByIndex: 2,
      items: [{ name: 'Суп', quantity: 1, unitPrice: 1200, totalPrice: 1200 }],
      assignments: [{ itemIndex: 0, personIndices: [1] }],
    });
  });

  test('one transaction revokes prior token and replay keys while retaining the stable person, financial fields and shares', async () => {
    const result = await (await caller(signedIn)).rotateGuestPersonalLink(request);
    expect(result).toMatchObject({
      personId: pid(1),
      name: 'Андрей',
      personToken: expect.stringMatching(UUID),
      rotatedAt: expect.any(String),
      rotationCount: 1,
    });
    expect(result.personToken).not.toBe(ALICE_TOKEN);
    const updated = savedPeople() as TestPerson[];
    expect(updated).toHaveLength(people.length);
    expect(updated[0]).toMatchObject({ personToken: OTHER_TOKEN, id: pid(0) });
    expect(updated[1]).toMatchObject({
      id: pid(1),
      name: 'Андрей',
      guestSlotNumber: 1,
      personToken: result.personToken,
      personalLinkReadyAt: readyAt,
      tipCents: 175,
      paymentDeclaredAt: '2026-11-06T19:00:00.000Z',
      paymentVerifiedAt: '2026-11-06T19:05:00.000Z',
      personalLinkRotation: { requestKey, rotatedAt: result.rotatedAt, count: 1 },
    });
    expect(updated[1]?.join).toBeUndefined();
    expect(updated[1]?.saves).toBeUndefined();
    expect(updated[2]?.personToken).toBe(people[2]?.personToken);
    const payload = mockDb.guestSplit.update.mock.calls[0]![0].data;
    expect(payload).not.toHaveProperty('assignments');
    expect(payload).not.toHaveProperty('paidByIndex');
    expect(payload).not.toHaveProperty('summary');
    expect(payload).not.toHaveProperty('receiptData');
    expect(payload).not.toHaveProperty('items');
    expect(JSON.stringify(payload)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(payload)).not.toContain(JOIN_KEY);
  });

  test('old token cannot resume, rename, change personal tip, or claim dishes after rotation', async () => {
    const rotated = await (await caller(signedIn)).rotateGuestPersonalLink(request);
    claimSession(savedPeople() as TestPerson[], { receiptData: data });
    mockDb.guestSplit.update.mockClear();
    await expect((await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).resolves.toBeNull();
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        targetId: pid(1),
        newName: 'Чужое',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      (await caller()).setPersonalTip({
        token: 'share-1',
        personId: pid(1),
        personToken: ALICE_TOKEN,
        tipCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personId: pid(1),
        personToken: ALICE_TOKEN,
        addItemIndices: [0],
        removeItemIndices: [],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      (await caller()).resumeSession({
        token: 'share-1',
        personToken: rotated.personToken,
      }),
    ).resolves.toMatchObject({ personId: pid(1), name: 'Андрей' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('idempotency key returns exactly the same new token on retry; a distinct request rotates again', async () => {
    const first = await (await caller(signedIn)).rotateGuestPersonalLink(request);
    claimSession(savedPeople() as TestPerson[], { receiptData: data });
    mockDb.guestSplit.update.mockClear();
    const second = await (await caller(signedIn)).rotateGuestPersonalLink(request);
    expect(second).toEqual(first);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    const next = await (
      await caller(signedIn)
    ).rotateGuestPersonalLink({
      ...request,
      requestKey: '123e4567-e89b-42d3-a456-426614174085',
    });
    expect(next.personToken).not.toBe(first.personToken);
    expect(next.rotationCount).toBe(2);
    const final = savedPeople() as TestPerson[];
    expect(final[1]?.personalLinkRotation?.count).toBe(2);
  });

  test('only registered receipt creator may rotate; payer, unrelated owner, anonymous and impersonator cannot', async () => {
    await expect((await caller()).rotateGuestPersonalLink(request)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      (await caller({ user: { id: 'billok-owner' } })).rotateGuestPersonalLink(request),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', messageKey: 'sessionNotFound' });
    const { guestRouter } = await import('./guest');
    const impersonating = guestRouter.createCaller({
      session: signedIn,
      db: mockDb,
      headers: new Headers(),
      impersonating: { adminId: 'someone' },
    } as unknown as Parameters<typeof guestRouter.createCaller>[0]);
    await expect(impersonating.rotateGuestPersonalLink(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('no guest token, no first saved action, creator row, foreign personId, expired/legacy check cannot rotate', async () => {
    const api = await caller(signedIn);
    await expect(api.rotateGuestPersonalLink({ ...request, personId: pid(2) })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      messageKey: 'guestPersonalLinkNotReady',
    });
    await expect(api.rotateGuestPersonalLink({ ...request, personId: pid(0) })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      messageKey: 'personGone',
    });
    await expect(api.rotateGuestPersonalLink({ ...request, personId: pid(7) })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      messageKey: 'personGone',
    });
    claimSession([{ name: 'Андрей', personToken: ALICE_TOKEN }]);
    await expect(api.rotateGuestPersonalLink({ ...request, personId: pid(0) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    claimSession(people, { receiptData: data, expiresAt: new Date(0) });
    await expect(api.rotateGuestPersonalLink(request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      messageKey: 'sessionExpired',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('finalized check can reissue a recovery link, without modifying financial settlement', async () => {
    claimSession(people, { receiptData: data, status: 'FINALIZED' });
    const rotated = await (await caller(signedIn)).rotateGuestPersonalLink(request);
    expect(rotated.personToken).not.toBe(ALICE_TOKEN);
    const dataUpdate = mockDb.guestSplit.update.mock.calls[0]![0].data;
    expect(Object.keys(dataUpdate)).toEqual(['people']);
  });

  test('rate limit rejects rotation without accessing or updating the private guest token', async () => {
    checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 0 });
    await expect((await caller(signedIn)).rotateGuestPersonalLink(request)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('only creator gets a tokenless audit event; public and unrelated accounts get none', async () => {
    const rotated = await (await caller(signedIn)).rotateGuestPersonalLink(request);
    claimSession(savedPeople() as TestPerson[], { receiptData: data });
    const creator = await (await caller(signedIn)).getSession({ token: 'share-1' });
    expect(creator.personalLinkEvents).toEqual([
      {
        personId: pid(1),
        rotatedAt: rotated.rotatedAt,
        rotationCount: 1,
      },
    ]);
    expect(JSON.stringify(creator.personalLinkEvents)).not.toContain(rotated.personToken);
    expect(JSON.stringify(creator.personalLinkEvents)).not.toContain(ALICE_TOKEN);
    const outside = await (await caller()).getSession({ token: 'share-1' });
    expect(outside.personalLinkEvents).toBeNull();
    const registered = await (await caller({ user: { id: 'registered-payer' } })).getSession({ token: 'share-1' });
    expect(registered.personalLinkEvents).toBeNull();
    expect(JSON.stringify(outside)).not.toContain(rotated.personToken);
    expect(JSON.stringify(outside)).not.toContain(requestKey);
  });
});

describe('Issue 3.11: account registration is a verified server-side person binding', () => {
  const receiptData = {
    subtotal: 1200,
    tax: 0,
    tip: 0,
    total: 1200,
    currency: 'RUB',
    guestSlotsMode: true,
    guestCount: 3,
    organizerPersonId: pid(0),
  };
  const people: TestPerson[] = [
    { name: 'Создатель', accountUserId: 'user-1', personToken: ALICE_TOKEN },
    { name: 'Зарегистрированный', accountUserId: 'user-2', personToken: OTHER_TOKEN, guestSlotNumber: 1 },
    { name: 'Зарегистрированный (двойник)', guestSlotNumber: 2, personToken: '33333333-3333-4333-8333-333333333333' },
    { name: 'Гость 3', guestSlotNumber: 3 },
  ];
  beforeEach(() => claimSession(people, { receiptData }));

  test('public getSession reveals only safe account status for bound and unbound rows', async () => {
    const result = await (await caller()).getSession({ token: 'share-1' });
    expect(result.people.map((person) => person.isRegistered)).toEqual([true, true, false, false]);
    expect(result.people.map((person) => person.hasJoined)).toEqual([true, true, true, false]);
    const json = JSON.stringify(result);
    expect(json).not.toContain('accountUserId');
    expect(json).not.toContain('user-2');
    expect(json).not.toContain(ALICE_TOKEN);
    expect(json).not.toContain(OTHER_TOKEN);
  });

  test('name, personal token and ordinary guest receipt privileges cannot produce registered badge', async () => {
    const result = await (
      await caller({ user: { id: 'unbound-registered-viewer' } })
    ).getSession({
      token: 'share-1',
    });
    expect(result.people[2]).toMatchObject({
      name: 'Зарегистрированный (двойник)',
      hasJoined: true,
      isRegistered: false,
    });
    expect(result.people[3]).toMatchObject({ name: 'Гость 3', isRegistered: false });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('finalized getSplit preserves the same account registration flags without exposing IDs', async () => {
    claimSession(people, { receiptData, status: 'FINALIZED' });
    const result = await (await caller()).getSplit({ token: 'share-1' });
    expect(result.people.map((person) => person.isRegistered)).toEqual([true, true, false, false]);
    expect(JSON.stringify(result)).not.toContain('accountUserId');
    expect(JSON.stringify(result)).not.toContain('user-2');
  });

  test('registered account binding remains after guest rename or token replacement', async () => {
    const rotated = people.map((person) => ({ ...person }));
    rotated[1] = { ...rotated[1]!, name: 'Новое имя', personToken: '44444444-4444-4444-8444-444444444444' };
    claimSession(rotated, { receiptData });
    const result = await (await caller()).getSession({ token: 'share-1' });
    expect(result.people[1]).toMatchObject({ name: 'Новое имя', isRegistered: true });
    expect(result.people[2]?.isRegistered).toBe(false);
  });
});

describe('Issue 3.8.2: creator retrieves a guest personal link only with verified account authority', () => {
  const savedAt = '2026-11-06T10:00:00.000Z';
  const data = {
    subtotal: 800,
    tax: 0,
    tip: 0,
    total: 800,
    currency: 'RUB',
    guestSlotsMode: true,
    guestCount: 3,
    organizerPersonId: pid(0),
  };
  const readyGuest: TestPerson = {
    name: 'Андрей',
    guestSlotNumber: 1,
    personToken: ALICE_TOKEN,
    personalLinkReadyAt: savedAt,
  };
  const people: TestPerson[] = [
    { name: 'Создатель', accountUserId: 'user-1', personToken: OTHER_TOKEN },
    readyGuest,
    { name: 'Гость 2', guestSlotNumber: 2, personToken: '33333333-3333-4333-8333-333333333333' },
    { name: 'Гость 3', guestSlotNumber: 3 },
  ];
  const request = { token: 'share-1', personId: pid(1) };
  beforeEach(() => claimSession(people, { receiptData: data }));

  test('only the actual creator receives the ready guest token through the explicit mutation', async () => {
    const result = await (await caller(signedIn)).getGuestPersonalLink(request);
    expect(result).toEqual({ personId: pid(1), name: 'Андрей', personToken: ALICE_TOKEN });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('a shared-link visitor cannot retrieve it without a registered account', async () => {
    await expect((await caller()).getGuestPersonalLink(request)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('another registered account, even if payer or BillOK owner, cannot access someone else receipt', async () => {
    await expect((await caller({ user: { id: 'not-creator' } })).getGuestPersonalLink(request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      messageKey: 'sessionNotFound',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('impersonating a creator account is forbidden without disclosing the credential', async () => {
    const { guestRouter } = await import('./guest');
    const api = guestRouter.createCaller({
      session: signedIn,
      db: mockDb,
      headers: new Headers(),
      impersonating: { adminId: 'someone' },
    } as unknown as Parameters<typeof guestRouter.createCaller>[0]);
    await expect(api.getGuestPersonalLink(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('a guest with no first saved action has no creator-copyable token yet', async () => {
    await expect(
      (await caller(signedIn)).getGuestPersonalLink({
        token: 'share-1',
        personId: pid(2),
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', messageKey: 'guestPersonalLinkNotReady' });
  });

  test('an unclaimed guest slot does not have a link', async () => {
    await expect(
      (await caller(signedIn)).getGuestPersonalLink({
        token: 'share-1',
        personId: pid(3),
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', messageKey: 'guestPersonalLinkNotJoined' });
  });

  test('creator row and a foreign personId cannot be returned as a guest secret', async () => {
    const api = await caller(signedIn);
    for (const personId of [pid(0), pid(9)]) {
      await expect(api.getGuestPersonalLink({ token: 'share-1', personId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        messageKey: 'personGone',
      });
    }
  });

  test('closed receipts can still provide recovery after first edit, but expired ones cannot', async () => {
    claimSession(people, { receiptData: data, status: 'FINALIZED' });
    await expect((await caller(signedIn)).getGuestPersonalLink(request)).resolves.toMatchObject({
      personToken: ALICE_TOKEN,
    });
    claimSession(people, { receiptData: data, expiresAt: new Date(0) });
    await expect((await caller(signedIn)).getGuestPersonalLink(request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      messageKey: 'sessionExpired',
    });
  });

  test('old named receipts do not accidentally release secrets via the new API', async () => {
    claimSession([{ name: 'Андрей', personToken: ALICE_TOKEN }]);
    await expect(
      (await caller(signedIn)).getGuestPersonalLink({
        token: 'share-1',
        personId: pid(0),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('fetching the link is bounded by an authenticated-account rate limit', async () => {
    checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 0 });
    await expect((await caller(signedIn)).getGuestPersonalLink(request)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('no public session response discloses the ready guest personal token', async () => {
    const publicState = await (await caller()).getSession({ token: 'share-1' });
    expect(publicState.people[1]).toMatchObject({ id: pid(1), personalLinkReady: true });
    expect(JSON.stringify(publicState)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(publicState)).not.toContain(savedAt);
  });
});

describe('Issue 3.8.1: personal link only after the guest saves a real change', () => {
  const data = {
    subtotal: 1500,
    tax: 0,
    tip: 0,
    total: 1500,
    currency: 'RUB',
    guestSlotsMode: true,
    guestCount: 2,
    organizerPersonId: pid(0),
  };
  const people: TestPerson[] = [
    { name: 'Создатель', personToken: OTHER_TOKEN, accountUserId: 'user-1' },
    { name: 'Андрей', personToken: ALICE_TOKEN, guestSlotNumber: 1 },
    { name: 'Гость 2', guestSlotNumber: 2 },
  ];
  const items = [{ name: 'Чай', quantity: 1, unitPrice: 1500, totalPrice: 1500 }];
  beforeEach(() => claimSession(people, { receiptData: data, items }));

  test('the invitation and initial slot claim do not publish a personal-link readiness bit or secret', async () => {
    const result = await (await caller()).getSession({ token: 'share-1' });
    expect(result.people[1]).toMatchObject({ guestSlotNumber: 1, personalLinkReady: false, hasJoined: true });
    expect(result.people[2]).toMatchObject({ guestSlotNumber: 2, personalLinkReady: false, hasJoined: false });
    const json = JSON.stringify(result);
    expect(json).not.toContain(ALICE_TOKEN);
    expect(json).not.toContain('personalLinkReadyAt');
    expect(json).not.toContain('accountUserId');
  });

  test('guest saves own changed name, then the same person becomes eligible', async () => {
    await (
      await caller()
    ).editPersonName({
      token: 'share-1',
      personToken: ALICE_TOKEN,
      targetId: pid(1),
      newName: 'Андрей П.',
    });
    const saved = savedPeople() as TestPerson[];
    expect(saved[1]).toMatchObject({
      id: pid(1),
      guestSlotNumber: 1,
      personToken: ALICE_TOKEN,
      name: 'Андрей П.',
      personalLinkReadyAt: expect.any(String),
    });
    expect(saved[0]?.personalLinkReadyAt).toBeUndefined();
    expect(saved[2]?.personalLinkReadyAt).toBeUndefined();
    claimSession(saved, { receiptData: data, items });
    const visible = await (await caller()).getSession({ token: 'share-1' });
    expect(visible.people[1]).toMatchObject({ id: pid(1), personalLinkReady: true });
    expect(JSON.stringify(visible)).not.toContain(ALICE_TOKEN);
  });

  test('creator renaming guest is NOT the guest first saved action', async () => {
    await (
      await caller(signedIn)
    ).editPersonName({
      token: 'share-1',
      targetId: pid(1),
      newName: 'Андрей Иванов',
    });
    expect((savedPeople() as TestPerson[])[1]?.personalLinkReadyAt).toBeUndefined();
  });

  test('saving the exact same name without a change does not unlock the personal link', async () => {
    await (
      await caller()
    ).editPersonName({
      token: 'share-1',
      personToken: ALICE_TOKEN,
      targetId: pid(1),
      newName: 'Андрей',
    });
    expect((savedPeople() as TestPerson[])[1]?.personalLinkReadyAt).toBeUndefined();
  });

  test('a real voluntary tip change unlocks the link; zero-to-zero does not', async () => {
    const guest = { token: 'share-1', personId: pid(1), personToken: ALICE_TOKEN };
    await (await caller()).setPersonalTip({ ...guest, tipCents: 0 });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    await (await caller()).setPersonalTip({ ...guest, tipCents: 275 });
    expect((savedPeople() as TestPerson[])[1]).toMatchObject({
      personToken: ALICE_TOKEN,
      tipCents: 275,
      personalLinkReadyAt: expect.any(String),
    });
  });

  test('saving your first selected dish unlocks the link without changing anyone else', async () => {
    await (
      await caller()
    ).claimItems({
      token: 'share-1',
      personId: pid(1),
      personToken: ALICE_TOKEN,
      addItemIndices: [0],
      removeItemIndices: [],
      saveKey: JOIN_KEY,
    });
    const saved = savedPeople() as TestPerson[];
    expect(saved[1]).toMatchObject({
      id: pid(1),
      personToken: ALICE_TOKEN,
      personalLinkReadyAt: expect.any(String),
    });
    expect(saved[0]?.personalLinkReadyAt).toBeUndefined();
    expect(saved[2]?.personalLinkReadyAt).toBeUndefined();
  });

  test('no-op save of an empty claim set does not unlock the link', async () => {
    await (
      await caller()
    ).claimItems({
      token: 'share-1',
      personId: pid(1),
      personToken: ALICE_TOKEN,
      claimedItemIndices: [],
    });
    expect(savedPeople()).toBeUndefined();
    expect(mockDb.guestSplit.update.mock.calls[0]![0].data).not.toHaveProperty('people');
  });

  test('guest first saved own portion count unlocks, without modifying other people', async () => {
    claimSession(people, {
      receiptData: data,
      items,
      assignments: [{ itemIndex: 0, personIndices: [1] }],
    });
    await (
      await caller()
    ).setMyItemParts({
      token: 'share-1',
      personId: pid(1),
      personToken: ALICE_TOKEN,
      itemIndex: 0,
      parts: 1,
    });
    expect((savedPeople() as TestPerson[])[1]).toMatchObject({
      personToken: ALICE_TOKEN,
      personalLinkReadyAt: expect.any(String),
    });
    const payload = mockDb.guestSplit.update.mock.calls[0]![0].data;
    expect(payload).not.toHaveProperty('paidByIndex');
    expect(payload.assignments).toMatchObject([{ itemIndex: 0, personIndices: [1], partsByPersonId: { [pid(1)]: 1 } }]);
  });

  test('changing another person allocation with own token cannot unlock target recovery link', async () => {
    await (
      await caller()
    ).claimItems({
      token: 'share-1',
      personId: pid(0),
      personToken: ALICE_TOKEN,
      addItemIndices: [0],
      removeItemIndices: [],
      saveKey: JOIN_KEY,
    });
    const saved = savedPeople() as TestPerson[];
    expect(saved[1]?.personalLinkReadyAt).toBeUndefined();
    expect(saved[0]?.personalLinkReadyAt).toBeUndefined();
  });

  test('legacy named guest does not need first action eligibility to preserve old personal links', async () => {
    claimSession([{ name: 'Андрей', personToken: ALICE_TOKEN }], { items });
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(session.people[0]).not.toHaveProperty('personalLinkReady');
  });
});

describe('Issue 3.7.2: atomic fixed guest slot reservation with a shared link', () => {
  const account = { user: { id: 'registered-guest' } };
  const anotherAccount = { user: { id: 'second-account' } };
  const receiptData = {
    subtotal: 1100,
    tax: 0,
    tip: 0,
    total: 1100,
    currency: 'RUB',
    guestSlotsMode: true,
    guestCount: 2,
    organizerPersonId: pid(0),
    partsApprovalHash: 'approved-digest',
  };
  const initialPeople: TestPerson[] = [
    { name: 'Создатель', accountUserId: 'user-1' },
    { name: 'Гость 1', guestSlotNumber: 1, tipCents: 25 },
    { name: 'Гость 2', guestSlotNumber: 2 },
  ];
  const assignment = [{ itemIndex: 0, personIndices: [1] }];
  beforeEach(() => {
    claimSession(initialPeople, {
      receiptData,
      assignments: assignment,
      items: [{ name: 'Чай', quantity: 1, unitPrice: 1100, totalPrice: 1100 }],
    });
    mockDb.user.findUnique.mockResolvedValue({
      email: 'guest@example.com',
      name: 'Андрей',
      suspendedAt: null,
    });
  });

  test('anonymous claims exact selected slot without creating any fourth participant or moving its dish', async () => {
    const joined = await (
      await caller()
    ).joinGuestSlot({
      token: 'share-1',
      slotId: pid(1),
      name: 'Андрей',
      joinKey: JOIN_KEY,
    });
    expect(joined).toMatchObject({
      personIndex: 1,
      personId: pid(1),
      name: 'Андрей',
      personToken: expect.stringMatching(UUID),
    });
    const people = savedPeople() as TestPerson[];
    expect(people).toHaveLength(3);
    expect(people[1]).toMatchObject({
      id: pid(1),
      name: 'Андрей',
      guestSlotNumber: 1,
      tipCents: 25,
      personToken: joined.personToken,
      join: { key: JOIN_KEY, name: 'андрей', expiresAt: expect.any(Number) },
    });
    expect(people[2]).toMatchObject({ id: pid(2), name: 'Гость 2', guestSlotNumber: 2 });
    const saved = mockDb.guestSplit.update.mock.calls[0]![0].data;
    expect(saved).not.toHaveProperty('assignments');
    expect(saved).not.toHaveProperty('paidByIndex');
    expect(saved).not.toHaveProperty('receiptData');
    expect(saved).not.toHaveProperty('summary');
  });

  test('a second device cannot claim already-occupied place or select by matching name', async () => {
    claimSession(
      [initialPeople[0]!, { name: 'Андрей', guestSlotNumber: 1, personToken: ALICE_TOKEN }, initialPeople[2]!],
      { receiptData },
    );
    const api = await caller();
    await expect(api.joinGuestSlot({ token: 'share-1', slotId: pid(1), name: 'Андрей' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'guestSlotTaken',
    });
    await expect(api.joinGuestSlot({ token: 'share-1', slotId: pid(1), name: 'Олег' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'guestSlotTaken',
    });
    await expect(api.joinGuestSlot({ token: 'share-1', slotId: pid(2), name: ' АНДРЕЙ ' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'nameTaken',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('guest with personal token recovers same place even after their name was changed by creator', async () => {
    claimSession(
      [initialPeople[0]!, { name: 'Андрей П.', guestSlotNumber: 1, personToken: ALICE_TOKEN }, initialPeople[2]!],
      { receiptData },
    );
    const returned = await (
      await caller()
    ).joinGuestSlot({
      token: 'share-1',
      slotId: pid(2),
      name: 'Другое',
      personToken: ALICE_TOKEN,
    });
    expect(returned).toEqual({
      personIndex: 1,
      personId: pid(1),
      personToken: ALICE_TOKEN,
      name: 'Андрей П.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('registered guest is linked to server account id, cannot take another slot on repeat login', async () => {
    const joined = await (
      await caller(account)
    ).joinGuestSlot({
      token: 'share-1',
      slotId: pid(1),
      name: 'Андрей',
    });
    const people = savedPeople() as TestPerson[];
    expect(people[1]).toMatchObject({
      name: 'Андрей',
      guestSlotNumber: 1,
      personToken: joined.personToken,
      accountUserId: 'registered-guest',
    });
    claimSession(people, { receiptData });
    mockDb.guestSplit.update.mockClear();
    const rejoined = await (
      await caller(account)
    ).joinGuestSlot({
      token: 'share-1',
      slotId: pid(2),
      name: 'Андрей П.',
    });
    expect(rejoined).toEqual(joined);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('one registered account cannot use another anonymous diner token to claim a different place', async () => {
    claimSession(
      [initialPeople[0]!, { name: 'Андрей', guestSlotNumber: 1, personToken: ALICE_TOKEN }, initialPeople[2]!],
      { receiptData },
    );
    await expect(
      (await caller(account)).joinGuestSlot({
        token: 'share-1',
        slotId: pid(2),
        name: 'Андрей П.',
        personToken: ALICE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('different registered users can occupy different slots; other-account token is not interchangeable', async () => {
    claimSession(
      [
        initialPeople[0]!,
        { name: 'Андрей', guestSlotNumber: 1, personToken: ALICE_TOKEN, accountUserId: 'registered-guest' },
        initialPeople[2]!,
      ],
      { receiptData },
    );
    await expect(
      (await caller(anotherAccount)).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'guestSlotTaken' });
    await expect(
      (await caller(anotherAccount)).joinGuestSlot({
        token: 'share-1',
        slotId: pid(2),
        name: 'Олег',
        personToken: ALICE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await (
      await caller(anotherAccount)
    ).joinGuestSlot({
      token: 'share-1',
      slotId: pid(2),
      name: 'Олег',
    });
    expect(other.personIndex).toBe(2);
    expect((savedPeople() as TestPerson[])[2]).toMatchObject({
      accountUserId: 'second-account',
      name: 'Олег',
    });
  });

  test('creator account recovers reserved creator row without creating an extra guest or changing its name', async () => {
    const recovered = await (
      await caller(signedIn)
    ).joinGuestSlot({
      token: 'share-1',
      slotId: pid(1),
      name: 'Посторонний',
    });
    expect(recovered.personId).toBe(pid(0));
    expect(recovered.personIndex).toBe(0);
    expect(recovered.name).toBe('Создатель');
    expect((savedPeople() as TestPerson[])[0]).toMatchObject({
      accountUserId: 'user-1',
      personToken: recovered.personToken,
    });
    expect((savedPeople() as TestPerson[]).length).toBe(3);
  });

  test('owner comes after another Илья: the same guest row and all other fields survive', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'owner@example.com');
    try {
      mockDb.user.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
        args.where.id === 'billok-owner'
          ? { name: 'Илья', email: 'owner@example.com', suspendedAt: null }
          : { name: 'Анна', email: 'other@example.com', suspendedAt: null },
      );
      claimSession(
        [
          initialPeople[0]!,
          { name: ' илья ', guestSlotNumber: 1, personToken: ALICE_TOKEN, tipCents: 25 },
          initialPeople[2]!,
        ],
        { receiptData, assignments: assignment },
      );
      const joined = await (
        await caller({ user: { id: 'billok-owner' } })
      ).joinGuestSlot({
        token: 'share-1',
        slotId: pid(2),
        name: 'Неважно',
      });
      expect(joined).toMatchObject({ personId: pid(2), name: 'Илья' });
      const people = savedPeople() as TestPerson[];
      expect(people[1]).toMatchObject({
        id: pid(1),
        name: 'Илья (2)',
        personToken: ALICE_TOKEN,
        tipCents: 25,
      });
      expect(people[2]).toMatchObject({
        id: pid(2),
        name: 'Илья',
        accountUserId: 'billok-owner',
        reservedOwner: true,
      });
      expect(mockDb.guestSplit.update.mock.calls[0]![0].data.assignments).toBeUndefined();
      expect(mockDb.guestSplit.update.mock.calls[0]![0].data.receiptData).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('a regular registered Илья cannot take the owner name after owner joins', async () => {
    claimSession(
      [
        initialPeople[0]!,
        {
          name: 'Илья',
          guestSlotNumber: 1,
          accountUserId: 'billok-owner',
          reservedOwner: true,
          personToken: ALICE_TOKEN,
        },
        initialPeople[2]!,
      ],
      { receiptData },
    );
    await expect(
      (await caller(account)).joinGuestSlot({
        token: 'share-1',
        slotId: pid(2),
        name: ' иЛьЯ ',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
  });

  test('anonymous joinKey replay returns only the same slot and name; changed or stolen key is rejected', async () => {
    const api = await caller();
    const first = await api.joinGuestSlot({ token: 'share-1', slotId: pid(1), name: 'Андрей', joinKey: JOIN_KEY });
    const people = savedPeople() as TestPerson[];
    claimSession(people, { receiptData });
    mockDb.guestSplit.update.mockClear();
    const replay = await api.joinGuestSlot({ token: 'share-1', slotId: pid(1), name: ' АНДРЕЙ ', joinKey: JOIN_KEY });
    expect(replay).toEqual(first);
    await expect(
      api.joinGuestSlot({
        token: 'share-1',
        slotId: pid(2),
        name: 'Андрей',
        joinKey: JOIN_KEY,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'joinKeyReused' });
    await expect(
      (await caller(account)).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
        joinKey: JOIN_KEY,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'joinKeyReused' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('guest slot ids from other checks, creator id, empty non-slot IDs are never claimable', async () => {
    const api = await caller();
    for (const id of [pid(0), pid(7)]) {
      await expect(api.joinGuestSlot({ token: 'share-1', slotId: id, name: 'Андрей' })).rejects.toMatchObject({
        code: 'CONFLICT',
        messageKey: 'personGone',
      });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('slot joining refuses old name-based receipts, expired and finalized receipts', async () => {
    claimSession(initialPeople, { receiptData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' } });
    await expect(
      (await caller()).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    claimSession(initialPeople, { receiptData, status: 'FINALIZED' });
    await expect(
      (await caller()).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    claimSession(initialPeople, { receiptData, expiresAt: new Date(0) });
    await expect(
      (await caller()).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('suspended registered account cannot reserve a guest slot', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: new Date() });
    await expect(
      (await caller(account)).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', messageKey: 'accountSuspended' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('public getSession lists stable available slot IDs but not private account ids or tokens', async () => {
    claimSession(initialPeople, { receiptData });
    const result = await (await caller()).getSession({ token: 'share-1' });
    expect(result.people).toMatchObject([
      { id: pid(0), name: 'Создатель', hasJoined: true },
      { id: pid(1), name: 'Гость 1', guestSlotNumber: 1, hasJoined: false },
      { id: pid(2), name: 'Гость 2', guestSlotNumber: 2, hasJoined: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('accountUserId');
    expect(JSON.stringify(result)).not.toContain('personToken');
    expect(JSON.stringify(result)).not.toContain('reservedOwner');
  });

  test('join attempts are separately rate limited by the same bounded session token', async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 0 });
    await expect(
      (await caller()).joinGuestSlot({
        token: 'share-1',
        slotId: pid(1),
        name: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe('Issue 3.7.1: creator plus exactly N additional unclaimed guest slots', () => {
  const receiptData = { subtotal: 1401, tax: 0, tip: 0, total: 1401, currency: 'RUB' };
  const items = [{ name: 'Суп', quantity: 1, unitPrice: 1401, totalPrice: 1401 }];
  const input = { receiptData, items };
  beforeEach(() => {
    mockDb.guestSplit.create.mockResolvedValue({ id: 'fresh', shareToken: 'share-fresh' });
    mockDb.user.findUnique.mockResolvedValue({ name: 'Анна', email: 'anna@example.com', suspendedAt: null });
  });

  function created() {
    return mockDb.guestSplit.create.mock.calls.at(-1)![0].data as {
      people: TestPerson[];
      paidByIndex: number;
      userId: string;
      receiptData: {
        guestSlotsMode?: boolean;
        guestCount?: number;
        organizerPersonId?: string;
        total: number;
        currency: string;
      };
    };
  }

  test('two guests means exactly three rows; creator is always a named account-bound participant', async () => {
    const result = await (
      await caller(signedIn)
    ).createClaimSession({
      ...input,
      guestCount: 2,
      paidByGuestSlot: 2,
      joinCreator: true,
    });
    const saved = created();
    expect(saved.people.map((p) => p.name)).toEqual(['Анна', 'Гость 1', 'Гость 2']);
    expect(saved.people[0]).toMatchObject({
      id: saved.receiptData.organizerPersonId,
      name: 'Анна',
      accountUserId: 'user-1',
      personToken: result.creator?.personToken,
    });
    expect(saved.people[0]?.guestSlotNumber).toBeUndefined();
    expect(saved.people.slice(1).map((p) => p.guestSlotNumber)).toEqual([1, 2]);
    expect(saved.people.slice(1).every((p) => !p.personToken && !p.accountUserId)).toBe(true);
    expect(new Set(saved.people.map((p) => p.id)).size).toBe(3);
    expect(saved.userId).toBe('user-1');
    expect(saved.paidByIndex).toBe(2);
    expect(saved.receiptData).toMatchObject({
      guestSlotsMode: true,
      guestCount: 2,
      total: 1401,
      currency: 'RUB',
    });
    expect(result.creator?.name).toBe('Анна');
  });

  test('zero guests keeps exactly the creator row; payer defaults to creator', async () => {
    const result = await (await caller(signedIn)).createClaimSession({ ...input, guestCount: 0, joinCreator: true });
    expect(created().people).toHaveLength(1);
    expect(created().people[0]).toMatchObject({ name: 'Анна', accountUserId: 'user-1' });
    expect(created().paidByIndex).toBe(0);
    expect(result.creator?.personId).toBe(created().people[0]?.id);
  });

  test('creator without storage is still account-bound and cannot be taken by a guest name', async () => {
    const result = await (await caller(signedIn)).createClaimSession({ ...input, guestCount: 2 });
    expect(result.creator).toBeNull();
    expect(created().people[0]).toMatchObject({ name: 'Анна', accountUserId: 'user-1' });
    claimSession(created().people, { userId: 'user-1' });
    await expect((await caller()).joinSession({ token: 'share-1', name: 'Анна' })).rejects.toMatchObject({
      code: 'CONFLICT',
      messageKey: 'joinNameTaken',
    });
  });

  test('maximum 99 additional guests makes 100 rows, more is refused', async () => {
    await (await caller(signedIn)).createClaimSession({ ...input, guestCount: 99 });
    const people = created().people;
    expect(people).toHaveLength(100);
    expect(people[1]).toMatchObject({ name: 'Гость 1', guestSlotNumber: 1 });
    expect(people[99]).toMatchObject({ name: 'Гость 99', guestSlotNumber: 99 });
    mockDb.guestSplit.create.mockClear();
    await expect((await caller(signedIn)).createClaimSession({ ...input, guestCount: 100 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  test('guest count and paidByGuestSlot cannot select a nonexistent payer or mix legacy people', async () => {
    const api = await caller(signedIn);
    for (const bad of [
      { guestCount: 2, paidByGuestSlot: 3 },
      { guestCount: 0, paidByGuestSlot: 1 },
      { guestCount: -1 },
      { guestCount: 1, people: ['Иван'] },
      { guestCount: 1, creatorName: 'Посторонний' },
      { guestCount: 1, paidByName: 'Посторонний' },
      { creatorName: 'Анна' },
      { paidByName: 'Анна' },
    ]) {
      await expect(
        api.createClaimSession({ ...input, ...bad } as Parameters<typeof api.createClaimSession>[0]),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  test('profile name is obtained from the database, not a client-supplied name; blank is refused', async () => {
    mockDb.user.findUnique.mockResolvedValue({ name: '', email: 'anna@example.com', suspendedAt: null });
    await expect((await caller(signedIn)).createClaimSession({ ...input, guestCount: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  test('creator name Guest 1 cannot collide with a temporary slot', async () => {
    mockDb.user.findUnique.mockResolvedValue({ name: 'Гость 1', email: 'other@example.com', suspendedAt: null });
    await (await caller(signedIn)).createClaimSession({ ...input, guestCount: 2 });
    expect(created().people.map((p) => p.name)).toEqual(['Гость 1', 'Гость 1 (гость)', 'Гость 2']);
    expect(created().people[1]?.guestSlotNumber).toBe(1);
  });

  test('regular user named Илья is not marked as the BillOK owner', async () => {
    mockDb.user.findUnique.mockResolvedValue({ name: 'Илья', email: 'other@example.com', suspendedAt: null });
    await (await caller(signedIn)).createClaimSession({ ...input, guestCount: 1 });
    expect(created().people[0]).toMatchObject({ name: 'Илья', accountUserId: 'user-1' });
    expect(created().people[0]?.reservedOwner).toBeUndefined();
  });

  test('fixed guest slots refuse legacy name-based joins and deletion until atomic slot selection is available', async () => {
    claimSession(
      [
        { name: 'Анна', personToken: ALICE_TOKEN, accountUserId: 'user-1' },
        { name: 'Гость 1', guestSlotNumber: 1 },
      ],
      {
        receiptData: {
          subtotal: 100,
          tax: 0,
          tip: 0,
          total: 100,
          currency: 'RUB',
          guestSlotsMode: true,
          guestCount: 1,
          organizerPersonId: pid(0),
        },
      },
    );
    await expect((await caller()).joinSession({ token: 'share-1', name: 'Гость 1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect((await caller()).joinSession({ token: 'share-1', name: 'Посторонний' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      (await caller()).removePerson({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        targetId: pid(0),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('verified owner creates one reserved Илья row plus guests and distinct payer', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'owner@example.com');
    try {
      mockDb.user.findUnique.mockResolvedValue({ name: 'Илья', email: 'owner@example.com', suspendedAt: null });
      await (await caller(signedIn)).createClaimSession({ ...input, guestCount: 2, paidByGuestSlot: 1 });
      expect(created().people[0]).toMatchObject({
        name: 'Илья',
        accountUserId: 'user-1',
        reservedOwner: true,
      });
      expect(created().paidByIndex).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('guest.createClaimSession', () => {
  const session = {
    receiptData: { subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'RUB' },
    items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100 }],
  };

  function created() {
    return (
      mockDb.guestSplit.create.mock.calls[0]![0] as {
        data: { people: { id: string; name: string; personToken?: string }[]; paidByIndex: number };
      }
    ).data;
  }

  beforeEach(() => {
    mockDb.guestSplit.create.mockResolvedValue({ id: 'gs1', shareToken: 'share-token-123' });
  });

  test('marks a new personal-link session for cross-item rounding without changing the receipt amount', async () => {
    await (await caller(signedIn)).createClaimSession({ ...session, creatorName: 'Host', paidByName: 'Payer' });
    const saved = mockDb.guestSplit.create.mock.calls[0]![0].data as {
      receiptData: { roundingBalanced?: boolean; subtotal: number; total: number };
    };
    expect(saved.receiptData.roundingBalanced).toBe(true);
    expect(saved.receiptData.total).toBe(saved.receiptData.subtotal);
  });

  test('2.17.2.2 saves the creator personal ID even when they are not first or the payer', async () => {
    await (
      await caller(signedIn)
    ).createClaimSession({
      ...session,
      people: ['Dana', 'Host', 'Payer'],
      creatorName: 'Host',
      paidByName: 'Payer',
    });
    const saved = mockDb.guestSplit.create.mock.calls[0]![0].data as {
      people: { id: string; name: string }[];
      paidByIndex: number;
      receiptData: { organizerPersonId: string; roundingBalanced: boolean };
    };
    expect(saved.paidByIndex).toBe(2);
    expect(saved.receiptData.organizerPersonId).toBe(saved.people[1]!.id);
    expect(saved.receiptData.organizerPersonId).not.toBe(saved.people[saved.paidByIndex]!.id);
    expect(saved.receiptData.roundingBalanced).toBe(true);
  });

  test('gives the creator and the payer ids', async () => {
    const result = await (
      await caller(signedIn)
    ).createClaimSession({ ...session, creatorName: 'Host', paidByName: 'Payer' });
    const { people } = created();
    expect(people).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host', visualColorId: 0 },
      { id: expect.stringMatching(UUID), name: 'Payer', visualColorId: 1 },
    ]);
    expect(people[0]!.id).not.toBe(people[1]!.id);
    // Nobody is joined unless the client asks: older clients join the creator by name afterwards
    expect(result).toEqual({ shareToken: 'share-token-123', creator: null });
  });

  // #263: Share Link dropped everyone typed on "Who's splitting?" except the payer
  test('lists everyone typed, in order, with the payer where they were typed', async () => {
    await (
      await caller(signedIn)
    ).createClaimSession({ ...session, people: ['Dana', 'Pat', 'Lee'], creatorName: 'Pat', paidByName: 'Pat' });
    const { people, paidByIndex } = created();
    expect(people.map((p) => p.name)).toEqual(['Dana', 'Pat', 'Lee']);
    expect(new Set(people.map((p) => p.id)).size).toBe(3);
    expect(paidByIndex).toBe(1);
  });

  test('3.6: refuses duplicate entered people instead of silently merging different diners', async () => {
    await expect(
      (await caller(signedIn)).createClaimSession({
        ...session,
        people: ['Pat', 'dana', ' Dana '],
        creatorName: 'pat',
        paidByName: 'PAT',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  test('3.6: still resolves creator and payer roles to the same real person, not duplicates', async () => {
    await (
      await caller(signedIn)
    ).createClaimSession({
      ...session,
      people: ['Pat', 'Dana'],
      creatorName: 'pat',
      paidByName: 'PAT',
    });
    const { people, paidByIndex } = created();
    expect(people.map((p) => p.name)).toEqual(['Pat', 'Dana']);
    expect(paidByIndex).toBe(0);
  });

  test('adds the creator and the payer when the list leaves them out', async () => {
    await (
      await caller(signedIn)
    ).createClaimSession({ ...session, people: ['Dana'], creatorName: 'Host', paidByName: 'Pat' });
    const { people, paidByIndex } = created();
    expect(people.map((p) => p.name)).toEqual(['Dana', 'Host', 'Pat']);
    expect(paidByIndex).toBe(2);
  });

  test('refuses more than 100 people, the most a session can hold', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `Person ${i}`);
    await expect(
      (await caller(signedIn)).createClaimSession({
        ...session,
        people: hundred,
        creatorName: 'Host',
        paidByName: 'Host',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
  });

  // #263: the creator landed on the join form, and whoever opened the link first could take the payer's place
  test('joins the creator when asked, returning the identity their device stores', async () => {
    const result = await (
      await caller(signedIn)
    ).createClaimSession({
      ...session,
      people: ['Dana', 'Pat'],
      creatorName: 'Pat',
      paidByName: 'Pat',
      joinCreator: true,
    });
    const { people } = created();
    expect(result).toEqual({
      shareToken: 'share-token-123',
      creator: { personId: people[1]!.id, personToken: expect.stringMatching(UUID), name: 'Pat' },
    });
    expect(people[1]!.personToken).toBe(result.creator!.personToken);
    expect(people[0]!.personToken).toBeUndefined();
  });
});

function savedAssignments() {
  const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { assignments: unknown } } | undefined;
  return call?.data.assignments;
}

const D_TOKEN = '33333333-3333-4333-8333-333333333333';

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `Item ${i}`, quantity: 1, unitPrice: 100, totalPrice: 100 }));
}

// Issue #205: B (index 1) was removed on another device, so C moved from index 2 to 1 and D
// from 3 to 2. C's page still had the old indexes. D has claimed item 1.
function sessionAfterBWasRemoved() {
  claimSession(
    [
      { id: pid(0), name: 'A', personToken: ALICE_TOKEN },
      { id: pid(2), name: 'C', personToken: OTHER_TOKEN },
      { id: pid(3), name: 'D', personToken: D_TOKEN },
    ],
    { items: items(3), assignments: [{ itemIndex: 1, personIndices: [2] }] },
  );
}

describe('claim-session write limits (#204)', () => {
  const writes = [
    {
      action: 'claim',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.claimItems({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(1), claimedItemIndices: [0] }),
    },
    {
      action: 'edit-name',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1), newName: 'X' }),
    },
    {
      action: 'remove-person',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1) }),
    },
    {
      action: 'split-item',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.splitClaimItem({ token: 'share-1', personToken: ALICE_TOKEN, itemIndex: 0, splitQuantity: 1 }),
    },
    {
      action: 'personal-tip',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.setPersonalTip({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(0), tipCents: 100 }),
    },
  ];

  test.each(writes)(
    "$action: refuses with TOO_MANY_REQUESTS once the caller's own budget is spent",
    async ({ action, call }) => {
      checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
      await expect(call(await caller())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(checkRateLimit).toHaveBeenCalledWith(
        `guest-${action}-person:${JSON.stringify(['share-1', ALICE_TOKEN])}`,
        30,
        60_000,
      );
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    },
  );

  test.each(writes)(
    "$action: refuses with TOO_MANY_REQUESTS once the share token's budget is spent, spending nothing",
    async ({ action, call }) => {
      peekRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
      await expect(call(await caller())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(peekRateLimit).toHaveBeenCalledWith(`guest-${action}:share-1`, 300);
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    },
  );
});

describe('guest.getSession read limit (#204)', () => {
  test("refuses with TOO_MANY_REQUESTS once the share token's read budget is spent", async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
    await expect((await caller()).getSession({ token: 'share-1' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(checkRateLimit).toHaveBeenCalledWith('guest-session-read:share-1', 3000, 60_000);
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });
});

describe('2.20.2 guest known original count: creator control and transaction safety', () => {
  const items = [{ name: 'Пицца', quantity: 1, unitPrice: 800, totalPrice: 800 }];
  const people = [
    { name: 'Анна', personToken: ALICE_TOKEN },
    { name: 'Борис', personToken: OTHER_TOKEN },
  ];
  const assignments = [
    {
      itemIndex: 0,
      personIndices: [0, 1],
      partsByPersonId: { [pid(0)]: 3, [pid(1)]: 5 },
    },
  ];
  const data = (knownPartsByItem: Record<string, number>, partsApprovalHash?: string) => ({
    subtotal: 800,
    total: 800,
    tax: 0,
    tip: 0,
    currency: 'RUB',
    organizerPersonId: pid(0),
    knownPartsByItem,
    ...(partsApprovalHash ? { partsApprovalHash } : {}),
  });
  const fixture = (knownPartsByItem: Record<string, number>, partsApprovalHash?: string) =>
    claimSession(people, {
      userId: 'user-1',
      items,
      assignments,
      receiptData: data(knownPartsByItem, partsApprovalHash),
    });

  test('only the signed-in original creator can set or clear a per-dish count', async () => {
    fixture({});
    await expect(
      (await caller()).setKnownItemParts({
        token: 'share-1',
        itemIndex: 0,
        totalParts: 8,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      (await caller({ user: { id: 'someone-else' } })).setKnownItemParts({
        token: 'share-1',
        itemIndex: 0,
        totalParts: 8,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    await expect(
      (await caller(signedIn)).setKnownItemParts({
        token: 'share-1',
        itemIndex: 0,
        totalParts: 8,
      }),
    ).resolves.toEqual({ success: true, totalParts: 8 });
    expect(mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData.knownPartsByItem).toEqual({ 0: 8 });
    expect(mockDb.guestSplit.update.mock.calls.at(-1)![0].data.items).toBeUndefined();
    expect(mockDb.guestSplit.update.mock.calls.at(-1)![0].data.assignments).toBeUndefined();
  });

  test('rejects original 7 below eight claimed parts and invalid item index', async () => {
    fixture({});
    const api = await caller(signedIn);
    await expect(api.setKnownItemParts({ token: 'share-1', itemIndex: 0, totalParts: 7 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(api.setKnownItemParts({ token: 'share-1', itemIndex: 1, totalParts: 8 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('changing known count removes a previously saved approval and clearing returns to unknown mode', async () => {
    fixture({ 0: 10 }, 'a'.repeat(64));
    await (await caller(signedIn)).setKnownItemParts({ token: 'share-1', itemIndex: 0, totalParts: 8 });
    const changed = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(changed.knownPartsByItem).toEqual({ 0: 8 });
    expect(changed.partsApprovalHash).toBeUndefined();
    fixture({ 0: 8 }, 'a'.repeat(64));
    await (await caller(signedIn)).setKnownItemParts({ token: 'share-1', itemIndex: 0, totalParts: null });
    const cleared = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(cleared.knownPartsByItem).toEqual({});
    expect(cleared.partsApprovalHash).toBeUndefined();
  });

  test('an anonymous guest cannot save more parts than the creator declared', async () => {
    fixture({ 0: 8 });
    await expect(
      (await caller()).setMyItemParts({
        token: 'share-1',
        personId: pid(1),
        personToken: OTHER_TOKEN,
        itemIndex: 0,
        parts: 6,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('claiming by another guest cannot overfill a known limit', async () => {
    claimSession([...people, { name: 'Виктор', personToken: '33333333-3333-4333-8333-333333333333' }], {
      userId: 'user-1',
      items,
      assignments,
      receiptData: data({ 0: 8 }),
    });
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personId: pid(2),
        personToken: '33333333-3333-4333-8333-333333333333',
        claimedItemIndices: [0],
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('known outstanding portions prevent sign-off and finalization even when every dish has a claimant', async () => {
    fixture({ 0: 10 });
    await expect((await caller(signedIn)).confirmSessionParts({ token: 'share-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      (await caller(signedIn)).finalizeSession({
        token: 'share-1',
        personId: pid(0),
        personToken: ALICE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    fixture({ 0: 8 });
    await (await caller(signedIn)).confirmSessionParts({ token: 'share-1' });
    const confirmed = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(confirmed.partsApprovalHash).toMatch(/^[a-f0-9]{64}$/);
    fixture({ 0: 8 }, confirmed.partsApprovalHash);
    await (
      await caller(signedIn)
    ).finalizeSession({
      token: 'share-1',
      personId: pid(0),
      personToken: ALICE_TOKEN,
    });
    const result = mockDb.guestSplit.update.mock.calls.at(-1)![0].data;
    expect(result.status).toBe('FINALIZED');
    expect(result.summary.reduce((sum: number, entry: { total: number }) => sum + entry.total, 0)).toBe(800);
  });
});

describe('guest.setPersonalTip: voluntary kopecks per authenticated participant', () => {
  const alice = { token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN };
  const people = [
    { name: 'Alice', personToken: ALICE_TOKEN },
    { name: 'Bob', personToken: OTHER_TOKEN, tipCents: 400 },
  ];

  test('sets only own tip and keeps the other person and existing session data untouched', async () => {
    claimSession(people);
    await expect((await caller()).setPersonalTip({ ...alice, tipCents: 125 })).resolves.toEqual({
      success: true,
      tipCents: 125,
    });
    expect(savedPeople()).toEqual([
      { id: pid(0), ...people[0], tipCents: 125 },
      { id: pid(1), ...people[1] },
    ]);
    const update = mockDb.guestSplit.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.keys(update.data)).toEqual(['people']);
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });

  test('default zero, stored zero and a repeated identical update require no write', async () => {
    claimSession(people);
    const api = await caller();
    expect((await api.getSession({ token: 'share-1' })).people).toEqual([
      { id: pid(0), name: 'Alice', groupSize: 1, hasJoined: true, isRegistered: false, tipCents: 0 },
      { id: pid(1), name: 'Bob', groupSize: 1, hasJoined: true, isRegistered: false, tipCents: 400 },
    ]);
    expect(await api.setPersonalTip({ ...alice, tipCents: 0 })).toEqual({ success: true, tipCents: 0 });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    claimSession([{ ...people[0]!, tipCents: 125 }, people[1]!]);
    expect(await api.setPersonalTip({ ...alice, tipCents: 125 })).toEqual({ success: true, tipCents: 125 });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('a participant can replace their own tip with zero, never the other participant', async () => {
    claimSession([{ ...people[0]!, tipCents: 125 }, people[1]!]);
    await (await caller()).setPersonalTip({ ...alice, tipCents: 0 });
    expect(savedPeople()).toEqual([
      { id: pid(0), ...people[0], tipCents: 0 },
      { id: pid(1), ...people[1] },
    ]);
  });

  test('refuses a valid token used with another person id', async () => {
    claimSession(people);
    await expect((await caller()).setPersonalTip({ ...alice, personId: pid(1), tipCents: 800 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a foreign or made-up person token even with a valid target id', async () => {
    claimSession(people);
    await expect(
      (await caller()).setPersonalTip({ ...alice, personToken: D_TOKEN, tipCents: 500 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test.each([-1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an invalid tip %s before DB access',
    async (tipCents) => {
      await expect((await caller()).setPersonalTip({ ...alice, tipCents })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    },
  );

  test('refuses finalized and expired sessions with no writes', async () => {
    claimSession(people, { status: 'FINALIZED' });
    await expect((await caller()).setPersonalTip({ ...alice, tipCents: 150 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    claimSession(people, { expiresAt: new Date(Date.now() - 60_000) });
    await expect((await caller()).setPersonalTip({ ...alice, tipCents: 150 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('2.14 guest personal parts cannot change another participant', () => {
  const base = { token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN, itemIndex: 0, parts: 3 };
  const diners = [
    { name: 'Alice', personToken: ALICE_TOKEN },
    { name: 'Bob', personToken: OTHER_TOKEN },
  ];
  function fixture(part?: number) {
    claimSession(diners, {
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 101, totalPrice: 101 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1], ...(part ? { partsByPersonId: { [pid(1)]: 5 } } : {}) }],
    });
  }

  test('stores only the caller own parts and retains another saved portion', async () => {
    fixture(5);
    expect(await (await caller()).setMyItemParts(base)).toEqual({ success: true, parts: 3 });
    expect(savedAssignments()).toEqual([
      {
        itemIndex: 0,
        personIndices: [0, 1],
        partsByPersonId: { [pid(1)]: 5, [pid(0)]: 3 },
      },
    ]);
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });
  test('same value is idempotent', async () => {
    claimSession(diners, {
      items: items(1),
      assignments: [{ itemIndex: 0, personIndices: [0], partsByPersonId: { [pid(0)]: 3 } }],
    });
    await (await caller()).setMyItemParts(base);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
  test('rejects token-to-person mismatch and strangers', async () => {
    fixture();
    await expect((await caller()).setMyItemParts({ ...base, personId: pid(1) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect((await caller()).setMyItemParts({ ...base, personToken: D_TOKEN })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
  test('requires an already claimed item and refuses out-of-bounds', async () => {
    fixture();
    await expect((await caller()).setMyItemParts({ ...base, itemIndex: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    claimSession(diners, { items: items(1), assignments: [{ itemIndex: 0, personIndices: [1] }] });
    await expect((await caller()).setMyItemParts(base)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
  test.each([0, -1, 1.5, 10001])('rejects malformed portions %s before transaction', async (parts) => {
    fixture();
    await expect((await caller()).setMyItemParts({ ...base, parts })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
  test('rejects finalized and expired sessions', async () => {
    fixture();
    claimSession(diners, { items: items(1), status: 'FINALIZED' });
    await expect((await caller()).setMyItemParts(base)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    claimSession(diners, { items: items(1), expiresAt: new Date(Date.now() - 60000) });
    await expect((await caller()).setMyItemParts(base)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  test('finalization honors saved 3:5 allocation and exact kopecks', async () => {
    claimSession(diners, {
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 101, totalPrice: 101 }],
      receiptData: { subtotal: 101, tax: 0, tip: 0, total: 101, currency: 'RUB' },
      assignments: [{ itemIndex: 0, personIndices: [0, 1], partsByPersonId: { [pid(0)]: 3, [pid(1)]: 5 } }],
    });
    await (await caller(signedIn)).finalizeSession({ token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN });
    const saved = mockDb.guestSplit.update.mock.calls.at(-1)![0] as { data: { summary: { itemTotal: number }[] } };
    expect(saved.data.summary.map((entry) => entry.itemTotal)).toEqual([38, 63]);
  });
});

describe('guest.claimItems with added and removed items (#226)', () => {
  // Cat's own phone saved items 0 and 1 while Ann's page was editing Cat's claims
  function catSavedMeanwhile() {
    claimSession(
      [
        { id: pid(0), name: 'Ann', personToken: ALICE_TOKEN },
        { id: pid(1), name: 'Cat', personToken: OTHER_TOKEN },
      ],
      {
        items: items(3),
        assignments: [
          { itemIndex: 0, personIndices: [1] },
          { itemIndex: 1, personIndices: [1] },
        ],
      },
    );
  }

  const forCat = (edits: { addItemIndices?: number[]; removeItemIndices?: number[] }) => ({
    token: 'share-1',
    personToken: ALICE_TOKEN,
    personId: pid(1),
    ...edits,
  });

  test('adds to the claims stored now, keeping the ones another device saved meanwhile', async () => {
    catSavedMeanwhile();
    await (await caller()).claimItems(forCat({ addItemIndices: [2] }));
    expect(savedAssignments()).toEqual([
      { itemIndex: 0, personIndices: [1] },
      { itemIndex: 1, personIndices: [1] },
      { itemIndex: 2, personIndices: [1] },
    ]);
  });

  test('removes only the items named', async () => {
    catSavedMeanwhile();
    await (await caller()).claimItems(forCat({ removeItemIndices: [0] }));
    expect(savedAssignments()).toEqual([{ itemIndex: 1, personIndices: [1] }]);
  });

  test('adds and removes in one save', async () => {
    catSavedMeanwhile();
    await (await caller()).claimItems(forCat({ addItemIndices: [2], removeItemIndices: [0] }));
    expect(savedAssignments()).toEqual([
      { itemIndex: 1, personIndices: [1] },
      { itemIndex: 2, personIndices: [1] },
    ]);
  });

  test('adding an item the person has, or removing one they lack, changes nothing', async () => {
    catSavedMeanwhile();
    await (await caller()).claimItems(forCat({ addItemIndices: [0], removeItemIndices: [2] }));
    expect(savedAssignments()).toEqual([
      { itemIndex: 0, personIndices: [1] },
      { itemIndex: 1, personIndices: [1] },
    ]);
  });

  test("leaves other people's claims on the same items alone", async () => {
    claimSession(
      [
        { id: pid(0), name: 'Ann', personToken: ALICE_TOKEN },
        { id: pid(1), name: 'Cat', personToken: OTHER_TOKEN },
      ],
      { items: items(2), assignments: [{ itemIndex: 0, personIndices: [0, 1] }] },
    );
    await (await caller()).claimItems(forCat({ addItemIndices: [1], removeItemIndices: [0] }));
    expect(savedAssignments()).toEqual([
      { itemIndex: 0, personIndices: [0] },
      { itemIndex: 1, personIndices: [1] },
    ]);
  });

  test('refuses an item named as both added and removed', async () => {
    catSavedMeanwhile();
    await expect(
      (await caller()).claimItems(forCat({ addItemIndices: [2], removeItemIndices: [2] })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses an item index past the end, added or removed', async () => {
    catSavedMeanwhile();
    const api = await caller();
    await expect(api.claimItems(forCat({ addItemIndices: [3] }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.claimItems(forCat({ removeItemIndices: [3] }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a request that sends the whole claim set and changes too, or neither', async () => {
    catSavedMeanwhile();
    const api = await caller();
    await expect(
      api.claimItems({ ...forCat({ addItemIndices: [2] }), claimedItemIndices: [0, 2] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.claimItems(forCat({}))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('the whole claim set still replaces what is stored (older clients)', async () => {
    catSavedMeanwhile();
    await (await caller()).claimItems({ ...forCat({}), claimedItemIndices: [2] });
    expect(savedAssignments()).toEqual([{ itemIndex: 2, personIndices: [1] }]);
  });
});

describe('guest.claimItems with a save key (#238)', () => {
  const SAVE_KEY = '55555555-5555-4555-8555-555555555555';

  const forCat = (edits: {
    addItemIndices?: number[];
    removeItemIndices?: number[];
    claimedItemIndices?: number[];
  }) => ({
    token: 'share-1',
    personToken: ALICE_TOKEN,
    personId: pid(1),
    saveKey: SAVE_KEY,
    ...edits,
  });

  // Ann's page saves for Cat; `annSaves` is what Ann's person has recorded of her earlier saves
  function session(
    assignments: { itemIndex: number; personIndices: number[] }[],
    annSaves?: { key: string; hash: string }[],
  ) {
    claimSession(
      [
        { id: pid(0), name: 'Ann', personToken: ALICE_TOKEN, ...(annSaves ? { saves: annSaves } : {}) },
        { id: pid(1), name: 'Cat', personToken: OTHER_TOKEN },
      ],
      { items: items(3), assignments },
    );
  }

  // The session as the last save stored it (its people, with the keys recorded), as the next
  // request reads it; `assignments` stands in for what other devices changed since
  function storedSinceLastSave(assignments?: { itemIndex: number; personIndices: number[] }[]) {
    const saved = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as {
      data: { people: TestPerson[]; assignments: { itemIndex: number; personIndices: number[] }[] };
    };
    claimSession(saved.data.people, { items: items(3), assignments: assignments ?? saved.data.assignments });
    mockDb.guestSplit.update.mockClear();
  }

  test("records the key on the caller's person with the save", async () => {
    session([]);
    await (await caller()).claimItems(forCat({ addItemIndices: [2] }));
    expect(savedAssignments()).toEqual([{ itemIndex: 2, personIndices: [1] }]);
    const people = savedPeople() as { saves?: { key: string }[] }[];
    expect(people[0]!.saves?.map((s) => s.key)).toEqual([SAVE_KEY]);
    expect(people[1]!.saves).toBeUndefined();
  });

  test('a retry of a stored save answers saved without applying it again', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [2] }));
    // Ann's page never got the answer; meanwhile Cat's own phone unclaimed the pie
    storedSinceLastSave([]);

    const answer = await api.claimItems(forCat({ addItemIndices: [2] }));
    expect(answer).toEqual({ success: true, conflicts: [] });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('a retry of a whole-claim-set save answers saved without applying it again', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ claimedItemIndices: [2] }));
    storedSinceLastSave([]);
    expect(await api.claimItems(forCat({ claimedItemIndices: [2] }))).toEqual({ success: true, conflicts: [] });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('matches a retry that lists an item twice', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [2] }));
    storedSinceLastSave();
    await api.claimItems(forCat({ addItemIndices: [2, 2] }));
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('matches a retry whatever order it lists the items in', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [0, 2], removeItemIndices: [1] }));
    storedSinceLastSave();
    await api.claimItems(forCat({ addItemIndices: [2, 0], removeItemIndices: [1] }));
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("a replay reports the conflicts on the person's claims as stored now", async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [2] }));
    // Meanwhile Ann claimed the pie for herself too
    storedSinceLastSave([{ itemIndex: 2, personIndices: [1, 0] }]);
    const answer = await api.claimItems(forCat({ addItemIndices: [2] }));
    expect(answer).toEqual({ success: true, conflicts: [{ itemIndex: 2, claimedBy: ['Ann'] }] });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses the same key with different changes, and saves nothing', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [2] }));
    storedSinceLastSave();
    await expect(api.claimItems(forCat({ addItemIndices: [1] }))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(api.claimItems({ ...forCat({ addItemIndices: [2] }), personId: pid(0) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(api.claimItems(forCat({ claimedItemIndices: [2] }))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("another person's save key isn't the caller's: it applies as a new save", async () => {
    session([]);
    await (await caller()).claimItems(forCat({ addItemIndices: [2] }));
    storedSinceLastSave();
    // Cat's phone happens to send the same key
    await (await caller()).claimItems({ ...forCat({ removeItemIndices: [2] }), personToken: OTHER_TOKEN });
    expect(savedAssignments()).toEqual([]);
  });

  test('keeps only the last 10 keys a person saved with', async () => {
    const older = Array.from({ length: 10 }, (_, i) => ({
      key: `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`,
      hash: 'x',
    }));
    session([], older);
    await (await caller()).claimItems(forCat({ addItemIndices: [2] }));
    const people = savedPeople() as { saves?: { key: string }[] }[];
    expect(people[0]!.saves?.map((s) => s.key)).toEqual([...older.slice(1).map((s) => s.key), SAVE_KEY]);
  });

  test('without a save key, records nothing and leaves the people alone', async () => {
    session([]);
    await (
      await caller()
    ).claimItems({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(1), addItemIndices: [2] });
    const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(call.data).not.toHaveProperty('people');
  });

  test('a retry of a stored save answers saved even after the split was finalized', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [2] }));
    const stored = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as {
      data: { people: TestPerson[]; assignments: { itemIndex: number; personIndices: number[] }[] };
    };
    claimSession(stored.data.people, { items: items(3), assignments: stored.data.assignments, status: 'FINALIZED' });
    mockDb.guestSplit.update.mockClear();
    expect(await api.claimItems(forCat({ addItemIndices: [2] }))).toEqual({ success: true, conflicts: [] });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    // A new save is still refused
    await expect(
      api.claimItems({ ...forCat({ addItemIndices: [1] }), saveKey: '88888888-8888-4888-8888-888888888888' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('a retry of a stored save answers saved, with no conflicts, after the person was removed', async () => {
    session([]);
    const api = await caller();
    await api.claimItems(forCat({ addItemIndices: [2] }));
    const stored = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { people: TestPerson[] } };
    // Cat was removed, and her claims with her
    claimSession([stored.data.people[0]!], { items: items(3), assignments: [] });
    mockDb.guestSplit.update.mockClear();
    expect(await api.claimItems(forCat({ addItemIndices: [2] }))).toEqual({ success: true, conflicts: [] });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('records a short digest of the changes, not the changes', async () => {
    session([]);
    await (await caller()).claimItems(forCat({ addItemIndices: [0, 1, 2] }));
    const people = savedPeople() as { saves?: { hash: string }[] }[];
    expect(people[0]!.saves?.[0]?.hash).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  test('ignores save records that are not well formed, and drops them with the next save', async () => {
    const junk = [null, 'x', { key: 1, hash: 'y' }, { key: SAVE_KEY }] as unknown as { key: string; hash: string }[];
    session([], junk);
    await (await caller()).claimItems(forCat({ addItemIndices: [2] }));
    expect(savedAssignments()).toEqual([{ itemIndex: 2, personIndices: [1] }]);
    const people = savedPeople() as { saves?: { key: string }[] }[];
    expect(people[0]!.saves?.map((s) => s.key)).toEqual([SAVE_KEY]);
  });

  test('refuses a save key that is not a UUID', async () => {
    session([]);
    await expect(
      (await caller()).claimItems({ ...forCat({ addItemIndices: [2] }), saveKey: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('claim-session transactions when the database is busy (#203)', () => {
  test('a mutation answers SERVICE_UNAVAILABLE when no pool connection frees up in time', async () => {
    const busy = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), {
      name: 'TransactionManagerError',
      code: 'P2028',
    });
    mockDb.$transaction.mockRejectedValueOnce(busy);
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        personId: pid(1),
        claimedItemIndices: [0],
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'BillOK is busy right now. Please try again in a moment.',
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('guest.claimItems', () => {
  test("saves claims for the person the id names, wherever they are now, leaving others' alone", async () => {
    sessionAfterBWasRemoved();
    await (
      await caller()
    ).claimItems({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2), claimedItemIndices: [0] });
    expect(savedAssignments()).toEqual([
      { itemIndex: 1, personIndices: [2] },
      { itemIndex: 0, personIndices: [1] },
    ]);
  });

  test('refuses an id nobody has any more with CONFLICT, and saves nothing', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        personId: pid(1),
        claimedItemIndices: [0],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a person index, which can name whoever moved into that place, and no id at all (#225)', async () => {
    sessionAfterBWasRemoved();
    const api = await caller();
    // Index inputs are gone from the schema; an older client (or a direct caller) can still send one
    const claimItems = api.claimItems as unknown as (input: Record<string, unknown>) => Promise<unknown>;
    await expect(
      claimItems({ token: 'share-1', personToken: OTHER_TOKEN, personIndex: 1, claimedItemIndices: [0] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      claimItems({ token: 'share-1', personToken: OTHER_TOKEN, claimedItemIndices: [0] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('guest.removePerson', () => {
  test('removes the person the id names, wherever they are now', async () => {
    sessionAfterBWasRemoved();
    await (await caller()).removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(2) });
    expect((savedPeople() as { id: string }[]).map((p) => p.id)).toEqual([pid(0), pid(3)]);
    // D's claim moves down with D
    expect(savedAssignments()).toEqual([{ itemIndex: 1, personIndices: [1] }]);
  });

  test('refuses an id nobody has any more with CONFLICT, and removes nobody', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a target index, and no id at all (#225)', async () => {
    sessionAfterBWasRemoved();
    const removePerson = (await caller()).removePerson as unknown as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    await expect(removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetIndex: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(removePerson({ token: 'share-1', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('Issue 3.6.2: creator renames guests, guest edits only their own row', () => {
  test('creator renames unjoined guest without obtaining a personal token or forcing guest registration', async () => {
    claimSession(
      [
        { name: 'Создатель', personToken: ALICE_TOKEN },
        { name: 'Гость 1', tipCents: 25 },
        { name: 'Гость 2', personToken: OTHER_TOKEN },
      ],
      { items: items(1), paidByIndex: 2, assignments: [{ itemIndex: 0, personIndices: [1] }] },
    );
    const result = await (
      await caller(signedIn)
    ).editPersonName({
      token: 'share-1',
      targetId: pid(1),
      newName: 'Андрей',
    });
    expect(result).toEqual({ success: true });
    const saved = savedPeople() as TestPerson[];
    expect(saved[1]).toMatchObject({ id: pid(1), name: 'Андрей', tipCents: 25 });
    expect(saved[1]?.personToken).toBeUndefined();
    const payload = mockDb.guestSplit.update.mock.calls[0]![0].data;
    expect(payload).not.toHaveProperty('assignments');
    expect(payload).not.toHaveProperty('paidByIndex');
    expect(payload).not.toHaveProperty('summary');
  });

  test('creator can rename same guest repeatedly without changing their ID, token or assigned shares', async () => {
    claimSession(
      [
        { name: 'Создатель', personToken: ALICE_TOKEN },
        { name: 'Андрей', personToken: OTHER_TOKEN, tipCents: 99, groupSize: 2 },
      ],
      { assignments: [{ itemIndex: 0, personIndices: [1] }], items: items(1) },
    );
    const api = await caller(signedIn);
    await api.editPersonName({ token: 'share-1', targetId: pid(1), newName: 'Андрей П.' });
    const saved = savedPeople() as TestPerson[];
    expect(saved[1]).toMatchObject({
      id: pid(1),
      name: 'Андрей П.',
      personToken: OTHER_TOKEN,
      tipCents: 99,
      groupSize: 2,
    });
    claimSession(saved, { assignments: [{ itemIndex: 0, personIndices: [1] }], items: items(1) });
    await api.editPersonName({ token: 'share-1', targetId: pid(1), newName: 'Андрей Петров' });
    expect((savedPeople() as TestPerson[])[1]).toMatchObject({
      id: pid(1),
      name: 'Андрей Петров',
      personToken: OTHER_TOKEN,
      tipCents: 99,
      groupSize: 2,
    });
  });

  test('anonymous guest edits own row but cannot rename another unjoined or already joined guest', async () => {
    claimSession([
      { name: 'Гость 1', personToken: ALICE_TOKEN },
      { name: 'Гость 2' },
      { name: 'Сергей', personToken: OTHER_TOKEN },
    ]);
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        targetId: pid(1),
        newName: 'Чужое',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        targetId: pid(2),
        newName: 'Чужое',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      (await caller()).editPersonName({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        targetId: pid(0),
        newName: 'Алексей',
      }),
    ).resolves.toMatchObject({ success: true });
    expect((savedPeople() as TestPerson[])[0]?.name).toBe('Алексей');
  });

  test('payer/another signed-in participant is not creator and cannot edit another guest', async () => {
    claimSession(
      [
        { name: 'Создатель', personToken: ALICE_TOKEN },
        { name: 'Плательщик', personToken: OTHER_TOKEN },
        { name: 'Гость 1' },
      ],
      { paidByIndex: 1 },
    );
    await expect(
      (await caller({ user: { id: 'other-user' } })).editPersonName({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        targetId: pid(2),
        newName: 'Захват',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      (await caller({ user: { id: 'other-user' } })).editPersonName({
        token: 'share-1',
        targetId: pid(2),
        newName: 'Захват',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('guest cannot rename a different receipt and creator cannot impersonate another account', async () => {
    claimSession([{ name: 'Создатель' }, { name: 'Гость' }], { userId: 'another-creator' });
    await expect(
      (await caller(signedIn)).editPersonName({
        token: 'share-1',
        targetId: pid(1),
        newName: 'Чужое',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    claimSession([{ name: 'Создатель' }, { name: 'Гость' }], { userId: 'user-1' });
    const impersonated = await caller(signedIn);
    // Explicitly test middleware context with an active impersonation flag.
    const { guestRouter } = await import('./guest');
    const api = guestRouter.createCaller({
      session: signedIn,
      db: mockDb,
      headers: new Headers(),
      impersonating: { adminId: 'real-admin' },
    } as unknown as Parameters<typeof guestRouter.createCaller>[0]);
    void impersonated;
    await expect(
      api.editPersonName({
        token: 'share-1',
        targetId: pid(1),
        newName: 'Чужое',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('creator cannot silently duplicate a name, use the owner reserved name or alter owner row', async () => {
    claimSession([
      { name: 'Илья', accountUserId: 'billok-owner', reservedOwner: true, personToken: ALICE_TOKEN },
      { name: 'Сергей', personToken: OTHER_TOKEN },
      { name: 'Гость 1' },
    ]);
    await expect(
      (await caller(signedIn)).editPersonName({
        token: 'share-1',
        targetId: pid(2),
        newName: ' иЛьЯ ',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
    await expect(
      (await caller(signedIn)).editPersonName({
        token: 'share-1',
        targetId: pid(2),
        newName: ' СЕРГЕЙ ',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'nameTaken' });
    await expect(
      (await caller(signedIn)).editPersonName({
        token: 'share-1',
        targetId: pid(0),
        newName: 'Гость 3',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('creator cannot change names once the receipt has been finalized', async () => {
    claimSession([{ name: 'Создатель' }, { name: 'Гость 1' }], { status: 'FINALIZED' });
    await expect(
      (await caller(signedIn)).editPersonName({
        token: 'share-1',
        targetId: pid(1),
        newName: 'Андрей',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('creator without personal token has a bounded per-account/session edit budget', async () => {
    claimSession([{ name: 'Создатель' }, { name: 'Гость 1' }]);
    await (
      await caller(signedIn)
    ).editPersonName({
      token: 'share-1',
      targetId: pid(1),
      newName: 'Андрей',
    });
    expect(checkRateLimit).toHaveBeenCalledWith(
      'guest-edit-name-person:' + JSON.stringify(['share-1', 'creator:user-1']),
      30,
      60_000,
    );
  });
});

describe('guest.editPersonName', () => {
  test('renames the person the id names, wherever they are now', async () => {
    sessionAfterBWasRemoved();
    // 3.6.2: only the authenticated receipt creator may rename C from A's device.
    await (
      await caller(signedIn)
    ).editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(2), newName: 'Cee' });
    expect((savedPeople() as { name: string }[]).map((p) => p.name)).toEqual(['A', 'Cee', 'D']);
  });

  test('refuses an id nobody has any more with CONFLICT, and renames nobody', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1), newName: 'X' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

// The issue's three-person case: A, B, C joined and B was removed, so C is second and the old
// index 2 is past the end
function sessionAfterBWasRemovedFromThree() {
  claimSession(
    [
      { id: pid(0), name: 'A', personToken: ALICE_TOKEN },
      { id: pid(2), name: 'C', personToken: OTHER_TOKEN },
    ],
    { items: items(2) },
  );
}

describe('guest.claimItems with three people', () => {
  test('an id still finds the person whose old index is now past the end', async () => {
    sessionAfterBWasRemovedFromThree();
    await (
      await caller()
    ).claimItems({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2), claimedItemIndices: [0] });
    expect(savedAssignments()).toEqual([{ itemIndex: 0, personIndices: [1] }]);
  });
});

describe('guest.editPersonName by index (#225)', () => {
  test('refuses a target index, and no id at all', async () => {
    sessionAfterBWasRemoved();
    const editPersonName = (await caller()).editPersonName as unknown as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const base = { token: 'share-1', personToken: ALICE_TOKEN, newName: 'X' };
    await expect(editPersonName({ ...base, targetIndex: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(editPersonName(base)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('Issue 3.4: only registered finalization organizers can close a guest receipt', () => {
  const request = { token: 'share-1', personId: pid(1), personToken: OTHER_TOKEN };
  const people = [
    { name: 'Creator', personToken: ALICE_TOKEN },
    { name: 'Payer', personToken: OTHER_TOKEN },
  ];
  function prepared(data?: Record<string, unknown>) {
    claimSession(people, {
      userId: 'user-1',
      paidByIndex: 1,
      items: [{ name: 'Dinner', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      receiptData: {
        subtotal: 1001,
        total: 1001,
        tax: 0,
        tip: 0,
        currency: 'RUB',
        ...(data ?? {}),
      },
    });
  }

  test('an anonymous guest cannot finalize, even with the payer personal token and complete claims', async () => {
    prepared();
    await expect((await caller()).finalizeSession(request)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('a signed-in payer and ordinary registered participant cannot finalize without delegation', async () => {
    prepared();
    for (const userId of ['registered-payer', 'registered-diner']) {
      await expect((await caller({ user: { id: userId } })).finalizeSession(request)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('the authenticated creator finalizes without having to be the payer', async () => {
    prepared();
    await (await caller(signedIn)).finalizeSession(request);
    const saved = mockDb.guestSplit.update.mock.calls.at(-1)![0].data;
    expect(saved.status).toBe('FINALIZED');
    expect(saved.summary.reduce((sum: number, entry: { total: number }) => sum + entry.total, 0)).toBe(1001);
  });

  test('only the creator can appoint a real active verified co-organizer', async () => {
    prepared();
    const original = await mockDb.guestSplit.findUnique();
    for (const session of [null, { user: { id: 'registered-payer' } }]) {
      await expect(
        (await caller(session)).setFinalizationOrganizer({
          token: 'share-1',
          email: 'helper@example.com',
        }),
      ).rejects.toMatchObject({ code: session ? 'FORBIDDEN' : 'UNAUTHORIZED' });
    }
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
      where.email
        ? {
            id: 'registered-helper',
            suspendedAt: null,
            isPlaceholder: false,
            registrationEmailVerificationRequired: true,
            emailVerified: new Date(),
          }
        : { suspendedAt: null },
    );
    await (
      await caller(signedIn)
    ).setFinalizationOrganizer({
      token: 'share-1',
      email: 'HELPER@example.com',
    });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'helper@example.com' },
      select: {
        id: true,
        suspendedAt: true,
        isPlaceholder: true,
        emailVerified: true,
        registrationEmailVerificationRequired: true,
      },
    });
    const delegated = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(delegated.finalizationOrganizerUserId).toBe('registered-helper');
    expect(delegated.partsApprovalHash).toBeUndefined();
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...original, receiptData: delegated });
    const readAsGuest = await (await caller()).getSession({ token: 'share-1' });
    expect(readAsGuest.canFinalize).toBe(false);
    expect(readAsGuest.hasFinalizationOrganizer).toBe(true);
    expect(JSON.stringify(readAsGuest)).not.toContain('registered-helper');
    const readAsDelegate = await (
      await caller({ user: { id: 'registered-helper' } })
    ).getSession({
      token: 'share-1',
    });
    expect(readAsDelegate.canFinalize).toBe(true);
    expect(readAsDelegate.isCreator).toBe(false);
  });

  test('delegated registered organizer can approve and finalize; revocation removes both rights', async () => {
    prepared({
      organizerPersonId: pid(0),
      roundingBalanced: true,
      finalizationOrganizerUserId: 'registered-helper',
    });
    const original = await mockDb.guestSplit.findUnique();
    const helper = await caller({ user: { id: 'registered-helper' } });
    await helper.confirmSessionParts({ token: 'share-1' });
    const approval = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(approval.partsApprovalHash).toMatch(/^[0-9a-f]{64}$/);
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...original, receiptData: approval });
    // Co-organizer is a registered account, not necessarily a food claimant.
    await helper.finalizeSession({ token: 'share-1' });
    expect(mockDb.guestSplit.update.mock.calls.at(-1)![0].data.status).toBe('FINALIZED');

    // Rewind only the disposable mock to test revocation before finalizing.
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...original, receiptData: approval });
    await (await caller(signedIn)).setFinalizationOrganizer({ token: 'share-1', email: null });
    const revoked = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(revoked.finalizationOrganizerUserId).toBeUndefined();
    expect(revoked.partsApprovalHash).toBeUndefined();
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...original, receiptData: revoked });
    await expect(helper.confirmSessionParts({ token: 'share-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(helper.finalizeSession(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test.each([
    { label: 'missing account', account: null },
    { label: 'suspended account', account: { id: 'x', suspendedAt: new Date(), isPlaceholder: false } },
    { label: 'placeholder', account: { id: 'x', suspendedAt: null, isPlaceholder: true } },
    {
      label: 'unverified registration',
      account: {
        id: 'x',
        suspendedAt: null,
        isPlaceholder: false,
        registrationEmailVerificationRequired: true,
        emailVerified: null,
      },
    },
  ])('cannot delegate to $label', async ({ account }) => {
    prepared();
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { email?: string } }) =>
      where.email ? account : { suspendedAt: null },
    );
    await expect(
      (await caller(signedIn)).setFinalizationOrganizer({
        token: 'share-1',
        email: 'helper@example.com',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('a valid registered user cannot finalize with someone else person token', async () => {
    prepared({ finalizationOrganizerUserId: 'registered-helper' });
    const helper = await caller({ user: { id: 'registered-helper' } });
    await expect(
      helper.finalizeSession({
        token: 'share-1',
        personId: pid(0),
        personToken: OTHER_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('guest.finalizeSession', () => {
  function savedStatus() {
    const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { status?: string } } | undefined;
    return call?.data.status;
  }

  // As sessionAfterBWasRemoved, with every item claimed
  function everyItemClaimed() {
    claimSession(
      [
        { id: pid(0), name: 'A', personToken: ALICE_TOKEN },
        { id: pid(2), name: 'C', personToken: OTHER_TOKEN },
        { id: pid(3), name: 'D', personToken: D_TOKEN },
      ],
      {
        items: items(3),
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [2] },
          { itemIndex: 2, personIndices: [1, 2] },
        ],
      },
    );
  }

  test('finalizes as the person the id names, wherever they are now', async () => {
    everyItemClaimed();
    await (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2) });
    expect(savedStatus()).toBe('FINALIZED');
  });

  test('2.16 finalization balances two guest dishes and does not change the paid bill', async () => {
    claimSession(
      [
        { name: 'Анна', personToken: ALICE_TOKEN },
        { name: 'Борис', personToken: OTHER_TOKEN },
      ],
      {
        items: [
          { name: 'Пицца', quantity: 1, unitPrice: 101, totalPrice: 101 },
          { name: 'Салат', quantity: 1, unitPrice: 101, totalPrice: 101 },
        ],
        receiptData: { subtotal: 202, total: 202, tax: 0, tip: 0, currency: 'RUB', roundingBalanced: true },
        assignments: [
          { itemIndex: 0, personIndices: [0, 1], partsByPersonId: { [pid(0)]: 1, [pid(1)]: 2 } },
          { itemIndex: 1, personIndices: [0, 1], partsByPersonId: { [pid(0)]: 1, [pid(1)]: 2 } },
        ],
      },
    );
    await (await caller(signedIn)).finalizeSession({ token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN });
    const saved = mockDb.guestSplit.update.mock.calls.at(-1)![0] as {
      data: { summary: { personIndex: number; itemTotal: number; total: number }[] };
    };
    expect(saved.data.summary.map((person) => person.itemTotal)).toEqual([67, 135]);
    expect(saved.data.summary.reduce((sum, person) => sum + person.total, 0)).toBe(202);
  });

  test('2.17.2.2 finalizes an indivisible guest kopeck to creator, not payer, with no phantom item', async () => {
    claimSession(
      [
        { name: 'Аня', personToken: ALICE_TOKEN },
        { name: 'Борис', personToken: OTHER_TOKEN },
        { name: 'Виктор', personToken: D_TOKEN },
        { name: 'Плательщик' },
        { name: 'Организатор' },
      ],
      {
        items: [
          { name: 'Блюдо', quantity: 1, unitPrice: 1, totalPrice: 1 },
          { name: 'Напиток', quantity: 1, unitPrice: 1, totalPrice: 1 },
        ],
        receiptData: {
          subtotal: 2,
          total: 2,
          tax: 0,
          tip: 0,
          currency: 'RUB',
          roundingBalanced: true,
          organizerPersonId: pid(4),
        },
        paidByIndex: 3,
        userId: 'user-1',
        assignments: [
          { itemIndex: 0, personIndices: [0, 1, 2] },
          { itemIndex: 1, personIndices: [3] },
        ],
      },
    );
    const before = await mockDb.guestSplit.findUnique();
    await expect(
      (await caller(signedIn)).finalizeSession({
        token: 'share-1',
        personId: pid(0),
        personToken: ALICE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      (await caller({ user: { id: 'payer-not-creator' } })).confirmSessionParts({
        token: 'share-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await (await caller(signedIn)).confirmSessionParts({ token: 'share-1' });
    const approval = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...before, receiptData: approval });
    await (await caller(signedIn)).finalizeSession({ token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN });
    const saved = mockDb.guestSplit.update.mock.calls.at(-1)![0] as {
      data: { summary: { personIndex: number; itemTotal: number; roundingCorrectionCents?: number; total: number }[] };
    };
    expect(saved.data.summary.map((person) => person.itemTotal)).toEqual([0, 0, 0, 1, 1]);
    expect(saved.data.summary[4]).toMatchObject({ personIndex: 4, roundingCorrectionCents: 1, total: 1 });
    expect(saved.data.summary.reduce((sum, person) => sum + person.total, 0)).toBe(2);
  });

  test('2.19.2.2 approval is creator-only and a changed portion invalidates it in the same transaction', async () => {
    claimSession(
      [
        { name: 'Creator', personToken: ALICE_TOKEN },
        { name: 'Guest', personToken: OTHER_TOKEN },
      ],
      {
        userId: 'user-1',
        items: [{ name: 'Пицца', quantity: 1, unitPrice: 800, totalPrice: 800 }],
        receiptData: {
          subtotal: 800,
          total: 800,
          tax: 0,
          tip: 0,
          currency: 'RUB',
          roundingBalanced: true,
          organizerPersonId: pid(0),
        },
        assignments: [{ itemIndex: 0, personIndices: [0, 1], partsByPersonId: { [pid(0)]: 3, [pid(1)]: 5 } }],
      },
    );
    const previous = await mockDb.guestSplit.findUnique();
    const api = await caller(signedIn);
    await expect((await caller()).confirmSessionParts({ token: 'share-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      (await caller({ user: { id: 'stranger' } })).confirmSessionParts({ token: 'share-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api.confirmSessionParts({ token: 'share-1' });
    const approval = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    expect(approval.partsApprovalHash).toMatch(/^[a-f0-9]{64}$/);
    mockDb.guestSplit.findUnique.mockResolvedValue({ ...previous, receiptData: approval });
    expect((await (await caller()).getSession({ token: 'share-1' })).partsConfirmed).toBe(true);

    await (
      await caller()
    ).setMyItemParts({
      token: 'share-1',
      personId: pid(1),
      personToken: OTHER_TOKEN,
      itemIndex: 0,
      parts: 6,
    });
    const mutated = mockDb.guestSplit.update.mock.calls.at(-1)![0].data;
    expect(mutated.receiptData.partsApprovalHash).toBeUndefined();
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...previous,
      receiptData: mutated.receiptData,
      assignments: mutated.assignments,
    });
    expect((await (await caller()).getSession({ token: 'share-1' })).partsConfirmed).toBe(false);
    await expect(
      (await caller(signedIn)).finalizeSession({
        token: 'share-1',
        personId: pid(0),
        personToken: ALICE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await api.confirmSessionParts({ token: 'share-1' });
    const approvedAgain = mockDb.guestSplit.update.mock.calls.at(-1)![0].data.receiptData;
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...previous,
      assignments: mutated.assignments,
      receiptData: approvedAgain,
    });
    await (
      await caller(signedIn)
    ).finalizeSession({
      token: 'share-1',
      personId: pid(0),
      personToken: ALICE_TOKEN,
    });
    expect(mockDb.guestSplit.update.mock.calls.at(-1)![0].data.status).toBe('FINALIZED');
  });

  test('2.19.2.2 refuses to approve a receipt with unclaimed items', async () => {
    claimSession([{ name: 'Creator', personToken: ALICE_TOKEN }], {
      userId: 'user-1',
      items: [{ name: 'Soup', quantity: 1, unitPrice: 100, totalPrice: 100 }],
      receiptData: {
        subtotal: 100,
        tax: 0,
        tip: 0,
        total: 100,
        currency: 'RUB',
        organizerPersonId: pid(0),
        roundingBalanced: true,
      },
      assignments: [],
    });
    await expect((await caller(signedIn)).confirmSessionParts({ token: 'share-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('uses only current personal tips when finalizing guest shares in the same transaction', async () => {
    claimSession(
      [
        { id: pid(0), name: 'Анна', personToken: ALICE_TOKEN, tipCents: 125 },
        { id: pid(1), name: 'Борис', personToken: OTHER_TOKEN, tipCents: 0 },
        { id: pid(2), name: 'Виктор', personToken: D_TOKEN, tipCents: 35 },
      ],
      {
        items: [{ name: 'Чай', quantity: 1, unitPrice: 101, totalPrice: 101 }],
        assignments: [{ itemIndex: 0, personIndices: [0, 1, 2] }],
      },
    );
    await (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(0) });
    expect(mockDb.guestSplit.update).toHaveBeenCalledWith({
      where: { id: 'gs1' },
      data: expect.objectContaining({
        status: 'FINALIZED',
        summary: [
          { personIndex: 0, name: 'Анна', itemTotal: 34, tax: 0, tip: 125, total: 159 },
          { personIndex: 1, name: 'Борис', itemTotal: 34, tax: 0, tip: 0, total: 34 },
          { personIndex: 2, name: 'Виктор', itemTotal: 33, tax: 0, tip: 35, total: 68 },
        ],
      }),
    });
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });

  test('refuses a tip-only guest and does not finalize the split', async () => {
    claimSession(
      [
        { name: 'Анна', personToken: ALICE_TOKEN, tipCents: 125 },
        { name: 'Борис', personToken: OTHER_TOKEN, tipCents: 35 },
      ],
      {
        items: [{ name: 'Чай', quantity: 1, unitPrice: 101, totalPrice: 101 }],
        assignments: [{ itemIndex: 0, personIndices: [0] }],
      },
    );
    await expect(
      (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(0) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('finalization refuses malformed or overflowing tips without storing FINALIZED', async () => {
    const fixture = [
      { name: 'Анна', personToken: ALICE_TOKEN, tipCents: 2_147_483_647 },
      { name: 'Борис', personToken: OTHER_TOKEN },
    ];
    claimSession(fixture, {
      items: [{ name: 'Чай', quantity: 1, unitPrice: 101, totalPrice: 101 }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
    });
    await expect(
      (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(0) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('a tip update after finalization is refused to prevent changing locked settlement amounts', async () => {
    claimSession([{ name: 'Анна', personToken: ALICE_TOKEN, tipCents: 125 }], {
      status: 'FINALIZED',
    });
    await expect(
      (await caller()).setPersonalTip({ token: 'share-1', personId: pid(0), personToken: ALICE_TOKEN, tipCents: 0 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses while an item has nobody, and finalizes nothing (#237)', async () => {
    // Items 0 and 2 are unclaimed
    sessionAfterBWasRemoved();
    await expect(
      (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2) }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Every item needs someone before the split can be finalized.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('counts an item whose claimants were all removed as unclaimed', async () => {
    claimSession([{ id: pid(0), name: 'A', personToken: ALICE_TOKEN }], {
      items: items(1),
      assignments: [{ itemIndex: 0, personIndices: [] }],
    });
    await expect(
      (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(0) }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('checks the caller before the claims: a bad id or token is still CONFLICT or FORBIDDEN', async () => {
    sessionAfterBWasRemoved();
    const api = await caller(signedIn);
    await expect(
      api.finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(1) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(3) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('refuses an id nobody has any more with CONFLICT', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(1) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("refuses someone else's id with the caller's token", async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller(signedIn)).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(3) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a person index, and no id at all (#225)', async () => {
    sessionAfterBWasRemoved();
    const finalizeSession = (await caller(signedIn)).finalizeSession as unknown as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    await expect(finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personIndex: 1 })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
    await expect(finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

// #265: deleting a Quick Split left its scanned receipt behind, with its items and image file
describe('deleting a split', () => {
  beforeEach(() => {
    mockDb.guestSplit.findUnique.mockResolvedValue({ userId: 'user-1', receiptId: 'r1' });
    mockDb.receipt.findMany.mockResolvedValue([{ id: 'r1', imagePath: 'receipts/r1.jpg' }]);
    mockDb.guestSplit.findMany.mockResolvedValue([]);
    mockDb.$queryRaw.mockResolvedValue([]);
  });

  test("deletes its receipt, and the image file once that's committed", async () => {
    const api = await caller(signedIn);
    await expect(api.deleteSplit({ id: 's1' })).resolves.toEqual({ success: true });

    expect(mockDb.guestSplit.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    // A group's receipt stays with the group, and so does one an expense was made from
    expect(mockDb.receipt.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, groupId: null, expense: { is: null } },
      select: { id: true, imagePath: true },
    });
    expect(mockDb.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(removeReceiptFiles).toHaveBeenCalledWith(['receipts/r1.jpg']);
    expect(removeReceiptFiles.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockDb.receipt.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  test('keeps a receipt another split still shows', async () => {
    mockDb.guestSplit.findMany.mockResolvedValue([{ receiptId: 'r1' }]);
    const api = await caller(signedIn);
    await api.deleteSplit({ id: 's1' });

    expect(mockDb.guestSplit.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
    expect(removeReceiptFiles).toHaveBeenCalledWith([]);
  });

  // Two splits made from one receipt, deleted at the same moment, would each still
  // see the other and both keep it
  test('locks the receipt before checking who else uses it', async () => {
    const api = await caller(signedIn);
    await api.deleteSplit({ id: 's1' });

    const lockCall = mockDb.$queryRaw.mock.calls.findIndex(([strings]) =>
      /FROM "Receipt" WHERE "id" IN .* FOR UPDATE/.test((strings as string[]).join('?')),
    );
    expect(lockCall).toBeGreaterThanOrEqual(0);
    const locked = mockDb.$queryRaw.mock.invocationCallOrder[lockCall]!;
    expect(locked).toBeGreaterThan(mockDb.guestSplit.delete.mock.invocationCallOrder[0]!);
    expect(mockDb.receipt.findMany.mock.invocationCallOrder[0]!).toBeGreaterThan(locked);
    expect(mockDb.guestSplit.findMany.mock.invocationCallOrder[0]!).toBeGreaterThan(locked);
  });

  test('a split without a receipt deletes just the split', async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue({ userId: 'user-1', receiptId: null });
    const api = await caller(signedIn);
    await api.deleteSplit({ id: 's1' });

    expect(mockDb.guestSplit.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(mockDb.receipt.findMany).not.toHaveBeenCalled();
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
  });

  test("someone else's split is refused, and nothing is deleted", async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue({ userId: 'user-2', receiptId: 'r1' });
    const api = await caller(signedIn);
    await expect(api.deleteSplit({ id: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.guestSplit.delete).not.toHaveBeenCalled();
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
    expect(removeReceiptFiles).not.toHaveBeenCalled();
  });
});

// #265: each new split clears expired ones (in the background), now with the receipts
// only they used
describe('creating a split', () => {
  test('clears a batch of expired splits with their receipts', async () => {
    mockDb.guestSplit.create.mockResolvedValue({ id: 's1', shareToken: 'tok' });
    const api = await caller(signedIn);
    await api.createSplit({
      receiptData: { subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'RUB' },
      items: [{ name: 'Pizza', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      people: [{ name: 'Pat' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
    });
    expect(deleteExpiredSplits).toHaveBeenCalledWith(mockDb, 100);
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
  });
});

// #265: a split made from a receipt while the receipt's last split or its group was being
// deleted could be saved pointing at the receipt deleted a moment later
describe('making a split from a receipt', () => {
  const receiptData = { subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'RUB' };
  const items = [{ name: 'Pizza', quantity: 1, unitPrice: 1000, totalPrice: 1000 }];
  type Api = Awaited<ReturnType<typeof caller>>;
  const makeSplit = {
    createSplit: (api: Api) =>
      api.createSplit({
        receiptId: 'r1',
        receiptData,
        items,
        people: [{ name: 'Pat' }],
        assignments: [{ itemIndex: 0, personIndices: [0] }],
      }),
    createClaimSession: (api: Api) =>
      api.createClaimSession({ receiptId: 'r1', receiptData, items, creatorName: 'Pat', paidByName: 'Pat' }),
  };

  const guestUpload = { isGuest: true, uploadedById: null, groupId: null };
  const groupReceipt = { isGuest: false, uploadedById: 'owner', groupId: 'g1' };

  beforeEach(() => {
    mockDb.guestSplit.create.mockResolvedValue({ id: 's1', shareToken: 'tok' });
    mockDb.groupMember.findUnique.mockResolvedValue(null);
  });

  // Codex on #319: a split's receipt is shown to anyone with its link, so making one from a
  // group's receipt would publish a photo only the group could see
  test.each(Object.keys(makeSplit) as (keyof typeof makeSplit)[])(
    "%s refuses a group's receipt to someone outside the group",
    async (name) => {
      mockDb.$queryRaw.mockResolvedValue([groupReceipt]);
      await expect(makeSplit[name](await caller())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(makeSplit[name](await caller(signedIn))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockDb.groupMember.findUnique).toHaveBeenCalledWith({
        where: { userId_groupId: { userId: 'user-1', groupId: 'g1' } },
      });
      expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
    },
  );

  test.each(Object.keys(makeSplit) as (keyof typeof makeSplit)[])(
    "%s takes a group's receipt from a member of its group, and one outside a group from its uploader",
    async (name) => {
      mockDb.$queryRaw.mockResolvedValue([groupReceipt]);
      mockDb.groupMember.findUnique.mockResolvedValue({ userId: 'user-1', groupId: 'g1' });
      await makeSplit[name](await caller(signedIn));
      mockDb.$queryRaw.mockResolvedValue([{ ...groupReceipt, groupId: null }]);
      mockDb.groupMember.findUnique.mockResolvedValue(null);
      await makeSplit[name](await caller({ user: { id: 'owner' } }));

      expect(mockDb.guestSplit.create).toHaveBeenCalledTimes(2);
      for (const [arg] of mockDb.guestSplit.create.mock.calls) {
        expect(arg.data).toMatchObject({ receiptId: 'r1', receiptShared: true });
      }
    },
  );

  // Codex on #319: the same access the group's pages give (verifyReceiptAccess), so its
  // uploader who has left the group can't share it either
  test.each(Object.keys(makeSplit) as (keyof typeof makeSplit)[])(
    "%s refuses a group's receipt to its uploader once they're not in the group",
    async (name) => {
      mockDb.$queryRaw.mockResolvedValue([groupReceipt]);
      await expect(makeSplit[name](await caller({ user: { id: 'owner' } }))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
    },
  );

  // The active account is checked before existing receipt authorization.
  test.each(Object.keys(makeSplit) as (keyof typeof makeSplit)[])(
    "%s refuses a group's receipt to a member whose account is suspended or was deleted",
    async (name) => {
      mockDb.$queryRaw.mockResolvedValue([groupReceipt]);
      mockDb.groupMember.findUnique.mockResolvedValue({ userId: 'user-1', groupId: 'g1' });
      for (const [account, code] of [
        [{ suspendedAt: new Date() }, 'FORBIDDEN'],
        [{ suspendedAt: null, isPlaceholder: true }, 'NOT_FOUND'],
        [null, 'UNAUTHORIZED'],
      ] as const) {
        mockDb.user.findUnique.mockResolvedValue(account);
        await expect(makeSplit[name](await caller(signedIn))).rejects.toMatchObject({ code });
      }
      expect(mockDb.guestSplit.create).not.toHaveBeenCalled();
    },
  );

  test.each(Object.keys(makeSplit) as (keyof typeof makeSplit)[])(
    '%s locks the receipt before saving the split',
    async (name) => {
      mockDb.$queryRaw.mockResolvedValue([guestUpload]);
      await makeSplit[name](await caller(signedIn));

      const lockCall = mockDb.$queryRaw.mock.calls.findIndex(([strings]) =>
        /FROM "Receipt" WHERE "id" = .* FOR KEY SHARE/.test((strings as string[]).join('?')),
      );
      expect(lockCall).toBeGreaterThanOrEqual(0);
      expect(mockDb.$transaction).toHaveBeenCalled();
      expect(mockDb.guestSplit.create.mock.invocationCallOrder[0]!).toBeGreaterThan(
        mockDb.$queryRaw.mock.invocationCallOrder[lockCall]!,
      );
      expect(mockDb.guestSplit.create.mock.calls[0]![0].data).toMatchObject({ receiptId: 'r1', receiptShared: true });
    },
  );

  test.each(Object.keys(makeSplit) as (keyof typeof makeSplit)[])(
    '%s from a receipt deleted meanwhile is saved without it',
    async (name) => {
      mockDb.$queryRaw.mockResolvedValue([]);
      await makeSplit[name](await caller(signedIn));

      expect(mockDb.guestSplit.create).toHaveBeenCalledTimes(1);
      expect(mockDb.guestSplit.create.mock.calls[0]![0].data).not.toHaveProperty('receiptId');
      expect(mockDb.guestSplit.create.mock.calls[0]![0].data).not.toHaveProperty('receiptShared');
    },
  );
});

describe('BillOK guest payer-only SBP contact (Issue #1 1.3.19)', () => {
  const payerId = '11111111-1111-4111-8111-111111111111';
  const payerToken = '22222222-2222-4222-8222-222222222222';
  const otherId = '33333333-3333-4333-8333-333333333333';
  const otherToken = '44444444-4444-4444-8444-444444444444';
  const base = {
    id: 'session-id',
    shareToken: 'private-bill-token',
    expiresAt: new Date(Date.now() + 86400000),
    paidByIndex: 1,
    status: 'FINALIZED',
    userId: 'user-1',
    payerSbpPhone: null,
    payerSbpBankId: null,
    people: [
      { id: otherId, name: 'Организатор', personToken: otherToken },
      { id: payerId, name: 'Плательщик-гость', personToken: payerToken },
    ],
  };
  const payerAuth = { token: base.shareToken, personId: payerId, personToken: payerToken };
  const otherAuth = { token: base.shareToken, personId: otherId, personToken: otherToken };

  beforeEach(() => {
    mockDb.guestSplit.findUnique.mockResolvedValue(structuredClone(base));
    mockDb.guestSplit.update.mockResolvedValue({ id: base.id });
  });

  test('guest payer can save an unverified phone and active bank without a user account', async () => {
    const api = await caller();
    await expect(
      api.setMyPayerSbpContact({ ...payerAuth, phone: '8 (999) 123-45-67', bankId: '100000000273' }),
    ).resolves.toEqual({ success: true });
    expect(mockDb.guestSplit.update).toHaveBeenCalledWith({
      where: { id: base.id },
      data: { payerSbpPhone: '+79991234567', payerSbpBankId: '100000000273' },
    });
  });

  test('non-payer, creator and wrong personal token cannot read or overwrite payer contact', async () => {
    const api = await caller(signedIn);
    for (const credentials of [
      otherAuth,
      { ...payerAuth, personToken: otherToken },
      { ...payerAuth, personId: otherId },
    ]) {
      await expect(api.getMyPayerSbpContact(credentials)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.setMyPayerSbpContact({ ...credentials, phone: '+79991234567', bankId: 'tbank' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('payer can read only their own stored contact and clear it', async () => {
    const api = await caller();
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      payerSbpPhone: '+79991234567',
      payerSbpBankId: 'akbars',
    });
    await expect(api.getMyPayerSbpContact(payerAuth)).resolves.toEqual({
      phone: '+79991234567',
      bankId: 'akbars',
    });
    await expect(api.setMyPayerSbpContact({ ...payerAuth, phone: null, bankId: null })).resolves.toEqual({
      success: true,
    });
    expect(mockDb.guestSplit.update).toHaveBeenCalledWith({
      where: { id: base.id },
      data: { payerSbpPhone: null, payerSbpBankId: null },
    });
  });

  test('rejects invalid phone, unknown bank, or incomplete destination before writing', async () => {
    const api = await caller();
    for (const data of [
      { phone: '+15551234567', bankId: 'tbank' },
      { phone: '+79991234567', bankId: 'not-a-bank' },
      { phone: '+79991234567', bankId: null },
      { phone: null, bankId: 'tbank' },
    ]) {
      await expect(api.setMyPayerSbpContact({ ...payerAuth, ...data })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('expired session cannot read or save sensitive destination', async () => {
    const api = await caller();
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      expiresAt: new Date(Date.now() - 86400000),
    });
    await expect(api.getMyPayerSbpContact(payerAuth)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.setMyPayerSbpContact({ ...payerAuth, phone: '+79991234567', bankId: 'tbank' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  describe('reimbursement-only contact sharing', () => {
    const receipt = { subtotal: 1001, total: 1001, tax: 0, tip: 0, currency: 'RUB' };
    const shares = [
      { personIndex: 0, total: 459, tip: 125 },
      { personIndex: 1, total: 742, tip: 75 },
    ];
    beforeEach(() => {
      mockDb.guestSplit.findUnique.mockResolvedValue({
        ...base,
        receiptData: receipt,
        summary: shares,
        payerSbpPhone: '+79991234567',
        payerSbpBankId: '100000000273',
      });
    });

    test('an actual nonpayer who owes money can read the bank/phone without signing in', async () => {
      const api = await caller();
      await expect(api.getPayerSbpForReimbursement(otherAuth)).resolves.toEqual({
        phone: '+79991234567',
        bankId: '100000000273',
      });
    });

    test('creator account alone, unrelated token, swapped ID or payer token do not expose the contact', async () => {
      const api = await caller(signedIn);
      for (const credentials of [
        payerAuth,
        { ...otherAuth, personToken: payerToken },
        { ...otherAuth, personId: payerId },
        { ...otherAuth, token: 'other-receipt' },
      ]) {
        if (credentials.token !== base.shareToken) mockDb.guestSplit.findUnique.mockResolvedValueOnce(null);
        await expect(api.getPayerSbpForReimbursement(credentials)).rejects.toMatchObject({
          code: credentials.token !== base.shareToken ? 'NOT_FOUND' : 'FORBIDDEN',
        });
      }
    });

    test('an unpaid, incomplete, expired or not finalized receipt does not expose a contact', async () => {
      const api = await caller();
      const original = {
        ...base,
        receiptData: receipt,
        summary: shares,
        payerSbpPhone: '+79991234567',
        payerSbpBankId: '100000000273',
      };
      for (const override of [
        {
          summary: [
            { personIndex: 0, total: 0, tip: 0 },
            { personIndex: 1, total: 1001, tip: 0 },
          ],
        },
        { summary: null },
        { status: 'CLAIMING' },
        { expiresAt: new Date(Date.now() - 86400000) },
        { receiptData: { ...receipt, total: 1002 } },
      ]) {
        mockDb.guestSplit.findUnique.mockResolvedValueOnce({ ...original, ...override });
        await expect(api.getPayerSbpForReimbursement(otherAuth)).rejects.toMatchObject({
          code: 'code' in override ? override.code : expect.stringMatching(/FORBIDDEN|BAD_REQUEST|NOT_FOUND/),
        });
      }
    });

    test('without payer consent the response contains no destination; public data remains private', async () => {
      const api = await caller();
      mockDb.guestSplit.findUnique.mockResolvedValue({
        ...base,
        receiptData: receipt,
        summary: shares,
      });
      await expect(api.getPayerSbpForReimbursement(otherAuth)).resolves.toEqual({
        phone: null,
        bankId: null,
      });
    });
  });

  test('payer SBP secret is never returned in public getSession or getSplit', async () => {
    const api = await caller();
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      payerSbpPhone: '+79991234567',
      payerSbpBankId: 'tbank',
      receiptData: { subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'RUB' },
      items: [],
      assignments: [],
      summary: [],
      createdAt: new Date(),
    });
    const publicSession = await api.getSession({ token: base.shareToken });
    expect(JSON.stringify(publicSession)).not.toContain('+79991234567');
    expect(publicSession).not.toHaveProperty('payerSbpPhone');
    expect(publicSession).not.toHaveProperty('payerSbpBankId');
  });
});

describe('BillOK guest payment declaration (Issue #1 1.3.19)', () => {
  const payerId = '11111111-1111-4111-8111-111111111111';
  const payerToken = '22222222-2222-4222-8222-222222222222';
  const debtorId = '33333333-3333-4333-8333-333333333333';
  const debtorToken = '44444444-4444-4444-8444-444444444444';
  const debtorAuth = { token: 'guest-payment-token', personId: debtorId, personToken: debtorToken };
  const base = {
    id: 'guest-payment-id',
    expiresAt: new Date(Date.now() + 86400000),
    status: 'FINALIZED',
    paidByIndex: 1,
    receiptData: { total: 1001, subtotal: 1001, tax: 0, tip: 0, currency: 'RUB' },
    summary: [
      { personIndex: 0, total: 459, tip: 125 },
      { personIndex: 1, total: 742, tip: 75 },
    ],
    people: [
      { id: debtorId, personToken: debtorToken, name: 'Анна' },
      { id: payerId, personToken: payerToken, name: 'Борис' },
    ],
  };

  beforeEach(() => {
    mockDb.guestSplit.findUnique.mockResolvedValue(structuredClone(base));
    mockDb.guestSplit.update.mockResolvedValue({ id: base.id });
  });

  test('a verified guest debtor declares payment without implying receipt or bank settlement', async () => {
    const api = await caller();
    const result = await api.markMyPayment(debtorAuth);
    expect(new Date(result.declaredPaidAt).toISOString()).toBe(result.declaredPaidAt);
    expect(mockDb.guestSplit.update).toHaveBeenCalledTimes(1);
    const data = mockDb.guestSplit.update.mock.calls[0]![0].data;
    expect(data).toHaveProperty('people');
    expect(data).not.toHaveProperty('summary');
    expect(data).not.toHaveProperty('status');
    expect(data.people[0].paymentDeclaredAt).toBe(result.declaredPaidAt);
    expect(data.people[1].paymentDeclaredAt).toBeUndefined();
    // Returning a timestamp means only that the participant pressed the button.
    expect(result).not.toHaveProperty('confirmedAt');
    expect(result).not.toHaveProperty('receiptVerifiedAt');
  });

  test('a reload can read the own declaration; repeating mark is idempotent', async () => {
    const api = await caller();
    const marked = '2026-10-28T18:00:00.000Z';
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      people: [{ ...base.people[0], paymentDeclaredAt: marked }, base.people[1]],
    });
    await expect(api.getMyPaymentDeclaration(debtorAuth)).resolves.toEqual({
      declaredPaidAt: marked,
      verifiedAt: null,
    });
    await expect(api.markMyPayment(debtorAuth)).resolves.toEqual({ declaredPaidAt: marked });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('only the debtor can read the payer confirmation for their own payment', async () => {
    const api = await caller();
    const declared = '2026-10-28T18:00:00.000Z';
    const verified = '2026-10-28T18:02:00.000Z';
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      people: [{ ...base.people[0], paymentDeclaredAt: declared, paymentVerifiedAt: verified }, base.people[1]],
    });
    await expect(api.getMyPaymentDeclaration(debtorAuth)).resolves.toEqual({
      declaredPaidAt: declared,
      verifiedAt: verified,
    });
  });

  test('unmarked participant receives null, and another identity cannot read or mark', async () => {
    const api = await caller(signedIn);
    await expect(api.getMyPaymentDeclaration(debtorAuth)).resolves.toEqual({ declaredPaidAt: null, verifiedAt: null });
    const impostors = [
      { ...debtorAuth, personId: payerId },
      { ...debtorAuth, personToken: payerToken },
      { ...debtorAuth, personToken: '55555555-5555-4555-8555-555555555555' },
      { ...debtorAuth, personId: payerId, personToken: payerToken },
    ];
    for (const creds of impostors) {
      await expect(api.markMyPayment(creds)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.getMyPaymentDeclaration(creds)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('rejects a nonfinalized, expired, zero-due or unreconciled receipt', async () => {
    const api = await caller();
    const scenarios = [
      [{ status: 'CLAIMING' }, 'BAD_REQUEST'],
      [{ expiresAt: new Date(Date.now() - 86400000) }, 'NOT_FOUND'],
      [
        {
          summary: [
            { personIndex: 0, total: 0, tip: 0 },
            { personIndex: 1, total: 1001, tip: 0 },
          ],
        },
        'FORBIDDEN',
      ],
      [{ summary: null }, 'FORBIDDEN'],
      [
        {
          summary: [
            { personIndex: 0, total: 459, tip: 125 },
            { personIndex: 0, total: 742, tip: 75 },
          ],
        },
        'FORBIDDEN',
      ],
      [{ receiptData: { ...base.receiptData, total: 1002 } }, 'FORBIDDEN'],
    ] as const;
    for (const [change, code] of scenarios) {
      mockDb.guestSplit.findUnique.mockResolvedValue({ ...base, ...change });
      await expect(api.markMyPayment(debtorAuth)).rejects.toMatchObject({ code });
      await expect(api.getMyPaymentDeclaration(debtorAuth)).rejects.toMatchObject({ code });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('BillOK payer verifies received guest payments (Issue #1 1.3.19)', () => {
  const payerId = '11111111-1111-4111-8111-111111111111';
  const payerToken = '22222222-2222-4222-8222-222222222222';
  const debtorId = '33333333-3333-4333-8333-333333333333';
  const debtorToken = '44444444-4444-4444-8444-444444444444';
  const anotherId = '55555555-5555-4555-8555-555555555555';
  const anotherToken = '66666666-6666-4666-8666-666666666666';
  const marked = '2026-10-28T18:00:00.000Z';
  const payerAuth = { token: 'guest-payment-review', personId: payerId, personToken: payerToken };
  const base = {
    id: 'guest-payment-id',
    expiresAt: new Date(Date.now() + 86400000),
    status: 'FINALIZED',
    paidByIndex: 1,
    receiptData: { total: 1001, subtotal: 1001, tax: 0, tip: 0, currency: 'RUB' },
    summary: [
      { personIndex: 0, total: 459, tip: 125 },
      { personIndex: 1, total: 334, tip: 0 },
      { personIndex: 2, total: 408, tip: 75 },
    ],
    people: [
      { id: debtorId, personToken: debtorToken, name: 'Анна', paymentDeclaredAt: marked },
      { id: payerId, personToken: payerToken, name: 'Борис' },
      { id: anotherId, personToken: anotherToken, name: 'Виктор' },
    ],
  };

  beforeEach(() => {
    mockDb.guestSplit.findUnique.mockResolvedValue(structuredClone(base));
    mockDb.guestSplit.update.mockResolvedValue({ id: base.id });
  });

  test('payer sees declared and undeclared balances but never sees their own debt as a transfer', async () => {
    const api = await caller();
    await expect(api.getMyPayerPaymentReview(payerAuth)).resolves.toEqual({
      payments: [
        { personId: debtorId, name: 'Анна', amount: 459, declaredPaidAt: marked, verifiedAt: null },
        { personId: anotherId, name: 'Виктор', amount: 408, declaredPaidAt: null, verifiedAt: null },
      ],
    });
  });

  test('only payer with valid personal token can confirm a declared transfer', async () => {
    const api = await caller();
    const result = await api.confirmGuestPaymentReceived({ ...payerAuth, debtorId });
    expect(new Date(result.verifiedAt).toISOString()).toBe(result.verifiedAt);
    const update = mockDb.guestSplit.update.mock.calls[0]![0];
    expect(update.data.people[0].paymentVerifiedAt).toBe(result.verifiedAt);
    expect(update.data.people[1].paymentVerifiedAt).toBeUndefined();
    expect(update.data.people[2].paymentVerifiedAt).toBeUndefined();
    expect(update.data).not.toHaveProperty('summary');
    expect(update.data).not.toHaveProperty('status');
  });

  test('repeated verification returns original timestamp without another write', async () => {
    const api = await caller();
    const verifiedAt = '2026-10-28T18:03:00.000Z';
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      people: [{ ...base.people[0], paymentVerifiedAt: verifiedAt }, ...base.people.slice(1)],
    });
    await expect(api.confirmGuestPaymentReceived({ ...payerAuth, debtorId })).resolves.toEqual({ verifiedAt });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('organizer login alone, the debtor, and someone from another bill are denied', async () => {
    const api = await caller(signedIn);
    const invalid = [
      { ...payerAuth, personId: debtorId },
      { ...payerAuth, personToken: debtorToken },
      { ...payerAuth, personId: debtorId, personToken: debtorToken },
    ];
    for (const credentials of invalid) {
      await expect(api.getMyPayerPaymentReview(credentials)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.confirmGuestPaymentReceived({ ...credentials, debtorId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    mockDb.guestSplit.findUnique.mockResolvedValueOnce(null);
    await expect(api.getMyPayerPaymentReview({ ...payerAuth, token: 'other-bill' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('payer cannot confirm undeclared money, their own share, or unknown participant', async () => {
    const api = await caller();
    for (const id of [anotherId, payerId, '77777777-7777-4777-8777-777777777777']) {
      await expect(api.confirmGuestPaymentReceived({ ...payerAuth, debtorId: id })).rejects.toMatchObject({
        code: id === anotherId ? 'BAD_REQUEST' : 'FORBIDDEN',
      });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('finalized and reconciled amounts are required even with payer personal token', async () => {
    const api = await caller();
    for (const [override, code] of [
      [{ status: 'CLAIMING' }, 'BAD_REQUEST'],
      [{ expiresAt: new Date(Date.now() - 86400000) }, 'NOT_FOUND'],
      [{ summary: null }, 'FORBIDDEN'],
      [{ receiptData: { ...base.receiptData, total: 1002 } }, 'FORBIDDEN'],
      [
        {
          summary: [
            { personIndex: 0, total: 459, tip: 125 },
            { personIndex: 0, total: 334, tip: 0 },
            { personIndex: 2, total: 408, tip: 75 },
          ],
        },
        'FORBIDDEN',
      ],
    ] as const) {
      mockDb.guestSplit.findUnique.mockResolvedValue({ ...base, ...override });
      await expect(api.getMyPayerPaymentReview(payerAuth)).rejects.toMatchObject({ code });
      await expect(api.confirmGuestPaymentReceived({ ...payerAuth, debtorId })).rejects.toMatchObject({ code });
    }
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('confirmed timestamp stays private in the public guest session response', async () => {
    const api = await caller();
    mockDb.guestSplit.findUnique.mockResolvedValue({
      ...base,
      people: [{ ...base.people[0], paymentVerifiedAt: '2026-10-28T18:03:00.000Z' }, ...base.people.slice(1)],
      receiptData: base.receiptData,
      items: [],
      assignments: [],
      createdAt: new Date(),
    });
    const publicView = await api.getSession({ token: payerAuth.token });
    expect(JSON.stringify(publicView)).not.toContain('paymentVerifiedAt');
    expect(JSON.stringify(publicView)).not.toContain('paymentDeclaredAt');
  });
});
