import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  receipt: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  groupMember: { findUnique: vi.fn() },
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
    await expect(call(await caller())).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
    expiresAt?: Date;
    assignments?: { itemIndex: number; personIndices: number[] }[];
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
    userId: null,
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
      { id: joined.personId, name: 'Bob', personToken: joined.personToken },
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

describe('guest.getSession people', () => {
  test('says which people have joined without exposing their tokens, join keys or save keys', async () => {
    claimSession([
      { name: 'Host' },
      { name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2, join: liveJoin('alice'), saves: [ALICE_SAVE] },
    ]);
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(session.people).toEqual([
      { id: pid(0), name: 'Host', groupSize: 1, hasJoined: false, tipCents: 0 },
      { id: pid(1), name: 'Alice', groupSize: 2, hasJoined: true, tipCents: 0 },
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
      { name: 'Host', groupSize: 1, hasJoined: false },
      { name: 'Alice', groupSize: 1, hasJoined: true },
    ]);
    expect(JSON.stringify(split)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(split)).not.toContain(JOIN_KEY);
    expect(JSON.stringify(split)).not.toContain(ALICE_SAVE.key);
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

  test('gives the creator and the payer ids', async () => {
    const result = await (
      await caller(signedIn)
    ).createClaimSession({ ...session, creatorName: 'Host', paidByName: 'Payer' });
    const { people } = created();
    expect(people).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host' },
      { id: expect.stringMatching(UUID), name: 'Payer' },
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

  test('lists a name typed twice once, as first typed, since people join by name', async () => {
    await (
      await caller(signedIn)
    ).createClaimSession({ ...session, people: ['Pat', 'dana', ' Dana '], creatorName: 'pat', paidByName: 'PAT' });
    const { people, paidByIndex } = created();
    expect(people.map((p) => p.name)).toEqual(['Pat', 'dana']);
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
      { id: pid(0), name: 'Alice', groupSize: 1, hasJoined: true, tipCents: 0 },
      { id: pid(1), name: 'Bob', groupSize: 1, hasJoined: true, tipCents: 400 },
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

describe('guest.editPersonName', () => {
  test('renames the person the id names, wherever they are now', async () => {
    sessionAfterBWasRemoved();
    await (
      await caller()
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
    await (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2) });
    expect(savedStatus()).toBe('FINALIZED');
  });

  test('refuses while an item has nobody, and finalizes nothing (#237)', async () => {
    // Items 0 and 2 are unclaimed
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2) }),
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
      (await caller()).finalizeSession({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(0) }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('checks the caller before the claims: a bad id or token is still CONFLICT or FORBIDDEN', async () => {
    sessionAfterBWasRemoved();
    const api = await caller();
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
      (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(1) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("refuses someone else's id with the caller's token", async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(3) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a person index, and no id at all (#225)', async () => {
    sessionAfterBWasRemoved();
    const finalizeSession = (await caller()).finalizeSession as unknown as (
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
