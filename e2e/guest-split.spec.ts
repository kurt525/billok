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

  test('Issue #19: link deadline is the same Moscow date and time on every device', async ({ browser }) => {
    const owner = await authedContext('alice@qa.billok.ru');
    const contexts = [];
    try {
      const receipt = await createUnifiedReceiptFixture(owner, {
        merchantName: 'Срок действия ссылки',
        items: [{ name: 'Чай', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      });
      const token = receipt.shareToken;
      const before = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
      const date = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        dateStyle: 'long',
        timeStyle: 'medium',
        hourCycle: 'h23',
      }).format(new Date(before.expiresAt));
      const expected = 'Ссылка на этот чек действует до ' + date + ' (МСК).';
      for (const timezoneId of ['Pacific/Honolulu', 'Asia/Vladivostok']) {
        contexts.push(await browser.newContext({ timezoneId, viewport: { width: 320, height: 650 } }));
      }
      for (const context of contexts) {
        const page = await context.newPage();
        await page.goto('/split/' + token + '/claim');
        await expect(page.getByTestId('receipt-link-expiry')).toHaveText(expected);
      }
      await finalizeUnifiedReceiptFixture(owner, receipt, [0]);
      const after = await trpcResult(await trpcQuery(owner, 'guest.getSplit', { token }));
      expect(after.expiresAt).toBe(before.expiresAt);
      for (const context of contexts) {
        const page = context.pages()[0]!;
        for (const route of ['/split/' + token, '/split/' + token + '/claim']) {
          await page.goto(route);
          await expect(page.getByTestId('receipt-link-expiry')).toHaveText(expected);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
        }
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await owner.dispose();
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
      await page.getByTestId('claim-tab-links').click();
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
