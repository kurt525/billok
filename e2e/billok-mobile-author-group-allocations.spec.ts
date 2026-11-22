import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { loginWithPasskey } from './passkey-auth';
import {
  authedContext,
  joinGuestSession,
  rememberClaimIdentity,
  trpcMutation,
  trpcQuery,
  trpcResult,
  users,
} from './helpers';

test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true });

test('Issue #19 13: author allocates dishes across groups, guest edits only own group', async ({ page, browser }) => {
  test.setTimeout(200_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const guestDevice = await browser.newContext({
    viewport: { width: 320, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | null = null;
  try {
    const createdResponse = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Чек с расчётными группами',
        subtotal: 180000,
        total: 180000,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [
        { name: 'Карбонара', quantity: 1, unitPrice: 40000, totalPrice: 40000 },
        { name: 'Пицца', quantity: 1, unitPrice: 60000, totalPrice: 60000 },
        { name: 'Пиво', quantity: 1, unitPrice: 80000, totalPrice: 80000 },
      ],
      people: ['Илья', 'Гость 1', 'Гость 2', 'Гость 3', 'Гость 4'],
      creatorName: 'Илья',
      paidByName: 'Гость 4',
      joinCreator: true,
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = (await createdResponse.json()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const id = (name: string) => (initial.people as { id: string; name: string }[]).find((p) => p.name === name)!.id;
    const ilya = id('Илья'),
      guest1 = id('Гость 1'),
      guest2 = id('Гость 2'),
      guest3 = id('Гость 3'),
      guest4 = id('Гость 4');
    expect(ilya).toBe(created.creator.personId);
    const grouped = await trpcMutation(owner, 'guest.setPaymentGroups', {
      token,
      groups: [
        { representativeId: guest1, memberIds: [guest1, guest2] },
        { representativeId: guest3, memberIds: [guest3, ilya] },
      ],
    });
    expect(grouped.ok(), await grouped.text()).toBe(true);
    await loginWithPasskey(page, users.alice.email);
    await rememberClaimIdentity(page.context(), token, created.creator);
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-tab-items')).toBeVisible({ timeout: 20_000 });
    for (const [itemIndex, targetIndex] of [
      [0, 2],
      [1, 3],
      [2, 1],
    ] as const) {
      const button = page.getByTestId('dish-person-' + itemIndex + '-' + targetIndex);
      await expect(button).toBeEnabled({ timeout: 20_000 });
      expect(await button.evaluate((el) => (el as HTMLElement).style.backgroundColor)).not.toBe('');
      await button.click();
      await expect
        .poll(
          async () => {
            const state = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
            return (
              state.assignments
                .find((a: { itemIndex: number }) => a.itemIndex === itemIndex)
                ?.personIndices.includes(targetIndex) ?? false
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    }
    for (let idx = 0; idx < 5; idx++) {
      const button = page.getByTestId('dish-person-0-' + idx);
      await expect(button).toBeEnabled();
      expect(await button.evaluate((el) => (el as HTMLElement).style.backgroundColor)).not.toBe('');
    }
    const representative = await joinGuestSession(guestDevice.request, { token, name: 'Гость 1' });
    await rememberClaimIdentity(guestDevice, token, representative);
    const guestPage = await guestDevice.newPage();
    await guestPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(guestPage.getByTestId('claim-tab-items')).toBeVisible({ timeout: 20_000 });
    for (const idx of [1, 2]) await expect(guestPage.getByTestId('dish-person-0-' + idx)).toBeEnabled();
    for (const idx of [0, 3, 4]) {
      const button = guestPage.getByTestId('dish-person-0-' + idx);
      await expect(button).toBeDisabled();
      expect(await button.evaluate((el) => (el as HTMLElement).style.backgroundColor)).toBe('');
    }
    const forbidden = await trpcMutation(guestDevice.request, 'guest.setReceiptItemParts', {
      token,
      personToken: representative.personToken,
      itemIndex: 0,
      changes: [{ personId: guest3, parts: 2 }],
      requestKey: randomUUID(),
    });
    expect(forbidden.ok()).toBe(false);
    const savedParts = await trpcMutation(owner, 'guest.setReceiptItemParts', {
      token,
      itemIndex: 2,
      changes: [{ personId: guest4, parts: 2 }],
      requestKey: randomUUID(),
    });
    expect(savedParts.ok(), await savedParts.text()).toBe(true);
    const saved = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(saved.assignments.find((a: { itemIndex: number }) => a.itemIndex === 2).partsByPersonId[guest4]).toBe(2);
    expect(saved.people.map((p: { id: string }) => p.id)).toEqual(initial.people.map((p: { id: string }) => p.id));
    expect(saved.people.find((p: { id: string }) => p.id === ilya).paymentGroupRepresentativeId).toBe(guest3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('dish-parts-count-2-4')).toContainText('2', { timeout: 20_000 });
    await page.addStyleTag({ content: 'html {font-size:20px !important;}' });
    for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 760 });
      for (let idx = 0; idx < 5; idx++) {
        const button = page.getByTestId('dish-person-0-' + idx);
        await expect(button).toBeEnabled();
        const box = await button.boundingBox();
        expect(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1).toBeTruthy();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await guestDevice.close();
    await owner.dispose();
  }
});
