import { describe, test, expect, vi } from 'vitest';

// #265: splits expire after a week and are deleted in batches; their receipts went nowhere
describe('deleteExpiredSplits', () => {
  function fakeDb() {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      guestSplit: { findMany: vi.fn(), deleteMany: vi.fn() },
      receipt: { findMany: vi.fn(), deleteMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { tx, db };
  }

  test('deletes expired splits and receipts only they used', async () => {
    const { tx, db } = fakeDb();
    tx.guestSplit.findMany
      .mockResolvedValueOnce([
        { id: 's1', receiptId: 'r1' },
        { id: 's2', receiptId: null },
      ])
      .mockResolvedValueOnce([]);
    tx.guestSplit.deleteMany.mockResolvedValue({ count: 2 });
    tx.receipt.findMany.mockResolvedValue([{ id: 'r1' }]);
    const { deleteExpiredSplits } = await import('./receipt-cleanup');

    expect(await deleteExpiredSplits(db as never, 100)).toBe(2);

    expect(tx.guestSplit.findMany).toHaveBeenNthCalledWith(1, {
      where: { status: 'CLAIMING', expiresAt: { lt: expect.any(Date) } },
      select: { id: true, receiptId: true },
      take: 100,
    });
    expect(tx.guestSplit.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] }, status: 'CLAIMING', expiresAt: { lt: expect.any(Date) } },
    });
    expect(tx.receipt.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, groupId: null, expense: { is: null } },
      select: { id: true },
    });
    expect(tx.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
  });

  test('never selects finalized bills merely because their original expiry date passed', async () => {
    const { tx, db } = fakeDb();
    tx.guestSplit.findMany.mockResolvedValue([]);
    const { deleteExpiredSplits } = await import('./receipt-cleanup');
    expect(await deleteExpiredSplits(db as never, 100)).toBe(0);
    expect(tx.guestSplit.findMany).toHaveBeenCalledWith({
      where: { status: 'CLAIMING', expiresAt: { lt: expect.any(Date) } },
      select: { id: true, receiptId: true },
      take: 100,
    });
    expect(tx.guestSplit.deleteMany).not.toHaveBeenCalled();
    expect(tx.receipt.deleteMany).not.toHaveBeenCalled();
  });

  test('with nothing expired, deletes nothing', async () => {
    const { tx, db } = fakeDb();
    tx.guestSplit.findMany.mockResolvedValue([]);
    const { deleteExpiredSplits } = await import('./receipt-cleanup');

    expect(await deleteExpiredSplits(db as never, 100)).toBe(0);
    expect(tx.guestSplit.deleteMany).not.toHaveBeenCalled();
    expect(tx.receipt.deleteMany).not.toHaveBeenCalled();
  });
});

// #312: receipts nothing uses (no group, no expense, no split made from them) stayed for good:
// ones left behind before #265, and Quick Split scans never made into a split
describe('unused receipts', () => {
  const DAY = 24 * 60 * 60 * 1000;

  type Query = { text: string; values: unknown[] };
  const isQuery = (arg: unknown): arg is Query => typeof (arg as Query)?.text === 'string';

  // Only records unchanged for a day may be considered abandoned
  function expectUnusedReceiptQuery(query: Query) {
    expect(query.text).toMatch(/"groupId" IS NULL/);
    expect(query.text).toMatch(/NOT EXISTS \(SELECT 1 FROM "Expense" e WHERE e\."receiptId" = r\."id"\)/);
    expect(query.text).toMatch(/NOT EXISTS \(SELECT 1 FROM "GuestSplit" s WHERE s\."receiptId" = r\."id"\)/);
    expect(query.text).toMatch(/r\."updatedAt" < \$1/);
    const cutoff = query.values[0] as Date;
    expect(Math.abs(cutoff.getTime() - (Date.now() - DAY))).toBeLessThan(5000);
  }

  test('counts detached records without filesystem metadata', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ count: 3 }]) };
    const { countUnusedReceipts } = await import('./receipt-cleanup');

    expect(await countUnusedReceipts(db as never)).toEqual({ count: 3 });
    expect(db.$queryRaw.mock.calls[0]![0].text).not.toContain('fileSize');
    expectUnusedReceiptQuery(db.$queryRaw.mock.calls[0]![0]);
  });

  function fakeDb(batches: { id: string }[][]) {
    const tx = {
      // The batch's candidates, then the row lock deleteUnusedSplitReceipts takes
      $queryRaw: vi.fn(async (arg: unknown) => (isQuery(arg) ? (batches.shift() ?? []) : [])),
      guestSplit: { findMany: vi.fn().mockResolvedValue([]) },
      receipt: { findMany: vi.fn(), deleteMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { tx, db };
  }

  test('deletes unused receipt records batch by batch under locks', async () => {
    const { tx, db } = fakeDb([[{ id: 'r1' }, { id: 'r2' }]]);
    // r2 was saved to a group after it was picked
    tx.receipt.findMany.mockResolvedValue([{ id: 'r1' }]);
    const { deleteUnusedReceipts } = await import('./receipt-cleanup');

    expect(await deleteUnusedReceipts(db as never, 500)).toBe(1);

    const pick = tx.$queryRaw.mock.calls[0]![0] as Query;
    expectUnusedReceiptQuery(pick);
    expect(pick.text).toMatch(/LIMIT \$2/);
    expect(pick.values[1]).toBe(500);
    // One scanned again since it was picked has changed, so it stays too
    expect(tx.receipt.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] }, groupId: null, expense: { is: null }, updatedAt: { lt: pick.values[0] } },
      select: { id: true },
    });
    expect(tx.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  // A picked receipt that's in use by the time it's locked isn't picked again
  test('goes on past a batch where every receipt turned out to be in use', async () => {
    const { tx, db } = fakeDb([[{ id: 'r1' }], [{ id: 'r3' }]]);
    tx.receipt.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r3' }]);
    const { deleteUnusedReceipts } = await import('./receipt-cleanup');

    expect(await deleteUnusedReceipts(db as never, 500)).toBe(1);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.receipt.deleteMany).toHaveBeenCalledTimes(1);
  });

  test('with none to delete, deletes nothing', async () => {
    const { tx, db } = fakeDb([]);
    const { deleteUnusedReceipts } = await import('./receipt-cleanup');

    expect(await deleteUnusedReceipts(db as never, 500)).toBe(0);
    expect(tx.receipt.findMany).not.toHaveBeenCalled();
    expect(tx.receipt.deleteMany).not.toHaveBeenCalled();
  });
});
