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

test('manual receipt creator saves, reloads and clears optional original portions on six mobile widths', async ({
  page,
  browser,
}) => {
  test.skip(!groupId, 'Requires disposable RUB group fixture');
  test.setTimeout(180_000);

  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('bob@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/groups/' + groupId + '/expenses/new', { waitUntil: 'networkidle' });
  await page.getByTestId('create-manual-group-receipt').click();
  await expect(page).toHaveURL(/\/scan\?receiptId=/);
  const createdUrl = page.url();
  const createdReceiptId = new URL(createdUrl).searchParams.get('receiptId');
  expect(createdReceiptId).toBeTruthy();

  await page.getByTestId('add-item-btn').click();
  const add = page.getByTestId('add-item-form');
  await add.locator('input').nth(0).fill('Пицца 8 частей');
  await add.locator('input').nth(1).fill('1');
  await add.locator('input').nth(2).fill('80,00');
  await add.getByRole('button', { name: 'Добавить', exact: true }).click();
  const pizza = item(page, 'Пицца 8 частей');
  await expect(pizza).toHaveCount(1);
  await pizza.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Bob' }).click();
  await pizza.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Alice' }).click();
  await pizza.getByLabel('Частей: Bob').fill('3');
  await pizza.getByLabel('Частей: Alice').fill('5');

  const original = pizza.locator(
    '[data-testid^="item-total-parts-"]:not([data-testid*="-input-"]):not([data-testid*="-save-"]):not([data-testid*="-clear-"]):not([data-testid*="-progress-"])',
  );
  const originalInput = pizza.locator('[data-testid^="item-total-parts-input-"]');
  const originalSave = pizza.locator('[data-testid^="item-total-parts-save-"]');
  const originalProgress = pizza.locator('[data-testid^="item-total-parts-progress-"]');
  await expect(original).toHaveCount(1);
  await expect(originalInput).toHaveValue('');
  await expect(originalProgress).toContainText('Участниками учтено частей: 8');
  await expect(originalProgress).toContainText('Исходное количество частей не указано');

  await originalInput.fill('7');
  await expect(originalSave).toBeDisabled();
  await originalInput.fill('10');
  await expect(originalSave).toBeEnabled();
  await touchTarget(originalSave);
  await originalSave.click();
  await expect(originalInput).toHaveValue('10');
  await expect(originalProgress).toContainText('Осталось нераспределённых частей: 2');
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 520 });
    await originalInput.scrollIntoViewIfNeeded();
    const inputBounds = await originalInput.boundingBox();
    expect(inputBounds, 'Original parts input at ' + width).not.toBeNull();
    expect(inputBounds!.x).toBeGreaterThanOrEqual(-1);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(width + 1);
    await noDocumentOverflow(page);
  }

  // The existing Save for Later flow persists actual consumed parts. The
  // original total is independently saved in the receipt JSON.
  await page.getByTestId('save-for-later-btn').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await page.goto(createdUrl, { waitUntil: 'networkidle' });
  const restored = item(page, 'Пицца 8 частей');
  await expect(restored.locator('[data-testid^="item-total-parts-input-"]')).toHaveValue('10');
  await expect(restored.locator('[data-testid^="item-total-parts-progress-"]')).toContainText(
    'Участниками учтено частей: 8',
  );
  await expect(restored.locator('[data-testid^="item-total-parts-progress-"]')).toContainText(
    'Осталось нераспределённых частей: 2',
  );
  const data = await trpcResult(
    await trpcQuery(page.request, 'receipts.getReceiptItems', { receiptId: createdReceiptId }),
  );
  expect(Object.values(data.receipt.extractedData.declaredTotalPartsByItem)).toEqual([10]);
  expect(data.items).toHaveLength(1);
  expect(data.items[0].totalPrice).toBe(8000);

  // A different registered group member may adjust their own consumption but
  // cannot edit the creator-only original-total field.
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
    await alicePage.goto(createdUrl, { waitUntil: 'networkidle' });
    await expect(alicePage.getByTestId('item-assignment-form')).toBeVisible();
    await expect(alicePage.locator('[data-testid^="item-total-parts-input-"]')).toHaveCount(0);
  } finally {
    await aliceContext.close();
  }

  await restored.locator('[data-testid^="item-total-parts-clear-"]').click();
  await expect(restored.locator('[data-testid^="item-total-parts-input-"]')).toHaveValue('');
  await expect(restored.locator('[data-testid^="item-total-parts-progress-"]')).toContainText(
    'Исходное количество частей не указано',
  );
  await page.reload({ waitUntil: 'networkidle' });
  await expect(item(page, 'Пицца 8 частей').locator('[data-testid^="item-total-parts-input-"]')).toHaveValue('');
  const cleared = await trpcResult(
    await trpcQuery(page.request, 'receipts.getReceiptItems', { receiptId: createdReceiptId }),
  );
  expect(cleared.receipt.extractedData.declaredTotalPartsByItem).toEqual({});
  expect(cleared.items[0].totalPrice).toBe(8000);
});

test('Issue 2.16.3: manual group receipt balances two dishes and persists exact kopecks at six mobile widths', async ({
  page,
}) => {
  test.skip(!groupId, 'Requires disposable RUB group fixture');
  test.setTimeout(180_000);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('bob@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/groups/' + groupId + '/expenses/new', { waitUntil: 'networkidle' });
  await page.getByTestId('create-manual-group-receipt').click();
  await expect(page).toHaveURL(/\/scan\?receiptId=/);
  const receiptUrl = page.url();
  const createdReceiptId = new URL(receiptUrl).searchParams.get('receiptId');
  expect(createdReceiptId).toBeTruthy();

  for (const name of ['Блюдо А', 'Блюдо Б']) {
    await page.getByTestId('add-item-btn').click();
    const form = page.getByTestId('add-item-form');
    await form.locator('input').nth(0).fill(name);
    await form.locator('input').nth(1).fill('1');
    await form.locator('input').nth(2).fill('1,01');
    await form.getByRole('button', { name: 'Добавить', exact: true }).click();
    const card = item(page, name);
    await expect(card).toHaveCount(1);
    for (const [member, parts] of [
      ['Bob', '1'],
      ['Alice', '2'],
    ] as const) {
      await card.locator('[data-testid^="member-toggle-"]').filter({ hasText: member }).click();
      await card.getByLabel('Частей: ' + member).fill(parts);
    }
  }

  const totals = page.getByTestId('per-person-totals');
  await expect(page.getByTestId('group-parts-preliminary')).toContainText('Предварительный расчёт');
  for (const name of ['Блюдо А', 'Блюдо Б']) {
    const progress = item(page, name).locator('[data-testid^="item-total-parts-progress-"]');
    await expect(progress).toContainText('Участниками учтено частей: 3');
    await expect(progress).toContainText('Исходное количество частей не указано');
    await expect(progress).not.toContainText('Осталось нераспределённых');
  }
  await expect(totals).toContainText('0,67');
  await expect(totals).toContainText('1,35');
  await expect(page.getByTestId('manual-rounding-guidance')).toContainText('по всему чеку');
  // Release the focused mobile numeric field before resizing, just as a guest
  // would after entering their share. Otherwise the emulated visual viewport
  // can stay horizontally panned to that field when the keyboard closes.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
  });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 520 });
    // Touch/number inputs may keep the visual viewport panned after a resize.
    // Move vertically to this exact card, resetting the horizontal page pan
    // without allowing scrollIntoViewIfNeeded() to scroll sideways.
    const geometry = await totals.evaluate((element) => {
      const before = element.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + before.top - 72, left: 0, behavior: 'instant' });
      const after = element.getBoundingClientRect();
      const action = document.querySelector('[data-testid="group-share-claiming-btn"]');
      const actionBounds = action?.getBoundingClientRect();
      const iconBounds = action?.querySelector('svg')?.getBoundingClientRect();
      return {
        left: after.left,
        right: after.right,
        cardWidth: after.width,
        actionLeft: actionBounds?.left,
        actionRight: actionBounds?.right,
        iconLeft: iconBounds?.left,
        iconRight: iconBounds?.right,
        scrollX: window.scrollX,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    const description = ' at ' + width + 'px: ' + JSON.stringify(geometry);
    expect(geometry.viewportWidth, 'Viewport' + description).toBe(width);
    expect(geometry.documentWidth, 'Document width' + description).toBeLessThanOrEqual(width + 1);
    expect(geometry.left, 'Rounding card left' + description).toBeGreaterThanOrEqual(-1);
    expect(geometry.right, 'Rounding card right' + description).toBeLessThanOrEqual(width + 1);
    expect(geometry.actionLeft, 'Share action left' + description).toBeGreaterThanOrEqual(-1);
    expect(geometry.actionRight, 'Share action right' + description).toBeLessThanOrEqual(width + 1);
    expect(geometry.iconLeft, 'Share action icon left' + description).toBeGreaterThanOrEqual(-1);
    expect(geometry.iconRight, 'Share action icon right' + description).toBeLessThanOrEqual(width + 1);
    await noDocumentOverflow(page);
  }

  await page.getByTestId('save-for-later-btn').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await page.goto(receiptUrl, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('per-person-totals')).toContainText('0,67');
  await expect(page.getByTestId('per-person-totals')).toContainText('1,35');

  const response = await trpcResult(
    await trpcQuery(page.request, 'receipts.getReceiptItems', { receiptId: createdReceiptId }),
  );
  expect(response.items).toHaveLength(2);
  expect(response.items.reduce((sum: number, entry: { totalPrice: number }) => sum + entry.totalPrice, 0)).toBe(202);

  // A new manual bill has no merchant/title by default. HTML form
  // validation correctly prevents submission until this required field is set.
  await page.locator('#title').fill('Проверка округления 2.16.3');
  await expect(page.getByTestId('create-expense-btn')).toBeDisabled();
  const approval = page.getByTestId('group-parts-confirm-checkbox');
  await expect(approval).toBeEnabled();
  await approval.check();
  await expect(page.getByTestId('create-expense-btn')).toBeEnabled();
  await page.getByTestId('create-expense-btn').click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await expect
    .poll(
      async () => {
        const result = await trpcResult(await trpcQuery(page.request, 'expenses.list', { groupId }));
        return (result.expenses as { receiptId: string | null }[]).some(
          (expense) => expense.receiptId === createdReceiptId,
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const result = await trpcResult(await trpcQuery(page.request, 'expenses.list', { groupId }));
  const stored = (
    result.expenses as {
      receiptId: string | null;
      amount: number;
      currency: string;
      shares: { amount: number }[];
    }[]
  ).find((expense) => expense.receiptId === createdReceiptId);
  expect(stored).toBeTruthy();
  expect(stored!.currency).toBe('RUB');
  expect(stored!.amount).toBe(202);
  expect(stored!.shares.map((share) => share.amount).sort((a, b) => a - b)).toEqual([67, 135]);
  expect(stored!.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(202);
  expect(stored!.shares.every((share) => share.amount >= 0)).toBe(true);
});

test('two registered group members independently save voluntary RUB tips on a mobile manual receipt', async ({
  page,
  browser,
}) => {
  test.skip(!groupId, 'Requires disposable RUB group fixture');
  test.setTimeout(225_000);

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
    const longItemName = 'ДесертОченьДлинноеНазвание'.repeat(3);
    const longReceiptTitle = 'ЧекЗаСемейныйУжин'.repeat(4);
    await page.getByTestId('add-item-btn').click();
    const add = page.getByTestId('add-item-form');
    await add.locator('input').nth(0).fill(longItemName);
    await add.locator('input').nth(1).fill('1');
    await add.locator('input').nth(2).fill('10,01');
    await add.getByRole('button', { name: 'Добавить', exact: true }).click();
    const dessert = item(page, longItemName);
    await expect(dessert).toBeVisible();
    await dessert.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Alice' }).click();
    await dessert.locator('[data-testid^="member-toggle-"]').filter({ hasText: 'Bob' }).click();
    await page.locator('#title').fill(longReceiptTitle);
    // The creator Bob consumed this dish. A 1001-kopeck split 1:1 gives
    // Alice 500, Bob 500 for food plus an explicit 1-kopeck correction.
    // The correction is NOT another line item or another payment.
    await expect(page.getByTestId('group-rounding-correction-preview')).toContainText('0,01');
    await expect(page.getByTestId('group-rounding-correction-preview')).toContainText('Bob');
    const approval = page.getByTestId('group-parts-confirm-checkbox');
    const submit = page.getByTestId('create-expense-btn');
    await expect(submit).toBeDisabled();
    await approval.check();
    await expect(submit).toBeEnabled();
    const bobParts = dessert.getByLabel('Частей: Bob');
    await bobParts.fill('2');
    await expect(approval).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await bobParts.fill('1');
    await approval.check();
    await expect(submit).toBeEnabled();
    await submit.click();
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
    await expect(page.getByTestId('group-finalized-rounding-correction')).toContainText('0,01');
    await expect(page.getByTestId('group-finalized-rounding-correction')).toContainText('Bob');
    await expect(page.getByTestId('group-finalized-grand-total')).toContainText('11,51');
    await expect(page.getByText('Всего чаевых официанту')).toBeVisible();
    await expect(page.getByTestId('group-payer-own-share')).toContainText('5,01');
    await expect(page.getByTestId('group-payer-reimbursements-total')).toContainText('6,50');
    const payerReimbursements = page.locator('[data-testid^="group-payer-reimbursement-"]');
    await expect(payerReimbursements).toHaveCount(1);
    await expect(payerReimbursements).toContainText('6,50');
    await expect(payerReimbursements).toContainText('Alice');
    await expect(page.getByText('Возмещения плательщику по этому чеку')).toBeVisible();
    await expect(page.getByTestId('group-finalized-receipt-item')).toHaveCount(1);
    await expect(page.getByTestId('group-finalized-item-name')).toHaveText(longItemName);
    await expect(page.getByTestId('group-finalized-item-total')).toContainText('10,01');
    await expect(page.getByTestId('expense-detail-payer')).toContainText('Bob');
    await noDocumentOverflow(page);

    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 380 });
      await page.goto('/groups/' + groupId + '/expenses/' + finalized.id, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await expect(page.getByRole('heading', { name: longReceiptTitle })).toBeVisible();
      const dish = page.getByTestId('group-finalized-item-name');
      await expect(dish).toHaveText(longItemName);
      const itemSize = await dish.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      expect(itemSize.scroll, 'Completed receipt item at ' + width + 'px').toBeLessThanOrEqual(itemSize.client + 1);
      await expect(page.getByTestId('group-finalized-grand-total')).toContainText('11,51');
      await expect(page.getByTestId('group-finalized-tip-total')).toContainText('1,50');
      await expect(page.getByTestId('expense-detail-payer')).toContainText('Bob');
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      expect(layout.viewport, 'Viewport expanded at ' + width + 'px').toBe(width);
      expect(layout.documentWidth, 'Document overflow at ' + width + 'px').toBeLessThanOrEqual(width + 1);
      expect(layout.bodyWidth, 'Body overflow at ' + width + 'px').toBeLessThanOrEqual(width + 1);
      for (const control of [
        page.getByTestId('expense-detail-back'),
        page.getByTestId('expense-detail-edit'),
        page.getByTestId('expense-detail-delete'),
      ]) {
        await touchTarget(control);
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x, 'Control left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width, 'Control right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
      }
      await page.getByTestId('expense-detail-back').click();
      await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
      await expect(page.locator('a[href="/groups/' + groupId + '/expenses/' + finalized.id + '"]')).toBeVisible();
    }
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
