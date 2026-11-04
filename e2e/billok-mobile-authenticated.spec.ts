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
      await page.setViewportSize({ width, height: 300 });
      await page.goto('/groups/' + group.groupId, { waitUntil: 'networkidle' });
      await page.addStyleTag({
        content: 'html { font-size: 20px !important; }',
      });
      const link = page.locator('a[href="/groups/' + group.groupId + '/expenses/' + expense.id + '"]');
      await expect(link).toBeVisible({ timeout: 15_000 });
      await expect(link.getByTestId('group-history-expense-title')).toHaveText(title);
      await expect(link.getByTestId('group-history-expense-amount')).toContainText('₽');
      const date = link.getByTestId('group-history-expense-date');
      await expect(date).toHaveText(/\d/);
      await date.scrollIntoViewIfNeeded();
      const dateBounds = await date.boundingBox();
      expect(dateBounds, 'History date present at ' + width + 'px').not.toBeNull();
      expect(dateBounds!.x, 'History date left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(dateBounds!.x + dateBounds!.width, 'History date right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
      expect(dateBounds!.y, 'History date top at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(dateBounds!.y + dateBounds!.height, 'History date bottom at ' + width + 'px').toBeLessThanOrEqual(301);
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
      // BillOK displays group debt read-only; actual reimbursements belong to a receipt.
      await expect(page.getByTestId('group-settle-all-button')).toHaveCount(0);
      await expect(page.getByTestId('group-debt-settlement-button')).toHaveCount(0);
      await expect(page.getByTestId('mobile-settle-dialog')).toHaveCount(0);
      const debtButton = page.getByTestId('group-debt-row').first();
      await expect(debtButton).toBeVisible();
      const debtBox = await debtButton.boundingBox();
      expect(debtBox!.height).toBeGreaterThanOrEqual(44);
      expect(debtBox!.x).toBeGreaterThanOrEqual(-1);
      expect(debtBox!.x + debtBox!.width).toBeLessThanOrEqual(width + 1);
      const debtAmount = debtButton.getByTestId('group-debt-amount');
      await expect(debtAmount).toContainText('₽');
      await debtAmount.scrollIntoViewIfNeeded();
      const debtGeometry = await debtAmount.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: element.clientWidth, scroll: element.scrollWidth };
      });
      expect(debtGeometry.left, 'Debt amount left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(debtGeometry.right, 'Debt amount right at ' + width).toBeLessThanOrEqual(width + 1);
      expect(debtGeometry.scroll, 'Unclipped RUB debt at ' + width).toBeLessThanOrEqual(debtGeometry.width + 1);
      await checkPhoneLayout(page, width);
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

test('mobile admin user controls remain touch-friendly with delete confirmation', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const section = page.getByTestId('admin-user-management');
    await expect(section).toBeVisible({ timeout: 15_000 });
    const search = section.getByRole('textbox', { name: 'Поиск пользователей' });
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', /Поиск/);

    for (const filter of ['all', 'active', 'suspended', 'placeholder']) {
      const button = section.getByTestId('admin-users-filter-' + filter);
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Admin status filter at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.width, 'Admin status filter at ' + width + 'px').toBeGreaterThanOrEqual(44);
    }
    const searchBounds = await search.boundingBox();
    expect(searchBounds!.height, 'Admin search at ' + width + 'px').toBeGreaterThanOrEqual(44);

    await search.fill('bob@example.com');
    const row = section.locator('tbody tr').filter({ hasText: 'bob@example.com' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    const deleteButton = row.getByRole('button', { name: /Удалить пользователя/ });
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(deleteButton).toBeVisible();
    const delBounds = await deleteButton.boundingBox();
    expect(delBounds!.width, 'Admin delete action width at ' + width + 'px').toBeGreaterThanOrEqual(44);
    expect(delBounds!.height, 'Admin delete action height at ' + width + 'px').toBeGreaterThanOrEqual(44);
    await deleteButton.click();

    const dialog = page.getByTestId('admin-user-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Bob');
    const cancel = dialog.getByRole('button', { name: 'Отмена' });
    const confirm = dialog.getByRole('button', { name: 'Удалить', exact: true });
    for (const button of [cancel, confirm]) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Admin confirm action at ' + width + 'px').toBeGreaterThanOrEqual(44);
    }
    const dialogRect = await dialog.boundingBox();
    expect(dialogRect).not.toBeNull();
    expect(dialogRect!.x, 'Admin dialog left at ' + width + 'px').toBeGreaterThanOrEqual(0);
    expect(dialogRect!.x + dialogRect!.width, 'Admin dialog right at ' + width + 'px').toBeLessThanOrEqual(width);
    expect(dialogRect!.height, 'Admin dialog height at ' + width + 'px').toBeLessThanOrEqual(380);
    await cancel.click();
    await expect(dialog).toBeHidden();

    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.viewport, 'Admin viewport width at ' + width + 'px').toBe(width);
    expect(layout.documentWidth, 'Admin document overflow at ' + width + 'px').toBeLessThanOrEqual(width + 1);
  }
});

test('mobile invitation management keeps registration controls accessible at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  const label = 'МобильноеПриглашение'.repeat(2);
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const section = page.getByTestId('admin-registration-control');
  await expect(section).toBeVisible();
  await section.getByTestId('admin-registration-invite-label').fill(label);
  await section.getByTestId('admin-registration-create-invite').click();
  const invite = section.getByTestId('admin-invitation-row').filter({ hasText: label });
  await expect(invite).toHaveCount(1, { timeout: 15_000 });

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const registration = page.getByTestId('admin-registration-control');
    await expect(registration).toBeVisible({ timeout: 15_000 });
    const labelInput = registration.getByTestId('admin-registration-invite-label');
    const createButton = registration.getByTestId('admin-registration-create-invite');

    for (const control of [
      registration.getByTestId('admin-registration-mode-open'),
      registration.getByTestId('admin-registration-mode-invite-only'),
      registration.getByTestId('admin-registration-mode-closed'),
      labelInput,
      createButton,
    ]) {
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width, 'Registration touch width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.height, 'Registration touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
    }
    const row = registration.getByTestId('admin-invitation-row').filter({ hasText: label });
    await expect(row).toHaveCount(1);
    const copy = row.getByRole('button', { name: 'Скопировать код приглашения' });
    const revoke = row.getByTestId('admin-registration-revoke-invite');
    for (const button of [copy, revoke]) {
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width, 'Invite action width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.height, 'Invite action height at ' + width + 'px').toBeGreaterThanOrEqual(44);
    }
    await revoke.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Отозвать код приглашения?');
    for (const button of [
      confirm.getByRole('button', { name: 'Отмена' }),
      confirm.getByRole('button', { name: 'Отозвать приглашение' }),
    ]) {
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds!.height, 'Revoke confirmation at ' + width + 'px').toBeGreaterThanOrEqual(44);
    }
    const dialogBounds = await confirm.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds!.x, 'Dialog left at ' + width + 'px').toBeGreaterThanOrEqual(0);
    expect(dialogBounds!.x + dialogBounds!.width, 'Dialog right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    await confirm.getByRole('button', { name: 'Отмена' }).click();
    await expect(confirm).toBeHidden();
    await expect(revoke).toBeVisible();

    await checkPhoneLayout(page, width, true);
  }
  const row = page.getByTestId('admin-invitation-row').filter({ hasText: label });
  await row.getByTestId('admin-registration-revoke-invite').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Отозвать приглашение' }).click();
  await expect(row).toContainText('Отозвано', { timeout: 15_000 });
  await expect(row.getByTestId('admin-registration-revoke-invite')).toHaveCount(0);
});

test('mobile server log filters and search remain reachable at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const section = page.getByTestId('admin-server-logs');
    await expect(section).toBeVisible();
    const search = section.getByTestId('admin-logs-search');
    for (const control of [
      section.getByTestId('admin-logs-level-debug'),
      section.getByTestId('admin-logs-level-info'),
      section.getByTestId('admin-logs-level-warn'),
      section.getByTestId('admin-logs-level-error'),
      search,
      section.getByTestId('admin-logs-pause'),
    ]) {
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Logs control height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.width, 'Logs control width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.x, 'Logs control left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width, 'Logs control right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    }
    await section.getByTestId('admin-logs-level-error').click();
    await expect(section.getByTestId('admin-logs-level-error')).toHaveAttribute('data-slot', 'button');
    await search.fill('billok-mobile-logs-check');
    await search.focus();
    await search.scrollIntoViewIfNeeded();
    await expect(search).toBeInViewport();

    const pause = section.getByTestId('admin-logs-pause');
    await expect(pause).toHaveAttribute('aria-label', 'Приостановить автоматическое обновление');
    await pause.click();
    await expect(pause).toHaveAttribute('aria-label', 'Возобновить автоматическое обновление');
    await expect(section).toContainText('Автоматическое обновление приостановлено');
    await pause.click();
    await expect(pause).toHaveAttribute('aria-label', 'Приостановить автоматическое обновление');
    await checkPhoneLayout(page, width, true);
  }
});

test('mobile admin tools confirm cleanup safely at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let cleanupCalls = 0;
  // Queries can be part of a tRPC batch: preserve the other procedures.
  let countMocked = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const procedurePath = new URL(route.request().url()).pathname.split('/api/trpc/')[1] ?? '';
    const procedures = procedurePath.split(',');
    const index = procedures.indexOf('admin.getExpiredSplitCount');
    if (index < 0) {
      if (procedures.includes('admin.cleanupExpiredSplits')) {
        cleanupCalls++;
        await route.abort();
      } else {
        await route.continue();
      }
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const payload = Array.isArray(body) ? body[index] : body;
    expect(payload?.result?.data).toBeDefined();
    payload.result.data.json = { expiredCount: 2, totalCount: 2 };
    countMocked++;
    await route.fulfill({ response, json: body });
  });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const section = page.getByTestId('admin-tools-section');
    await expect(section).toBeVisible({ timeout: 15_000 });
    const cleanup = section.getByTestId('admin-tools-cleanup');
    await expect(cleanup).toBeEnabled({ timeout: 15_000 });
    for (const button of [
      section.getByTestId('admin-tools-export'),
      section.getByTestId('admin-tools-test-email'),
      cleanup,
    ]) {
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Admin tool height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.width, 'Admin tool width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.x, 'Admin tool left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width, 'Admin tool right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    }
    await cleanup.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Удалить незавершённые черновики?');
    await expect(dialog).toContainText('незавершённые черновики: 2');
    for (const button of [
      dialog.getByRole('button', { name: 'Отмена' }),
      dialog.getByRole('button', { name: 'Удалить черновики' }),
    ]) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Cleanup confirmation height at ' + width + 'px').toBeGreaterThanOrEqual(44);
    }
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x, 'Cleanup dialog left at ' + width + 'px').toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width, 'Cleanup dialog right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(dialog).toBeHidden();
    expect(cleanupCalls, 'Cancel must not delete data on ' + width + 'px').toBe(0);
    await checkPhoneLayout(page, width, true);
  }
  expect(cleanupCalls).toBe(0);
  expect(countMocked).toBeGreaterThan(0);
});

test('mobile admin announcement controls remain accessible at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let writes = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    if (procedures.includes('admin.setAnnouncement')) {
      writes++;
      await route.abort();
    } else {
      await route.continue();
    }
  });

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    const section = page.getByTestId('admin-announcement-section');
    await expect(section).toBeVisible({ timeout: 15_000 });
    const input = section.getByTestId('admin-announcement-input');
    const save = section.getByTestId('admin-announcement-save');
    const clear = section.getByTestId('admin-announcement-clear');
    await expect(input).toHaveAttribute('maxlength', '500');
    const controls = [input, save];
    if (await clear.count()) controls.push(clear);
    for (const control of controls) {
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Announcement control height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.width, 'Announcement control width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.x, 'Announcement control left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width, 'Announcement control right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    }

    const announcement = 'МобильноеОбъявление'.repeat(10);
    await input.fill(announcement);
    await expect(input).toHaveValue(announcement);
    await expect(section.getByTestId('admin-announcement-counter')).toContainText(
      'Символов: ' + announcement.length + '/500',
    );
    await expect(save).toBeEnabled();
    await input.focus();
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    expect(writes, 'No server changes while testing width ' + width + 'px').toBe(0);
    await checkPhoneLayout(page, width, true);
  }
  expect(writes).toBe(0);
});

test('mobile admin activity and audit tables scroll inside cards at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let mockedQueries = 0;
  let writes = 0;
  const longName = 'МобильныйЖурналОченьДлинноеНазваниеБезПробелов'.repeat(6);
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    if (route.request().method() !== 'GET') {
      writes++;
      await route.abort();
      return;
    }
    const activityIndex = procedures.indexOf('admin.getGlobalActivity');
    const auditIndex = procedures.indexOf('admin.getAuditLog');
    if (activityIndex < 0 && auditIndex < 0) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    if (activityIndex >= 0) {
      const item = entries[activityIndex];
      expect(item?.result?.data).toBeDefined();
      item.result.data.json = {
        items: [
          {
            id: 'mobile-activity-row',
            type: 'EXPENSE_CREATED',
            userName: longName,
            groupName: longName,
            createdAt: '2026-10-27T10:00:00.000Z',
          },
        ],
        nextCursor: 'mobile-activity-next',
      };
      // Drop the response's old SuperJSON metadata: a real query without a next
      // page marks nextCursor as undefined, overriding the mocked cursor.
      item.result.data = { json: item.result.data.json };
      mockedQueries++;
    }
    if (auditIndex >= 0) {
      const item = entries[auditIndex];
      expect(item?.result?.data).toBeDefined();
      item.result.data.json = {
        items: [
          {
            id: 'mobile-audit-row',
            action: 'INVITE_CREATED',
            adminName: longName,
            metadata: { name: longName },
            createdAt: '2026-10-27T10:00:00.000Z',
          },
        ],
        nextCursor: 'mobile-audit-next',
      };
      // Drop the response's old SuperJSON metadata: a real query without a next
      // page marks nextCursor as undefined, overriding the mocked cursor.
      item.result.data = { json: item.result.data.json };
      mockedQueries++;
    }
    await route.fulfill({ response, json: Array.isArray(body) ? entries : entries[0] });
  });

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    for (const ids of [
      { section: 'admin-activity-section', scroll: 'admin-activity-scroll', load: 'admin-activity-load-more' },
      { section: 'admin-audit-section', scroll: 'admin-audit-scroll', load: 'admin-audit-load-more' },
    ]) {
      const section = page.getByTestId(ids.section);
      await expect(section).toBeVisible({ timeout: 15_000 });
      const scroll = section.getByTestId(ids.scroll);
      await expect(scroll).toBeVisible();
      await expect(scroll.getByText(longName, { exact: true }).first()).toBeVisible();
      await expect(scroll).toHaveAttribute('tabindex', '0');
      await expect(scroll).toHaveAttribute('role', 'region');
      const metrics = await scroll.evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
      expect(metrics.scrollWidth, ids.scroll + ' must scroll inside its card').toBeGreaterThan(metrics.clientWidth);
      const rect = await scroll.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x, ids.scroll + ' left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width, ids.scroll + ' right at ' + width).toBeLessThanOrEqual(width + 1);
      const load = section.getByTestId(ids.load);
      await expect(load).toBeVisible();
      const button = await load.boundingBox();
      expect(button).not.toBeNull();
      expect(button!.height, ids.load + ' height at ' + width).toBeGreaterThanOrEqual(44);
      expect(button!.width, ids.load + ' width at ' + width).toBeGreaterThanOrEqual(44);
      expect(button!.x + button!.width, ids.load + ' right at ' + width).toBeLessThanOrEqual(width + 1);
    }
    await checkPhoneLayout(page, width, true);
    expect(writes, 'Audit E2E must not change persistent data').toBe(0);
  }
  expect(mockedQueries).toBeGreaterThanOrEqual(12);
  expect(writes).toBe(0);
});

test('mobile admin group search and status filters are touch-friendly at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    const section = page.getByTestId('admin-groups-section');
    await expect(section).toBeVisible({ timeout: 15_000 });
    const search = section.getByTestId('admin-groups-search');
    const filters = ['all', 'active', 'archived'].map((status) => section.getByTestId('admin-groups-filter-' + status));

    for (const control of [search, ...filters]) {
      await expect(control).toBeVisible();
      const rect = await control.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.height, 'Group filter/search height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(rect!.width, 'Group filter/search width at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(rect!.x, 'Group filter/search left at ' + width + 'px').toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width, 'Group filter/search right at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    }

    await expect(filters[0]!).toHaveAttribute('aria-pressed', 'true');
    await filters[1]!.click();
    await expect(filters[1]!).toHaveAttribute('aria-pressed', 'true');
    await filters[2]!.click();
    await expect(filters[2]!).toHaveAttribute('aria-pressed', 'true');
    await filters[0]!.click();
    await expect(filters[0]!).toHaveAttribute('aria-pressed', 'true');

    await search.fill('ОченьДлинноеИмяГруппыБезПробелов');
    await expect(search).toHaveValue('ОченьДлинноеИмяГруппыБезПробелов');
    await search.focus();
    await search.scrollIntoViewIfNeeded();
    await expect(search).toBeInViewport();
    await search.fill('');
    await checkPhoneLayout(page, width, true);
  }
});

test('mobile group table sort and local scroll at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  const groupName = 'ОченьДлинноеИмяГруппыБезПробелов'.repeat(3);
  let reads = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    const index = procedures.indexOf('admin.listGroups');
    if (index < 0) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const items = Array.isArray(body) ? body : [body];
    expect(items[index]?.result?.data).toBeDefined();
    // Replace the SuperJSON metadata together with the response to preserve nextCursor.
    items[index].result.data = {
      json: {
        groups: [
          {
            id: 'mobile-mocked-group',
            name: groupName,
            memberCount: 2,
            expenseCount: 1,
            currency: 'RUB',
            totalAmount: 12500,
            lastActivity: '2026-10-20T00:00:00Z',
            createdAt: '2026-10-19T00:00:00Z',
            isArchived: false,
          },
        ],
        totalCount: 2,
        totalExpenses: 1,
        totalSettlements: 0,
        nextCursor: 'next-mobile-page',
      },
    };
    reads++;
    await route.fulfill({ response, json: Array.isArray(body) ? items : items[0] });
  });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const section = page.getByTestId('admin-groups-section');
    const scroll = section.getByTestId('admin-groups-scroll');
    await expect(scroll.getByText(groupName, { exact: true })).toBeVisible();
    await expect(scroll).toHaveAttribute('tabindex', '0');
    const metrics = await scroll.evaluate((el) => ({ content: el.scrollWidth, visible: el.clientWidth }));
    expect(metrics.content).toBeGreaterThan(metrics.visible);
    const box = await scroll.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    const sort = section.getByTestId('admin-groups-sort-name');
    const sortBox = await sort.boundingBox();
    expect(sortBox).not.toBeNull();
    expect(sortBox!.height).toBeGreaterThanOrEqual(44);
    await sort.click();
    await expect(section.locator('th[aria-sort="ascending"]')).toContainText('Название');
    await sort.click();
    await expect(section.locator('th[aria-sort="descending"]')).toContainText('Название');
    const load = section.getByTestId('admin-groups-load-more');
    await expect(load).toBeVisible();
    const loadBox = await load.boundingBox();
    expect(loadBox).not.toBeNull();
    expect(loadBox!.height).toBeGreaterThanOrEqual(44);
    expect(loadBox!.width).toBeGreaterThanOrEqual(44);
    await checkPhoneLayout(page, width, true);
  }
  expect(reads).toBeGreaterThanOrEqual(6);
});

test('mobile admin group deletion dialog is safe at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let deletions = 0;
  const name = 'ДлинноеИмяГруппыБезПробелов'.repeat(5);
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    if (procedures.includes('admin.deleteGroup')) {
      deletions++;
      await route.abort();
      return;
    }
    const index = procedures.indexOf('admin.listGroups');
    if (index < 0) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    const entries = Array.isArray(data) ? data : [data];
    expect(entries[index]?.result?.data).toBeDefined();
    entries[index].result.data = {
      json: {
        groups: [
          {
            id: 'mock-group',
            name,
            memberCount: 2,
            expenseCount: 1,
            currency: 'RUB',
            totalAmount: 100,
            lastActivity: '2026-10-20T00:00:00Z',
            createdAt: '2026-10-20T00:00:00Z',
            isArchived: false,
          },
        ],
        totalCount: 1,
        totalExpenses: 1,
        totalSettlements: 0,
        nextCursor: null,
      },
    };
    await route.fulfill({ response, json: Array.isArray(data) ? entries : entries[0] });
  });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const trigger = page.getByTestId('admin-groups-delete-trigger');
    await trigger.scrollIntoViewIfNeeded();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
    expect(triggerBox!.width).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const dialog = page.getByTestId('admin-groups-delete-dialog');
    await expect(dialog).toContainText(name);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(box!.height).toBeLessThanOrEqual(380);
    for (const control of [
      dialog.getByTestId('admin-groups-delete-cancel'),
      dialog.getByTestId('admin-groups-delete-confirm'),
      dialog.locator('[data-slot="dialog-close"]'),
    ]) {
      const rect = await control.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(rect!.width).toBeGreaterThanOrEqual(44);
    }
    await dialog.getByTestId('admin-groups-delete-cancel').click();
    await expect(dialog).toBeHidden();
    expect(deletions).toBe(0);
    await checkPhoneLayout(page, width, true);
  }
});

test('mobile read-only admin health and storage cards fit six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  const longValue = 'АдаптивнаяПроверкаОченьДлинногоЗначенияБезПробелов'.repeat(3);
  let healthReads = 0;
  let storageReads = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    const healthIndex = procedures.indexOf('admin.getSystemHealth');
    const storageIndex = procedures.indexOf('admin.getStorageStats');
    if (healthIndex < 0 && storageIndex < 0) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    if (healthIndex >= 0) {
      expect(entries[healthIndex]?.result?.data).toBeDefined();
      entries[healthIndex].result.data = {
        json: {
          dbStatus: 'connected',
          version: longValue,
          commitSha: 'a'.repeat(96),
          uptime: 3600,
          serverStartTime: '2026-10-20T10:00:00.000Z',
        },
      };
      healthReads++;
    }
    if (storageIndex >= 0) {
      expect(entries[storageIndex]?.result?.data).toBeDefined();
      entries[storageIndex].result.data = {
        json: {
          receiptCount: 5,
          diskFiles: 3,
          totalDiskUsage: 1024,
          totalDiskUsageFormatted: longValue,
          orphanCount: 0,
          orphanPaths: [],
          unusedReceiptCount: 0,
          unusedReceiptBytes: 0,
          unusedReceiptBytesFormatted: '0 B',
        },
      };
      storageReads++;
    }
    await route.fulfill({ response, json: Array.isArray(body) ? entries : entries[0] });
  });

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    const health = page.getByTestId('admin-system-health');
    const storage = page.getByTestId('admin-storage-stats');
    await expect(health.getByTestId('admin-system-version')).toContainText(longValue);
    await expect(health.getByTestId('admin-system-commit')).toContainText('a'.repeat(96));
    await expect(storage.getByTestId('admin-storage-disk-usage')).toContainText(longValue);
    for (const section of [health, storage]) {
      await expect(section).toBeVisible();
      const cards = section.locator('[data-slot="card"]');
      await expect(cards).toHaveCount(section === health ? 3 : 4);
      for (const card of await cards.all()) {
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.width, 'Card width at ' + width).toBeGreaterThan(0);
        expect(bounds!.x, 'Card left at ' + width).toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width, 'Card right at ' + width).toBeLessThanOrEqual(width + 1);
        const sizes = await card.evaluate((element) => ({
          width: element.clientWidth,
          content: element.scrollWidth,
        }));
        expect(sizes.content, 'Card content overflow at ' + width).toBeLessThanOrEqual(sizes.width + 1);
      }
    }
    await checkPhoneLayout(page, width, true);
  }
  expect(healthReads).toBeGreaterThanOrEqual(6);
  expect(storageReads).toBeGreaterThanOrEqual(6);
});

test('mobile storage cleanup confirmation cancels both actions at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let cleanupMutations = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const procedures = path.split('/api/trpc/')[1]?.split(',') ?? [];
    if (procedures.some((name) => ['admin.cleanupOrphans', 'admin.cleanupUnusedReceipts'].includes(name))) {
      cleanupMutations++;
      await route.abort();
      return;
    }
    const index = procedures.indexOf('admin.getStorageStats');
    if (index < 0) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    const entries = Array.isArray(data) ? data : [data];
    expect(entries[index]?.result?.data).toBeDefined();
    entries[index].result.data = {
      json: {
        receiptCount: 12,
        diskFiles: 8,
        totalDiskUsage: 4096,
        totalDiskUsageFormatted: '4 KB',
        orphanCount: 3,
        orphanPaths: [],
        unusedReceiptCount: 4,
        unusedReceiptBytes: 2048,
        unusedReceiptBytesFormatted: '2 KB',
      },
    };
    await route.fulfill({ response, json: Array.isArray(data) ? entries : entries[0] });
  });

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const storage = page.getByTestId('admin-storage-stats');
    const triggers = storage.getByTestId('admin-storage-open-cleanup');
    await expect(triggers).toHaveCount(2);
    for (const index of [0, 1]) {
      const trigger = triggers.nth(index);
      const triggerRect = await trigger.boundingBox();
      expect(triggerRect).not.toBeNull();
      expect(triggerRect!.height).toBeGreaterThanOrEqual(44);
      expect(triggerRect!.width).toBeGreaterThanOrEqual(44);
      await trigger.click();
      const dialog = page.getByTestId('admin-storage-cleanup-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(index === 0 ? 'Файлов без связанного чека: 3' : 'Неиспользуемых чеков: 4');
      const rect = await dialog.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
      expect(rect!.height).toBeLessThanOrEqual(380);
      for (const button of [
        dialog.getByTestId('admin-storage-cleanup-cancel'),
        dialog.getByTestId('admin-storage-cleanup-confirm'),
        dialog.locator('[data-slot="dialog-close"]'),
      ]) {
        await expect(button).toBeVisible();
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
      }
      await dialog.getByTestId('admin-storage-cleanup-cancel').click();
      await expect(dialog).toBeHidden();
      expect(cleanupMutations, 'Closing dialog must not delete any data').toBe(0);
    }
    await checkPhoneLayout(page, width, true);
  }
  expect(cleanupMutations).toBe(0);
});

test('mobile BillOK hides legacy Venmo controls while preserving SBP at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await expect(page.getByTestId('admin-system-health')).toBeVisible();
    await expect(page.getByTestId('venmo-toggle-btn')).toHaveCount(0);
    await expect(page.getByText('Платежи через Venmo')).toHaveCount(0);
    await checkPhoneLayout(page, width, true);

    await page.goto('/settings', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const phone = page.getByTestId('sbp-phone-input');
    const bank = page.getByTestId('sbp-bank-search');
    await expect(phone).toBeVisible();
    await expect(bank).toBeVisible();
    await expect(page.getByTestId('venmo-username-input')).toHaveCount(0);
    for (const field of [phone, bank]) {
      const bounds = await field.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'SBP input touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(bounds!.x + bounds!.width, 'SBP input right edge at ' + width + 'px').toBeLessThanOrEqual(width + 1);
    }
    await checkPhoneLayout(page, width, true);
  }
});

test('mobile profile SBP search stays reachable with compact keyboard viewport', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  const height = 300;
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height });
    await page.goto('/settings', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const form = page.getByTestId('mobile-profile-form');
    const phone = form.getByTestId('sbp-phone-input');
    const search = form.getByTestId('sbp-bank-search');
    const options = form.getByTestId('sbp-bank-list');
    const save = form.getByTestId('save-profile-btn');

    await phone.focus();
    await phone.fill('+79991234567');
    await search.focus();
    await search.fill('Сбер');
    await expect(options.getByTestId('sbp-bank-option-sberbank')).toBeVisible();
    const option = options.getByTestId('sbp-bank-option-sberbank');
    await option.click();
    await expect(option.getByTestId('sbp-bank-radio-sberbank')).toBeChecked();

    const listDimensions = await options.evaluate((el) => ({ height: el.clientHeight }));
    expect(listDimensions.height, 'SBP list height at ' + width).toBeLessThanOrEqual(height * 0.36 + 2);
    for (const field of [phone, search, save]) {
      await field.scrollIntoViewIfNeeded();
      const rect = await field.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.height, 'Field touch height at ' + width).toBeGreaterThanOrEqual(44);
      expect(rect!.x, 'Field left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width, 'Field right at ' + width).toBeLessThanOrEqual(width + 1);
      expect(rect!.y, 'Field top at ' + width).toBeGreaterThanOrEqual(-1);
      expect(rect!.y + rect!.height, 'Field below viewport at ' + width).toBeLessThanOrEqual(height + 1);
    }
    await checkPhoneLayout(page, width);
  }
});

test('mobile invite modal survives long content and a short keyboard viewport', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let interceptedInvites = 0;
  await page.route('**/api/trpc/groups.createInvite*', async (route) => {
    interceptedInvites++;
    const token = 'long-test-token-'.repeat(12);
    const result = { result: { data: { json: { token } } } };
    const isBatch = new URL(route.request().url()).searchParams.has('batch');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isBatch ? [result] : result),
    });
  });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 300 });
    await page.goto('/groups', { waitUntil: 'networkidle' });
    const group = page.locator('a[href^="/groups/"]').filter({ hasText: 'Apartment' }).first();
    await expect(group).toBeVisible();
    await group.click();
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await page.getByRole('button', { name: 'Пригласить', exact: true }).click();
    const dialog = page.getByTestId('mobile-invite-dialog');
    await expect(dialog).toBeVisible();
    const title = dialog.locator('[data-slot="dialog-title"]');
    const description = dialog.locator('[data-slot="dialog-description"]');
    await expect(title).toBeVisible();
    await expect(description).toBeVisible();
    await description.evaluate((el) => {
      el.textContent += 'ДлинноеИмяПриглашённогоБезПробелов'.repeat(8);
    });
    const generate = dialog.getByRole('button', { name: 'Создать ссылку-приглашение' });
    await generate.scrollIntoViewIfNeeded();
    await expect(generate).toBeVisible();
    expect((await generate.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const before = interceptedInvites;
    await generate.click();
    await expect.poll(() => interceptedInvites).toBe(before + 1);
    const copy = dialog.getByTestId('mobile-copy-invite');
    await copy.scrollIntoViewIfNeeded();
    await expect(copy).toBeVisible();
    const close = dialog.locator('[data-slot="dialog-close"]');
    for (const button of [copy, close]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(-1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(301);
    const overflow = await dialog.evaluate((el) => ({
      content: el.scrollWidth,
      visible: el.clientWidth,
    }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.visible + 1);
    await close.click();
    await expect(dialog).toHaveCount(0);
    await checkPhoneLayout(page, width);
  }
  expect(interceptedInvites).toBe(6);
});

test('keyboard-height manual item inputs stay reachable at six mobile widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  let saveRequests = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && /guest\.(createSplit|createClaimSession)/.test(path)) {
      saveRequests++;
      await route.abort();
      return;
    }
    await route.continue();
  });
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 300 });
    await page.goto('/split', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await page.getByTestId('person-input-0').fill('Участник');
    await page.getByTestId('next-assign-btn').click();
    await expect(page.getByTestId('guest-assign-step')).toBeVisible();
    const bar = await page.getByTestId('guest-assign-actions').boundingBox();
    const header = await page.locator('header').first().boundingBox();
    expect(bar, 'Finalization bar geometry at ' + width + 'px').not.toBeNull();
    expect(header, 'Sticky header geometry at ' + width + 'px').not.toBeNull();
    expect(
      bar!.y - (header!.y + header!.height),
      'Clickable content gap at ' + width + 'px: ' + JSON.stringify({ bar, header }),
    ).toBeGreaterThanOrEqual(44);
    await page.getByTestId('guest-add-item-btn').click();
    const form = page.getByTestId('manual-item-entry-form');
    await expect(form).toBeVisible();
    await expect(page.getByTestId('guest-assign-actions')).toHaveCount(0);
    const fields = form.locator('input');
    await expect(fields).toHaveCount(3);
    await fields.nth(0).fill('БлюдоБезПробелов'.repeat(5));
    await fields.nth(1).fill('2');
    await fields.nth(2).fill('155,70');
    for (const control of [
      fields.nth(0),
      fields.nth(1),
      fields.nth(2),
      form.getByTestId('guest-add-item-submit'),
      form.getByRole('button', { name: 'Отмена' }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const b = await control.boundingBox();
      expect(b).not.toBeNull();
      expect(b!.height, 'Touch height at ' + width).toBeGreaterThanOrEqual(44);
      expect(b!.x, 'Left boundary at ' + width).toBeGreaterThanOrEqual(-1);
      expect(b!.x + b!.width, 'Right boundary at ' + width).toBeLessThanOrEqual(width + 1);
      expect(b!.y, 'Top boundary at ' + width).toBeGreaterThanOrEqual(-1);
      expect(b!.y + b!.height, 'Bottom boundary at ' + width).toBeLessThanOrEqual(301);
    }
    await checkPhoneLayout(page, width, true);
    await form.getByTestId('guest-add-item-submit').click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
    // Open the split before showing the mobile keyboard.
    await page.setViewportSize({ width, height: 520 });
    await page.getByTestId('guest-split-btn-0').click();
    const qty = page.getByTestId('guest-split-qty-0');
    const confirmSplit = page.getByTestId('guest-split-submit-0');
    await expect(qty).toBeVisible();
    await page.setViewportSize({ width, height: 300 });
    await expect(page.getByTestId('guest-assign-actions')).toHaveCount(0);
    await qty.fill('0');
    await expect(confirmSplit).toBeDisabled();
    await qty.fill('1');
    await expect(confirmSplit).toBeEnabled();
    for (const control of [qty, confirmSplit]) {
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.height, 'Split touch height at ' + width).toBeGreaterThanOrEqual(44);
      expect(rect!.x, 'Split left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width, 'Split right at ' + width).toBeLessThanOrEqual(width + 1);
      expect(rect!.y, 'Split top at ' + width).toBeGreaterThanOrEqual(-1);
      expect(rect!.y + rect!.height, 'Split bottom at ' + width).toBeLessThanOrEqual(301);
    }
    await checkPhoneLayout(page, width, true);
    await confirmSplit.click();
    await expect(page.locator('[data-testid^="guest-item-card-"]')).toHaveCount(2);
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
    // Restore the normal viewport to select the two local portions.
    await page.setViewportSize({ width, height: 520 });
    for (const idx of [0, 1]) {
      const guest = page.getByTestId('guest-item-card-' + idx).getByRole('button', { name: 'Участник' });
      // The floating action bar must leave a usable region for each portion chip.
      await guest.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      const hit = await guest.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const overlay = document.elementFromPoint(x, y);
        const bar = document.querySelector('[data-testid="guest-assign-actions"]')?.getBoundingClientRect();
        const header = document.querySelector('header')?.getBoundingClientRect();
        return {
          height: rect.height,
          visible: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
          clickable: overlay === element || element.contains(overlay),
          target: overlay?.tagName,
          barTop: bar?.top ?? null,
          headerBottom: header?.bottom ?? null,
          centerY: y,
        };
      });
      expect(hit.height, 'Portion chip height at ' + width).toBeGreaterThanOrEqual(44);
      expect(hit.visible, 'Chip outside viewport at ' + width + ': ' + JSON.stringify(hit)).toBe(true);
      expect(hit.clickable, 'Chip intercepted at ' + width + ': ' + JSON.stringify(hit)).toBe(true);
      await guest.click();
      await expect(guest).toHaveClass(/bg-primary/);
    }
    const finalSave = page.getByTestId('create-split-btn');
    await expect(finalSave).toBeEnabled();
    const card = page.getByTestId('guest-item-card-0');
    await card.locator('button[title]').first().click();
    const edit = page.getByTestId('guest-edit-item-form');
    await expect(edit).toBeVisible();
    await page.setViewportSize({ width, height: 300 });
    await expect(page.getByTestId('guest-assign-actions')).toHaveCount(0);
    const editedName = edit.locator('input').first();
    await editedName.fill('   ');
    const saveEdit = edit.getByRole('button', { name: 'Сохранить' });
    const cancelEdit = edit.getByRole('button', { name: 'Отмена' });
    for (const control of [editedName, saveEdit, cancelEdit]) {
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds, 'Edit action at ' + width).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y).toBeGreaterThanOrEqual(-1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(301);
    }
    await saveEdit.click();
    await expect(page.getByText('Укажите название позиции.', { exact: true })).toBeVisible();
    await expect(edit).toBeVisible();
    await checkPhoneLayout(page, width, true);
    await cancelEdit.click();
    await expect(edit).toHaveCount(0);
    await expect(card).toContainText('БлюдоБезПробелов');
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
    await page.setViewportSize({ width, height: 520 });
    await card.locator('button[title]').first().click();
    await page.getByTestId('guest-edit-item-form').locator('input').first().fill('Блюдо на двоих');
    await page.getByTestId('guest-edit-item-form').getByRole('button', { name: 'Сохранить' }).click();
    await expect(card).toContainText('Блюдо на двоих');
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
    expect(saveRequests, 'Local edit, cancel and validation cannot create a receipt').toBe(0);
  }
  expect(saveRequests).toBe(0);
});

test('group search and archive fit with a keyboard-height viewport', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsSeedAdmin(page);
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 300 });
    await page.goto('/groups', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const search = page.getByTestId('mobile-groups-search');
    const archived = page.getByTestId('mobile-groups-archived-toggle');
    const create = page.getByTestId('mobile-groups-create');
    await expect(search).toBeVisible();
    await expect(archived).toHaveAttribute('aria-pressed', 'false');
    for (const control of [search, archived, create]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box, 'Group control at ' + width).not.toBeNull();
      expect(box!.height, 'Touch height at ' + width).toBeGreaterThanOrEqual(44);
      expect(box!.x, 'Left edge at ' + width).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, 'Right edge at ' + width).toBeLessThanOrEqual(width + 1);
      expect(box!.y, 'Top edge at ' + width).toBeGreaterThanOrEqual(-1);
      expect(box!.y + box!.height, 'Bottom edge at ' + width).toBeLessThanOrEqual(301);
    }
    await search.fill('Apartment');
    const link = page.locator('a[href^="/groups/"]').filter({ hasText: 'Apartment' }).first();
    await expect(link).toBeVisible();
    await checkPhoneLayout(page, width);
    await search.fill('no-such-billok-group-1234');
    await expect(link).toHaveCount(0);
    await search.fill('');
    await archived.click();
    await expect(archived).toHaveAttribute('aria-pressed', 'true');
    await archived.click();
    await expect(archived).toHaveAttribute('aria-pressed', 'false');
    await checkPhoneLayout(page, width);
    await search.fill('Apartment');
    await link.click();
    await expect(page).toHaveURL(/\/groups\/[^/]+$/);
    await checkPhoneLayout(page, width);
  }
});

test('receipt-linked history layout is usable on six keyboard-sized phones', async ({ page }) => {
  test.setTimeout(160_000);
  const group = await createTestGroup(users.alice.email, users.alice.password, [
    { email: users.bob.email, password: users.bob.password },
  ]);
  const note = 'ДлинноеПримечание'.repeat(5);
  let deleted = 0;
  try {
    await signInAsSeedAdmin(page);
    // Mocked visual history only: no payment record is created.
    await page.route('**/api/trpc/**', async (route) => {
      const names = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
      if (names.includes('settlements.delete')) {
        deleted++;
        return route.abort();
      }
      const idx = names.indexOf('settlements.list');
      if (idx < 0) return route.continue();
      const response = await route.fetch();
      const original = await response.json();
      const rows = Array.isArray(original) ? original : [original];
      rows[idx].result.data = {
        json: {
          items: [
            {
              id: 'visual-only',
              fromId: group.memberIds[users.bob.email],
              toId: group.memberIds[users.alice.email],
              from: { name: 'Борис'.repeat(8) },
              to: { name: 'Алексей'.repeat(6) },
              amount: 61728395,
              currency: 'RUB',
              baseCurrencyAmount: null,
              settledAt: '2026-11-01T00:00:00Z',
              note,
            },
          ],
          nextCursor: null,
        },
      };
      return route.fulfill({ response, json: Array.isArray(original) ? rows : rows[0] });
    });
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 300 });
      await page.goto('/groups/' + group.groupId, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      const row = page.getByTestId('payments-section').getByTestId('payment-row');
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('payment-note')).toContainText(note);
      await expect(row.getByTestId('payment-amount')).toContainText('₽');
      await checkPhoneLayout(page, width);
      const remove = row.getByTestId('delete-payment');
      const button = await remove.boundingBox();
      expect(button!.width).toBeGreaterThanOrEqual(44);
      expect(button!.height).toBeGreaterThanOrEqual(44);
      await remove.click();
      const dialog = page.getByTestId('mobile-payment-delete-dialog');
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y).toBeGreaterThanOrEqual(-1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(301);
      await dialog.getByTestId('cancel-delete-payment').click();
      await expect(dialog).toHaveCount(0);
      expect(deleted).toBe(0);
    }
  } finally {
    await group.dispose();
  }
});

test('mobile group and expense dialogs remain reachable without mutations', async ({ page }) => {
  test.setTimeout(260_000);
  const group = await createTestGroup(
    users.alice.email,
    users.alice.password,
    [{ email: users.bob.email, password: users.bob.password }],
    'Мобильная проверка диалогов',
  );
  const expenseTitle = 'БольшойЧекДляПроверки'.repeat(2);
  try {
    const bobMemberId = group.memberIds[users.bob.email];
    if (!bobMemberId) throw new Error('Missing disposable Bob member ID');
    const placeholder = await trpcMutation(group.owner, 'groups.addPlaceholder', {
      groupId: group.groupId,
      name: 'ДлинноеИмяГостяДляДиалога',
    });
    expect(placeholder.ok(), await placeholder.text()).toBeTruthy();
    const created = await trpcMutation(group.owner, 'expenses.create', {
      groupId: group.groupId,
      title: expenseTitle,
      amount: 125000,
      currency: 'RUB',
      paidById: group.memberIds[users.alice.email],
      splitMode: 'EQUAL',
      shares: [
        { userId: group.memberIds[users.alice.email], amount: 62500 },
        { userId: group.memberIds[users.bob.email], amount: 62500 },
      ],
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const expenseId = (await created.json()).result.data.json.id as string;
    await signInAsSeedAdmin(page);
    const blockedMutations: string[] = [];
    const mutations = new Set([
      'groups.create',
      'groups.update',
      'groups.delete',
      'groups.mergePlaceholder',
      'groups.transferOwnership',
      'expenses.create',
      'expenses.update',
      'expenses.delete',
      'settlements.create',
      'settlements.delete',
    ]);
    await page.route('**/api/trpc/**', async (route) => {
      const names = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
      for (const name of names) {
        if (mutations.has(name)) {
          blockedMutations.push(name);
          await route.abort();
          return;
        }
      }
      await route.continue();
    });

    async function checkControl(locator: ReturnType<Page['locator']>, width: number, name: string) {
      await expect(locator).toBeVisible();
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      expect(box, name + ' missing at ' + width).not.toBeNull();
      expect(box!.x, name + ' left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, name + ' right at ' + width).toBeLessThanOrEqual(width + 1);
      expect(box!.y, name + ' top at ' + width).toBeGreaterThanOrEqual(-1);
      expect(box!.y + box!.height, name + ' bottom at ' + width).toBeLessThanOrEqual(301);
      expect(box!.height, name + ' touch height at ' + width).toBeGreaterThanOrEqual(44);
    }

    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 300 });

      // Group creation: fill draft only, never submit.
      await page.goto('/groups/new', { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await page.locator('#name').fill('ГруппаБезПробеловДляТелефона');
      await checkControl(page.locator('#name'), width, 'Create group name');
      await checkControl(page.locator('form button[type=submit]'), width, 'Create group action');
      await checkPhoneLayout(page, width);

      // Editing existing group: no changes are saved.
      await page.goto('/groups/' + group.groupId + '/settings', { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await page.locator('#name').fill('НовоеИмяДляПредпросмотра');
      await checkControl(page.locator('#name'), width, 'Edit group name');
      await checkControl(page.locator('#description'), width, 'Edit group description');
      await checkControl(page.locator('form').first().locator('button[type=submit]'), width, 'Save group action');
      await checkPhoneLayout(page, width);

      // Group-member merge: selection and cancellation only.
      await page.getByTestId('mobile-group-merge-trigger').click();
      const mergeDialog = page.getByTestId('mobile-group-merge-dialog');
      await checkControl(mergeDialog.locator('#merge-target'), width, 'Merge group member');
      await mergeDialog.locator('#merge-target').selectOption(bobMemberId);
      await checkControl(mergeDialog.getByRole('button', { name: 'Отмена' }), width, 'Cancel group merge');
      await mergeDialog.getByRole('button', { name: 'Отмена' }).click();
      await expect(mergeDialog).toHaveCount(0);

      // Ownership transfer: selection and cancellation only.
      await page.getByTestId('mobile-group-transfer-trigger').click();
      const transferDialog = page.getByTestId('mobile-group-transfer-dialog');
      await checkControl(transferDialog.locator('#transfer-target'), width, 'Transfer group owner');
      await transferDialog.locator('#transfer-target').selectOption(bobMemberId);
      await checkControl(transferDialog.getByRole('button', { name: 'Отмена' }), width, 'Cancel owner transfer');
      await transferDialog.getByRole('button', { name: 'Отмена' }).click();
      await expect(transferDialog).toHaveCount(0);

      // Group removal: inspect confirmation and cancel, no delete mutation.
      await page.getByTestId('mobile-group-delete-trigger').click();
      const groupAlert = page.getByRole('alertdialog');
      await expect(groupAlert).toBeVisible();
      await checkControl(groupAlert.getByRole('button', { name: 'Отмена' }), width, 'Cancel group deletion');
      await groupAlert.getByRole('button', { name: 'Отмена' }).click();
      await expect(groupAlert).toHaveCount(0);
      await checkPhoneLayout(page, width);

      // New manual expense form: preview only.
      await page.goto('/groups/' + group.groupId + '/expenses/new', { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await page.locator('#title').fill('ПозицииЧекаДляПроверки');
      await checkControl(page.locator('#title'), width, 'New expense title');
      await checkControl(page.locator('#amount'), width, 'New expense amount');
      await checkControl(page.locator('form button[type=submit]'), width, 'Create expense action');
      await checkPhoneLayout(page, width);

      // Edit existing disposable expense; do not submit changes.
      await page.goto('/groups/' + group.groupId + '/expenses/' + expenseId + '/edit', { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await page.locator('#title').fill('ЧерновикРедактированияЧека');
      await checkControl(page.locator('#title'), width, 'Edit expense title');
      await checkControl(page.locator('#amount'), width, 'Edit expense amount');
      await checkControl(page.locator('form button[type=submit]'), width, 'Save expense action');
      await checkPhoneLayout(page, width);

      // Expense deletion: the existing record must survive Cancel.
      await page.goto('/groups/' + group.groupId + '/expenses/' + expenseId, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await checkControl(page.getByTestId('expense-detail-edit'), width, 'Expense edit link');
      await checkControl(page.getByTestId('expense-detail-delete'), width, 'Expense delete action');
      await page.getByTestId('expense-detail-delete').click();
      const expenseAlert = page.getByRole('alertdialog');
      await expect(expenseAlert).toContainText(expenseTitle);
      await checkControl(expenseAlert.getByRole('button', { name: 'Отмена' }), width, 'Cancel expense deletion');
      await expenseAlert.getByRole('button', { name: 'Отмена' }).click();
      await expect(expenseAlert).toHaveCount(0);
      await expect(page.getByRole('heading', { name: expenseTitle })).toBeVisible();
      await checkPhoneLayout(page, width);
      expect(blockedMutations, 'No write request at ' + width).toEqual([]);
    }
  } finally {
    await group.dispose();
  }
});
