import { expect, test } from '@playwright/test';
import { loginWithPasskey } from './passkey-auth';
import { authedContext, trpcMutation, users } from './helpers';

test.use({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });

test('Issue 10.31: mobile tabs keep receipt data and draft edits', async ({ page }) => {
  const owner = await authedContext(users.alice.email, users.alice.password);
  try {
    const response = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Вкладки', subtotal: 800, tax: 0, tip: 0, total: 800, currency: 'RUB' },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 800, totalPrice: 800 }],
      guestCount: 0,
      joinCreator: true,
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { shareToken } = (await response.json()).result.data.json;
    await loginWithPasskey(page, users.alice.email);
    await page.goto('/split/' + shareToken + '/claim');
    await expect(page.getByTestId('claim-tab-items')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('receipt-item-edit-0').click();
    await page.getByTestId('receipt-item-name-0').fill('Новое название');
    await page.getByTestId('claim-tab-people').click();
    await expect(page.getByTestId('guest-color-person-0')).toBeVisible();
    await expect(page.getByTestId('claim-item-0')).toBeHidden();
    await page.getByTestId('claim-tab-items').click();
    await expect(page.getByTestId('receipt-item-name-0')).toHaveValue('Новое название');
    await page.getByTestId('receipt-item-cancel-0').click();
    for (const width of [320, 375, 720]) {
      await page.setViewportSize({ width, height: 740 });
      for (const tab of ['people', 'items']) {
        await page.getByTestId('claim-tab-' + tab).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
      }
    }
  } finally {
    await owner.dispose();
  }
});
