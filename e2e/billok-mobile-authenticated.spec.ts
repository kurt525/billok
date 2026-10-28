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

    // Invitation works within a small Android visual viewport. It must not
    // push the copy action off-screen or cause horizontal page scrolling.
    if (width === 320 || width === 412) {
      await page.setViewportSize({ width, height: 460 });
      await page.getByRole('button', { name: 'Пригласить', exact: true }).click();
      const inviteDialog = page.getByTestId('mobile-invite-dialog');
      await expect(inviteDialog).toBeVisible();
      const inviteBounds = await inviteDialog.boundingBox();
      expect(inviteBounds!.y).toBeGreaterThanOrEqual(0);
      expect(inviteBounds!.y + inviteBounds!.height).toBeLessThanOrEqual(460);
      const generate = inviteDialog.getByRole('button', { name: 'Создать ссылку-приглашение' });
      await expect(generate).toBeVisible();
      expect((await generate.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await generate.click();
      const copy = page.getByTestId('mobile-copy-invite');
      await expect(copy).toBeVisible();
      const copyBox = await copy.boundingBox();
      expect(copyBox!.width).toBeGreaterThanOrEqual(44);
      expect(copyBox!.height).toBeGreaterThanOrEqual(44);
      await checkPhoneLayout(page, width);
      await inviteDialog.getByRole('button', { name: 'Закрыть' }).click();
      await expect(inviteDialog).toHaveCount(0);
      await page.setViewportSize({ width, height: 800 });
    }

    await page.goto(new URL(page.url()).pathname + '/expenses/new', { waitUntil: 'networkidle' });
    await expect(page.getByRole('main')).toBeVisible();
    await checkPhoneLayout(page, width);

    // Real share-entry forms are where long participant names + monetary values
    // used to push input fields past the edge of narrow Android screens.
    if (width === 320 || width === 412) {
      for (const mode of ['EXACT', 'PERCENTAGE', 'SHARES'] as const) {
        const choice = page.getByTestId('expense-split-mode-' + mode);
        await expect(choice).toBeVisible();
        const choiceBounds = await choice.boundingBox();
        expect(choiceBounds!.height).toBeGreaterThanOrEqual(44);
        await choice.click();
        const rows = page.getByTestId('split-member-row');
        await expect(rows.first()).toBeVisible();
        await checkPhoneLayout(page, width);
        const amount = rows.first().locator('input');
        const rect = await amount.boundingBox();
        expect(rect, mode + ' amount at ' + width + 'px').toBeTruthy();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        expect(rect!.height).toBeGreaterThanOrEqual(44);
      }
      const submit = page.locator('form button[type=submit]').last();
      await expect(submit).toBeVisible();
      const submitBounds = await submit.boundingBox();
      expect(submitBounds!.height).toBeGreaterThanOrEqual(44);
      await checkPhoneLayout(page, width);
    }

    const input = page.locator('input:visible').first();
    await expect(input).toBeVisible();
    await page.setViewportSize({ width, height: 460 });
    await input.focus();
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    await checkPhoneLayout(page, width);
    await page.setViewportSize({ width, height: 800 });

    if (width === 320 || width === 412) {
      await page.goto('/settings', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
      await checkPhoneLayout(page, width);
      await page.setViewportSize({ width, height: 460 });
      const name = page.locator('#name');
      await name.focus();
      await name.scrollIntoViewIfNeeded();
      await expect(name).toBeInViewport();
      expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const save = page.getByTestId('save-profile-btn');
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await checkPhoneLayout(page, width);
      await page.setViewportSize({ width, height: 800 });
    }

    await page.goto('/admin', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Панель администратора' })).toBeVisible();
    await checkPhoneLayout(page, width, true);
    await expect(page.locator('aside')).not.toBeVisible();
  }
});

test('mobile SBP profile persists phone and selected bank without verification claims', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsSeedAdmin(page);
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const phone = page.getByTestId('sbp-phone-input');
  const bank = page.getByTestId('sbp-bank-select');
  await expect(phone).toBeVisible();
  await expect(bank).toBeVisible();
  await expect(page.getByText('Номер не проверяется по СМС')).toBeVisible();
  await phone.fill('8 (999) 123-45-67');
  await bank.selectOption('tbank');
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('sbp-phone-input')).toHaveValue('+79991234567');
  await expect(page.getByTestId('sbp-bank-select')).toHaveValue('tbank');
  await checkPhoneLayout(page, 320);

  // Leave the disposable CI account as it was before this test.
  await page.getByTestId('sbp-phone-input').fill('');
  await page.getByTestId('sbp-bank-select').selectOption('');
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
});
