import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authedContext, trpcMutation, trpcQuery, trpcResult, users } from './helpers';
import { loginWithPasskey } from './passkey-auth';

test.use({ viewport: { width: 430, height: 760 } });

test('TASK-BILLOK-003: creator reassigns a dish by its own person chips without global selection', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  let token: string | null = null;
  try {
    const created = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Reassignment without switcher',
        subtotal: 3000,
        tax: 0,
        tip: 0,
        total: 3000,
        currency: 'USD',
      },
      items: [
        { name: 'Burger', quantity: 1, unitPrice: 1200, totalPrice: 1200 },
        { name: 'Salad', quantity: 1, unitPrice: 800, totalPrice: 800 },
        { name: 'Fries', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      guestCount: 1,
      joinCreator: true,
    });
    expect(created.ok(), await created.text()).toBe(true);
    const result = (await created.json()).result.data.json;
    token = result.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const guest = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Bob',
      joinKey: randomUUID(),
    });
    expect(guest.ok(), await guest.text()).toBe(true);
    const bob = (await guest.json()).result.data.json as { personId: string };
    for (const [itemIndex, personId] of [
      [0, bob.personId],
      [1, result.creator.personId],
      [2, bob.personId],
    ] as [number, string][]) {
      const assigned = await trpcMutation(owner, 'guest.setReceiptItemParts', {
        token,
        itemIndex,
        changes: [{ personId, parts: 1 }],
        requestKey: randomUUID(),
      });
      expect(assigned.ok(), await assigned.text()).toBe(true);
    }

    await loginWithPasskey(page, users.alice.email);
    await page.goto('/split/' + token + '/claim');
    await expect(page.getByTestId('dish-person-2-1')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
    await expect(page.getByTestId('dish-person-1-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid^="switch-person-"]')).toHaveCount(0);
    await expect(page.getByTestId('save-claims-btn')).toHaveCount(0);

    // Remove Bob from Fries, then add creator to the same dish, without affecting Burger.
    await page.getByTestId('dish-person-2-1').click();
    await expect(page.getByTestId('dish-person-2-1')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('dish-person-2-0').click();
    await expect(page.getByTestId('dish-person-2-0')).toHaveAttribute('aria-pressed', 'true');
    const saved = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(saved.assignments.find((item: { itemIndex: number }) => item.itemIndex === 0).personIndices).toEqual([1]);
    expect(saved.assignments.find((item: { itemIndex: number }) => item.itemIndex === 1).personIndices).toEqual([0]);
    expect(saved.assignments.find((item: { itemIndex: number }) => item.itemIndex === 2).personIndices).toEqual([0]);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await owner.dispose();
  }
});
