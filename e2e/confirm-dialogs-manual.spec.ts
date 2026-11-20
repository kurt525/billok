import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation, trpcQuery, trpcResult } from './helpers';

// Uses signed, isolated QA WebAuthn credentials.
async function signIn(page: Page) {
  const api = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await api.storageState()).cookies);
  } finally {
    await api.dispose();
  }
}
async function createGroup(page: Page, name: string) {
  const response = await trpcMutation(page.request, 'groups.create', { name: name + Date.now() });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  const id = body.result?.data?.json?.id as string;
  expect(id).toBeTruthy();
  return id;
}
async function manualReceipt(page: Page, groupId: string) {
  const created = await trpcMutation(page.request, 'receipts.createManual', { groupId });
  const body = await created.json();
  expect(created.ok(), JSON.stringify(body)).toBe(true);
  const receiptId = body.result?.data?.json?.receiptId as string;
  expect(receiptId).toBeTruthy();
  const item = await trpcMutation(page.request, 'receipts.addItem', {
    receiptId,
    name: 'Салат',
    quantity: 1,
    unitPrice: 35000,
    totalPrice: 35000,
  });
  expect(item.ok(), await item.text()).toBe(true);
  return receiptId;
}
function browserDialogs(page: Page) {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}
test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: group deletion asks in Russian; Escape and Cancel leave group intact', async ({ page }) => {
  await signIn(page);
  const native = browserDialogs(page);
  const groupId = await createGroup(page, 'Диалог группы ');
  await page.goto('/groups/' + groupId + '/settings');
  const trigger = page.getByTestId('mobile-group-delete-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await dialog.getByRole('button', { name: 'Удалить группу' }).click();
  await expect(page).toHaveURL(/\/groups(?:\?.*)?$/);
  expect(native).toEqual([]);
});

test('9.3: manual pending receipt survives cancellation and is deleted after confirmation', async ({ page }) => {
  await signIn(page);
  const native = browserDialogs(page);
  const groupId = await createGroup(page, 'Диалог чека ');
  const receiptId = await manualReceipt(page, groupId);
  const saved = await trpcMutation(page.request, 'receipts.saveForLater', { groupId, receiptId });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto('/groups/' + groupId);
  const trigger = page.getByRole('button', { name: 'Удалить чек' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(trigger).toBeVisible();
  const before = await trpcResult(await trpcQuery(page.request, 'receipts.listPending', { groupId }));
  expect((before as { id: string }[]).some((r) => r.id === receiptId)).toBe(true);
  await trigger.click();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(trigger).toHaveCount(0);
  const after = await trpcResult(await trpcQuery(page.request, 'receipts.listPending', { groupId }));
  expect((after as { id: string }[]).some((r) => r.id === receiptId)).toBe(false);
  expect(native).toEqual([]);
});

test('9.3: removing a manual receipt item names the item and requires confirmation', async ({ page }) => {
  await signIn(page);
  const native = browserDialogs(page);
  const groupId = await createGroup(page, 'Диалог позиции ');
  const receiptId = await manualReceipt(page, groupId);
  await page.goto('/groups/' + groupId + '/scan?receiptId=' + receiptId);
  const card = page.locator('[data-testid^="item-card-"]').filter({ has: page.getByText('Салат', { exact: true }) });
  await expect(card).toHaveCount(1);
  const remove = card.locator('button[title]').nth(1);
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Салат');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(card).toHaveCount(1);
  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(card).toHaveCount(0);
  const result = await trpcResult(await trpcQuery(page.request, 'receipts.getReceiptItems', { receiptId }));
  expect(result.items).toHaveLength(0);
  expect(native).toEqual([]);
});
