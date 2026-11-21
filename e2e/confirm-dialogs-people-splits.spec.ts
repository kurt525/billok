import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation } from './helpers';

async function signIn(page: Page) {
  const api = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await api.storageState()).cookies);
  } finally {
    await api.dispose();
  }
}

function recordNativeDialogs(page: Page) {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: removing a group placeholder requires confirmation and Cancel preserves it', async ({ page }) => {
  await signIn(page);
  const native = recordNativeDialogs(page);
  const created = await trpcMutation(page.request, 'groups.create', { name: 'Временный участник ' + Date.now() });
  const body = await created.json();
  expect(created.ok(), JSON.stringify(body)).toBe(true);
  const groupId = body.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();
  const added = await trpcMutation(page.request, 'groups.addPlaceholder', { groupId, name: 'Диана' });
  expect(added.ok(), await added.text()).toBe(true);

  await page.goto('/groups/' + groupId + '/settings');
  // В режиме редактирования имя находится в value input, а не в текстовом узле строки.
  const row = page.getByTestId('group-placeholder-row');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Переименовать участника Диана' }).click();
  await expect(row.locator('input')).toHaveValue('Диана');
  await expect(row.getByRole('button', { name: 'Сохранить имя' })).toBeVisible();
  await row.getByRole('button', { name: 'Отменить переименование' }).click();
  const remove = row.getByRole('button', { name: 'Удалить участника Диана' });
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Диана');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(native).toEqual([]);
});

test('9.3: deleting a RUB split requires confirmation and Cancel preserves it', async ({ page }) => {
  await signIn(page);
  const native = recordNativeDialogs(page);
  const merchantName = 'Чек для удаления ' + Date.now();
  const created = await trpcMutation(page.request, 'guest.createClaimSession', {
    receiptData: { merchantName, subtotal: 12500, tax: 0, tip: 0, total: 12500, currency: 'RUB' },
    items: [{ name: 'Обед', quantity: 1, unitPrice: 12500, totalPrice: 12500 }],
    guestCount: 0,
    joinCreator: true,
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto('/splits');
  const card = page.locator('[data-testid^="split-card-"]').filter({ hasText: merchantName });
  await expect(card).toBeVisible();
  const remove = card.getByRole('button', { name: 'Удалить чек' });
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Ссылка на него перестанет работать');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(card).toBeVisible();
  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(native).toEqual([]);
});
