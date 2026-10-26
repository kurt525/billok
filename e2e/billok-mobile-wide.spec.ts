import { expect, test, type Page } from '@playwright/test';

// Galaxy S23 normally uses roughly 360 CSS px, covered by the existing smoke.
// These widths extend coverage to large phones and unfolded narrow devices.
const widths = [430, 480, 600, 720] as const;

test.use({ viewport: { width: 430, height: 800 }, isMobile: true, hasTouch: true });

async function noHorizontalOverflow(page: Page, width: number) {
  const measured = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('main,header,form,input,button,[data-slot="card"]')];
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      clipped: controls
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -2 || rect.right > window.innerWidth + 2);
        })
        .map((element) => element.tagName)
        .slice(0, 6),
    };
  });
  expect(measured.viewport).toBe(width);
  expect(measured.document).toBeLessThanOrEqual(width + 1);
  expect(measured.clipped).toEqual([]);
}

test('login and registration keep fields and actions reachable on large Android displays', async ({ page }) => {
  test.setTimeout(100_000);
  for (const path of ['/login', '/register'] as const) {
    await page.goto(path, { waitUntil: 'networkidle' });
    const inputs = page.locator('input:visible');
    await expect(inputs.first()).toBeVisible();
    const submit = page.locator('form button[type="submit"]:visible').first();
    await expect(submit).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await noHorizontalOverflow(page, width);
      const input = inputs.last();
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if (width === 480 || width === 720) {
        await page.setViewportSize({ width, height: 380 });
        await input.focus();
        await input.scrollIntoViewIfNeeded();
        await expect(input).toBeInViewport();
        await submit.scrollIntoViewIfNeeded();
        await expect(submit).toBeInViewport();
        await noHorizontalOverflow(page, width);
      }
    }
  }
});

test('mobile app stays centered and scroll-free horizontally at 430–720px with enlarged text', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('alice@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/, { timeout: 20_000 });

  for (const path of ['/dashboard', '/groups', '/splits', '/settings'] as const) {
    await page.goto(path, { waitUntil: 'networkidle' });
    await expect(page.locator('main')).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await noHorizontalOverflow(page, width);
      const content = page.locator('main > div:last-child');
      const rect = await content.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.width).toBeLessThanOrEqual(576);
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      if (width === 720) {
        expect(rect!.x).toBeGreaterThan(50);
        const header = page.locator('header').first();
        const logo = header.getByText('BillOK', { exact: true });
        const menu = header.getByRole('button', { name: 'Открыть меню' });
        await expect(menu).toBeVisible();
        const left = await logo.boundingBox();
        const right = await menu.boundingBox();
        expect(left!.x).toBeGreaterThan(50);
        expect(right!.x + right!.width).toBeLessThan(670);
      }
    }
    if (path === '/dashboard') {
      await page.setViewportSize({ width: 600, height: 800 });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await noHorizontalOverflow(page, 600);
      const hamburger = page.getByRole('button', { name: 'Открыть меню' });
      expect((await hamburger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  // An actual group is created in the disposable CI database after validating
  // both the Galaxy S23 CSS viewport and unfolded-screen tap targets.
  await page.goto('/groups/new', { waitUntil: 'networkidle' });
  const nameInput = page.locator('input#name');
  const descriptionInput = page.locator('input#description');
  const create = page.getByRole('button', { name: 'Создать группу', exact: true });
  const cafe = page.getByRole('button', { name: '🍽️', exact: true });
  await expect(nameInput).toBeVisible();
  await expect(create).toBeVisible();

  for (const width of [360, ...widths]) {
    await page.setViewportSize({ width, height: 800 });
    await noHorizontalOverflow(page, width);
    for (const control of [nameInput, descriptionInput, create, cafe]) {
      const rect = await control.boundingBox();
      expect(rect, 'Group create control at ' + width + 'px').not.toBeNull();
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    }
    if (width === 360 || width === 720) {
      await page.setViewportSize({ width, height: 380 });
      await descriptionInput.focus();
      await descriptionInput.scrollIntoViewIfNeeded();
      await expect(descriptionInput).toBeInViewport();
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport();
      await noHorizontalOverflow(page, width);
    }
  }

  await page.setViewportSize({ width: 480, height: 800 });
  await nameInput.fill('Поездка — тест широкого экрана');
  await descriptionInput.fill('Тест мобильного интерфейса BillOK');
  await expect(page.locator('select#currency')).toHaveCount(0);
  await cafe.click();
  await expect(cafe).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '💰', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await create.click();
  await expect(page).toHaveURL(/\/groups\/[^/]+$/, { timeout: 20000 });
  await expect(page.getByText('Поездка — тест широкого экрана').first()).toBeVisible();
  const groupUrl = new URL(page.url()).pathname;
  await page.goto(groupUrl + '/settings', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('group-currency-readonly')).toHaveText('Российский рубль (₽)');
  await expect(page.locator('select#currency')).toHaveCount(0);
  await noHorizontalOverflow(page, 480);

  // No forex selectors or exchange-rate forms for new group expenses.
  await page.goto(groupUrl + '/expenses/new', { waitUntil: 'networkidle' });
  await expect(page.getByLabel('Сумма (₽)')).toBeVisible();
  await expect(page.locator('select#currency')).toHaveCount(0);
  await expect(page.getByTestId('create-manual-group-receipt')).toBeEnabled();
  await expect(page.getByTestId('rub-only-legacy-warning')).toHaveCount(0);
  for (const width of [360, 480, 720]) {
    await page.setViewportSize({ width, height: 800 });
    await noHorizontalOverflow(page, width);
    const amount = page.getByLabel('Сумма (₽)');
    expect((await amount.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  // Existing disposable seed groups are now RUB too; they need no conversion
  // warning or separate legacy-group path to create a manual receipt.
  await page.goto('/groups', { waitUntil: 'networkidle' });
  const seededGroup = page.locator('a[href^="/groups/"]').filter({ hasText: 'Apartment' }).first();
  await expect(seededGroup).toBeVisible();
  const seededGroupUrl = await seededGroup.getAttribute('href');
  await page.goto(seededGroupUrl + '/expenses/new', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('rub-only-legacy-warning')).toHaveCount(0);
  await expect(page.getByTestId('create-manual-group-receipt')).toBeEnabled();
  await expect(page.locator('select#currency')).toHaveCount(0);
  await noHorizontalOverflow(page, 720);

  // Existing RUB expense remains editable without a currency selector or rate.
  await page.goto(seededGroupUrl!, { waitUntil: 'networkidle' });
  const expenseLink = page.locator('a[href*="/expenses/"]').filter({ hasText: 'Groceries' }).first();
  await expect(expenseLink).toBeVisible();
  const expenseUrl = await expenseLink.getAttribute('href');
  await page.goto(expenseUrl + '/edit', { waitUntil: 'networkidle' });
  await expect(page.getByLabel('Сумма (₽)')).toBeVisible();
  await expect(page.locator('select#currency')).toHaveCount(0);
  await expect(page.getByTestId('rub-only-legacy-edit-warning')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toBeEnabled();
  for (const width of [360, 480, 720]) {
    await page.setViewportSize({ width, height: 800 });
    await noHorizontalOverflow(page, width);
    const amount = await page.getByLabel('Сумма (₽)').boundingBox();
    expect(amount!.height).toBeGreaterThanOrEqual(44);
  }

  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/groups', { waitUntil: 'networkidle' });
  await expect(page.getByText('Поездка — тест широкого экрана').first()).toBeVisible();
  await noHorizontalOverflow(page, 480);
});
