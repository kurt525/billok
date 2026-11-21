import { expect, test, type Locator, type Page } from '@playwright/test';
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

// Move a real touch target into the uncovered viewport band. At 320px,
// Playwright's minimal auto-scroll may leave wrapped buttons behind the
// sticky header or fixed claim-actions. This helper scrolls only; the
// following touch/click is still subject to normal pointer hit-testing.
async function revealMobileTouchTarget(control: Locator) {
  const bounds = await control.evaluate((node) => {
    const element = node as HTMLElement;
    const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
    const actionsTop = (() => {
      const el = document.querySelector('[data-testid="claim-actions"]');
      return el && el.getClientRects().length > 0 ? el.getBoundingClientRect().top : window.innerHeight;
    })();
    const safeTop = headerBottom + 12;
    const safeBottom = Math.min(actionsTop, window.innerHeight) - 12;
    const center = (safeTop + safeBottom) / 2;
    const scrollers: HTMLElement[] = [];
    let parent = element.parentElement;
    while (parent) {
      const overflowY = window.getComputedStyle(parent).overflowY;
      if (/(auto|scroll)/.test(overflowY) && parent.scrollHeight > parent.clientHeight + 2) {
        scrollers.push(parent);
      }
      parent = parent.parentElement;
    }
    if (document.scrollingElement && !scrollers.includes(document.scrollingElement as HTMLElement)) {
      scrollers.push(document.scrollingElement as HTMLElement);
    }
    for (const scroller of scrollers) {
      const rect = element.getBoundingClientRect();
      scroller.scrollTop += rect.top + rect.height / 2 - center;
    }
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, safeTop, safeBottom, height: rect.height };
  });
  expect(bounds.top, 'Touch target lies under sticky header: ' + JSON.stringify(bounds)).toBeGreaterThanOrEqual(
    bounds.safeTop - 1,
  );
  expect(bounds.bottom, 'Touch target lies under fixed action bar: ' + JSON.stringify(bounds)).toBeLessThanOrEqual(
    bounds.safeBottom + 1,
  );
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
  test.setTimeout(90_000);
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
  await page.getByTestId('claim-tab-people').click();
  await expect(page.getByTestId('creator-add-guest-place')).toBeVisible();
  const names = ['Алексей', 'Алексей Иванов', 'Анна Ли', 'Кристофер Александрович Петров'];
  for (let i = 1; i <= names.length; i++) {
    const editButton = page.getByTestId('edit-person-' + i);
    // Use a real touch event. On the 320px claim screen, Playwright's minimal
    // auto-scroll may place edit-person-3 beneath the sticky header or fixed
    // claim-actions panel. Center the real button between those layers.
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await revealMobileTouchTarget(editButton);
    await expect(editButton).toBeVisible();
    await editButton.tap();
    await expect(page.getByTestId('edit-name-input-' + i)).toBeVisible();
    await page.getByTestId('edit-name-input-' + i).fill(names[i - 1]!);
    // At 320 CSS px the form wraps into multiple rows. Success toasts can
    // temporarily obscure the save button, and the sticky header/claim-actions
    // bar may cover it when Playwright scrolls only as far as "needed".
    // Wait for visible toasts to clear and center this exact button inside
    // the unobstructed mobile viewport; do not force/bypass pointer checks.
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    const saveButton = page.getByTestId('guest-color-person-' + i).locator('button[type="submit"]');
    await revealMobileTouchTarget(saveButton);
    await expect(saveButton).toBeVisible();
    await saveButton.click();
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
