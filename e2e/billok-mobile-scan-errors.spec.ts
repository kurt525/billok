import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const receiptId = process.env.BILLOK_MOBILE_GUEST_RECEIPT_ID;
const correctedReceiptId = process.env.BILLOK_MOBILE_GUEST_RESCAN_ID;
const sample = resolve('e2e/test-receipt.png');

async function checkWidth(page: Page, width: number) {
  const dimensions = await page.evaluate(() => ({
    window: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.window).toBe(width);
  expect(dimensions.document).toBeLessThanOrEqual(width + 1);
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('real anonymous photo upload validates file content and returns localized errors', async ({ page }) => {
  test.skip(!receiptId, 'Requires isolated CI guest receipt fixtures');
  test.setTimeout(65_000);
  await page.goto('/split', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const camera = page.getByTestId('guest-snap-upload').locator('input[type=file]');
  await expect(camera).toHaveAttribute('capture', 'environment');
  await expect(camera).toHaveAttribute('accept', /image\/jpeg/);
  await expect(page.getByTestId('guest-file-input')).toHaveAttribute('accept', /image\/png/);

  const invalid = await page.request.post('/api/upload?guest=true', {
    multipart: { file: { name: 'forged.png', mimeType: 'image/png', buffer: Buffer.from('%PDF1.7 not an image') } },
    headers: { 'x-locale': 'ru' },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error).toMatch(/[А-Яа-яЁё]/);

  const valid = await page.request.post('/api/upload?guest=true', {
    multipart: { file: { name: 'test-receipt.png', mimeType: 'image/png', buffer: readFileSync(sample) } },
    headers: { 'x-locale': 'ru' },
  });
  expect(valid.status()).toBe(200);
  const uploaded = await valid.json();
  expect(uploaded.receiptId).toMatch(/^[a-zA-Z0-9]+$/);
  expect(uploaded.imagePath).toMatch(/^receipts\//);
  await checkWidth(page, 320);
});

test('failed OCR can retry the same photo; failed correction shows an alert and a successful rescan replaces items', async ({
  page,
}) => {
  test.skip(!receiptId || !correctedReceiptId, 'Requires isolated original and corrected guest receipts');
  test.setTimeout(130_000);
  let scans = 0;
  let useCorrectedItems = false;
  const scanPayload = (corrected: boolean) => ({
    merchantName: corrected ? 'Повторно распознанный чек' : 'Гостевой тестовый чек',
    subtotal: corrected ? 12000 : 9000,
    tax: 0,
    tip: 0,
    total: corrected ? 12000 : 9000,
    currency: 'RUB',
  });

  await page.route('**/api/upload?guest=true', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ receiptId, imagePath: '' }),
    });
  });
  await page.route('**/api/trpc/guest.processReceipt*', async (route) => {
    scans++;
    if (scans === 1 || scans === 3) {
      await route.abort('failed');
      return;
    }
    if (scans === 4) useCorrectedItems = true;
    const result = { result: { data: { json: scanPayload(scans === 4) } } };
    const isBatch = new URL(route.request().url()).searchParams.get('batch') === '1';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isBatch ? [result] : result),
    });
  });
  await page.route('**/api/trpc/guest.getReceiptItems*', async (route) => {
    if (!useCorrectedItems) {
      await route.continue();
      return;
    }
    // Query the actual corrected fixture in PostgreSQL after a simulated rescan.
    const url = new URL(route.request().url());
    const inputs = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<string, { json: { receiptId: string } }>;
    const receiptInput = inputs['0'];
    if (!receiptInput) throw new Error('Expected batched guest receipt query');
    receiptInput.json.receiptId = correctedReceiptId!;
    url.searchParams.set('input', JSON.stringify(inputs));
    await route.continue({ url: url.toString() });
  });

  await page.goto('/split', { waitUntil: 'networkidle' });
  const fileInput = page.getByTestId('guest-file-input');
  await fileInput.setInputFiles(sample);
  await expect(page.getByTestId('guest-scan-error')).toContainText('Не удалось обработать чек');
  await expect(fileInput).toHaveJSProperty('value', '');
  await fileInput.setInputFiles(sample);
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await expect(page.getByTestId('guest-scan-error')).toHaveCount(0);
  await page.getByTestId('person-input-0').fill('Анна');
  await page.getByTestId('next-assign-btn').click();
  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(page.getByText('Суп', { exact: true })).toBeVisible();

  // Add a hand-entered item and assignments to verify old scan state is cleared.
  await page.getByTestId('guest-add-item-btn').click();
  const form = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form.locator('input').nth(0).fill('Старая позиция');
  await form.locator('input').nth(1).fill('1');
  await form.locator('input').nth(2).fill('12,50');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(page.getByText('Старая позиция', { exact: true })).toBeVisible();
  await page.getByTestId('guest-split-all-btn').click();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByTestId('guest-people-step')).toBeVisible();

  await page.setViewportSize({ width: 320, height: 460 });
  const openRescan = page.getByRole('button', { name: 'Повторить распознавание с исправлениями' });
  await openRescan.click();
  const hint = page.getByPlaceholder(/Например/);
  await hint.fill('На чеке каша и сок');
  const submit = page.getByRole('button', { name: 'Распознать повторно', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await checkWidth(page, 320);
  await submit.click();
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await expect(page.getByTestId('guest-scan-error')).toContainText('Не удалось обработать чек');
  await checkWidth(page, 320);

  await openRescan.click();
  await hint.fill('Второй проход: каша 2 шт., сок 1 шт.');
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await expect(page.getByTestId('guest-scan-error')).toHaveCount(0);
  await page.setViewportSize({ width: 412, height: 800 });
  await page.getByTestId('next-assign-btn').click();
  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(page.getByText('Каша', { exact: true })).toBeVisible();
  await expect(page.getByText('Сок', { exact: true })).toBeVisible();
  await expect(page.getByText('Старая позиция', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Суп', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Повторно распознанный чек')).toBeVisible();
  await expect(page.getByText(/0 из 2/)).toBeVisible();
  await checkWidth(page, 412);
  expect(scans).toBe(4);
});
