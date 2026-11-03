import { expect, test, type Page } from '@playwright/test';
import { createTestGroup, trpcMutation, users } from './helpers';

// Only against the disposable seed database created by the Mobile Chromium CI job.
const widths = [320, 360, 393, 412] as const;

async function checkPhoneLayout(page: Page, width: number, allowInnerTables = false) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const result = await page.evaluate(
    (requestedWidth) => ({
      viewport: innerWidth,
      requestedViewport: requestedWidth,
      visualViewport: window.visualViewport?.width,
      screenWidth: window.screen.width,
      metaViewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
      documentClient: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      clipped: [...document.querySelectorAll('header,main,button,input,[data-slot="card"]')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -2 || rect.right > innerWidth + 2);
        })
        .slice(0, 8)
        .map((el) => ({
          tag: el.tagName,
          testId: el.getAttribute('data-testid'),
          left: Math.round(el.getBoundingClientRect().left * 10) / 10,
          right: Math.round(el.getBoundingClientRect().right * 10) / 10,
          label: (el.textContent ?? '').trim().slice(0, 30),
        })),
      // Mobile Chromium may expand innerWidth to fit a wide descendant.
      // Compare DOM geometry to the requested CSS viewport, not the expanded one.
      overflowCandidates:
        innerWidth !== requestedWidth || document.documentElement.scrollWidth > requestedWidth + 1
          ? [...document.querySelectorAll('body *')]
              .filter((el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && (rect.left < -2 || rect.right > requestedWidth + 2);
              })
              .map((el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return {
                  tag: el.tagName,
                  testId: el.getAttribute('data-testid'),
                  className: typeof el.className === 'string' ? el.className.slice(0, 100) : '',
                  left: Math.round(rect.left * 10) / 10,
                  right: Math.round(rect.right * 10) / 10,
                  width: Math.round(rect.width * 10) / 10,
                  scrollWidth: el.scrollWidth,
                  clientWidth: el.clientWidth,
                  minWidth: style.minWidth,
                  whiteSpace: style.whiteSpace,
                  position: style.position,
                  overflowX: style.overflowX,
                  label: (el.textContent ?? '').trim().slice(0, 35),
                };
              })
              .sort((a, b) => b.right - a.right)
              .slice(0, 20)
          : [],
    }),
    width,
  );
  // Include precise DOM overflow evidence when mobile visualViewport sizing
  // rounds to an extra pixel; do not accept a wider viewport as passing.
  expect(result.viewport, 'Viewport expanded on ' + width + 'px: ' + JSON.stringify(result)).toBe(width);
  expect(result.document, 'Document expanded on ' + width + 'px: ' + JSON.stringify(result)).toBeLessThanOrEqual(
    width + 1,
  );
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
test.use({
  viewport: { width: 320, height: 800 },
  isMobile: true,
  hasTouch: true,
});

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
    // Base UI keeps the closing sheet portal in the DOM for its exit
    // transition, translated off the right edge of the viewport. Verify
    // the sheet has actually unmounted after navigation, THEN measure the
    // settled page. Never hide clipped controls from checkPhoneLayout.
    await expect(menu).toHaveCount(0, { timeout: 15_000 });
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
      const generate = inviteDialog.getByRole('button', {
        name: 'Создать ссылку-приглашение',
      });
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

    await page.goto(new URL(page.url()).pathname + '/expenses/new', {
      waitUntil: 'networkidle',
    });
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
  const bankList = page.getByTestId('sbp-bank-list');
  const selectedTbank = page.getByTestId('sbp-bank-radio-tbank');
  await expect(phone).toBeVisible();
  await expect(bankList).toBeVisible();
  const search = page.getByTestId('sbp-bank-search');
  await expect(search).toBeVisible();
  await search.fill('ТИНЬКОФФ');
  const tbankRow = page.getByTestId('sbp-bank-option-tbank');
  await expect(tbankRow).toBeVisible();
  await expect(page.getByTestId('sbp-bank-option-sberbank')).toHaveCount(0);
  const logo = tbankRow.locator('img');
  await expect(logo).toHaveAttribute('src', '/banks/tbank.svg');
  // SVG intrinsic dimensions are browser-dependent; naturalWidth need not
  // equal the 40px CSS display size. Assert successful load and layout separately.
  await expect(logo).toHaveJSProperty('complete', true);
  await expect.poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(logo).toHaveCSS('width', '40px');
  await expect(logo).toHaveCSS('height', '40px');
  // A bank outside the original eight must be searchable and its local WEBP must load.
  await search.fill('Озон Банк');
  const ozon = page.getByTestId('sbp-bank-option-100000000273');
  await expect(ozon).toBeVisible();
  const ozonLogo = ozon.locator('img');
  await expect(ozonLogo).toHaveAttribute('src', '/banks/nspk/100000000273.webp');
  await expect.poll(() => ozonLogo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  // An entry missing an image should still be available via the fallback label.
  await search.fill('НООСФЕРА');
  await expect(page.getByTestId('sbp-bank-fallback-100000000313')).toBeVisible();
  await search.fill('ТИНЬКОФФ');
  await expect(page.getByText('Номер не проверяется по СМС')).toBeVisible();
  await phone.fill('8 (999) 123-45-67');
  await tbankRow.click();
  await expect(selectedTbank).toBeChecked();
  await search.fill('АК БАРС');
  await expect(selectedTbank).toBeChecked();
  await expect(page.getByTestId('sbp-bank-option-akbars')).toBeVisible();
  await search.fill('нет такого банка');
  await expect(page.getByTestId('sbp-bank-no-results')).toBeVisible();
  await expect(selectedTbank).toBeChecked();
  await search.fill('');
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('sbp-phone-input')).toHaveValue('+79991234567');
  await expect(page.getByTestId('sbp-bank-radio-tbank')).toBeChecked();
  await checkPhoneLayout(page, 320);

  // A new registry bank ID must persist through the existing profile API.
  await page.getByTestId('sbp-bank-search').fill('Озон Банк');
  await page.getByTestId('sbp-bank-option-100000000273').click();
  await expect(page.getByTestId('sbp-bank-radio-100000000273')).toBeChecked();
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('sbp-bank-radio-100000000273')).toBeChecked();
  await checkPhoneLayout(page, 320);

  // Complete mobile profile acceptance: real name editing and contact data,
  // persistence through the profile API, enlarged Android font, short keyboard
  // viewport, touch targets, and all expected phone/foldable widths.
  const name = page.locator('#name');
  const originalName = await name.inputValue();
  const changedName = 'Участник BillOK ' + 'ОченьДлинноеИмя'.repeat(4);
  expect(changedName.length).toBeLessThanOrEqual(100);
  await name.fill(changedName);
  await page.getByTestId('sbp-phone-input').fill('8 (999) 123-45-67');
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('#name')).toHaveValue(changedName);
  await expect(page.getByTestId('sbp-phone-input')).toHaveValue('+79991234567');
  await expect(page.locator('#email')).toBeDisabled();

  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 360 });
    const profileName = page.locator('#name');
    const profilePhone = page.getByTestId('sbp-phone-input');
    const save = page.getByTestId('save-profile-btn');
    for (const field of [profileName, profilePhone]) {
      await field.focus();
      await field.scrollIntoViewIfNeeded();
      await expect(field).toBeInViewport();
      expect((await field.boundingBox())!.height, 'input touch height at ' + width).toBeGreaterThanOrEqual(44);
    }
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    const saveBounds = await save.boundingBox();
    expect(saveBounds!.height, 'save touch height at ' + width).toBeGreaterThanOrEqual(44);
    expect(saveBounds!.width, 'save touch width at ' + width).toBeGreaterThanOrEqual(44);
    await checkPhoneLayout(page, width);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('#name').fill(originalName);
  // Leave the disposable CI account as it was before this test.
  await page.getByTestId('sbp-phone-input').fill('');
  await page.getByTestId('sbp-bank-option-none').click();
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
});

test('long group history links stay readable and open on all mobile widths', async ({ page }) => {
  test.setTimeout(125_000);
  const longName = 'СемейнаяГруппа'.repeat(6);
  expect(longName.length).toBeLessThanOrEqual(100);
  const testGroup = await createTestGroup(users.alice.email, users.alice.password, [], longName);
  try {
    await signInAsSeedAdmin(page);
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 380 });
      await page.goto('/groups', { waitUntil: 'networkidle' });
      await page.addStyleTag({
        content: 'html { font-size: 20px !important; }',
      });
      const historyLink = page.locator('a[href="/groups/' + testGroup.groupId + '"]');
      await expect(historyLink).toBeVisible({ timeout: 15_000 });
      const name = historyLink.getByText(longName, { exact: true });
      await expect(name).toBeVisible();
      const nameSizes = await name.evaluate((el) => ({
        client: el.clientWidth,
        content: el.scrollWidth,
      }));
      expect(nameSizes.content, 'Full group name at ' + width + 'px').toBeLessThanOrEqual(nameSizes.client + 1);
      const linkBounds = await historyLink.boundingBox();
      expect(linkBounds).not.toBeNull();
      expect(linkBounds!.height).toBeGreaterThanOrEqual(44);
      expect(linkBounds!.x).toBeGreaterThanOrEqual(0);
      expect(linkBounds!.x + linkBounds!.width).toBeLessThanOrEqual(width);
      await checkPhoneLayout(page, width);
      await historyLink.click();
      await expect(page).toHaveURL(new RegExp('/groups/' + testGroup.groupId + '$'));
      const heading = page.getByRole('heading', { name: longName });
      await expect(heading).toBeVisible({ timeout: 15_000 });
      const headingSizes = await heading.evaluate((el) => ({
        client: el.clientWidth,
        content: el.scrollWidth,
      }));
      expect(headingSizes.content, 'Full group heading at ' + width + 'px').toBeLessThanOrEqual(
        headingSizes.client + 1,
      );
      await checkPhoneLayout(page, width);
      const members = await page.getByTestId('group-member-chip').evaluateAll((chips) =>
        chips.map((chip) => {
          const bounds = chip.getBoundingClientRect();
          const name = chip.querySelector('[data-testid="group-member-name"]');
          return {
            left: bounds.left,
            right: bounds.right,
            nameClientWidth: name?.clientWidth ?? 0,
            nameScrollWidth: name?.scrollWidth ?? 0,
          };
        }),
      );
      expect(members.length, 'Group members should be visible').toBeGreaterThan(0);
      for (const member of members) {
        expect(member.left, 'Member chip left on ' + width + 'px').toBeGreaterThanOrEqual(-1);
        expect(member.right, 'Member chip right on ' + width + 'px').toBeLessThanOrEqual(width + 1);
        expect(member.nameScrollWidth, 'Unclipped member name on ' + width + 'px').toBeLessThanOrEqual(
          member.nameClientWidth + 1,
        );
      }
      await page.goBack({ waitUntil: 'networkidle' });
      await expect(historyLink).toBeVisible({ timeout: 15_000 });
      await checkPhoneLayout(page, width);
    }
  } finally {
    await testGroup.dispose();
  }
});

test('long expense history stays readable and opens at six mobile widths', async ({ page }) => {
  test.setTimeout(170_000);
  const title = 'РесторанныйСчётБезПробелов'.repeat(3);
  const group = await createTestGroup(
    users.alice.email,
    users.alice.password,
    [{ email: users.bob.email, password: users.bob.password }],
    'Мобильная история расходов',
  );
  try {
    const result = await trpcMutation(group.owner, 'expenses.create', {
      groupId: group.groupId,
      title,
      amount: 123456789,
      currency: 'RUB',
      splitMode: 'EQUAL',
      paidById: group.memberIds[users.alice.email],
      shares: [
        { userId: group.memberIds[users.alice.email], amount: 61728394 },
        { userId: group.memberIds[users.bob.email], amount: 61728395 },
      ],
    });
    expect(result.ok(), 'Disposable history fixture must be created').toBeTruthy();
    const expense = (await result.json()).result?.data?.json;
    expect(expense?.id).toBeTruthy();
    await signInAsSeedAdmin(page);

    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 380 });
      await page.goto('/groups/' + group.groupId, { waitUntil: 'networkidle' });
      await page.addStyleTag({
        content: 'html { font-size: 20px !important; }',
      });
      const link = page.locator('a[href="/groups/' + group.groupId + '/expenses/' + expense.id + '"]');
      await expect(link).toBeVisible({ timeout: 15_000 });
      await expect(link.getByTestId('group-history-expense-title')).toHaveText(title);
      await expect(link.getByTestId('group-history-expense-amount')).toContainText('₽');
      const sizes = await link.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const titleElement = element.querySelector<HTMLElement>('[data-testid="group-history-expense-title"]');
        const amountElement = element.querySelector<HTMLElement>('[data-testid="group-history-expense-amount"]');
        return {
          left: bounds.left,
          right: bounds.right,
          height: bounds.height,
          titleClientWidth: titleElement?.clientWidth ?? 0,
          titleScrollWidth: titleElement?.scrollWidth ?? 0,
          amountClientWidth: amountElement?.clientWidth ?? 0,
          amountScrollWidth: amountElement?.scrollWidth ?? 0,
        };
      });
      expect(sizes.left, 'Expense history link left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(sizes.right, 'Expense history link right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
      expect(sizes.height, 'Expense history touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(sizes.titleScrollWidth, 'Expense title fully visible at ' + width + 'px').toBeLessThanOrEqual(
        sizes.titleClientWidth + 1,
      );
      expect(sizes.amountScrollWidth, 'Expense amount fully visible at ' + width + 'px').toBeLessThanOrEqual(
        sizes.amountClientWidth + 1,
      );
      await checkPhoneLayout(page, width);
      for (const button of [
        page.getByTestId('group-settle-all-button'),
        page.getByTestId('group-debt-settlement-button'),
      ]) {
        await expect(button).toBeVisible();
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x, 'Settlement button left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width, 'Settlement button right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
        expect(bounds!.height, 'Settlement tap target at ' + width + 'px').toBeGreaterThanOrEqual(44);
      }
      await link.click();
      await expect(page).toHaveURL(new RegExp('/groups/' + group.groupId + '/expenses/' + expense.id + '$'));
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expect(page.getByTestId('expense-detail-total')).toContainText('1');
      await checkPhoneLayout(page, width);
      const back = page.getByTestId('expense-detail-back');
      const backBounds = await back.boundingBox();
      expect(backBounds).not.toBeNull();
      expect(backBounds!.width, 'Expense back button width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(backBounds!.height, 'Expense back button height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      await back.click();
      await expect(page).toHaveURL(new RegExp('/groups/' + group.groupId + '$'));
      await expect(link).toBeVisible();
      await checkPhoneLayout(page, width);
    }
  } finally {
    await group.dispose();
  }
});
