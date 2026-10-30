import { expect, test } from '@playwright/test';

// Public BillOK journeys, isolated from any authenticated test data.
const widths = [320, 360, 393, 412] as const;
const pages = [
  { path: '/login', heading: 'С возвращением!', hasInput: true },
  { path: '/register', heading: 'Создать аккаунт', hasInput: true },
  { path: '/verify-request', heading: 'Проверьте почту', hasInput: false },
  { path: '/split', heading: 'Разделить чек', hasInput: false },
] as const;

for (const width of widths) {
  test.describe(`Russian mobile public pages at ${width} CSS px`, () => {
    test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

    for (const item of pages) {
      test(`${item.path} renders without horizontal clipping, including keyboard-sized viewport`, async ({ page }) => {
        const response = await page.goto(item.path, { waitUntil: 'networkidle' });
        expect(response?.status()).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
        await expect(page.getByText(item.heading, { exact: true }).first()).toBeVisible();
        if (item.path === '/split') {
          await expect(page.getByTestId('manual-split-sign-in-required')).toBeVisible();
          await expect(page.getByTestId('guest-people-step')).toHaveCount(0);
          await expect(page.getByRole('link', { name: 'Войти и создать чек' })).toHaveAttribute(
            'href',
            /\/login\?callbackUrl=/,
          );
          const header = page.locator('header').first();
          for (const href of ['/split', '/login']) {
            const link = header.locator('a[href="' + href + '"]');
            await expect(link).toBeVisible();
            const bounds = await link.boundingBox();
            expect(bounds?.height, href + ' header height at ' + width + 'px').toBeGreaterThanOrEqual(44);
          }
        }

        const checkWidth = async () => {
          const bounds = await page.evaluate(() => ({
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth,
            clippedControls: [...document.querySelectorAll('input,button,main,form,[data-slot="card"]')]
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && (rect.right > innerWidth + 2 || rect.left < -2);
              })
              .map((element) => element.tagName),
          }));
          expect(bounds.viewport).toBe(width);
          expect(bounds.document).toBeLessThanOrEqual(width + 1);
          expect(bounds.clippedControls).toEqual([]);
        };
        await checkWidth();

        if (item.hasInput) {
          const inputs = page.locator('input:visible');
          const first = inputs.first();
          await expect(first).toBeVisible();
          for (const input of await inputs.all()) {
            expect((await input.boundingBox())!.height, item.path + ' input height').toBeGreaterThanOrEqual(44);
          }
          const submit = page.locator('form button[type="submit"]:visible').first();
          await expect(submit).toBeVisible();
          expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          if (item.path === '/register') {
            await expect(page.locator('input#name')).toHaveAttribute('autocomplete', 'off');
          }

          // Simulates the remaining height after Android's software keyboard opens.
          // Focus the *last* field and reach the primary action by vertical scrolling.
          await page.setViewportSize({ width, height: 360 });
          const last = inputs.last();
          await last.focus();
          await last.scrollIntoViewIfNeeded();
          await expect(last).toBeInViewport();
          await submit.scrollIntoViewIfNeeded();
          await expect(submit).toBeInViewport();
          await checkWidth();
        } else if (item.path === '/verify-request') {
          const back = page.getByRole('link', { name: 'Вернуться ко входу' });
          expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
      });
    }
  });
}

test('root and legacy language links reach canonical Russian pages without redirect loops', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/en/login', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login$/);
});

test('internal Russian legacy routes still enforce authentication', async ({ page }) => {
  await page.goto('/ru/admin', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});
