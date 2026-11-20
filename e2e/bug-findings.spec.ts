import { randomUUID } from 'node:crypto';
import { test, expect, request } from '@playwright/test';
import { loginWithPasskey } from './passkey-auth';
import { authedContext, rememberClaimIdentity, trpcMutation, trpcResult, trpcQuery } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

test.describe('Finding #3: removal must not corrupt stable person IDs', () => {
  test('removing a joined guest preserves the creator’s already saved dish allocation', async ({ page }) => {
    test.setTimeout(120_000);
    await loginWithPasskey(page, 'alice@qa.billok.ru');
    const owner = await authedContext('alice@qa.billok.ru');
    const guestCtx = await request.newContext({ baseURL: BASE });
    try {
      const created = await trpcMutation(owner, 'guest.createClaimSession', {
        receiptData: {
          merchantName: 'Проверка удаления',
          subtotal: 3000,
          tax: 0,
          tip: 0,
          total: 3000,
          currency: 'RUB',
        },
        items: [
          { name: 'Блюдо А', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
          { name: 'Блюдо Б', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
          { name: 'Блюдо В', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        ],
        guestCount: 1,
        joinCreator: true,
      });
      expect(created.ok(), await created.text()).toBe(true);
      const { shareToken, creator } = (await created.json()).result.data.json;
      const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: shareToken }));
      const bobRes = await trpcMutation(guestCtx, 'guest.joinGuestSlot', {
        token: shareToken,
        slotId: initial.people[1].id,
        name: 'Борис',
        joinKey: randomUUID(),
      });
      expect(bobRes.ok(), await bobRes.text()).toBe(true);
      const bob = (await bobRes.json()).result.data.json;
      await rememberClaimIdentity(page.context(), shareToken, {
        name: creator.name,
        personToken: creator.personToken,
      });
      await page.goto('/split/' + shareToken + '/claim');
      await expect(page.getByTestId('claim-item-0')).toBeVisible();
      await page.getByTestId('claim-item-0').click();
      await page.getByTestId('save-claims-btn').click();
      await expect
        .poll(async () => {
          const saved = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: shareToken }));
          return saved.assignments.some(
            (assignment: { itemIndex: number; personIndices: number[] }) =>
              assignment.itemIndex === 0 && assignment.personIndices.includes(0),
          );
        })
        .toBe(true);

      const removed = await trpcMutation(owner, 'guest.removePerson', {
        token: shareToken,
        personToken: creator.personToken,
        targetId: bob.personId,
      });
      expect(removed.ok(), await removed.text()).toBe(true);
      await expect(page.getByTestId('claim-item-0')).toBeVisible();
      const after = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: shareToken }));
      expect(after.people).toHaveLength(1);
      expect(after.people[0].id).toBe(creator.personId);
      expect(after.assignments[0].personIndices).toContain(0);
    } finally {
      await guestCtx.dispose();
      await owner.dispose();
    }
  });
});

test.describe('Finding #5: payer index in unified receipt creation', () => {
  test('creator remains row 0 while a selected guest place is the sole payer', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const res = await trpcMutation(ctx, 'guest.createClaimSession', {
        receiptData: {
          merchantName: 'Плательщик — гость',
          subtotal: 1000,
          tax: 0,
          tip: 0,
          total: 1000,
          currency: 'RUB',
        },
        items: [{ name: 'Блюдо', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
        guestCount: 1,
        paidByGuestSlot: 1,
        joinCreator: true,
      });
      expect(res.ok(), await res.text()).toBe(true);
      const { shareToken } = (await res.json()).result.data.json;
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
      expect(session.people).toHaveLength(2);
      expect(session.paidByIndex).toBe(1);
      expect(session.people[0].isRegistered).toBe(true);
      expect(session.people[1].guestSlotNumber).toBe(1);
      expect(session.people[1].hasJoined).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});

test.describe('Finding #6: shared items in the unified claiming flow', () => {
  test('creator and guest share the same item, without deleting either assignment', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const created = await trpcMutation(ctx, 'guest.createClaimSession', {
        receiptData: {
          merchantName: 'Общее блюдо',
          subtotal: 1000,
          tax: 0,
          tip: 0,
          total: 1000,
          currency: 'RUB',
        },
        items: [{ name: 'Общее блюдо', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
        guestCount: 1,
        joinCreator: true,
      });
      expect(created.ok(), await created.text()).toBe(true);
      const { shareToken, creator } = (await created.json()).result.data.json;
      const initial = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
      const guest = await trpcMutation(ctx, 'guest.joinGuestSlot', {
        token: shareToken,
        slotId: initial.people[1].id,
        name: 'Гость',
        joinKey: randomUUID(),
      });
      expect(guest.ok(), await guest.text()).toBe(true);
      const joined = (await guest.json()).result.data.json;
      for (const person of [creator, joined]) {
        const saved = await trpcMutation(ctx, 'guest.claimItems', {
          token: shareToken,
          personId: person.personId,
          personToken: person.personToken,
          claimedItemIndices: [0],
        });
        expect(saved.ok(), await saved.text()).toBe(true);
      }
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
      expect(session.receiptData.total).toBe(1000);
      const share = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0);
      expect(share.personIndices).toEqual([0, 1]);
      expect(session.people).toHaveLength(2);
    } finally {
      await ctx.dispose();
    }
  });
});

test.describe('Finding #7: empty items submit guard', () => {
  test('the single supported creation API rejects empty item arrays', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const refused = await trpcMutation(ctx, 'guest.createClaimSession', {
        receiptData: { merchantName: 'Пусто', subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' },
        items: [],
        guestCount: 0,
        joinCreator: true,
      });
      expect(refused.ok(), await refused.text()).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});
