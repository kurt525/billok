import { expect, test, type Page } from '@playwright/test';

// Only against the disposable seed database created by the Mobile Chromium CI job.
const widths = [320, 360, 393, 412] as const;

async function checkPhoneLayout(page: Page, width: number, allowInnerTables = false) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const result = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    clipped: [...document.querySelectorAll('header,main,button,input,[data-slot="card"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -2 || rect.right > innerWidth + 2);
      })
      .slice(0, 8)
      .map((el) => ({ tag: el.tagName, label: (el.textContent ?? '').trim().slice(0, 45) })),
  }));
  expect(result.viewport).toBe(width);
  expect(result.document).toBeLessThanOrEqual(width + 1);
  if (!allowInnerTables) expect(result.clipped).toEqual([]);
}

async function signInAsSeedAdmin(page: Page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.getByText('С возвращением!', { exact: true })).toBeVisible();
  await page.locator('input[type=email]').fill('alice@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
}

// One authenticated session across four viewports avoids tripping BillOK's
// login rate limiter when Chromium runs several mobile tests in parallel.
test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('Russian mobile dashboard, groups, expenses and admin at all 4 phone widths', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsSeedAdmin(page);

  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
    await checkPhoneLayout(page, width);

    const hamburger = page.getByRole('button', { name: 'Открыть меню' });
    await expect(hamburger).toBeVisible();
    const trigger = await hamburger.boundingBox();
    expect(trigger?.height).toBeGreaterThanOrEqual(44);
    expect(trigger?.width).toBeGreaterThanOrEqual(44);
    await hamburger.click();

    const menu = page.getByRole('dialog');
    await expect(menu).toContainText('Группы');
    for (const name of ['Главная', 'Группы', 'Разделить чек', 'Мои чеки', 'Настройки', 'Администрирование']) {
      const link = menu.getByRole('link', { name, exact: true });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box?.height, `Menu link "${name}" at ${width}px`).toBeGreaterThanOrEqual(44);
    }

    for (const name of ['Выйти', 'Переключить тему', 'Закрыть']) {
      const button = menu.getByRole('button', { name });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.width, `Menu button "${name}" at ${width}px`).toBeGreaterThanOrEqual(44);
      expect(box?.height, `Menu button "${name}" at ${width}px`).toBeGreaterThanOrEqual(44);
    }

    await page.setViewportSize({ width, height: 460 });
    const exit = menu.getByRole('button', { name: 'Выйти' });
    await exit.scrollIntoViewIfNeeded();
    await expect(exit).toBeInViewport();
    await checkPhoneLayout(page, width, true);
    await page.setViewportSize({ width, height: 800 });
    await menu.getByRole('link', { name: 'Группы', exact: true }).click();
    await expect(page).toHaveURL(/\/groups$/);
    await expect(page.getByRole('heading', { name: 'Группы' })).toBeVisible();
    await checkPhoneLayout(page, width);

    const groupLink = page.locator('a[href^="/groups/"]').filter({ hasText: 'Apartment' }).first();
    await expect(groupLink).toBeVisible();
    await groupLink.click();
    await expect(page).toHaveURL(/\/groups\/[^/]+$/);
    await expect(page.getByText('Расходы', { exact: true }).first()).toBeVisible();
    await checkPhoneLayout(page, width);
    await expect(page.locator('a[href$="/scan"]')).toHaveCount(0);
    await expect(page.locator('a[href$="/expenses/new"]').first()).toBeVisible();

    await page.goto(new URL(page.url()).pathname + '/expenses/new', { waitUntil: 'networkidle' });
    await expect(page.getByRole('main')).toBeVisible();
    await checkPhoneLayout(page, width);
    const input = page.locator('input:visible').first();
    await expect(input).toBeVisible();
    await page.setViewportSize({ width, height: 460 });
    await input.focus();
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    await checkPhoneLayout(page, width);
    await page.setViewportSize({ width, height: 800 });

    await page.goto('/admin', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Панель администратора' })).toBeVisible();
    await checkPhoneLayout(page, width, true);
    await expect(page.locator('aside')).not.toBeVisible();
  }
});
