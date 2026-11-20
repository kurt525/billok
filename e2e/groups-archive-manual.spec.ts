import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcError, trpcMutation, trpcQuery, trpcResult } from './helpers';

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

// Перенос API-защиты архива: только текущий API RUB + подписанные Passkey-сессии.
test('9.3: archive hides a group from active list and restore returns it', async ({ page }) => {
  await signedPage(page);
  const response = await trpcMutation(page.request, 'groups.create', { name: 'Архивный список ' + Date.now() });
  const created = await response.json();
  expect(response.ok(), JSON.stringify(created)).toBe(true);
  const groupId = created.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();

  const active = await trpcResult(await trpcQuery(page.request, 'groups.list'));
  expect((active as Array<{ id: string }>).some((g) => g.id === groupId)).toBe(true);
  const archived = await trpcMutation(page.request, 'groups.archive', { groupId });
  expect(archived.ok(), await archived.text()).toBe(true);
  expect((await archived.json()).result?.data?.json?.archivedAt).toBeTruthy();

  const list = await trpcResult(await trpcQuery(page.request, 'groups.list'));
  expect((list as Array<{ id: string }>).some((g) => g.id === groupId)).toBe(false);
  const archivedList = await trpcResult(await trpcQuery(page.request, 'groups.listArchived'));
  expect(
    (archivedList as Array<{ id: string; archivedAt: string | null }>).some((g) => g.id === groupId && !!g.archivedAt),
  ).toBe(true);

  const restored = await trpcMutation(page.request, 'groups.unarchive', { groupId });
  expect(restored.ok(), await restored.text()).toBe(true);
  expect((await restored.json()).result?.data?.json?.archivedAt).toBeNull();
  expect(
    ((await trpcResult(await trpcQuery(page.request, 'groups.list'))) as Array<{ id: string }>).some(
      (g) => g.id === groupId,
    ),
  ).toBe(true);
});

test('9.3: signed ordinary member cannot archive or restore a group', async () => {
  const owner = await authedPasskeyContext('alice@qa.billok.ru');
  const member = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    const result = await trpcMutation(owner, 'groups.create', { name: 'Архив и роль ' + Date.now() });
    const body = await result.json();
    expect(result.ok(), JSON.stringify(body)).toBe(true);
    const groupId = body.result?.data?.json?.id as string;
    const invitation = await trpcMutation(owner, 'groups.createInvite', { groupId });
    expect(invitation.ok(), await invitation.text()).toBe(true);
    const token = (await invitation.json()).result?.data?.json?.token as string;
    const joined = await trpcMutation(member, 'groups.joinByInvite', { token });
    expect(joined.ok(), await joined.text()).toBe(true);

    const deniedArchive = await trpcMutation(member, 'groups.archive', { groupId });
    expect(deniedArchive.ok()).toBe(false);
    expect((await trpcError(deniedArchive))?.data?.code).toBe('FORBIDDEN');
    const archived = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(archived.ok(), await archived.text()).toBe(true);
    const deniedRestore = await trpcMutation(member, 'groups.unarchive', { groupId });
    expect(deniedRestore.ok()).toBe(false);
    expect((await trpcError(deniedRestore))?.data?.code).toBe('FORBIDDEN');
    const restore = await trpcMutation(owner, 'groups.unarchive', { groupId });
    expect(restore.ok(), await restore.text()).toBe(true);
  } finally {
    await member.dispose();
    await owner.dispose();
  }
});

test('9.3: archived group rejects a new RUB expense and keeps expense list unchanged', async ({ page }) => {
  await signedPage(page);
  const create = await trpcMutation(page.request, 'groups.create', { name: 'Архив без расходов ' + Date.now() });
  const response = await create.json();
  expect(create.ok(), JSON.stringify(response)).toBe(true);
  const groupId = response.result?.data?.json?.id as string;
  const group = await trpcResult(await trpcQuery(page.request, 'groups.get', { groupId }));
  const payerId = (group.members as Array<{ user: { email: string; id: string } }>).find(
    (m) => m.user.email === 'bob@qa.billok.ru',
  )?.user.id;
  expect(payerId).toBeTruthy();

  const archive = await trpcMutation(page.request, 'groups.archive', { groupId });
  expect(archive.ok(), await archive.text()).toBe(true);
  const denied = await trpcMutation(page.request, 'expenses.create', {
    groupId,
    title: 'Не должен сохраниться',
    amount: 1000,
    currency: 'RUB',
    paidById: payerId,
    splitMode: 'EQUAL',
    shares: [{ userId: payerId, amount: 1000 }],
  });
  expect(denied.ok()).toBe(false);
  expect((await trpcError(denied))?.data?.code).toBe('BAD_REQUEST');
  const expenses = await trpcResult(await trpcQuery(page.request, 'expenses.list', { groupId }));
  expect(expenses.expenses).toHaveLength(0);
});
