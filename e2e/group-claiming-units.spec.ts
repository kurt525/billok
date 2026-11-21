import { randomUUID } from 'node:crypto';
import { test, expect, request } from '@playwright/test';
import { authedContext, createUnifiedReceiptFixture, trpcMutation, trpcQuery, trpcResult } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// Issue #10 23: the obsolete groupSize flow must not be revived by old
// clients, while payment groups keep separate identities, debts and tokens.
test.describe('Individual family members and payment groups, not legacy groupSize', () => {
  test('new shared-link join has no company-size field and rejected legacy API input', async ({ page }) => {
    const owner = await authedContext('alice@qa.billok.ru');
    const guest = await request.newContext({ baseURL: BASE });
    try {
      const receipt = await createUnifiedReceiptFixture(owner, {
        merchantName: 'Семейный ужин',
        guestCount: 1,
        items: [{ name: 'Суп', quantity: 1, totalPrice: 700, unitPrice: 700 }],
      });
      await page.goto('/split/' + receipt.shareToken + '/claim');
      await expect(page.getByTestId('claim-join-form')).toBeVisible();
      await expect(page.getByTestId('group-size-input')).toHaveCount(0);
      await expect(page.getByTestId('edit-group-size-1')).toHaveCount(0);
      const stale = await trpcMutation(guest, 'guest.joinSession', {
        token: receipt.shareToken,
        name: 'Компания',
        groupSize: 3,
      });
      expect(stale.ok(), await stale.text()).toBe(false);
      const session = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      expect(session.people).toHaveLength(2);
    } finally {
      await guest.dispose();
      await owner.dispose();
    }
  });

  test('wife assigns 4/2/1 for three separate members of one payment group', async () => {
    const owner = await authedContext('alice@qa.billok.ru');
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const receipt = await createUnifiedReceiptFixture(owner, {
        merchantName: 'Семейное распределение',
        guestCount: 3,
        items: [{ name: 'Общая пицца', quantity: 1, totalPrice: 700, unitPrice: 700 }],
      });
      let session = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      const personIds: string[] = [];
      const personalTokens: string[] = [];
      for (let index = 1; index <= 3; index++) {
        const response = await trpcMutation(anon, 'guest.joinGuestSlot', {
          token: receipt.shareToken,
          slotId: session.people[index].id,
          name: ['Жена', 'Муж', 'Ребёнок'][index - 1],
          joinKey: randomUUID(),
        });
        expect(response.ok(), await response.text()).toBe(true);
        const joined = (await response.json()).result.data.json;
        personIds.push(joined.personId);
        personalTokens.push(joined.personToken);
      }
      expect(new Set(personIds).size).toBe(3);
      const grouped = await trpcMutation(owner, 'guest.setPaymentGroups', {
        token: receipt.shareToken,
        groups: [{ representativeId: personIds[0], memberIds: personIds }],
      });
      expect(grouped.ok(), await grouped.text()).toBe(true);
      const assigned = await trpcMutation(anon, 'guest.setReceiptItemParts', {
        token: receipt.shareToken,
        personToken: personalTokens[0],
        itemIndex: 0,
        changes: personIds.map((personId, index) => ({ personId, parts: [4, 2, 1][index] })),
        requestKey: randomUUID(),
      });
      expect(assigned.ok(), await assigned.text()).toBe(true);
      session = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      expect(session.people.map((person: { id: string }) => person.id).slice(1, 4)).toEqual(personIds);
      expect(session.assignments[0].partsByPersonId).toMatchObject(
        Object.fromEntries(personIds.map((personId, index) => [personId, [4, 2, 1][index]])),
      );
      expect(session.people[2].paymentGroupRepresentativeId).toBe(personIds[0]);
      const wrong = await trpcMutation(anon, 'guest.setReceiptItemParts', {
        token: receipt.shareToken,
        personToken: personalTokens[1],
        itemIndex: 0,
        changes: [{ personId: personIds[2], parts: 2 }],
        requestKey: randomUUID(),
      });
      expect(wrong.ok(), await wrong.text()).toBe(false);
      session = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      expect(session.assignments[0].partsByPersonId[personIds[2]!]).toBe(1);
    } finally {
      await anon.dispose();
      await owner.dispose();
    }
  });

  test('regular guest cannot recreate a merged 2-person card through name editor', async () => {
    const owner = await authedContext('alice@qa.billok.ru');
    const guest = await request.newContext({ baseURL: BASE });
    try {
      const receipt = await createUnifiedReceiptFixture(owner, {
        merchantName: 'Без устаревшей группы',
        guestCount: 1,
        items: [{ name: 'Чай', quantity: 1, totalPrice: 300, unitPrice: 300 }],
      });
      const session = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      const joined = await trpcMutation(guest, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId: session.people[1].id,
        name: 'Гость 1',
        joinKey: randomUUID(),
      });
      expect(joined.ok(), await joined.text()).toBe(true);
      const { personId, personToken } = (await joined.json()).result.data.json;
      const refused = await trpcMutation(guest, 'guest.editPersonName', {
        token: receipt.shareToken,
        targetId: personId,
        personToken,
        newName: 'Гость 1',
        groupSize: 2,
      });
      expect(refused.ok(), await refused.text()).toBe(false);
      const after = await trpcResult(await trpcQuery(guest, 'guest.getSession', { token: receipt.shareToken }));
      expect(after.people[1].name).toBe('Гость 1');
      expect(after.people[1].groupSize).toBe(1);
    } finally {
      await guest.dispose();
      await owner.dispose();
    }
  });
});
