import { randomUUID } from 'node:crypto';
import { test, expect, request } from '@playwright/test';
import {
  authedContext,
  createUnifiedReceiptFixture,
  finalizeUnifiedReceiptFixture,
  trpcMutation,
  trpcQuery,
  trpcResult,
} from './helpers';

test.describe('BillOK — only unified receipt creation and legacy finalized reader', () => {
  test('creator, guest places and payer are stable after creation', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Кафе Тест',
        guestCount: 2,
        items: [
          { name: 'Бургер', quantity: 1, unitPrice: 1500, totalPrice: 1500 },
          { name: 'Салат', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
          { name: 'Картофель', quantity: 1, unitPrice: 500, totalPrice: 500 },
        ],
      });
      const data = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: receipt.shareToken }));
      expect(data.shareToken).toBe(receipt.shareToken);
      expect(data.receiptData.merchantName).toBe('Кафе Тест');
      expect(data.receiptData.total).toBe(3000);
      expect(data.items).toHaveLength(3);
      expect(data.people).toHaveLength(3);
      expect(data.people[0].id).toBe(receipt.creator.personId);
      expect(data.paidByIndex).toBe(0);
      expect(data.status).toBe('CLAIMING');
    } finally {
      await ctx.dispose();
    }
  });

  test('creator can claim, confirm, finalize and fetch the old read-only getSplit endpoint', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Кафе на углу',
        items: [
          { name: 'Завтрак', quantity: 1, unitPrice: 3000, totalPrice: 3000 },
          { name: 'Чай', quantity: 1, unitPrice: 500, totalPrice: 500 },
        ],
      });
      await finalizeUnifiedReceiptFixture(ctx, receipt, [0, 1]);
      const split = await trpcResult(await trpcQuery(ctx, 'guest.getSplit', { token: receipt.shareToken }));
      expect(split.receiptData.merchantName).toBe('Кафе на углу');
      expect(split.receiptData.total).toBe(3500);
      expect(split.items).toHaveLength(2);
      expect(split.people).toHaveLength(1);
      expect(split.summary).toHaveLength(1);
      expect(split.summary[0].total).toBe(3500);
    } finally {
      await ctx.dispose();
    }
  });

  test('two participants can share one dish, and their finalized totals add up', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Общая закуска',
        guestCount: 1,
        items: [{ name: 'Пицца', quantity: 1, unitPrice: 375, totalPrice: 375 }],
      });
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: receipt.shareToken }));
      const anonymous = await request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3001' });
      const res = await trpcMutation(anonymous, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId: session.people[1].id,
        name: 'Борис',
        joinKey: randomUUID(),
      });
      expect(res.ok(), await res.text()).toBe(true);
      const guest = (await res.json()).result.data.json;
      const ownerClaim = await trpcMutation(ctx, 'guest.claimItems', {
        token: receipt.shareToken,
        personId: receipt.creator.personId,
        personToken: receipt.creator.personToken,
        claimedItemIndices: [0],
      });
      expect(ownerClaim.ok(), await ownerClaim.text()).toBe(true);
      const guestClaim = await trpcMutation(anonymous, 'guest.claimItems', {
        token: receipt.shareToken,
        personId: guest.personId,
        personToken: guest.personToken,
        claimedItemIndices: [0],
      });
      expect(guestClaim.ok(), await guestClaim.text()).toBe(true);
      const approved = await trpcMutation(ctx, 'guest.confirmSessionParts', { token: receipt.shareToken });
      expect(approved.ok(), await approved.text()).toBe(true);
      const finalized = await trpcMutation(ctx, 'guest.finalizeSession', { token: receipt.shareToken });
      expect(finalized.ok(), await finalized.text()).toBe(true);
      const split = await trpcResult(await trpcQuery(ctx, 'guest.getSplit', { token: receipt.shareToken }));
      expect(split.assignments[0].personIndices).toEqual([0, 1]);
      expect(split.summary.reduce((sum: number, row: { total: number }) => sum + row.total, 0)).toBe(375);
      expect(split.summary).toHaveLength(2);
      await anonymous.dispose();
    } finally {
      await ctx.dispose();
    }
  });
});

test.describe('BillOK — share-link UI of the unified receipt', () => {
  test('the open receipt displays its item and a copyable shared link', async ({ page }) => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Пиццерия',
        guestCount: 1,
        items: [{ name: 'Большая пицца', quantity: 1, unitPrice: 2400, totalPrice: 2400 }],
      });
      await page.goto('/split/' + receipt.shareToken + '/claim');
      await expect(page.getByText('Пиццерия').first()).toBeVisible();
      await expect(page.getByText('Большая пицца').first()).toBeVisible();
      await expect(page.getByTestId('copy-link-btn')).toBeVisible();
    } finally {
      await ctx.dispose();
    }
  });

  test('two independent guests cannot occupy the same reserved slot', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Общий чек',
        guestCount: 1,
        items: [{ name: 'Чай', quantity: 1, unitPrice: 150, totalPrice: 150 }],
      });
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: receipt.shareToken }));
      const slotId = session.people[1].id;
      const anonymous = await request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3001' });
      const first = await trpcMutation(anonymous, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId,
        name: 'Анна',
        joinKey: randomUUID(),
      });
      expect(first.ok(), await first.text()).toBe(true);
      const denied = await trpcMutation(anonymous, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId,
        name: 'Борис',
        joinKey: randomUUID(),
      });
      expect(denied.ok(), await denied.text()).toBe(false);
      const still = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: receipt.shareToken }));
      expect(still.people[1].name).toBe('Анна');
      await anonymous.dispose();
    } finally {
      await ctx.dispose();
    }
  });

  test('an invented share token does not reveal a receipt', async ({ page }) => {
    await page.goto('/split/nonexistent-token-abc123/claim');
    await expect(page.getByTestId('claim-join-form')).toHaveCount(0);
    await expect(page.getByText('Пиццерия')).toHaveCount(0);
  });
});
