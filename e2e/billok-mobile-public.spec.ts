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

// The public registration mutation returns a pending account, not a session.
// Stub transport only: the disposable Chromium database and SMTP are untouched.
test('invited mobile signup waits for email confirmation without automatic sign-in', async ({ page }) => {
  test.setTimeout(45_000);
  const email = 'registration-mobile@mail.ru';
  const inviteCode = 'INVITE-MOBILE-TEST';
  let registrations = 0;
  let credentialsSignIns = 0;

  page.on('request', (request) => {
    if (request.url().includes('/api/auth/callback/credentials')) credentialsSignIns++;
  });

  await page.route('**/api/trpc/auth.getRegistrationMode*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ result: { data: { json: { mode: 'invite-only' } } } }]),
    });
  });

  await page.route('**/api/trpc/auth.register*', async (route) => {
    registrations++;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ result: { data: { json: { email, verificationRequired: true } } } }]),
    });
  });

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/register', { waitUntil: 'networkidle' });
  await page.getByLabel('Имя').fill('Участник');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill('testpass123');
  await page.getByLabel('Код приглашения').fill(inviteCode);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

  const pending = page.getByRole('status');
  await expect(pending).toContainText('Проверьте электронную почту');
  await expect(pending).toContainText(email);
  await expect(pending).toContainText('30 минут');
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page).toHaveURL(/\/register$/);
  expect(registrations).toBe(1);
  expect(credentialsSignIns, 'a pending registration must not start a credentials session').toBe(0);

  for (const width of [320, 430]) {
    await page.setViewportSize({ width, height: 320 });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const link = pending.getByRole('link', { name: 'Войти' });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    const bounds = await link.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(width + 1);
  }
});

// Security-relevant UI check: email scanners can render GET links, so only an
// explicit button click may consume the one-time confirmation token.
test('registration email link requires a tap before POST confirmation', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 320, height: 700 });
  const token = 'A'.repeat(43);
  let confirmations = 0;
  let releaseConfirmation: () => void = () => {};
  const confirmationDelay = new Promise<void>((resolve) => {
    releaseConfirmation = resolve;
  });
  await page.route('**/api/trpc/auth.confirmEmail*', async (route) => {
    confirmations++;
    expect(route.request().method()).toBe('POST');
    await confirmationDelay;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ result: { data: { json: { verified: true } } } }]),
    });
  });

  await page.goto(`/verify-email?token=${token}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Подтверждение почты' })).toBeVisible();
  expect(confirmations, 'opening a mail link must not consume a token').toBe(0);
  const button = page.getByRole('button', { name: /^(Подтвердить адрес|Подтверждаем…)$/ });
  await expect(button).toBeVisible();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText('Подтверждаем…');
  expect(confirmations).toBe(1);
  releaseConfirmation();

  await expect(page.getByRole('status')).toContainText(
    'Адрес электронной почты подтверждён. Теперь можно войти в аккаунт.',
  );
  await expect(page).toHaveURL(/\/verify-email$/);

  // One successful confirmation stays readable with a larger Android font and
  // short viewport at every required mobile width, including 720 CSS px.
  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  const back = page.getByRole('link', { name: 'Перейти ко входу' });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 320 });
    await expect(page.getByRole('status')).toBeVisible();
    await back.scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();
    const bounds = await back.boundingBox();
    expect(bounds, 'login link at ' + width + 'px').not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth, 'horizontal overflow at ' + width + 'px').toBeLessThanOrEqual(width + 1);
  }

  await back.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('С возвращением!', { exact: true })).toBeVisible();
});

test.describe('mail waiting screen on wide mobile viewports', () => {
  test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

  test('stays usable with large Android text and a short viewport, and returns to login', async ({ page }) => {
    await page.goto('/verify-request', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const backToLogin = page.getByRole('link', { name: 'Вернуться ко входу' });

    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 320 });
      await expect(page.getByText('Проверьте почту', { exact: true })).toBeVisible();
      await backToLogin.scrollIntoViewIfNeeded();
      await expect(backToLogin).toBeInViewport();

      const bounds = await backToLogin.boundingBox();
      expect(bounds, 'return to login at ' + width + 'px').not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth, 'horizontal overflow at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    }

    await backToLogin.click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('С возвращением!', { exact: true })).toBeVisible();
  });
});

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
