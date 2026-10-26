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
  test.setTimeout(140_000);
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
});
