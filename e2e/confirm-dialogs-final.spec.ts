import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { joinGuestSession, rememberClaimIdentity, trpcMutation, trpcQuery, trpcResult } from './helpers';

async function signIn(page: Page) {
  const ctx = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await ctx.storageState()).cookies);
  } finally {
    await ctx.dispose();
  }
}

function rejectNativeDialogs(page: Page) {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}

async function ensureReceiptTab(page: Page, tab: 'people' | 'items') {
  const control = page.getByTestId('claim-tab-' + tab);
  await expect(control).toBeVisible({ timeout: 20_000 });
  if ((await control.getAttribute('aria-selected')) !== 'true') await control.click();
  await expect(control).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#claim-' + tab + '-panel')).toBeVisible({ timeout: 10_000 });
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: deleting a RUB group expense confirms its name, Cancel preserves it', async ({ page }) => {
  await signIn(page);
  const native = rejectNativeDialogs(page);
  const response = await trpcMutation(page.request, 'groups.create', { name: 'Удаление расхода ' + Date.now() });
  const groupBody = await response.json();
  expect(response.ok(), JSON.stringify(groupBody)).toBe(true);
  const groupId = groupBody.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();
  const profile = await trpcResult(await trpcQuery(page.request, 'auth.getProfile'));
  const userId = profile.id as string;
  expect(userId).toBeTruthy();
  const title = 'Обед на двоих ' + Date.now();
  const expense = await trpcMutation(page.request, 'expenses.create', {
    groupId,
    title,
    amount: 12500,
    currency: 'RUB',
    paidById: userId,
    splitMode: 'EQUAL',
    shares: [{ userId, amount: 12500 }],
  });
  const expenseBody = await expense.json();
  expect(expense.ok(), JSON.stringify(expenseBody)).toBe(true);
  const expenseId = expenseBody.result?.data?.json?.id as string;
  expect(expenseId).toBeTruthy();

  await page.goto('/groups/' + groupId + '/expenses/' + expenseId);
  const remove = page.getByTestId('expense-detail-delete');
  await expect(remove).toBeVisible();
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(title);
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const stillThere = await trpcResult(await trpcQuery(page.request, 'expenses.get', { groupId, expenseId }));
  expect(stillThere.id).toBe(expenseId);

  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  const list = await trpcResult(await trpcQuery(page.request, 'expenses.list', { groupId }));
  expect((list.expenses as Array<{ id: string }>).some((e) => e.id === expenseId)).toBe(false);
  expect(native).toEqual([]);
});

test('9.3: organizer removes a joined person only after an in-page confirmation', async ({ page }) => {
  await signIn(page);
  const native = rejectNativeDialogs(page);
  const created = await trpcMutation(page.request, 'guest.createClaimSession', {
    receiptData: { merchantName: 'Семейный обед', subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'RUB' },
    items: [{ name: 'Чай', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    people: ['Анна', 'Борис', 'Катя'],
    creatorName: 'Анна',
    paidByName: 'Анна',
    joinCreator: true,
  });
  const body = await created.json();
  expect(created.ok(), JSON.stringify(body)).toBe(true);
  const token = body.result?.data?.json?.shareToken as string;
  const creator = body.result?.data?.json?.creator as { name: string; personToken: string };
  expect(token).toBeTruthy();
  expect(creator?.personToken).toBeTruthy();
  const guest = await joinGuestSession(page.request, { token, name: 'Борис' });
  await rememberClaimIdentity(page.context(), token, creator);
  await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('claim-people-panel')).toBeAttached({ timeout: 20_000 });

  // Editing a person's name is cancellable, and the icon buttons have accessible names.
  await ensureReceiptTab(page, 'people');
  await page.getByTestId('edit-person-1').click();
  await expect(page.getByTestId('edit-name-input-1')).toHaveValue('Борис');
  await expect(page.getByRole('button', { name: 'Сохранить имя' })).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await ensureReceiptTab(page, 'people');
  await expect(page.getByTestId('edit-person-1')).toBeVisible();

  const remove = page.getByTestId('remove-person-1');
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Борис');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  const before = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
  expect((before.people as Array<{ id: string }>).some((p) => p.id === guest.personId)).toBe(true);

  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect
    .poll(async () => {
      const session = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
      return (session.people as Array<{ id: string }>).some((p) => p.id === guest.personId);
    })
    .toBe(false);
  await expect(page.getByText('Участник удалён').first()).toBeVisible();
  expect(native).toEqual([]);
});
