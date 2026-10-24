import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Anonymous guest split with genuine server-side persistence and retrieval.
 * Only the external OCR/upload boundary is simulated; the source receipt is a
 * real, already processed row in the disposable CI PostgreSQL database.
 */
const receiptId = process.env.BILLOK_MOBILE_GUEST_RECEIPT_ID;
const sampleImage = resolve('e2e/test-receipt.png');

function item(page: Page, name: string): Locator {
  return page.locator('[data-testid^="guest-item-card-"]').filter({
    has: page.getByText(name, { exact: true }),
  });
}

async function noHorizontalScroll(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function tapTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const size = await locator.boundingBox();
  expect(size?.width).toBeGreaterThanOrEqual(44);
  expect(size?.height).toBeGreaterThanOrEqual(44);
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('anonymous mobile guest: add/edit/split/assign, save and share result without login', async ({
  page,
  browser,
}) => {
  test.skip(!receiptId, 'Requires disposable guest receipt seeded for CI');
  test.setTimeout(170_000);

  await page.route('**/api/upload?guest=true', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ receiptId, imagePath: '' }),
    });
  });
  await page.route('**/api/trpc/guest.processReceipt*', async (route) => {
    const payload = {
      merchantName: 'Гостевой тестовый чек',
      subtotal: 9000,
      tax: 0,
      tip: 0,
      total: 9000,
      currency: 'RUB',
    };
    const isBatch = new URL(route.request().url()).searchParams.get('batch') === '1';
    const result = { result: { data: { json: payload } } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isBatch ? [result] : result),
    });
  });

  // Explicitly remain anonymous throughout the browser workflow.
  await page.goto('/split', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('guest-gallery-upload')).toBeVisible();
  await page.getByTestId('guest-file-input').setInputFiles(sampleImage);
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await page.getByTestId('person-input-0').fill('Анна');
  await page.getByTestId('add-person-btn').click();
  await page.getByTestId('person-input-1').fill('Борис');
  await page.locator('#who-paid').selectOption('0');
  await page.getByTestId('next-assign-btn').click();
  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(item(page, 'Суп')).toHaveCount(1);
  await expect(item(page, 'Чай')).toHaveCount(1);
  await noHorizontalScroll(page);

  const add = page.getByTestId('guest-add-item-btn');
  await tapTarget(add);
  await add.click();
  const form = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByTestId('guest-add-item-submit')).toHaveCount(0);

  await add.click();
  const form2 = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form2.locator('input').nth(0).fill('Булочка');
  await form2.locator('input').nth(1).fill('0');
  await form2.locator('input').nth(2).fill('15,50');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(item(page, 'Булочка')).toHaveCount(0);
  await form2.locator('input').nth(1).fill('3');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(item(page, 'Булочка')).toHaveCount(1);

  // Stable index selector: item name becomes an editable input in edit mode.
  const bunId = await item(page, 'Булочка').getAttribute('data-testid');
  expect(bunId).toBeTruthy();
  const bun = page.getByTestId(bunId!);
  await tapTarget(bun.locator('button[title]').first());
  await bun.locator('button[title]').first().click();
  await bun.locator('input').nth(0).fill('Черновик');
  await bun.getByRole('button', { name: 'Отмена' }).click();
  await expect(item(page, 'Черновик')).toHaveCount(0);
  await bun.locator('button[title]').first().click();
  await bun.locator('input').nth(0).fill('Булочка с маком');
  await bun.locator('input').nth(1).fill('3');
  await bun.locator('input').nth(2).fill('18,90');
  await bun.getByRole('button', { name: 'Сохранить' }).click();
  await expect(item(page, 'Булочка с маком')).toHaveCount(1);
  await expect(item(page, 'Булочка с маком')).toContainText('x3');

  const soup = item(page, 'Суп');
  await tapTarget(soup.locator('[data-testid^="guest-split-btn-"]'));
  await soup.locator('[data-testid^="guest-split-btn-"]').click();
  await soup.getByRole('button', { name: 'Отмена' }).click();
  await expect(item(page, 'Суп')).toHaveCount(1);
  await soup.locator('[data-testid^="guest-split-btn-"]').click();
  await soup.locator('[data-testid^="guest-split-qty-"]').fill('1');
  await soup.locator('[data-testid^="guest-split-submit-"]').click();
  await expect(item(page, 'Суп')).toHaveCount(2);

  await page.getByTestId('guest-split-all-btn').click();
  await expect(page.getByTestId('create-split-btn')).toBeEnabled();
  // Change the added item's allocation: Boris alone, not the default both people.
  const annaChip = item(page, 'Булочка с маком').locator('button').filter({ hasText: 'Анна' });
  const borisChip = item(page, 'Булочка с маком').locator('button').filter({ hasText: 'Борис' });
  await tapTarget(annaChip.first());
  await annaChip.first().click();
  await expect(annaChip.first()).not.toHaveClass(/bg-primary/);
  await expect(borisChip.first()).toHaveClass(/bg-primary/);
  await noHorizontalScroll(page);

  await page.setViewportSize({ width: 412, height: 460 });
  await page.getByTestId('create-split-btn').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('create-split-btn')).toBeInViewport();
  await noHorizontalScroll(page);
  await page.getByTestId('create-split-btn').click();

  await expect(page).toHaveURL(/\/split\/[^/]+$/);
  await expect(page.getByTestId('split-result')).toBeVisible();
  await expect(page.getByText('Гостевой тестовый чек').first()).toBeVisible();
  await expect(page.getByTestId('person-card-0')).toContainText('Анна');
  await expect(page.getByTestId('person-card-1')).toContainText('Борис');
  await expect(page.getByTestId('person-card-0')).not.toContainText('Булочка с маком');
  await expect(page.getByTestId('person-card-1')).toContainText('Булочка с маком');
  const resultUrl = page.url();

  // A brand new browser context with no cookies can open the actual persisted result.
  const anonymous = await browser.newContext({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  try {
    const secondDevice = await anonymous.newPage();
    await secondDevice.goto(resultUrl, { waitUntil: 'networkidle' });
    await expect(secondDevice.getByTestId('split-result')).toBeVisible();
    await expect(secondDevice.getByTestId('person-card-0')).toContainText('Анна');
    await expect(secondDevice.getByTestId('person-card-1')).toContainText('Борис');
    await noHorizontalScroll(secondDevice);
  } finally {
    await anonymous.close();
  }
});
