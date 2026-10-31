import { expect, test, type Locator, type Page } from '@playwright/test';
import { trpcQuery, trpcResult } from './helpers';

/**
 * Real mobile interaction and persistence (no AI/OCR, no production accounts).
 * Runs only with receipts generated in a disposable CI PostgreSQL database.
 */
const groupId = process.env.BILLOK_MOBILE_GROUP_ID;
const receiptId = process.env.BILLOK_MOBILE_RECEIPT_ID;
const receiptUrl = groupId && receiptId ? `/groups/${groupId}/scan?receiptId=${receiptId}` : null;

const item = (page: Page, name: string): Locator =>
  page.locator('[data-testid^="item-card-"]').filter({ has: page.getByText(name, { exact: true }) });

async function noDocumentOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function touchTarget(button: Locator) {
  await expect(button).toBeVisible();
  const rect = await button.boundingBox();
  expect(rect?.height).toBeGreaterThanOrEqual(44);
  expect(rect?.width).toBeGreaterThanOrEqual(44);
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('group receipt: add, edit, cancel, split, assign, save, delete and finalize', async ({ page }) => {
  test.skip(!receiptUrl, 'Requires isolated BILLOK_MOBILE_RECEIPT_ID and GROUP_ID fixture');
  test.setTimeout(180_000);

  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('bob@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto(receiptUrl!, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('item-assignment-form')).toBeVisible();
  // Historical photo receipts remain readable, but OCR/upload/retry are no longer available.
  await expect(page.getByTestId('scan-rescan-btn')).toHaveCount(0);
  await expect(page.getByTestId('scan-file-input')).toHaveCount(0);
  await expect(item(page, 'Суп')).toHaveCount(1);
  await expect(item(page, 'Чай')).toHaveCount(1);
  await noDocumentOverflow(page);

  // Both cancel and add work on narrow screens.
  await touchTarget(page.getByTestId('add-item-btn'));
  await page.getByTestId('add-item-btn').click();
  const addForm = page.getByTestId('add-item-form');
  await expect(addForm).toBeVisible();
  await addForm.getByRole('button', { name: 'Отмена' }).click();
  await expect(addForm).toHaveCount(0);

  await page.getByTestId('add-item-btn').click();
  await addForm.locator('input').nth(0).fill('Булочка');
  await addForm.locator('input').nth(1).fill('0');
  await addForm.locator('input').nth(2).fill('15,50');
  await addForm.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(item(page, 'Булочка')).toHaveCount(0);

  await addForm.locator('input').nth(1).fill('2');
  await addForm.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(item(page, 'Булочка')).toHaveCount(1);
  await expect(item(page, 'Булочка')).toContainText('15,50');
  await noDocumentOverflow(page);

  const bunTestId = await item(page, 'Булочка').getAttribute('data-testid');
  expect(bunTestId).toBeTruthy();
  const bun = page.getByTestId(bunTestId!);
  await touchTarget(bun.locator('button[title]').first());
  await bun.locator('button[title]').first().click();
  await bun.locator('input').nth(0).fill('Черновик');
  await bun.getByRole('button', { name: 'Отмена' }).click();
  await expect(item(page, 'Черновик')).toHaveCount(0);

  await bun.locator('button[title]').first().click();
  await bun.locator('input').nth(0).fill('Булочка большая');
  await bun.locator('input').nth(1).fill('3');
  await bun.locator('input').nth(2).fill('18,90');
  await bun.getByRole('button', { name: 'Сохранить' }).click();
  const updated = item(page, 'Булочка большая');
  await expect(updated).toHaveCount(1);
  await expect(updated).toContainText('x3');
  await expect(updated).toContainText('18,90');

  // Splitting a quantity uses real mutation and preserves the total in cents.
  const soup = item(page, 'Суп');
  await touchTarget(soup.locator('[data-testid^="split-btn-"]'));
  await soup.locator('[data-testid^="split-btn-"]').click();
  await page.getByTestId('split-form').getByRole('button', { name: 'Отмена' }).click();
  await expect(item(page, 'Суп')).toHaveCount(1);
  await soup.locator('[data-testid^="split-btn-"]').click();
  await page.getByTestId('split-qty-input').fill('1');
  await page.getByTestId('split-submit').click();
  await expect(item(page, 'Суп')).toHaveCount(2);
  await noDocumentOverflow(page);

  // Assign a real group member to the new item.
  const bobChip = updated.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Bob' }).first();
  await touchTarget(bobChip);
  await bobChip.click();
  await expect(bobChip).toHaveClass(/bg-primary/);

  // Persist and reload: the item and member assignment must survive.
  await page.getByTestId('save-for-later-btn').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await page.setViewportSize({ width: 412, height: 800 });
  await page.goto(receiptUrl!, { waitUntil: 'networkidle' });
  await expect(item(page, 'Булочка большая')).toHaveCount(1);
  await expect(
    item(page, 'Булочка большая').locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Bob' }),
  ).toHaveClass(/bg-primary/);
  await noDocumentOverflow(page);

  // Destructive action must be cancellable and only delete on explicit confirmation.
  const persisted = item(page, 'Булочка большая');
  await touchTarget(persisted.locator('button[title]').nth(1));
  await persisted.locator('button[title]').nth(1).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(item(page, 'Булочка большая')).toHaveCount(1);
  await persisted.locator('button[title]').nth(1).click();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(item(page, 'Булочка большая')).toHaveCount(0);

  // Complete the receipt and verify the newly created expense in the group.
  await page.getByTestId('split-all-btn').click();
  await expect(page.getByTestId('create-expense-btn')).toBeEnabled();
  await page.getByTestId('create-expense-btn').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await expect(page.getByText('Тестовый чек', { exact: true }).first()).toBeVisible();
});

test('two registered group members independently save voluntary RUB tips on a mobile manual receipt', async ({
  page,
  browser,
}) => {
  test.skip(!groupId, 'Requires disposable RUB group fixture');
  test.setTimeout(165_000);

  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('bob@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/groups/' + groupId + '/expenses/new', { waitUntil: 'networkidle' });
  await page.getByTestId('create-manual-group-receipt').click();
  await expect(page).toHaveURL(/\/scan\?receiptId=/);
  const receiptUrl = page.url();
  const newReceiptId = new URL(receiptUrl).searchParams.get('receiptId');
  expect(newReceiptId).toBeTruthy();

  const bobTip = page.getByTestId('group-personal-tip-input');
  const bobSave = page.getByTestId('group-personal-tip-save');
  await expect(bobTip).toHaveValue('0.00');
  await expect(bobSave).toBeDisabled();
  await bobTip.fill('-2');
  await expect(bobSave).toBeDisabled();
  await bobTip.fill('1,235');
  await expect(bobSave).toBeDisabled();
  await bobTip.fill('2,75');
  await touchTarget(bobSave);
  await bobSave.click();
  await expect(bobTip).toHaveValue('2.75', { timeout: 15_000 });
  await expect(bobSave).toBeDisabled();
  await expect(page.getByTestId('group-personal-tip-list')).toContainText('2,75');
  await noDocumentOverflow(page);

  const aliceContext = await browser.newContext({
    viewport: { width: 320, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const alicePage = await aliceContext.newPage();
    await alicePage.goto('/login', { waitUntil: 'networkidle' });
    await alicePage.locator('input[type=email]').fill('alice@example.com');
    await alicePage.locator('input[type=password]').fill('password123');
    await alicePage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(alicePage).toHaveURL(/\/dashboard/);
    await alicePage.goto(receiptUrl, { waitUntil: 'networkidle' });
    const aliceTip = alicePage.getByTestId('group-personal-tip-input');
    // Alice can see Bob's already saved tip, but cannot edit it.
    await expect(alicePage.getByTestId('group-personal-tip-list')).toContainText('2,75');
    await expect(aliceTip).toHaveValue('0.00');
    await aliceTip.fill('1,50');
    await alicePage.getByTestId('group-personal-tip-save').click();
    await expect(aliceTip).toHaveValue('1.50', { timeout: 15_000 });
    await noDocumentOverflow(alicePage);

    const receipt = await trpcResult(
      await trpcQuery(page.request, 'receipts.getReceiptItems', {
        receiptId: newReceiptId,
      }),
    );
    const tips = Object.values(receipt.receipt.extractedData.personalTips as Record<string, number>).sort(
      (a, b) => a - b,
    );
    expect(tips).toEqual([150, 275]);
    // Bob's open tab must observe Alice's update WITHOUT a reload. The
    // server updates only Alice's record and Bob's own input stays unchanged.
    await expect(
      page.locator('[data-testid^="group-personal-tip-member-"]').filter({ hasText: 'Alice' }),
    ).toContainText('1,50', { timeout: 15_000 });
    await expect(bobTip).toHaveValue('2.75');
    await bobTip.fill('0');
    await bobSave.click();
    await expect(bobTip).toHaveValue('0.00', { timeout: 15_000 });
    // Conversely Alice's open tab sees Bob's updated amount without a reload.
    await expect(
      alicePage.locator('[data-testid^="group-personal-tip-member-"]').filter({ hasText: 'Bob' }),
    ).toContainText('0,00', { timeout: 15_000 });
    await expect(aliceTip).toHaveValue('1.50');
    await noDocumentOverflow(page);
    const updated = await trpcResult(
      await trpcQuery(page.request, 'receipts.getReceiptItems', {
        receiptId: newReceiptId,
      }),
    );
    expect(
      Object.values(updated.receipt.extractedData.personalTips as Record<string, number>).sort((a, b) => a - b),
    ).toEqual([0, 150]);

    // Finalize a real manual receipt with both diners assigned a dish.
    // Bob is the creator/payer and chooses 0 RUB; Alice chooses 1.50 RUB.
    await page.getByTestId('add-item-btn').click();
    const add = page.getByTestId('add-item-form');
    await add.locator('input').nth(0).fill('Десерт');
    await add.locator('input').nth(1).fill('1');
    await add.locator('input').nth(2).fill('10,01');
    await add.getByRole('button', { name: 'Добавить', exact: true }).click();
    const dessert = item(page, 'Десерт');
    await expect(dessert).toBeVisible();
    await dessert.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Alice' }).click();
    await dessert.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Bob' }).click();
    await page.locator('#title').fill('Десерт с личными чаевыми');
    await page.getByTestId('create-expense-btn').click();
    await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'), { timeout: 20_000 });

    const response = await trpcResult(await trpcQuery(page.request, 'expenses.list', { groupId, limit: 100 }));
    const finalized = response.expenses.find((expense: { receiptId?: string }) => expense.receiptId === newReceiptId);
    expect(finalized).toBeTruthy();
    expect(finalized.amount).toBe(1151);
    const shares = finalized.shares
      .map((share: { amount: number }) => share.amount)
      .sort((a: number, b: number) => a - b);
    expect(shares).toEqual([501, 650]);

    await page.goto('/groups/' + groupId + '/expenses/' + finalized.id, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('manual-group-payer-summary')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('group-finalized-food-total')).toContainText('10,01');
    await expect(page.getByTestId('group-finalized-tip-total')).toContainText('1,50');
    await expect(page.getByTestId('group-finalized-grand-total')).toContainText('11,51');
    await expect(page.getByText('Всего чаевых официанту')).toBeVisible();
    await expect(page.getByTestId('group-payer-own-share')).toContainText('5,01');
    await expect(page.getByTestId('group-payer-reimbursements-total')).toContainText('6,50');
    const payerReimbursements = page.locator('[data-testid^="group-payer-reimbursement-"]');
    await expect(payerReimbursements).toHaveCount(1);
    await expect(payerReimbursements).toContainText('6,50');
    await expect(payerReimbursements).toContainText('Alice');
    await expect(page.getByText('Возмещения плательщику по этому чеку')).toBeVisible();
    await noDocumentOverflow(page);
  } finally {
    await aliceContext.close();
  }
});

test('manual group bill starts without upload and keeps its positions', async ({ page }) => {
  test.skip(!groupId, 'Requires disposable RUB group fixture');
  test.setTimeout(110_000);
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/upload|receipts\.processReceipt|api\.openai/.test(r.url())) uploads.push(r.url());
  });
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('bob@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/groups/' + groupId + '/expenses/new', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('manual-group-receipt-entry')).toBeVisible();
  await page.getByTestId('create-manual-group-receipt').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '/scan\\?receiptId=[^/]+$'));
  await expect(page.getByRole('heading', { name: 'Ручной групповой чек' })).toBeVisible();
  await expect(page.getByTestId('item-assignment-form')).toBeVisible();
  await expect(page.getByTestId('scan-file-input')).toHaveCount(0);
  await expect(page.getByTestId('scan-rescan-btn')).toHaveCount(0);
  const savedUrl = page.url();
  await page.getByTestId('add-item-btn').click();
  const form = page.getByTestId('add-item-form');
  await form.locator('input').nth(0).fill('Пицца');
  await form.locator('input').nth(1).fill('2');
  await form.locator('input').nth(2).fill('330,40');
  await form.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(item(page, 'Пицца')).toHaveCount(1);
  const pizza = item(page, 'Пицца');
  const toggles = pizza.locator('[data-testid^="member-toggle-"]');
  await toggles.nth(0).click();
  await toggles.nth(1).click();
  const portions = pizza.locator('[data-testid^="item-parts-"]');
  await expect(portions).toHaveCount(2);
  await portions.nth(0).fill('3');
  await portions.nth(1).fill('5');
  await page.getByTestId('save-for-later-btn').scrollIntoViewIfNeeded();
  await page.getByTestId('save-for-later-btn').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await page.goto(savedUrl, { waitUntil: 'networkidle' });
  await expect(item(page, 'Пицца')).toHaveCount(1);
  const restored = item(page, 'Пицца').locator('[data-testid^="item-parts-"]');
  await expect(restored).toHaveCount(2);
  await expect(restored.nth(0)).toHaveValue('3');
  await expect(restored.nth(1)).toHaveValue('5');
  expect(uploads).toEqual([]);
});
