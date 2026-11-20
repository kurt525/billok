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

test('9.3: guest manual receipt labels distinguish shared first names on a phone', async ({ page }) => {
  await signIn(page);
  await page.goto('/split');
  await page.getByTestId('workflow-manual').click();
  await page.getByTestId('manual-receipt-name').fill('Тест имён');
  const people = ['Илья', 'Илья Петров', 'Анна Ли', 'Кристофер Александрович Иванов', 'Кристофер Александрович Петров'];
  for (const [i, name] of people.entries()) {
    if (i > 0) await page.getByTestId('add-person-btn').click();
    await page.getByTestId('person-input-' + i).fill(name);
  }
  await page.getByTestId('next-assign-btn').click();
  await page.getByTestId('guest-add-item-btn').click();
  const form = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form.locator('input').nth(0).fill('Пирог');
  await form.locator('input').nth(1).fill('1');
  await form.locator('input').nth(2).fill('250,00');
  await page.getByTestId('guest-add-item-submit').click();
  const card = page.getByTestId('guest-item-card-0');
  const labels = card.getByTestId('chip-label');
  await expect(labels).toHaveText(['Илья', 'Илья Петров', 'Анна', ...people.slice(3)]);
  await expect(labels.nth(2)).toHaveAttribute('title', 'Анна Ли');
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await card.evaluate((element) => {
      const edge = element.getBoundingClientRect().right;
      return [...element.querySelectorAll<HTMLElement>('[data-testid="chip-label"]')]
        .filter((chip) => chip.scrollWidth > chip.clientWidth || chip.getBoundingClientRect().right > edge)
        .map((chip) => chip.textContent);
    });
    expect(overflow, 'Names overflow at ' + width).toEqual([]);
  }
});
