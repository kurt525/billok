import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation, trpcQuery, trpcResult } from './helpers';

async function signedPage(page: Page, email: string) {
  const api = await authedPasskeyContext(email);
  try {
    await page.context().addCookies((await api.storageState()).cookies);
  } finally {
    await api.dispose();
  }
}

async function newGroup(owner: APIRequestContext) {
  const res = await trpcMutation(owner, 'groups.create', { name: 'Архив и права ' + Date.now() });
  const body = await res.json();
  expect(res.ok(), JSON.stringify(body)).toBe(true);
  const groupId = body.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();
  const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
  const ownerId = (group.members as Array<{ user: { id: string; email: string } }>).find(
    (row) => row.user.email === 'alice@qa.billok.ru',
  )?.user.id;
  expect(ownerId).toBeTruthy();
  return { groupId, ownerId: ownerId! };
}

async function inviteMember(owner: APIRequestContext, member: APIRequestContext, groupId: string) {
  const invite = await trpcMutation(owner, 'groups.createInvite', { groupId });
  expect(invite.ok(), await invite.text()).toBe(true);
  const token = (await invite.json()).result?.data?.json?.token as string;
  expect(token).toBeTruthy();
  const joined = await trpcMutation(member, 'groups.joinByInvite', { token });
  expect(joined.ok(), await joined.text()).toBe(true);
}

async function newExpense(owner: APIRequestContext, groupId: string, ownerId: string) {
  const created = await trpcMutation(owner, 'expenses.create', {
    groupId,
    title: 'Расход перед архивом',
    amount: 12500,
    currency: 'RUB',
    paidById: ownerId,
    splitMode: 'EQUAL',
    shares: [{ userId: ownerId, amount: 12500 }],
  });
  const body = await created.json();
  expect(created.ok(), JSON.stringify(body)).toBe(true);
  const expenseId = body.result?.data?.json?.id as string;
  expect(expenseId).toBeTruthy();
  return expenseId;
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: archived RUB expense cannot be edited or deleted and direct entry pages show archive notice', async ({
  page,
}) => {
  const owner = await authedPasskeyContext('alice@qa.billok.ru');
  try {
    const { groupId, ownerId } = await newGroup(owner);
    const expenseId = await newExpense(owner, groupId, ownerId);
    const archive = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(archive.ok(), await archive.text()).toBe(true);
    await signedPage(page, 'alice@qa.billok.ru');

    await page.goto('/groups/' + groupId + '/expenses/' + expenseId);
    await expect(page.getByRole('heading', { name: 'Расход перед архивом' })).toBeVisible();
    await expect(
      page.getByText('Группа находится в архиве, поэтому этот расход нельзя изменить или удалить.'),
    ).toBeVisible();
    await expect(page.getByTestId('expense-detail-edit')).toHaveCount(0);
    await expect(page.getByTestId('expense-detail-delete')).toHaveCount(0);

    for (const route of ['expenses/new', 'expenses/' + expenseId + '/edit', 'scan', 'scan?receiptId=any']) {
      await page.goto('/groups/' + groupId + '/' + route);
      await expect(page.getByRole('heading', { name: 'Группа в архиве' }), route).toBeVisible();
      await expect(page.getByRole('link', { name: 'К группе' }), route).toBeVisible();
      await expect(page.locator('form'), route).toHaveCount(0);
    }
  } finally {
    await owner.dispose();
  }
});

test('9.3: ordinary member receives a Russian access error when deleting an expense owned by someone else', async ({
  page,
}) => {
  const owner = await authedPasskeyContext('alice@qa.billok.ru');
  const member = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    const { groupId, ownerId } = await newGroup(owner);
    await inviteMember(owner, member, groupId);
    const expenseId = await newExpense(owner, groupId, ownerId);
    await signedPage(page, 'bob@qa.billok.ru');
    await page.goto('/groups/' + groupId + '/expenses/' + expenseId);
    await expect(page.getByTestId('expense-detail-delete')).toBeVisible();
    await page.getByTestId('expense-detail-delete').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(
      page.getByText('Удалять расход могут только его создатель, плательщик, владелец группы или администратор.'),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp('/expenses/' + expenseId + '$'));
    const expense = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId }));
    expect(expense.id).toBe(expenseId);
  } finally {
    await member.dispose();
    await owner.dispose();
  }
});

test('9.3: archived group shows management to owner, but no restore action for ordinary member', async ({
  page,
  browser,
}) => {
  const owner = await authedPasskeyContext('alice@qa.billok.ru');
  const member = await authedPasskeyContext('bob@qa.billok.ru');
  const memberContext = await browser.newContext({
    viewport: { width: 320, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const { groupId } = await newGroup(owner);
    await inviteMember(owner, member, groupId);
    const archived = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(archived.ok(), await archived.text()).toBe(true);
    await signedPage(page, 'alice@qa.billok.ru');

    await page.goto('/groups/' + groupId);
    await expect(page.getByRole('link', { name: 'Управление' })).toBeVisible();
    await expect(page.getByText('Попросите владельца или администратора восстановить группу из архива.')).toHaveCount(
      0,
    );
    await page.goto('/groups/' + groupId + '/settings');
    await expect(page.getByRole('button', { name: 'Восстановить из архива' })).toBeVisible();

    const memberPage = await memberContext.newPage();
    await signedPage(memberPage, 'bob@qa.billok.ru');
    await memberPage.goto('/groups/' + groupId);
    await expect(
      memberPage.getByText('Попросите владельца или администратора восстановить группу из архива.'),
    ).toBeVisible();
    await expect(memberPage.getByRole('link', { name: 'Управление' })).toHaveCount(0);
    await memberPage.goto('/groups/' + groupId + '/settings');
    await expect(memberPage.getByText('Группа в архиве', { exact: true })).toBeVisible();
    await expect(
      memberPage.getByText('Попросите владельца или администратора восстановить группу из архива.'),
    ).toBeVisible();
    await expect(memberPage.getByRole('button', { name: 'Восстановить из архива' })).toHaveCount(0);
  } finally {
    await memberContext.close();
    await member.dispose();
    await owner.dispose();
  }
});
