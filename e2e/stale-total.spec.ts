import { test, expect } from '@playwright/test';
import { authedContext, trpcMutation, trpcQuery, trpcResult } from './helpers';

// TASK-BILLOK-002: only the unified claiming flow may create a new receipt.
// Keep the regression against stale totals and unapproved shared tips.
test.describe('Unified receipt: totals and tip-override safety', () => {
  const receiptData = {
    merchantName: 'Проверка расчётов',
    subtotal: 2000,
    tax: 0,
    tip: 0,
    total: 2000,
    currency: 'RUB',
  };
  const items = [{ name: 'Салат', quantity: 1, unitPrice: 2000, totalPrice: 2000 }];

  test('an obsolete top-level tipOverride cannot change the saved total or tips', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const created = await trpcMutation(ctx, 'guest.createClaimSession', {
        receiptData,
        items,
        guestCount: 0,
        joinCreator: true,
        tipOverride: 500,
      });
      expect(created.ok(), await created.text()).toBe(true);
      const { shareToken } = (await created.json()).result.data.json;
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
      expect(session.receiptData.tip).toBe(0);
      expect(session.receiptData.total).toBe(2000);
      expect(session.receiptData.subtotal).toBe(2000);
    } finally {
      await ctx.dispose();
    }
  });

  test('valid unchanged subtotal is preserved; shared tax/tips cannot be added', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      for (const invalid of [
        { ...receiptData, tip: 500, total: 2500 },
        { ...receiptData, tax: 200, total: 2200 },
        { ...receiptData, total: 2500 },
      ]) {
        const refused = await trpcMutation(ctx, 'guest.createClaimSession', {
          receiptData: invalid,
          items,
          guestCount: 0,
        });
        expect(refused.ok(), await refused.text()).toBe(false);
      }
      const created = await trpcMutation(ctx, 'guest.createClaimSession', {
        receiptData,
        items,
        guestCount: 0,
        joinCreator: true,
      });
      expect(created.ok(), await created.text()).toBe(true);
      const { shareToken } = (await created.json()).result.data.json;
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
      expect(session.receiptData.total).toBe(2000);
      expect(session.receiptData.tip).toBe(0);
    } finally {
      await ctx.dispose();
    }
  });
});
