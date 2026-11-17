import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation, trpcQuery, trpcResult } from './helpers';

async function signedPage(page: Page) {
  const ctx = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await ctx.storageState()).cookies);
  } finally {
    await ctx.dispose();
  }
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: archived group preserves its manually saved receipt, prevents finishing it, allows deletion', async ({
  page,
}) => {
  await signedPage(page);

  const group = await trpcMutation(page.request, 'groups.create', { name: 'Архив и ручной чек ' + Date.now() });
  const groupBody = await group.json();
  expect(group.ok(), JSON.stringify(groupBody)).toBe(true);
  const groupId = groupBody.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();

  const created = await trpcMutation(page.request, 'receipts.createManual', { groupId });
  const receiptBody = await created.json();
  expect(created.ok(), JSON.stringify(receiptBody)).toBe(true);
  const receiptId = receiptBody.result?.data?.json?.receiptId as string;
  expect(receiptId).toBeTruthy();

  const item = await trpcMutation(page.request, 'receipts.addItem', {
    receiptId,
    name: 'Плов',
    quantity: 1,
    unitPrice: 12500,
    totalPrice: 12500,
  });
  expect(item.ok(), await item.text()).toBe(true);

  const saved = await trpcMutation(page.request, 'receipts.saveForLater', { groupId, receiptId });
  expect(saved.ok(), await saved.text()).toBe(true);
  const pendingBefore = await trpcResult(await trpcQuery(page.request, 'receipts.listPending', { groupId }));
  expect((pendingBefore as Array<{ id: string }>).some((r) => r.id === receiptId)).toBe(true);

  const archived = await trpcMutation(page.request, 'groups.archive', { groupId });
  expect(archived.ok(), await archived.text()).toBe(true);
  const freshReceipt = await trpcMutation(page.request, 'receipts.createManual', { groupId });
  expect(freshReceipt.ok(), 'Archived group must reject new receipts').toBe(false);

  await page.goto('/groups/' + groupId, { waitUntil: 'networkidle' });
  await expect(page.locator('a[href*="receiptId=' + receiptId + '"]')).toHaveCount(0);
  // Deletion remains available even though editing would produce a new expense.
  const remove = page.getByRole('button', { name: 'Удалить чек' });
  await expect(remove).toBeVisible();
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  expect((await trpcResult(await trpcQuery(page.request, 'receipts.listPending', { groupId }))).length).toBe(1);

  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(remove).toHaveCount(0);
  const pendingAfter = await trpcResult(await trpcQuery(page.request, 'receipts.listPending', { groupId }));
  expect((pendingAfter as Array<{ id: string }>).some((r) => r.id === receiptId)).toBe(false);

  const restored = await trpcMutation(page.request, 'groups.unarchive', { groupId });
  expect(restored.ok(), await restored.text()).toBe(true);
});
