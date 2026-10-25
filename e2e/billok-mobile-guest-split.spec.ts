import { expect, test, type Page } from '@playwright/test';

/** Signed-in creator, anonymous recipient: real persistence, no photo, OCR, or AI. */
async function fitsPhone(page: Page) {
  const { width, scrollWidth } = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(width + 1);
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('authenticated manual receipt: add, edit, allocate, share with a second anonymous device', async ({
  page,
  browser,
}) => {
  test.setTimeout(110_000);
  const remoteCalls: string[] = [];
  page.on('request', (request) => {
    if (/guest\.processReceipt|\/api\/upload|guest\.getUploadStatus|api\.openai/.test(request.url())) {
      remoteCalls.push(request.url());
    }
  });

  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('alice@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);

  await page.goto('/split', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('manual-split-title')).toContainText('Разделить чек');
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await expect(page.getByTestId('guest-file-input')).toHaveCount(0);
  await page.getByTestId('manual-receipt-name').fill('Ужин в кафе');
  await page.getByTestId('person-input-0').fill('Анна');
  await page.getByTestId('add-person-btn').click();
  await page.getByTestId('person-input-1').fill('Борис');
  await page.locator('#who-paid').selectOption('0');
  await page.getByTestId('next-assign-btn').click();
  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(page.getByTestId('manual-no-items')).toBeVisible();
  await expect(page.getByTestId('create-split-btn')).toBeDisabled();
  await fitsPhone(page);

  await page.getByTestId('guest-add-item-btn').click();
  const form = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form.locator('input').nth(0).fill('Суп');
  await form.locator('input').nth(1).fill('2');
  await form.locator('input').nth(2).fill('90,00');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(page.getByText('Суп', { exact: true })).toBeVisible();

  await page.getByTestId('guest-add-item-btn').click();
  const form2 = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form2.locator('input').nth(0).fill('Чай');
  await form2.locator('input').nth(1).fill('1');
  await form2.locator('input').nth(2).fill('20,50');
  await page.getByTestId('guest-add-item-submit').click();

  const soup = page.locator('[data-testid^="guest-item-card-"]').filter({
    has: page.getByText('Суп', { exact: true }),
  });
  await soup.locator('[data-testid^="guest-split-btn-"]').click();
  await soup.locator('[data-testid^="guest-split-qty-"]').fill('1');
  await soup.locator('[data-testid^="guest-split-submit-"]').click();
  await expect(page.getByText('Суп', { exact: true })).toHaveCount(2);

  await page.getByTestId('guest-split-all-btn').click();
  const tea = page.locator('[data-testid^="guest-item-card-"]').filter({
    has: page.getByText('Чай', { exact: true }),
  });
  // The second participant alone owes the tea.
  await tea.getByRole('button', { name: /Анна/ }).click();
  await expect(tea.getByRole('button', { name: /Анна/ })).not.toHaveClass(/bg-primary/);
  await expect(tea.getByRole('button', { name: /Борис/ })).toHaveClass(/bg-primary/);

  await page.setViewportSize({ width: 412, height: 460 });
  await fitsPhone(page);
  await page.getByTestId('create-split-btn').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('create-split-btn')).toBeEnabled();
  await page.getByTestId('create-split-btn').click();

  await expect(page).toHaveURL(/\/split\/[^/]+$/);
  await expect(page.getByTestId('split-result')).toBeVisible();
  await expect(page.getByText('Ужин в кафе').first()).toBeVisible();
  await expect(page.getByTestId('person-card-1')).toContainText('Чай');
  await expect(page.getByTestId('person-card-0')).not.toContainText('Чай');
  const shareUrl = page.url();

  const otherDevice = await browser.newContext({
    viewport: { width: 320, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const otherPage = await otherDevice.newPage();
    await otherPage.goto(shareUrl, { waitUntil: 'networkidle' });
    await expect(otherPage.getByTestId('split-result')).toBeVisible();
    await expect(otherPage.getByTestId('person-card-1')).toContainText('Чай');
    await fitsPhone(otherPage);
  } finally {
    await otherDevice.close();
  }

  expect(remoteCalls).toEqual([]);
});
