import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
const unlink = vi.fn();
vi.mock('fs/promises', async (importOriginal) => ({ ...(await importOriginal<object>()), unlink }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findMany: vi.fn() },
  receipt: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  receiptItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  receiptItemAssignment: { deleteMany: vi.fn(), createMany: vi.fn() },
  expense: { create: vi.fn(), findUnique: vi.fn() },
  guestSplit: { findMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller(userId = 'u1') {
  const { receiptsRouter } = await import('./receipts');
  const ctx = { session: { user: { id: userId } }, db: mockDb, headers: new Headers(), impersonating: null };
  return receiptsRouter.createCaller(ctx as unknown as Parameters<typeof receiptsRouter.createCaller>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
});

describe('manual group bill authorization and storage', () => {
  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.group.findUnique.mockResolvedValue({ currency: 'RUB' });
    mockDb.receipt.create.mockResolvedValue({ id: 'r-manual' });
  });
  test('creates a resumable RUB bill with no file and no AI', async () => {
    expect(await (await caller()).createManual({ groupId: 'g1' })).toEqual({ receiptId: 'r-manual' });
    expect(mockDb.receipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupId: 'g1',
        uploadedById: 'u1',
        originalName: 'billok-manual',
        imagePath: '',
        fileSize: 0,
        status: 'COMPLETED',
        extractedData: expect.objectContaining({ currency: 'RUB', total: 0 }),
      }),
    });
  });
  test('checks RUB under the group row lock before creating a manual receipt', async () => {
    expect(await (await caller()).createManual({ groupId: 'g1' })).toEqual({ receiptId: 'r-manual' });
    expect(mockDb.group.findUnique).toHaveBeenCalledWith({
      where: { id: 'g1' },
      select: { currency: true },
    });
    const lockCall = mockDb.$queryRaw.mock.invocationCallOrder[0]!;
    const currencyReadCall = mockDb.group.findUnique.mock.invocationCallOrder[0]!;
    const createCall = mockDb.receipt.create.mock.invocationCallOrder[0]!;
    expect(lockCall).toBeLessThan(currencyReadCall);
    expect(currencyReadCall).toBeLessThan(createCall);
  });

  test.each(['USD', 'eur'])('rejects direct manual receipt creation in a %s group', async (currency) => {
    mockDb.group.findUnique.mockResolvedValue({ currency });
    await expect((await caller()).createManual({ groupId: 'g1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Expenses from receipts are allowed only for RUB receipts in RUB groups.',
    });
    expect(mockDb.$queryRaw).toHaveBeenCalledOnce();
    expect(mockDb.receipt.create).not.toHaveBeenCalled();
  });

  test('refuses a missing group without inserting an orphan receipt', async () => {
    mockDb.group.findUnique.mockResolvedValue(null);
    await expect((await caller()).createManual({ groupId: 'g1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.receipt.create).not.toHaveBeenCalled();
  });

  test('rejects archived groups without creating any bill', async () => {
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: new Date() }]);
    await expect((await caller()).createManual({ groupId: 'g1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.group.findUnique).not.toHaveBeenCalled();
    expect(mockDb.receipt.create).not.toHaveBeenCalled();
  });
  test('rejects callers who are not active group members', async () => {
    mockDb.groupMember.findUnique.mockResolvedValue(null);
    await expect((await caller()).createManual({ groupId: 'g1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.create).not.toHaveBeenCalled();
  });
  test('does not expose OCR processing or retry APIs to any caller', async () => {
    const { receiptsRouter } = await import('./receipts');
    expect(Object.keys(receiptsRouter._def.procedures)).not.toContain('processReceipt');
    expect(Object.keys(receiptsRouter._def.procedures)).not.toContain('retryProcessing');
  });
});

describe('manual group receipt: each member saves only their own voluntary tip', () => {
  const baseData = { subtotal: 505, tax: 0, tip: 0, total: 505, currency: 'RUB' };
  const receipt = {
    id: 'r1',
    groupId: 'g1',
    status: 'COMPLETED',
    originalName: 'billok-manual',
    extractedData: baseData,
  };
  const input = { groupId: 'g1', receiptId: 'r1', tipCents: 125 };

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ userId: 'u1', groupId: 'g1', removedAt: null });
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'RUB' });
    mockDb.receipt.findUnique.mockResolvedValue(receipt);
    mockDb.$queryRaw.mockResolvedValue([{ id: 'r1' }]);
    mockDb.expense.findUnique.mockResolvedValue(null);
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  });

  test('saves own tip in RUB kopecks while retaining receipt totals and dish prices', async () => {
    expect(await (await caller()).setPersonalTip(input)).toEqual({ success: true, tipCents: 125 });
    expect(mockDb.receipt.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: {
        extractedData: { ...baseData, personalTips: { u1: 125 } },
      },
    });
    expect(mockDb.receiptItem.update).not.toHaveBeenCalled();
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.$queryRaw).toHaveBeenCalledOnce();
    const sql = (mockDb.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/FROM "Receipt" WHERE "id" = \? FOR UPDATE/);
    expect(sql).not.toContain('FROM "Group"');
    expect(mockDb.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.receipt.findUnique.mock.invocationCallOrder[0]!,
    );
  });

  test('default zero and repeated identical amount do not write anything', async () => {
    expect(await (await caller()).setPersonalTip({ ...input, tipCents: 0 })).toEqual({ success: true, tipCents: 0 });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
    mockDb.receipt.findUnique.mockResolvedValue({
      ...receipt,
      extractedData: { ...baseData, personalTips: { u1: 125 } },
    });
    expect(await (await caller()).setPersonalTip(input)).toEqual({ success: true, tipCents: 125 });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test("two members saving in sequence preserve each other's tip in one receipt JSON", async () => {
    let stored: Record<string, unknown> = { ...baseData };
    mockDb.receipt.findUnique.mockImplementation(async () => ({ ...receipt, extractedData: stored }));
    mockDb.receipt.update.mockImplementation(async (args: { data: { extractedData: Record<string, unknown> } }) => {
      stored = args.data.extractedData;
    });
    expect(await (await caller()).setPersonalTip(input)).toEqual({ success: true, tipCents: 125 });
    // Use an independent authenticated member on the next call: the endpoint
    // never accepts a userId parameter from the requesting client.
    mockDb.groupMember.findUnique.mockImplementation(async () => ({ removedAt: null }));
    expect(await (await caller('u2')).setPersonalTip({ ...input, tipCents: 350 })).toEqual({
      success: true,
      tipCents: 350,
    });
    expect(stored.personalTips).toEqual({ u1: 125, u2: 350 });
    expect(mockDb.receipt.update).toHaveBeenCalledTimes(2);
    expect(mockDb.group.findUnique).toHaveBeenCalledTimes(2);
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
  });

  test('allows a member to set their own tip back to zero without touching others', async () => {
    mockDb.receipt.findUnique.mockResolvedValue({
      ...receipt,
      extractedData: { ...baseData, personalTips: { u1: 125, u2: 350 } },
    });
    await (await caller()).setPersonalTip({ ...input, tipCents: 0 });
    expect(mockDb.receipt.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { extractedData: { ...baseData, personalTips: { u1: 0, u2: 350 } } },
    });
  });

  test.each([-1, 1.4, 2_147_483_648])('rejects invalid tip %s without a transaction', async (tipCents) => {
    await expect((await caller()).setPersonalTip({ ...input, tipCents })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('refuses a receipt belonging to another group, before any update', async () => {
    mockDb.receipt.findUnique.mockResolvedValue({ ...receipt, groupId: 'g2' });
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('refuses a removed member even when middleware initially accepted the member', async () => {
    mockDb.groupMember.findUnique
      .mockResolvedValueOnce({ userId: 'u1', groupId: 'g1', removedAt: null })
      .mockResolvedValueOnce({ userId: 'u1', groupId: 'g1', removedAt: new Date() });
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('refuses a finalized receipt whose expense already exists', async () => {
    mockDb.expense.findUnique.mockResolvedValue({ id: 'e1' });
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Receipt already has an expense',
    });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test.each(['USD', 'EUR'])('refuses tips on a group in %s', async (currency) => {
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency });
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('refuses archived groups and non-RUB receipts', async () => {
    mockDb.group.findUnique.mockResolvedValueOnce({ archivedAt: new Date(), currency: 'RUB' });
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    mockDb.receipt.findUnique.mockResolvedValue({
      ...receipt,
      extractedData: { ...baseData, currency: 'USD' },
    });
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('refuses unauthorized nonmembers before acquiring receipt row lock', async () => {
    mockDb.groupMember.findUnique.mockResolvedValueOnce(null);
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
  });

  test('rejects editing if the receipt has been deleted before the transaction lock', async () => {
    mockDb.$queryRaw.mockResolvedValueOnce([]);
    await expect((await caller()).setPersonalTip(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });
});

describe('manual receipt: consumed portions and creator rounding', () => {
  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'RUB' });
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' },
      items: [{ id: 'pizza', totalPrice: 101 }],
    });
    mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Receipt"') ? [{ groupId: 'g1' }] : [{ archivedAt: null }],
    );
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.expense.create.mockResolvedValue({ id: 'expense1' });
  });

  const finish = {
    groupId: 'g1',
    receiptId: 'r1',
    title: 'Пицца',
    paidById: 'u2',
    assignments: [{ receiptItemId: 'pizza', userIds: ['u2', 'u3'], parts: [3, 5] }],
  };

  test('saves actual portions; the rounding kopeck goes to creator, not payer', async () => {
    await (await caller()).assignItemsAndCreateExpense(finish);
    expect(mockDb.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 101,
        paidById: 'u2',
        addedById: 'u1',
        splitMode: 'ITEM',
        shares: {
          create: expect.arrayContaining([
            { userId: 'u2', amount: 37 },
            { userId: 'u3', amount: 63 },
            { userId: 'u1', amount: 1 },
          ]),
        },
      }),
    });
    expect(mockDb.receiptItemAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { receiptItemId: 'pizza', userId: 'u2', shareOfItem: 3 },
        { receiptItemId: 'pizza', userId: 'u3', shareOfItem: 5 },
      ],
      skipDuplicates: true,
    });
  });

  test('atomically finalizes current personal tips, not the stale pre-lock receipt snapshot', async () => {
    const raw = {
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' },
      items: [{ id: 'pizza', totalPrice: 101 }],
    };
    // Another member saved the tip while the finishing request was waiting
    // for the receipt's FOR UPDATE lock. Read fresh JSON inside the transaction.
    mockDb.receipt.findUnique.mockResolvedValueOnce(raw).mockResolvedValueOnce({
      ...raw,
      extractedData: { ...raw.extractedData, personalTips: { u1: 25, u2: 100, u3: 0 } },
    });

    await (await caller()).assignItemsAndCreateExpense(finish);

    expect(mockDb.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 226,
        shares: {
          create: [
            { userId: 'u2', amount: 137 },
            { userId: 'u3', amount: 63 },
            { userId: 'u1', amount: 26 },
          ],
        },
      }),
    });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { title: 'Пицца', amount: 226, fromReceipt: true } }),
    });
    const locks = mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as TemplateStringsArray).join('?'));
    expect(locks[0]).toContain('FROM "Group"');
    expect(locks[0]).toContain('FOR SHARE');
    expect(locks[1]).toContain('FROM "Receipt"');
    expect(locks[1]).toContain('FOR UPDATE');
    expect(mockDb.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mockDb.receipt.findUnique.mock.invocationCallOrder[1]!,
    );
    expect(mockDb.receipt.findUnique.mock.invocationCallOrder[1]).toBeLessThan(
      mockDb.expense.create.mock.invocationCallOrder[0]!,
    );
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('participant with no assigned dish can leave a voluntary tip', async () => {
    mockDb.groupMember.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: 'u3' },
      { userId: 'u4' },
    ]);
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB', personalTips: { u4: 49 } },
      items: [{ id: 'pizza', totalPrice: 101 }],
    });

    await (await caller()).assignItemsAndCreateExpense(finish);
    expect(mockDb.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 150,
        shares: { create: expect.arrayContaining([{ userId: 'u4', amount: 49 }]) },
      }),
    });
  });

  test('rejects a tip from a removed member without writing an expense', async () => {
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB', personalTips: { exMember: 1 } },
      items: [{ id: 'pizza', totalPrice: 101 }],
    });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid personal tips or receipt total exceeds the permitted amount.',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.createMany).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test.each([
    ['negative', { u2: -1 }],
    ['fractional', { u2: 1.75 }],
    ['string', { u2: '25' }],
    ['overflow', { u2: 2_147_483_647 }],
  ])('rejects %s personal tips before creating an expense', async (_name, personalTips) => {
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB', personalTips },
      items: [{ id: 'pizza', totalPrice: 101 }],
    });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });

  test('rejects currency changed after locking manual receipt', async () => {
    const original = {
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' },
      items: [{ id: 'pizza', totalPrice: 101 }],
    };
    mockDb.receipt.findUnique.mockResolvedValueOnce(original).mockResolvedValueOnce({
      ...original,
      extractedData: { ...original.extractedData, currency: 'USD' },
    });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });

  test('rejects group detached or receipt finalized before the locked re-read', async () => {
    const original = {
      id: 'r1',
      originalName: 'billok-manual',
      uploadedById: 'u1',
      groupId: 'g1',
      status: 'COMPLETED',
      extractedData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' },
      items: [{ id: 'pizza', totalPrice: 101 }],
    };
    mockDb.receipt.findUnique.mockResolvedValueOnce(original).mockResolvedValueOnce({
      ...original,
      status: 'PENDING',
    });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });

  test('rejects mismatched portions before writing', async () => {
    await expect(
      (await caller()).assignItemsAndCreateExpense({
        ...finish,
        assignments: [{ receiptItemId: 'pizza', userIds: ['u2', 'u3'], parts: [3] }],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });

  test('requires creator membership when a rounding kopeck is owed', async () => {
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'u2' }, { userId: 'u3' }]);
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });
});

test('obsolete API for editing shared tax/tip is not exposed', async () => {
  const { receiptsRouter } = await import('./receipts');
  expect(Object.keys(receiptsRouter._def.procedures)).not.toContain('updateExtractedData');
});

describe('RUB-only finalization of a group receipt', () => {
  const finish = {
    groupId: 'g1',
    receiptId: 'r1',
    title: 'Чек',
    paidById: 'u1',
    assignments: [{ receiptItemId: 'i1', userIds: ['u1', 'u2'] }],
  };
  const receipt = {
    id: 'r1',
    originalName: 'receipt.jpg',
    status: 'COMPLETED',
    groupId: 'g1',
    uploadedById: 'u1',
    extractedData: { subtotal: 505, tax: 0, tip: 0, total: 505, currency: 'RUB' },
    items: [{ id: 'i1', totalPrice: 505 }],
  };

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'RUB' });
    mockDb.receipt.findUnique.mockResolvedValue(receipt);
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Receipt"') ? [{ groupId: 'g1' }] : [{ archivedAt: null }],
    );
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.expense.create.mockResolvedValue({ id: 'e-rub' });
  });

  test('rejects finalizing a receipt in a non-RUB group before any transaction', async () => {
    mockDb.group.findUnique.mockResolvedValueOnce({ archivedAt: null, currency: 'USD' });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Expenses from receipts are allowed only for RUB receipts in RUB groups.',
    });
    expect(mockDb.receipt.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test.each(['USD', 'eur'])('rejects a receipt with currency %s without converting or writing', async (currency) => {
    mockDb.receipt.findUnique.mockResolvedValueOnce({
      ...receipt,
      extractedData: { ...receipt.extractedData, currency },
    });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.createMany).not.toHaveBeenCalled();
  });

  test('rejects a group whose currency changed before finalization acquired the group row lock', async () => {
    mockDb.group.findUnique
      .mockResolvedValueOnce({ archivedAt: null, currency: 'RUB' })
      .mockResolvedValueOnce({ currency: 'USD' });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.$queryRaw).toHaveBeenCalledOnce();
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });

  test.each([
    ['extra tax', { tax: 110, tip: 0 }],
    ['shared tip', { tax: 0, tip: 220 }],
  ])('refuses finalization with %s already in receipt JSON', async (_name, charges) => {
    mockDb.receipt.findUnique.mockResolvedValueOnce({
      ...receipt,
      extractedData: { ...receipt.extractedData, ...charges },
    });
    await expect((await caller()).assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Additional tax and shared tips are not supported for receipts.',
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.createMany).not.toHaveBeenCalled();
  });

  test('refuses any shared tipOverride, including zero, before reading group data', async () => {
    const api = await caller();
    for (const tipOverride of [0, 225]) {
      await expect(
        api.assignItemsAndCreateExpense({
          ...finish,
          tipOverride,
        } as unknown as Parameters<typeof api.assignItemsAndCreateExpense>[0]),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDb.group.findUnique).not.toHaveBeenCalled();
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });

  test('stores 505 kopecks exactly in RUB with rate 1 and no converted amount', async () => {
    await (await caller()).assignItemsAndCreateExpense(finish);
    expect(mockDb.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupId: 'g1',
        amount: 505,
        currency: 'RUB',
        exchangeRate: 1,
        baseCurrencyAmount: null,
        splitMode: 'ITEM',
        shares: {
          create: [
            { userId: 'u1', amount: 253 },
            { userId: 'u2', amount: 252 },
          ],
        },
      }),
    });
    expect(mockDb.receiptItemAssignment.createMany).toHaveBeenCalledOnce();
    expect(mockDb.activityLog.create).toHaveBeenCalledOnce();
  });
});

describe('AI provider setup (#280)', () => {
  test('no receipts procedure exposes the AI provider setup', async () => {
    const { receiptsRouter } = await import('./receipts');
    const names = Object.keys(receiptsRouter._def.procedures).filter((name) => /provider/i.test(name));
    expect(names, 'the AI provider setup is admin-only, in admin.getSystemHealth').toEqual([]);
  });
});

describe('receipt item names are trimmed', () => {
  test('addItem refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.addItem({ receiptId: 'r1', name: '   ', unitPrice: 100, totalPrice: 100 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.receiptItem.create).not.toHaveBeenCalled();
  });

  test('updateItem refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.updateItem({ itemId: 'i1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.receiptItem.findUnique).not.toHaveBeenCalled();
  });
});

// #289: the archived check ran in its own statement before the write, so an
// archive that landed in between let the expense through, and the group could
// end up archived with a balance nobody can settle.
describe('a group archived while a receipt was being finished (#289)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const finish = {
    groupId: 'g1',
    receiptId: 'r1',
    title: 'Lunch',
    paidById: 'u1',
    assignments: [{ receiptItemId: 'i1', userIds: ['u1'] }],
  };
  // What the transaction's row locks read: the group, and the receipt (still in the group)
  const locksRead = (group: object, receipt: object | null = { groupId: 'g1' }) =>
    mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Receipt"') ? (receipt ? [receipt] : []) : [group],
    );

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'u1' }]);
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'COMPLETED',
      groupId: 'g1',
      uploadedById: 'u1',
      extractedData: { subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'RUB' },
      items: [{ id: 'i1', totalPrice: 1000 }],
    });
    // The early check still sees the group active, but by the time the
    // transaction locks its row, it's archived
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'RUB' });
    locksRead({ archivedAt: new Date() });
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  });

  test('assignItemsAndCreateExpense refuses, writing nothing', async () => {
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot create expenses in archived groups',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
  });

  test('an active group is locked FOR SHARE inside the transaction, before the write', async () => {
    locksRead({ archivedAt: null });
    mockDb.expense.create.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await api.assignItemsAndCreateExpense(finish);

    expect(rawSql()).toEqual([
      expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/),
      expect.stringMatching(/FROM "Receipt" WHERE "id" = \? FOR SHARE/),
    ]);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(mockDb.expense.create.mock.invocationCallOrder[0]!);
  });

  // Codex on #308: see the expenses test of the same name
  test('assignItemsAndCreateExpense checks its people are members inside the transaction, after the lock', async () => {
    locksRead({ archivedAt: null });
    mockDb.expense.create.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await api.assignItemsAndCreateExpense(finish);

    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(mockDb.groupMember.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.expense.create.mock.invocationCallOrder[0]!,
    );
    // Not a placeholder removed from the group (#284)
    expect(mockDb.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', removedAt: null } }),
    );
  });

  // Codex on #319: deleting a receipt from the pending list keeps it off the group while a
  // claim session uses it (#318), so an expense that passed the checks above just before
  // must see that under the receipt's lock, not link a receipt the group can no longer open
  test('a receipt taken off the group meanwhile is refused, writing nothing', async () => {
    locksRead({ archivedAt: null }, { groupId: null });
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Receipt was removed from this group',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
  });

  test('a receipt deleted meanwhile is refused, writing nothing', async () => {
    locksRead({ archivedAt: null }, null);
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finish)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });
});

// #318: the group scan page's Share Link makes a claim session from a group receipt, and
// deleting the receipt from the group's pending list deleted it under the claim page, which
// shows its photo. It now leaves the group, and goes only once no split uses it.
describe('deleting a pending receipt (#318)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));

  beforeEach(() => {
    mockDb.$transaction.mockImplementation((fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      groupId: 'g1',
      uploadedById: 'u1',
      savedById: null,
      imagePath: 'receipts/r1.jpg',
    });
    mockDb.expense.findUnique.mockResolvedValue(null);
    // Off the group, with no expense: what the cleanup finds under the lock
    mockDb.receipt.findMany.mockResolvedValue([{ id: 'r1', imagePath: 'receipts/r1.jpg' }]);
    mockDb.guestSplit.findMany.mockResolvedValue([]);
  });

  test('one a claim session uses leaves the group, and stays for the claim page', async () => {
    mockDb.guestSplit.findMany.mockResolvedValue([{ receiptId: 'r1' }]);
    const api = await caller();
    await api.deletePending({ receiptId: 'r1' });

    expect(mockDb.receipt.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { groupId: null } });
    expect(mockDb.receipt.delete).not.toHaveBeenCalled();
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  test('one nothing else uses is deleted, its file once the transaction has committed', async () => {
    let committed = false;
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => {
      const result = await fn(mockDb);
      committed = true;
      return result;
    });
    unlink.mockImplementation(async () => expect(committed).toBe(true));
    const api = await caller();
    await api.deletePending({ receiptId: 'r1' });

    expect(mockDb.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls[0]![0]).toMatch(/receipts\/r1\.jpg$/);
  });

  test('locks the receipt before checking for an expense, so one made meanwhile is seen', async () => {
    const api = await caller();
    await api.deletePending({ receiptId: 'r1' });

    expect(rawSql()[0]).toMatch(/FROM "Receipt" WHERE "id" = \? FOR UPDATE/);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(mockDb.expense.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.receipt.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDb.expense.findUnique.mock.invocationCallOrder[0]!,
    );
  });

  test('one an expense was made from is refused and kept', async () => {
    mockDb.expense.findUnique.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await expect(api.deletePending({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockDb.receipt.update).not.toHaveBeenCalled();
    expect(mockDb.receipt.delete).not.toHaveBeenCalled();
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  test('one deleted by someone else in the meantime is NOT_FOUND', async () => {
    mockDb.$queryRaw.mockResolvedValue([]);
    const api = await caller();
    await expect(api.deletePending({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('someone who neither uploaded nor saved it is refused', async () => {
    mockDb.receipt.findUnique.mockResolvedValue({ id: 'r1', groupId: 'g1', uploadedById: 'u2', savedById: 'u3' });
    const api = await caller();
    await expect(api.deletePending({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

// Codex on #319: deleting a receipt from the pending list now keeps it (off the group) while a
// claim session uses it, so a save for later that read it just before must not put it back
describe('saving a receipt for later while it is deleted from the pending list (#318)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const inGroup = {
    id: 'r1',
    status: 'COMPLETED',
    groupId: 'g1',
    uploadedById: 'u2',
    group: { members: [{ userId: 'u1' }] },
  };
  const offGroup = { id: 'r1', status: 'COMPLETED', groupId: null, uploadedById: 'u2', group: null };

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.group.findUnique.mockResolvedValue({ currency: 'RUB' });
    mockDb.expense.findUnique.mockResolvedValue(null);
  });

  test('a receipt taken off the group before the save got its lock is refused, and stays off it', async () => {
    // The check before the transaction saw it in the group; under the lock it's gone from it
    mockDb.receipt.findUnique.mockResolvedValueOnce(inGroup).mockResolvedValue(offGroup);
    const api = await caller();
    await expect(api.saveForLater({ groupId: 'g1', receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test("the receipt is locked before it's read in the transaction", async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    const api = await caller();
    await api.saveForLater({ groupId: 'g1', receiptId: 'r1' });

    expect(rawSql()[0]).toMatch(/FROM "Group" WHERE "id" = \? FOR SHARE/);
    expect(rawSql()[1]).toMatch(/FROM "Receipt" WHERE "id" = \? FOR NO KEY UPDATE/);
    const [groupLocked, receiptLocked] = mockDb.$queryRaw.mock.invocationCallOrder;
    const currencyChecked = mockDb.group.findUnique.mock.invocationCallOrder[0]!;
    expect(groupLocked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(currencyChecked).toBeGreaterThan(groupLocked!);
    expect(currencyChecked).toBeLessThan(receiptLocked!);
    const lastRead = mockDb.receipt.findUnique.mock.invocationCallOrder.at(-1)!;
    expect(lastRead).toBeGreaterThan(receiptLocked!);
    expect(mockDb.receipt.update.mock.invocationCallOrder[0]).toBeGreaterThan(lastRead);
  });

  test.each(['USD', 'eur'])('rejects saving a receipt in a %s group before changing it', async (currency) => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    mockDb.group.findUnique.mockResolvedValue({ currency });
    await expect((await caller()).saveForLater({ groupId: 'g1', receiptId: 'r1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Expenses from receipts are allowed only for RUB receipts in RUB groups.',
    });
    expect(rawSql()).toEqual([expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/)]);
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
  });

  test('rejects saving a non-RUB receipt in a RUB group, without changing it', async () => {
    mockDb.receipt.findUnique.mockResolvedValue({
      ...inGroup,
      extractedData: { subtotal: 505, tax: 0, tip: 0, total: 505, currency: 'USD' },
    });
    await expect((await caller()).saveForLater({ groupId: 'g1', receiptId: 'r1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(rawSql()).toHaveLength(2);
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
    expect(mockDb.expense.findUnique).not.toHaveBeenCalled();
  });

  test('rejects saving when the group was archived before acquiring its row lock', async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    mockDb.$queryRaw.mockResolvedValueOnce([{ archivedAt: new Date() }]);
    await expect((await caller()).saveForLater({ groupId: 'g1', receiptId: 'r1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot add expenses to an archived group',
    });
    expect(mockDb.group.findUnique).not.toHaveBeenCalled();
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('rejects saving when the group was removed before the currency check', async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    mockDb.group.findUnique.mockResolvedValue(null);
    await expect((await caller()).saveForLater({ groupId: 'g1', receiptId: 'r1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('a placeholder removed from the group is not saved as the payer (#284)', async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    mockDb.groupMember.findMany.mockResolvedValue([]);
    const api = await caller();
    await expect(api.saveForLater({ groupId: 'g1', receiptId: 'r1', paidById: 'hal' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', userId: { in: ['hal'] }, removedAt: null } }),
    );
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });
});
