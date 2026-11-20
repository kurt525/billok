import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation, trpcQuery, trpcResult } from './helpers';

async function signIn(page: Page) {
  const session = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await session.storageState()).cookies);
  } finally {
    await session.dispose();
  }
}

async function newGroup(page: Page, title: string) {
  const created = await trpcMutation(page.request, 'groups.create', { name: title });
  const body = await created.json();
  expect(created.ok(), JSON.stringify(body)).toBe(true);
  const groupId = body.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();
  return groupId;
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: archive confirmation moves a group from active to archive view on mobile', async ({ page }) => {
  await signIn(page);
  // Keep another active group so the archive filter is available on a newly created QA account.
  await newGroup(page, 'Активная группа архива ' + Date.now());
  const name = 'Архивная группа UI ' + Date.now();
  const groupId = await newGroup(page, name);

  await page.goto('/groups/' + groupId + '/settings');
  const archive = page.getByRole('button', { name: 'Архивировать группу', exact: true });
  await expect(archive).toBeVisible();
  await archive.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Архивировать группу?');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  const stillActive = await trpcResult(await trpcQuery(page.request, 'groups.get', { groupId }));
  expect(stillActive.archivedAt).toBeNull();

  await archive.click();
  await dialog.getByRole('button', { name: 'Архивировать группу', exact: true }).click();
  await expect(page).toHaveURL(/\/groups(?:\?.*)?$/);
  const search = page.getByTestId('mobile-groups-search');
  await expect(search).toBeVisible();
  await search.fill(name);
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);

  await page.getByTestId('mobile-groups-archived-toggle').click();
  const row = page.getByRole('link').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp('/groups/' + groupId + '$'));
  await expect(page.getByText('Группа находится в архиве.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Добавить расход' })).toHaveCount(0);
});

test('9.3: archived group can be restored from Russian settings to active list', async ({ page }) => {
  await signIn(page);
  const name = 'Восстановление группы UI ' + Date.now();
  const groupId = await newGroup(page, name);
  const archived = await trpcMutation(page.request, 'groups.archive', { groupId });
  expect(archived.ok(), await archived.text()).toBe(true);

  await page.goto('/groups/' + groupId + '/settings');
  const archivedMessage = page.getByText('Группа в архиве', { exact: true });
  await expect(archivedMessage).toBeVisible();
  await page.getByRole('button', { name: 'Восстановить из архива' }).click();
  await expect(archivedMessage).toHaveCount(0);
  const restored = await trpcResult(await trpcQuery(page.request, 'groups.get', { groupId }));
  expect(restored.archivedAt).toBeNull();

  await page.goto('/groups');
  await page.getByTestId('mobile-groups-search').fill(name);
  await expect(page.getByRole('link').filter({ hasText: name })).toBeVisible();
});
