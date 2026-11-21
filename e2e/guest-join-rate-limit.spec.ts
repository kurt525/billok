import { randomUUID } from 'node:crypto';
import { test, expect, request } from '@playwright/test';
import { authedContext, createUnifiedReceiptFixture, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// The old groupSize-rejoin path is gone. Verify that the SAME per-person
// safety budget protects the supported fixed-slot join even for resumed
// bearer credentials, without freezing a different guest on the same link.
test.describe('Supported shared-link joins: rate limits without legacy groupSize', () => {
  test('the 11th rejoin is rate limited; another independent guest may still join', async () => {
    const owner = await authedContext('alice@qa.billok.ru');
    const guest = await request.newContext({ baseURL: BASE });
    try {
      const receipt = await createUnifiedReceiptFixture(owner, {
        merchantName: 'Проверка лимита входа',
        guestCount: 2,
        items: [{ name: 'Блюдо', quantity: 1, unitPrice: 100, totalPrice: 100 }],
      });
      const session = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      const slotId = session.people[1].id;
      const otherSlotId = session.people[2].id;
      const first = await trpcMutation(guest, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId,
        name: 'Алиса',
        joinKey: randomUUID(),
      });
      expect(first.ok(), await first.text()).toBe(true);
      const { personToken } = (await first.json()).result.data.json;

      for (let index = 0; index < 10; index++) {
        const retry = await trpcMutation(guest, 'guest.joinGuestSlot', {
          token: receipt.shareToken,
          slotId,
          name: 'Алиса',
          personToken,
        });
        expect(retry.ok(), 'rejoin ' + (index + 1) + ': ' + (await retry.text())).toBe(true);
      }
      const refused = await trpcMutation(guest, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId,
        name: 'Алиса',
        personToken,
      });
      expect(refused.status()).toBe(429);
      expect((await trpcError(refused))?.data?.code).toBe('TOO_MANY_REQUESTS');

      const bob = await trpcMutation(guest, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId: otherSlotId,
        name: 'Борис',
        joinKey: randomUUID(),
      });
      expect(bob.ok(), await bob.text()).toBe(true);
    } finally {
      await guest.dispose();
      await owner.dispose();
    }
  });
});
