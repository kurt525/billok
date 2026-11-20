import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation } from './helpers';

// Genuine CI-only signed Passkey cookie, not password auth or a session mock.
async function signIn(page: Page) {
  const context = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await context.storageState()).cookies);
  } finally {
    await context.dispose();
  }
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: group manual receipt shows different names on assignment chips', async ({ page }) => {
  await signIn(page);
  const created = await trpcMutation(page.request, 'groups.create', { name: 'Names ' + Date.now() });
  expect(created.ok(), await created.text()).toBe(true);
  const groupId = (await created.json()).result.data.json.id as string;
  const ids: string[] = [];
  for (const name of ['Алексей', 'Алексей Иванов']) {
    const added = await trpcMutation(page.request, 'groups.addPlaceholder', { groupId, name });
    expect(added.ok(), await added.text()).toBe(true);
    ids.push((await added.json()).result.data.json.id as string);
  }
  await page.goto('/groups/' + groupId + '/expenses/new');
  await page.getByTestId('create-manual-group-receipt').click();
  await expect(page.getByTestId('item-assignment-form')).toBeVisible();
  await page.getByTestId('add-item-btn').click();
  const form = page.getByTestId('add-item-form');
  await form.locator('input').nth(0).fill('Салат');
  await form.locator('input').nth(1).fill('1');
  await form.locator('input').nth(2).fill('150,00');
  await form.getByRole('button', { name: 'Добавить', exact: true }).click();
  for (const [i, name] of ['Алексей', 'Алексей Иванов'].entries()) {
    const chip = page
      .getByTestId('member-toggle-' + ids[i])
      .getByTestId('chip-label')
      .first();
    await expect(chip).toHaveText(name);
    await expect(chip).toHaveAttribute('title', name);
  }
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  expect(narrow).toBe(true);
});

test('TASK-BILLOK-002: creator can distinguish and rename long guest names on a phone', async ({ page }) => {
  await signIn(page);
  await page.goto('/split');
  await expect(page.getByTestId('guest-count-input')).toBeVisible();
  await page.getByTestId('manual-receipt-name').fill('Тест имён');
  await page.getByTestId('guest-count-input').fill('4');
  await page.getByTestId('next-assign-btn').click();
  await page.getByTestId('guest-add-item-btn').click();
  const form = page.getByTestId('manual-item-entry-form');
  await form.locator('input').nth(0).fill('Пирог');
  await form.locator('input').nth(1).fill('1');
  await form.locator('input').nth(2).fill('250,00');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(page.getByTestId('receipt-item-name-0')).toHaveText('Пирог');
  await page.getByTestId('share-for-claiming-btn').click();
  await expect(page.getByTestId('creator-add-guest-place')).toBeVisible();
  const names = ['Алексей', 'Алексей Иванов', 'Анна Ли', 'Кристофер Александрович Петров'];
  for (let i = 1; i <= names.length; i++) {
    const editButton = page.getByTestId('edit-person-' + i);
    // A real touch locator, not a manual coordinate derived from
    // getBoundingClientRect: Playwright tracks viewport/scroll and requires
    // the actual edit button to receive the touch.
    await editButton.tap();
    await expect(page.getByTestId('edit-name-input-' + i)).toBeVisible();
    await page.getByTestId('edit-name-input-' + i).fill(names[i - 1]!);
    await page
      .getByTestId('guest-color-person-' + i)
      .locator('button[type="submit"]')
      .click();
    // The SSE response may update the visible name earlier than tRPC's
    // mutation onSuccess. Wait until the previous editor has fully closed
    // before beginning the next rename, so both transitions are verified.
    await expect(page.getByTestId('edit-name-input-' + i)).toHaveCount(0);
    await expect(page.getByTestId('guest-color-person-' + i)).toContainText(names[i - 1]!);
  }
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow, 'Guest names cause horizontal page overflow at ' + width).toBe(false);
    for (let i = 1; i <= names.length; i++) {
      const card = page.getByTestId('guest-color-person-' + i);
      await expect(card).toContainText(names[i - 1]!);
      const rect = await card.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x + rect!.width, 'Guest card boundary at ' + width).toBeLessThanOrEqual(width + 1);
      const nameLabel = card.getByTestId('guest-display-name-' + i);
      await expect(nameLabel).toBeVisible();
      const labelRect = await nameLabel.boundingBox();
      expect(labelRect).not.toBeNull();
      expect(labelRect!.width, 'Name must not collapse into a letter-wide column at ' + width).toBeGreaterThanOrEqual(
        100,
      );
    }
  }
});
