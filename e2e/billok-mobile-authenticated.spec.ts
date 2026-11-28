import {
  authedPasskeyContext,
  signedQaAssertion,
  installSelectedQaPasskey,
  loginWithPasskey,
  enableVirtualPasskey,
} from './passkey-auth';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { auditMobileViewport, auditMobileTarget } from './billok-mobile-viewport-audit';
import { createTestGroup, trpcMutation, trpcQuery, trpcResult, users } from './helpers';
import { systemInviteCreateApprovalTarget } from '@/lib/system-invite-approval-target';

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

// Real WebAuthn assertions produce these Auth.js cookies. Cache a signed
// session per Playwright worker instead of initiating 25 browser login
// ceremonies against the same disposable QA account in one short run.
// This is NOT a mock session or a bypass: the session is issued only after
// a valid WebAuthn challenge is verified by the real QA server.
type SignedQaCookies = Awaited<ReturnType<BrowserContext['storageState']>>['cookies'];
const signedQaSessions = new Map<string, Promise<SignedQaCookies>>();

async function signedQaCookies(email: string): Promise<SignedQaCookies> {
  let pending = signedQaSessions.get(email);
  if (!pending) {
    pending = (async () => {
      const session = await authedPasskeyContext(email, 0);
      try {
        return (await session.storageState()).cookies;
      } finally {
        await session.dispose();
      }
    })();
    signedQaSessions.set(email, pending);
  }
  try {
    return await pending;
  } catch (error) {
    signedQaSessions.delete(email);
    throw error;
  }
}

async function signInAsSeedAdmin(page: Page) {
  // "alice@qa.billok.ru" is an ordinary QA account despite ADMIN_EMAIL.
  await page.context().addCookies(await signedQaCookies('alice@qa.billok.ru'));
  await page.goto('/dashboard', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
}

// The single completed OwnerBootstrap record references this distinct account.
async function signInAsOwnerAdmin(page: Page) {
  await page.context().addCookies(await signedQaCookies('owner-qa@mail.ru'));
  await page.goto('/dashboard', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
}

// Authenticated API-level WebAuthn assertion for the NON-destructive mobile
// layout suite. Key #0 uses zero-counter multi-device semantics; the separate
// owner recovery suite exclusively tests CTAP2 browser button flows using keys
// #0–#2 AFTER this suite. Never install a counter-incrementing CTAP2 authenticator
// for the shared API key here: it would invalidate subsequent QA logins.
async function approveQaOwnerAction(
  context: APIRequestContext,
  action: 'SYSTEM_INVITE_CREATE' | 'SYSTEM_INVITE_REVOKE' | 'IMPERSONATE',
  targetId: string,
) {
  const started = await context.post('/api/webauthn/owner/approval/start', {
    data: { action, targetId },
  });
  expect(started.ok(), 'WebAuthn start rejected: ' + (await started.text())).toBe(true);
  const { options } = (await started.json()) as { options: { challenge: string; rpId: string } };
  const signed = signedQaAssertion({
    email: 'owner-qa@mail.ru',
    credentialIndex: 0,
    challenge: options.challenge,
    rpId: options.rpId,
  });
  const finished = await context.post('/api/webauthn/owner/approval/finish', { data: signed });
  expect(finished.ok(), 'WebAuthn signature rejected: ' + (await finished.text())).toBe(true);
  const { approvalToken } = (await finished.json()) as { approvalToken: string };
  expect(approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return approvalToken;
}

// One authenticated session across four viewports avoids tripping BillOK's
// login rate limiter when Chromium runs several mobile tests in parallel.
test.use({
  viewport: { width: 320, height: 800 },
  isMobile: true,
  hasTouch: true,
});

test('6.12.6: live middleware rejects CSRF Origin/Forwarded spoofing before WebAuthn or admin data', async ({
  request,
}) => {
  const payload = { approvalToken: 'x'.repeat(43) };
  for (const path of [
    '/api/admin/export',
    '/api/admin/impersonate',
    '/api/webauthn/owner/approval/start',
    '/api/trpc/auth.updateProfile',
  ]) {
    const foreign = await request.post(path, {
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      data: payload,
    });
    expect(foreign.status(), path).toBe(403);
    expect(await foreign.text(), path).toContain('Недоверенный источник');
  }
  const forwarded = await request.post('/api/admin/export', {
    headers: { 'X-Forwarded-Host': 'attacker.invalid', 'Content-Type': 'application/json' },
    data: payload,
  });
  expect(forwarded.status()).toBe(403);
  expect(await forwarded.text()).toContain('Недоверенный источник');
});

test('ADMIN_EMAIL-matched account cannot impersonate or export without sole owner User.id', async ({ page }) => {
  test.setTimeout(60_000);
  // On disposable CI ADMIN_EMAIL intentionally equals Alice; the finished
  // OwnerBootstrap row instead references owner-qa@mail.ru.
  const ordinary = await authedPasskeyContext('alice@qa.billok.ru', 0);
  try {
    await page.context().addCookies((await ordinary.storageState()).cookies);
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    // GET export is intentionally disabled for everyone. A signed-form POST
    // by this non-owner is still denied by immutable ownerId.
    const exportResponse = await ordinary.get('/api/admin/export');
    expect(exportResponse.status()).toBe(405);
    const deniedExport = await ordinary.post('/api/admin/export', {
      data: { approvalToken: 'b'.repeat(43) },
    });
    expect(deniedExport.status()).toBe(403);
    const impersonation = await ordinary.post('/api/admin/impersonate', {
      data: { userId: 'billok-owner', approvalToken: 'b'.repeat(43) },
    });
    expect(impersonation.status()).toBe(403);
    const adminQuery = await ordinary.get(
      '/api/trpc/admin.getAuditLog?input=' + encodeURIComponent(JSON.stringify({ json: { limit: 1 } })),
    );
    expect(adminQuery.status()).toBe(403);
    await page.goto('/admin/users', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('owner-users-page')).toHaveCount(0);
    expect(
      (
        (await (await ordinary.get('/api/auth/session')).json()) as {
          user?: { email?: string };
        }
      ).user?.email,
    ).toBe('alice@qa.billok.ru');
  } finally {
    await ordinary.dispose();
  }
});

test('Russian mobile dashboard, groups and expenses at all 4 phone widths', async ({ page }) => {
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
    // Alice is NOT the owner: matching ADMIN_EMAIL must not show the admin link.
    await expect(menu.getByRole('link', { name: 'Администрирование', exact: true })).toHaveCount(0);
    for (const name of ['Главная', 'Группы', 'Разделить чек', 'Мои чеки', 'Настройки']) {
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

    // Owner-only admin is exercised independently below; this flow uses
    // Alice's ordinary account for her own dashboard and group history.
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
  await expect(page.getByTestId('sbp-profile-receipt-scope')).toContainText('Суммы и история платежей не меняются');

  await phone.fill('89991234567');
  await tbankRow.click();
  await expect(selectedTbank).toBeChecked();
  const selectedBank = page.getByTestId('sbp-bank-selected');
  await expect(selectedBank).toContainText('Т-Банк');
  await expect(selectedBank.locator('img')).toHaveAttribute('src', '/banks/tbank.svg');
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
  await expect(page.getByTestId('sbp-bank-selected').locator('img')).toHaveAttribute(
    'src',
    '/banks/nspk/100000000273.webp',
  );
  await checkPhoneLayout(page, 320);

  // Complete mobile profile acceptance: real name editing and contact data,
  // persistence through the profile API, enlarged Android font, short keyboard
  // viewport, touch targets, and all expected phone/foldable widths.
  const name = page.locator('#name');
  const originalName = await name.inputValue();
  const changedName = 'Участник BillOK ' + 'ОченьДлинноеИмя'.repeat(4);
  expect(changedName.length).toBeLessThanOrEqual(100);
  await name.fill(changedName);
  await page.getByTestId('sbp-phone-input').fill('89991234567');
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

test('Issue 19.18: strict profile SBP phone characters, digit ceiling, paste and reload', async ({ page }) => {
  test.setTimeout(110_000);
  await signInAsSeedAdmin(page);
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const phone = page.getByTestId('sbp-phone-input');
  const save = page.getByTestId('save-profile-btn');
  const error = page.getByTestId('sbp-phone-validation');
  await expect(phone).toBeVisible();
  await phone.fill('89991234567');
  await expect(save).toBeEnabled();
  await phone.press('9'); // 12th digit is rejected, existing value preserved.
  await expect(phone).toHaveValue('89991234567');
  await phone.press('3'); // Repeated invalid digit must not stick in the DOM.
  await expect(phone).toHaveValue('89991234567');
  await expect(error).toContainText('11 цифр');
  await expect(save).toBeEnabled(); // 11 valid digits remain savable after rejected 12th/13th.
  await phone.fill('79991234567'); // edit clears rejected-input state.
  await expect(error).toBeEmpty();
  await expect(save).toBeEnabled();
  await phone.fill('+79991234567');
  await phone.press('8'); // 13th visible character cannot be added.
  await expect(phone).toHaveValue('+79991234567');
  await phone.fill('89991234567');
  await phone.evaluate((el) => {
    const target = el as HTMLInputElement;
    target.setSelectionRange(0, target.value.length);
    const clipboard = new DataTransfer();
    clipboard.setData('text', '+7 (999) 123-45-67');
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(phone).toHaveValue('89991234567');
  await expect(error).toContainText('вставка отклонены');
  await expect(save).toBeDisabled();
  await phone.fill('899912345678'); // invalid overlong fill never silently truncates and saves.
  await expect(phone).toHaveValue('89991234567');
  await phone.fill('79991234567');
  await expect(save).toBeEnabled();

  await phone.evaluate((el) => (el as HTMLInputElement).setSelectionRange(1, 2));
  await phone.press('8'); // replacement in middle of a complete phone is allowed.
  await expect(phone).toHaveValue('78991234567');
  await phone.fill('79991234567');
  await phone.fill('8999123456');
  await expect(save).toBeDisabled();
  await expect(error).toContainText('полный российский номер');
  await phone.fill('89991234567');
  await page.getByTestId('sbp-bank-option-tbank').click();
  await save.click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('sbp-phone-input')).toHaveValue('+79991234567');
  const again = page.getByTestId('sbp-phone-input');
  await again.fill('79991234567');
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByText('Профиль обновлён!')).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('sbp-phone-input')).toHaveValue('+79991234567');
  await page.addStyleTag({ content: 'html {font-size:20px !important}' });
  for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    const current = page.getByTestId('sbp-phone-input');
    await current.scrollIntoViewIfNeeded();
    const rect = await current.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
    await checkPhoneLayout(page, width);
  }
  // Restore the disposable seeded user's contact.
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

test('real owner mobile user page keeps filters and confirmed suspension safe', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsOwnerAdmin(page);
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('admin-user-management')).toHaveCount(0);
    await page.getByTestId('owner-users-nav').click();
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const section = page.getByTestId('owner-users-page');
    await expect(section).toBeVisible();
    const search = section.getByTestId('owner-users-search');
    await expect(search).toBeVisible();
    for (const filter of ['all', 'active', 'suspended', 'pending']) {
      const button = section.getByTestId('owner-users-filter-' + filter);
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
    }
    await search.fill('bob@qa.billok.ru');
    const row = section.locator('[data-testid^="owner-user-"]').filter({ hasText: 'bob@qa.billok.ru' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    const block = row.getByRole('button', { name: 'Заблокировать' });
    await expect(block).toBeVisible();
    expect((await block.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await block.click();
    const dialog = page.getByTestId('owner-users-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Bob Smith');
    const bounds = await dialog.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width, 'Confirmation outside ' + width).toBeLessThanOrEqual(width + 1);
    await dialog.getByTestId('owner-users-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await checkPhoneLayout(page, width, true);
  }
});

test('mobile invitation management keeps registration controls accessible at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsOwnerAdmin(page);
  const label = 'МобильноеПриглашение'.repeat(2);
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const section = page.getByTestId('admin-registration-control');
  await expect(section).toBeVisible();
  // 6.12.4.3: the old test clicked Create with just a session cookie, but
  // creation now requires a signed WebAuthn assertion. Preserve the six-width
  // UI audit by creating the disposable invite using a REAL server-verified
  // QA WebAuthn signature rather than bypassing the security gate.
  const createApproval = await approveQaOwnerAction(
    page.request,
    'SYSTEM_INVITE_CREATE',
    systemInviteCreateApprovalTarget(label),
  );
  const createResponse = await trpcMutation(page.request, 'admin.createSystemInvite', {
    label,
    expiresInDays: 7,
    approvalToken: createApproval,
  });
  expect(createResponse.ok(), 'Signed invite creation failed: ' + (await createResponse.text())).toBe(true);
  const created = (await createResponse.json()) as { result: { data: { json: { id: string } } } };
  const inviteId = created.result.data.json.id;
  expect(inviteId).toBeTruthy();
  await page.reload({ waitUntil: 'networkidle' });
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
  // Revoke the same disposable code with a DIFFERENT freshly signed approval.
  // The mobile revoke dialog's real CTAP2 click path is covered by the owner
  // recovery Chromium suite, after this shared-key layout suite finishes.
  const revokeApproval = await approveQaOwnerAction(page.request, 'SYSTEM_INVITE_REVOKE', inviteId);
  const revokeResponse = await trpcMutation(page.request, 'admin.revokeSystemInvite', {
    inviteId,
    approvalToken: revokeApproval,
  });
  expect(revokeResponse.ok(), 'Signed invite revocation failed: ' + (await revokeResponse.text())).toBe(true);
  await page.reload({ waitUntil: 'networkidle' });
  const row = page.getByTestId('admin-invitation-row').filter({ hasText: label });
  await expect(row).toContainText('Отозвано', { timeout: 15_000 });
  await expect(row.getByTestId('admin-registration-revoke-invite')).toHaveCount(0);
});

test('TASK-BILLOK-011 invitation cards and UUID journal fit 32 mobile combinations', async ({ page }) => {
  test.setTimeout(220_000);
  await signInAsOwnerAdmin(page);
  const a = 'abcdef12-1234-4abc-8def-123456789abc';
  const b = 'abcdef12-4321-4abc-8def-123456789abc';
  const missing = '01234567-4321-4abc-8def-123456789abc';
  const none = '12345678-4321-4abc-8def-123456789abc';
  const longName = 'ОченьДлинноеИмяБезПробелов'.repeat(7);
  const longEmail = 'a'.repeat(64) + '@' + 'b'.repeat(60) + '.mail.ru';
  const label = 'ПримечаниеБезПробелов'.repeat(7);
  const createdAt = '2026-11-28T22:15:32.000Z';
  const expiresAt = '2026-12-05T22:15:32.000Z';
  const usedAt = '2026-11-29T01:02:03.000Z';
  const revokedAt = '2026-11-29T01:02:04.000Z';
  const code = 'synthetic-invite-qa-code-for-clipboard-only';
  const baseInvite = {
    id: 'active',
    label,
    code,
    createdAt,
    expiresAt,
    usedAt: null,
    revokedAt: null,
    usedBy: null,
    isActive: true,
    isReserved: false,
    canRevoke: true,
  };
  const invites = [
    baseInvite,
    { ...baseInvite, id: 'reserved', label: 'Резерв', isActive: false, isReserved: true, code: 'reserved-qa-code' },
    {
      ...baseInvite,
      id: 'used',
      label: 'Использованный',
      usedAt,
      usedBy: { name: longName, email: longEmail },
      isActive: false,
      canRevoke: false,
    },
    { ...baseInvite, id: 'revoked', label: 'Отозванный', revokedAt, isActive: false, canRevoke: false },
    {
      ...baseInvite,
      id: 'expired',
      label: 'Исторический',
      expiresAt: '2027-01-01T00:00:00.000Z',
      isActive: false,
      canRevoke: false,
    },
    { ...baseInvite, id: 'invalid', label: null, expiresAt: null, isActive: false, canRevoke: false },
    {
      ...baseInvite,
      id: 'email-fallback',
      label: 'Без имени',
      usedAt,
      usedBy: { name: null, email: longEmail },
      isActive: false,
      canRevoke: false,
    },
  ];
  const baseEvent = { action: 'OWNER_PASSKEY_RENAMED', outcome: 'ALLOWED', targetFingerprint: null, createdAt };
  const accounts = {
    a: { name: 'Гость', email: longEmail, isOwner: true },
    b: { name: 'Гость', email: 'second-qa@mail.ru', isOwner: false },
  };
  const initial = [
    { ...baseEvent, id: 'owner', actorId: a, actor: accounts.a },
    { ...baseEvent, id: 'regular', actorId: b, actor: accounts.b },
    { ...baseEvent, id: 'missing', actorId: missing, actor: null },
    { ...baseEvent, id: 'legacy', actorId: 'legacy-identifier-' + 'x'.repeat(100), actor: null },
    { ...baseEvent, id: 'unknown', actorId: null, actor: null },
  ];
  const filtered = Array.from({ length: 43 }, (_, i) => ({
    ...baseEvent,
    id: 'filtered-' + i,
    actorId: a,
    actor: { ...accounts.a, name: longName },
  }));
  let failNext = true;
  let delayFirst = false;
  let releaseDelayed: (() => void) | undefined;
  const calls: Array<{ actorId?: string; cursor?: string }> = [];
  let writes = 0;
  // Clipboard is isolated per browser page, never the CI host clipboard.
  await page.addInitScript(() => {
    let value = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          value = text;
        },
        readText: async () => value,
      },
      configurable: true,
    });
  });
  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    const invitesIndex = procedures.indexOf('admin.listSystemInvites');
    const securityIndex = procedures.indexOf('admin.getSecurityEvents');
    if (route.request().method() !== 'GET') {
      writes++;
      await route.abort();
      return;
    }
    if (invitesIndex < 0 && securityIndex < 0) {
      await route.continue();
      return;
    }
    const input = JSON.parse(url.searchParams.get('input') ?? '{}');
    const query = securityIndex < 0 ? {} : { ...(input[String(securityIndex)]?.json ?? input.json ?? {}) };
    if (securityIndex >= 0) {
      calls.push({ actorId: query.actorId, cursor: query.cursor });
      if (query.actorId === a && query.cursor === 'p20' && failNext) {
        failNext = false;
        await route.abort('failed');
        return;
      }
      // Preserve the actual server authorization check. Mock cursors are not
      // valid real signed cursors, so the forwarded request reads page one.
      if (query.cursor) {
        if (input[String(securityIndex)]?.json) delete input[String(securityIndex)].json.cursor;
        else delete input.json.cursor;
        url.searchParams.set('input', JSON.stringify(input));
      }
    }
    const response = await route.fetch({ url: url.toString() });
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    if (invitesIndex >= 0) {
      expect(entries[invitesIndex]?.result?.data).toBeDefined();
      entries[invitesIndex].result.data = { json: invites };
    }
    if (securityIndex >= 0) {
      expect(entries[securityIndex]?.result?.data).toBeDefined();
      const start = query.cursor === 'p20' ? 20 : query.cursor === 'p40' ? 40 : 0;
      const rows =
        query.actorId === a
          ? filtered
          : query.actorId === b
            ? [initial[1]]
            : query.actorId === missing
              ? [initial[2]]
              : query.actorId
                ? []
                : initial;
      entries[securityIndex].result.data = {
        json: {
          items: rows.slice(start, start + 20),
          ...(start + 20 < rows.length ? { nextCursor: 'p' + (start + 20) } : {}),
        },
      };
      if (query.actorId === a && !query.cursor && delayFirst) {
        delayFirst = false;
        await new Promise<void>((resolve) => {
          releaseDelayed = resolve;
        });
      }
    }
    await route.fulfill({ response, json: Array.isArray(body) ? entries : entries[0] });
  });
  const dateText = (value: string) =>
    page.evaluate((v) => {
      const date = new Date(v);
      return (
        new Intl.DateTimeFormat('ru', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) +
        ', ' +
        new Intl.DateTimeFormat('ru', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(date)
      );
    }, value);
  const expectedCreated = await dateText(createdAt),
    expectedExpiry = await dateText(expiresAt);
  const expectedUsed = await dateText(usedAt),
    expectedRevoked = await dateText(revokedAt);
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const invitationList = page.getByTestId('admin-invites-list');
  const security = page.getByTestId('admin-security-events');
  const entries = security.getByTestId('journal-entry');
  const filterInput = security.getByTestId('security-uuid-input');
  const apply = security.getByTestId('security-uuid-apply');
  const reset = security.getByTestId('security-uuid-reset');
  const load = security.getByTestId('admin-security-load-more');
  const row = invitationList.getByTestId('admin-invitation-row');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload({ waitUntil: 'networkidle' });
    }
    await expect(page.locator('html')).toHaveClass(new RegExp('(?:^|\\s)' + theme + '(?:\\s|$)'));
    await expect(row).toHaveCount(7);
    await expect(entries).toHaveCount(5);
    // Expand the legacy ID as well as a UUID to check both wrapping cases.
    await entries.nth(0).getByTestId('security-actor-toggle').click();
    await entries.nth(3).getByTestId('security-actor-toggle').click();
    for (const size of [16, 20]) {
      await page.evaluate((s) => document.documentElement.style.setProperty('font-size', s + 'px', 'important'), size);
      for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await row.getByTestId('admin-invitation-status').allTextContents()).toEqual([
          'Действует',
          'Ожидает подтверждения email',
          'Использовано',
          'Отозвано',
          'Срок истёк',
          'Срок истёк',
          'Использовано',
        ]);
        for (let i = 0; i < 7; i++)
          await expect(row.nth(i).getByTestId('admin-invitation-created-at')).toHaveText(expectedCreated);
        for (let i = 0; i < 5; i++)
          await expect(row.nth(i).getByTestId('admin-invitation-expires-at')).toHaveText(expectedExpiry);
        await expect(row.nth(5).getByTestId('admin-invitation-expires-at')).toHaveText('Дата и время не определены');
        await expect(row.nth(2)).toContainText(longName);
        await expect(row.nth(6)).toContainText(longEmail);
        await expect(row.nth(6).getByTestId('admin-invitation-expires-at')).toHaveText(expectedExpiry);
        await expect(row.nth(2).getByTestId('admin-invitation-used-at')).toContainText(expectedUsed);
        await expect(row.nth(3).getByTestId('admin-invitation-revoked-at')).toContainText(expectedRevoked);
        await expect(invitationList.getByTestId('admin-registration-revoke-invite')).toHaveCount(2);
        await expect(invitationList).not.toContainText(code);
        await expect(entries.nth(0)).toContainText(longEmail);
        await expect(entries.nth(0)).toContainText('Владелец проекта');
        await expect(entries.nth(1)).toContainText('second-qa@mail.ru');
        await expect(entries.nth(2)).toContainText('Учётная запись не найдена');
        await expect(entries.nth(4)).toContainText('Личность не установлена');
        await expect(entries.nth(4).getByTestId('security-actor-toggle')).toHaveCount(0);
        await expect(entries.nth(3).getByTestId('security-actor-filter')).toHaveCount(0);
        await expect(entries.nth(0).getByTestId('security-actor-full-id')).toHaveText(a);
        await expect(entries.nth(1).getByTestId('security-actor-full-id')).toHaveCount(0);
        for (const section of [invitationList, security]) {
          const metrics = await section.evaluate((el) => {
            const bounds = el.getBoundingClientRect();
            const clipped: string[] = [];
            for (const node of el.querySelectorAll('p,dt,dd,button')) {
              const rect = node.getBoundingClientRect();
              if (
                rect.left < bounds.left - 1 ||
                rect.right > bounds.right + 1 ||
                node.scrollWidth > node.clientWidth + 1 ||
                node.scrollHeight > node.clientHeight + 1
              )
                clipped.push((node.textContent ?? '').slice(0, 40));
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of range.getClientRects()) {
                if (
                  r.width > 0 &&
                  (r.left < rect.left - 1 ||
                    r.right > rect.right + 1 ||
                    r.top < rect.top - 2 ||
                    r.bottom > rect.bottom + 2)
                )
                  clipped.push('range:' + (node.textContent ?? '').slice(0, 40));
              }
            }
            return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, clipped };
          });
          expect(metrics.scrollWidth, theme + '/' + size + '/' + width).toBeLessThanOrEqual(metrics.clientWidth + 1);
          expect(metrics.clipped, theme + '/' + size + '/' + width).toEqual([]);
          for (const button of await section.getByRole('button').all()) {
            const rect = await button.boundingBox();
            expect(rect!.height, theme + '/' + size + '/' + width).toBeGreaterThanOrEqual(44);
            expect(rect!.width).toBeGreaterThanOrEqual(44);
            expect(rect!.x).toBeGreaterThanOrEqual(-1);
            expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
          }
        }
        await checkPhoneLayout(page, width, true);
      }
    }
  }
  await row.first().getByRole('button', { name: 'Скопировать код приглашения' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await row.nth(1).getByTestId('admin-registration-revoke-invite').click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await entries.first().getByTestId('security-actor-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(a);
  await filterInput.fill(a.slice(0, 8));
  await apply.click();
  await expect(security.getByText('Введите полный корректный UUID.')).toBeVisible();
  const before = calls.length;
  await filterInput.fill(' ' + a.toUpperCase() + ' ');
  expect(calls.length).toBe(before);
  await apply.click();
  await expect(security.getByTestId('security-uuid-active')).toContainText(a);
  await expect(entries).toHaveCount(20);
  await expect(entries.first()).toContainText(longName);
  await load.click();
  await expect(security.getByText('Не удалось загрузить следующие записи.')).toBeVisible();
  await expect(entries).toHaveCount(20);
  await load.click();
  await expect(entries).toHaveCount(40);
  await load.click();
  await expect(entries).toHaveCount(43);
  await expect(load).toHaveCount(0);
  expect(await entries.evaluateAll((els) => els.map((el) => el.getAttribute('data-entry-id')))).toEqual(
    filtered.map((e) => e.id),
  );
  await reset.click();
  await expect(entries).toHaveCount(5);
  await entries.nth(2).getByTestId('security-actor-filter').click();
  await expect(filterInput).toHaveValue(missing);
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Учётная запись не найдена');
  await reset.click();
  await expect(entries).toHaveCount(5);
  await entries.nth(1).getByTestId('security-actor-filter').click();
  await expect(filterInput).toHaveValue(b);
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('second-qa@mail.ru');
  await filterInput.fill(none);
  await apply.click();
  await expect(security.getByText('Событий с таким UUID нет.')).toBeVisible();
  // Returning to a previously visited UUID starts at page one. A delayed
  // response for that UUID must not replace the results of a newer filter.
  delayFirst = true;
  await filterInput.fill(a);
  await apply.click();
  await expect.poll(() => Boolean(releaseDelayed)).toBe(true);
  await filterInput.fill(b);
  await apply.click();
  await expect(entries).toHaveCount(1);
  releaseDelayed?.();
  await page.waitForLoadState('networkidle');
  await expect(entries.first()).toContainText('second-qa@mail.ru');
  await filterInput.fill(a);
  await apply.click();
  await expect(entries).toHaveCount(20);
  await expect(load).toBeVisible();
  await reset.click();
  await expect(filterInput).toHaveValue('');
  await expect(entries).toHaveCount(5);
  await expect(load).toHaveCount(0);
  expect(writes).toBe(0);
});

test('mobile server log filters and search remain reachable at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsOwnerAdmin(page);

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
  await signInAsOwnerAdmin(page);
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
  await signInAsOwnerAdmin(page);
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

test('TASK-BILLOK-010 mobile journals fit all widths and preserve paginated records', async ({ page }) => {
  test.setTimeout(220_000);
  await signInAsOwnerAdmin(page);
  let writes = 0;
  let failInitial = true;
  let failNext = true;
  const requestedCursors: string[] = [];
  const longName = 'МобильныйЖурналОченьДлинноеНазваниеБезПробелов'.repeat(6);
  const label = 'ДлинноеПримечаниеБезПробелов'.repeat(3);
  const timestamp = '2026-11-28T10:00:32.000Z';
  const expiry = '2026-12-05T10:00:32.000Z';
  const rows = Array.from({ length: 43 }, (_, index) => ({
    id: 'audit-fixture-' + index,
    action:
      index === 0
        ? 'INVITE_CREATED'
        : index === 1
          ? 'OWNER_PASSKEY_APPROVAL_VERIFIED'
          : index === 2
            ? 'UNKNOWN_EVENT_FIXTURE'
            : 'OWNER_PASSKEY_RENAMED',
    adminName: index === 0 ? longName : 'Тестовый владелец',
    metadata:
      index === 0
        ? { label, expiresAt: expiry, code: 'qa-invitation-secret-never-render' }
        : index === 1
          ? { action: 'RENAME', expiresInSeconds: 30 }
          : null,
    createdAt: index < 41 ? timestamp : '2026-11-27T10:00:32.000Z',
  }));
  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    if (route.request().method() !== 'GET') {
      writes++;
      await route.abort();
      return;
    }
    expect(procedures).not.toContain('admin.getGlobalActivity');
    const auditIndex = procedures.indexOf('admin.getAuditLog');
    const securityIndex = procedures.indexOf('admin.getSecurityEvents');
    if (auditIndex < 0 && securityIndex < 0) {
      await route.continue();
      return;
    }
    const input = JSON.parse(url.searchParams.get('input') ?? '{}');
    const cursor = auditIndex < 0 ? undefined : (input[String(auditIndex)]?.json ?? input.json)?.cursor;
    if (auditIndex >= 0) {
      requestedCursors.push(cursor ?? 'initial');
      if (!cursor && failInitial) {
        failInitial = false;
        await route.abort('failed');
        return;
      }
      if (cursor === rows[20]!.id && failNext) {
        failNext = false;
        await route.abort('failed');
        return;
      }
    }
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    if (auditIndex >= 0) {
      const item = entries[auditIndex];
      expect(item?.result?.data).toBeDefined();
      const start = cursor ? rows.findIndex((entry) => entry.id === cursor) : 0;
      expect(start).toBeGreaterThanOrEqual(0);
      item.result.data = { json: { items: rows.slice(start, start + 20), nextCursor: rows[start + 20]?.id } };
    }
    if (securityIndex >= 0) {
      const item = entries[securityIndex];
      expect(item?.result?.data).toBeDefined();
      item.result.data = {
        json: {
          items: [
            {
              id: 'security-1',
              action: 'OWNER_PASSKEY_ADD_STARTED',
              actorId: 'a'.repeat(128),
              targetFingerprint: 'b'.repeat(64),
              outcome: 'DENIED',
              createdAt: timestamp,
            },
            {
              id: 'security-2',
              action: 'admin.createSystemInvite',
              actorId: null,
              targetFingerprint: null,
              outcome: 'ALLOWED',
              createdAt: timestamp,
            },
            {
              id: 'security-3',
              action: 'UNKNOWN_SECURITY_FIXTURE',
              actorId: null,
              targetFingerprint: null,
              outcome: 'DENIED',
              createdAt: timestamp,
            },
          ],
        },
      };
    }
    await route.fulfill({ response, json: Array.isArray(body) ? entries : entries[0] });
  });

  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const section = page.getByTestId('admin-audit-section');
  const audit = section.getByTestId('admin-audit-list');
  const security = section.getByTestId('admin-security-list');
  const load = section.getByTestId('admin-audit-load-more');
  await expect(section.getByText('Не удалось загрузить журнал.', { exact: true }).last()).toBeVisible();
  await expect(section.getByText('Записей аудита пока нет.', { exact: true })).toHaveCount(0);
  // An aborted batch can also fail the security query: retry both separately.
  const auditRetry = section.getByRole('alert').filter({ hasText: 'Не удалось загрузить журнал.' }).last();
  await auditRetry.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(audit.getByTestId('journal-entry')).toHaveCount(20);
  const securityRetry = section
    .getByTestId('admin-security-events')
    .getByRole('button', { name: 'Повторить', exact: true });
  if (await securityRetry.count()) await securityRetry.click();
  await expect(audit.getByTestId('journal-entry')).toHaveCount(20);
  await expect(security.getByTestId('journal-entry')).toHaveCount(3);

  const expectedExpiry = await page.evaluate((value) => {
    const date = new Date(value);
    const d = new Intl.DateTimeFormat('ru', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const time = new Intl.DateTimeFormat('ru', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(date);
    return d + ', ' + time;
  }, expiry);

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload({ waitUntil: 'networkidle' });
    }
    await expect(page.locator('html')).toHaveClass(new RegExp('(?:^|\\s)' + theme + '(?:\\s|$)'));
    await expect(audit.getByTestId('journal-entry')).toHaveCount(20);
    await expect(security.getByTestId('journal-entry')).toHaveCount(3);
    for (const fontSize of [16, 20]) {
      await page.evaluate(
        (size) => document.documentElement.style.setProperty('font-size', size + 'px', 'important'),
        fontSize,
      );
      for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(audit.getByTestId('journal-action').first()).toHaveText('Создано приглашение');
        await expect(audit.getByTestId('journal-actor').first()).toContainText(longName);
        await expect(audit.getByTestId('journal-details').first()).toContainText(label);
        await expect(audit.getByTestId('journal-details').first()).toContainText('Действует до: ' + expectedExpiry);
        await expect(audit.getByTestId('journal-time').first()).toHaveAttribute('datetime', timestamp);
        await expect(audit.getByTestId('journal-time').first()).toHaveText(/^\d{2}:\d{2}:32$/u);
        await expect(audit.getByText('Подтверждена операция с ключом доступа', { exact: true })).toBeVisible();
        await expect(audit.getByText('Неизвестное событие', { exact: true })).toBeVisible();
        await expect(security.getByText('Начало добавления ключа доступа владельца', { exact: true })).toBeVisible();
        await expect(security.getByText('Отклонено', { exact: true })).toHaveCount(2);
        await expect(security.getByText('Отпечаток объекта: ' + 'b'.repeat(16), { exact: true })).toBeVisible();
        await expect(section.getByText('qa-invitation-secret-never-render', { exact: false })).toHaveCount(0);
        for (const list of [audit, security]) {
          const metrics = await list.evaluate((el) => {
            const bounds = el.getBoundingClientRect();
            const clipped: string[] = [];
            for (const text of el.querySelectorAll(
              'p,time,h3,[data-testid="journal-actor"],[data-testid="journal-details"]',
            )) {
              const rect = text.getBoundingClientRect();
              if (
                rect.left < bounds.left - 1 ||
                rect.right > bounds.right + 1 ||
                text.scrollWidth > text.clientWidth + 1 ||
                text.scrollHeight > text.clientHeight + 1
              ) {
                clipped.push((text.textContent ?? '').slice(0, 40));
              }
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const r of range.getClientRects()) {
                if (
                  r.width > 0 &&
                  (r.left < rect.left - 1 ||
                    r.right > rect.right + 1 ||
                    r.top < rect.top - 2 ||
                    r.bottom > rect.bottom + 2)
                ) {
                  clipped.push('range:' + (text.textContent ?? '').slice(0, 40));
                }
              }
            }
            return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, clipped };
          });
          expect(metrics.scrollWidth, theme + '/' + fontSize + '/' + width).toBeLessThanOrEqual(
            metrics.clientWidth + 1,
          );
          expect(metrics.clipped, theme + '/' + fontSize + '/' + width).toEqual([]);
        }
        const rect = await load.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        expect(rect!.width).toBeGreaterThanOrEqual(44);
        expect(rect!.x).toBeGreaterThanOrEqual(-1);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
        await checkPhoneLayout(page, width, true);
      }
    }
  }
  await load.focus();
  await expect(load).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(section.getByText('Не удалось загрузить следующие записи.', { exact: true })).toBeVisible();
  await expect(audit.getByTestId('journal-entry')).toHaveCount(20);
  await expect(load).toHaveText('Повторить');
  await load.click();
  await expect(audit.getByTestId('journal-entry')).toHaveCount(40);
  await expect(audit.getByTestId('journal-date')).toHaveCount(1);
  await load.click();
  await expect(audit.getByTestId('journal-entry')).toHaveCount(43);
  await expect(audit.getByTestId('journal-date')).toHaveCount(2);
  await expect(load).toHaveCount(0);
  const ids = await audit
    .getByTestId('journal-entry')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-entry-id')));
  expect(ids).toEqual(rows.map((row) => row.id));
  expect(requestedCursors.filter((cursor) => cursor === rows[20]!.id)).toHaveLength(2);
  expect(requestedCursors.filter((cursor) => cursor === rows[40]!.id)).toHaveLength(1);
  await expect(page.getByTestId('admin-activity-section')).toHaveCount(0);
  expect(writes, 'Audit E2E must not change persistent data').toBe(0);
});

test('mobile admin group search and status filters are touch-friendly at six widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsOwnerAdmin(page);

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
  await signInAsOwnerAdmin(page);
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
  await signInAsOwnerAdmin(page);
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

test('mobile admin health and manual receipt cards fit eight widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsOwnerAdmin(page);
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
          version: longValue,
          commitSha: 'a'.repeat(96),
          release: { taskId: 'TASK-BILLOK-008', taskTitle: longValue, pullRequest: 33 },
          deployedAt: '2026-10-19T10:00:00.000Z',
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
          claimingCount: 2,
          finalizedCount: 3,
          unusedReceiptCount: 0,
        },
      };
      storageReads++;
    }
    await route.fulfill({ response, json: Array.isArray(body) ? entries : entries[0] });
  });

  for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    const health = page.getByTestId('admin-system-health');
    const storage = page.getByTestId('admin-storage-stats');
    await expect(health.getByTestId('admin-system-version')).toContainText(longValue);
    await expect(health.getByTestId('admin-system-commit')).toContainText('a'.repeat(96));
    await expect(health.getByTestId('admin-system-release-task')).toContainText('TASK-BILLOK-008');
    await expect(health.getByTestId('admin-system-release-task')).toContainText(longValue);
    const pr = health.getByTestId('admin-system-release-pr').getByRole('link', { name: '#33' });
    await expect(pr).toHaveAttribute('href', 'https://github.com/kurt525/billok/pull/33');
    expect((await pr.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(health.getByTestId('admin-system-deployed-at')).not.toContainText('Нет сведений');
    await expect(health.getByTestId('admin-system-deployed-at')).toContainText('19.10.2026');

    await expect(health.getByText('База данных', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('admin-activity-section')).toHaveCount(0);
    await expect(storage.getByTestId('admin-receipt-count-total')).toContainText('5');
    await expect(storage.getByTestId('admin-receipt-count-claiming')).toContainText('2');
    await expect(storage.getByTestId('admin-receipt-count-finalized')).toContainText('3');
    const unusedReceiptsCard = storage.getByTestId('unused-receipts-card');
    await expect(unusedReceiptsCard).toContainText('Неиспользуемые записи чеков');
    await expect(unusedReceiptsCard).toContainText('Технические записи старше суток');
    for (const section of [health, storage]) {
      await expect(section).toBeVisible();
      const cards = section.locator('[data-slot="card"]');
      await expect(cards).toHaveCount(section === health ? 2 : 4);
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
  expect(healthReads).toBeGreaterThanOrEqual(8);
  expect(storageReads).toBeGreaterThanOrEqual(8);
});

test('TASK-BILLOK-008 release metadata is local and an unconfirmed deployment date stays unknown', async ({ page }) => {
  await signInAsOwnerAdmin(page);
  let githubRequests = 0;
  await page.route('https://github.com/**', async (route) => {
    githubRequests++;
    await route.abort();
  });
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const health = page.getByTestId('admin-system-health');
  await expect(health.getByTestId('admin-system-release-task')).toContainText('TASK-BILLOK-');
  await expect(health.getByTestId('admin-system-release-pr').getByRole('link')).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/kurt525\/billok\/pull\/\d+$/,
  );
  await expect(health.getByTestId('admin-system-deployed-at')).toHaveText('Нет сведений');
  expect(githubRequests).toBe(0);
});

test('TASK-BILLOK-008 statistics failure is not displayed as zero and can be retried', async ({ page }) => {
  await signInAsOwnerAdmin(page);
  let fail = true;
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    const index = procedures.indexOf('admin.getStorageStats');
    if (index < 0) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    entries[index] = fail
      ? {
          error: {
            json: { message: 'Test failure', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } },
          },
        }
      : { result: { data: { json: { receiptCount: 0, claimingCount: 0, finalizedCount: 0, unusedReceiptCount: 0 } } } };
    await route.fulfill({ response, json: Array.isArray(body) ? entries : entries[0] });
  });
  await page.goto('/admin');
  const storage = page.getByTestId('admin-storage-stats');
  await expect(storage.getByRole('alert')).toContainText('Не удалось загрузить статистику чеков');
  await expect(storage.getByTestId('admin-receipt-count-total')).toHaveCount(0);
  fail = false;
  await storage.getByTestId('admin-storage-retry').click();
  await expect(storage.getByTestId('admin-receipt-count-total').locator('p')).toHaveText('0');
  await expect(storage.getByTestId('admin-receipt-count-claiming').locator('p')).toHaveText('0');
  await expect(storage.getByTestId('admin-receipt-count-finalized').locator('p')).toHaveText('0');
});

test('mobile unused receipt cleanup confirmation cancels without deleting at eight widths', async ({ page }) => {
  test.setTimeout(170_000);
  await signInAsOwnerAdmin(page);
  let cleanupMutations = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const procedures = path.split('/api/trpc/')[1]?.split(',') ?? [];
    if (procedures.some((name) => ['admin.cleanupUnusedReceipts'].includes(name))) {
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
        claimingCount: 4,
        finalizedCount: 8,
        unusedReceiptCount: 4,
      },
    };
    await route.fulfill({ response, json: Array.isArray(data) ? entries : entries[0] });
  });

  for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 380 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const storage = page.getByTestId('admin-storage-stats');
    const triggers = storage.getByTestId('admin-storage-open-cleanup');
    await expect(triggers).toHaveCount(1);
    for (const index of [0]) {
      const trigger = triggers.nth(index);
      const triggerRect = await trigger.boundingBox();
      expect(triggerRect).not.toBeNull();
      expect(triggerRect!.height).toBeGreaterThanOrEqual(44);
      expect(triggerRect!.width).toBeGreaterThanOrEqual(44);
      await trigger.click();
      const dialog = page.getByTestId('admin-storage-cleanup-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Записей: 4');
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
  await signInAsOwnerAdmin(page);
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

test('TASK-BILLOK-002: unified item creation and editing fit six mobile keyboard widths', async ({ page }) => {
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
    await expect(page.getByTestId('guest-count-input')).toBeVisible();
    await page.getByTestId('next-assign-btn').click();
    await expect(page.getByTestId('guest-assign-step')).toBeVisible();
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
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
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height, 'Touch height at ' + width).toBeGreaterThanOrEqual(44);
      expect(bounds!.x, 'Left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width, 'Right at ' + width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y, 'Top at ' + width).toBeGreaterThanOrEqual(-1);
      expect(bounds!.y + bounds!.height, 'Bottom at ' + width).toBeLessThanOrEqual(301);
    }
    await checkPhoneLayout(page, width, true);
    await form.getByTestId('guest-add-item-submit').click();
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
    await expect(page.getByTestId('receipt-item-name-0')).toContainText('БлюдоБезПробелов');
    await page.setViewportSize({ width, height: 520 });
    await page.getByTestId('guest-split-btn-0').click();
    const qty = page.getByTestId('guest-split-qty-0');
    const confirmSplit = page.getByTestId('guest-split-submit-0');
    await page.setViewportSize({ width, height: 300 });
    await expect(page.getByTestId('guest-assign-actions')).toHaveCount(0);
    await qty.fill('0');
    await expect(confirmSplit).toBeDisabled();
    await qty.fill('1');
    await expect(confirmSplit).toBeEnabled();
    await confirmSplit.scrollIntoViewIfNeeded();
    await checkPhoneLayout(page, width, true);
    await confirmSplit.click();
    await expect(page.locator('[data-testid^="guest-item-card-"]')).toHaveCount(2);
    await expect(page.getByTestId('guest-assign-actions')).toBeVisible();
    await page.setViewportSize({ width, height: 520 });
    const card = page.getByTestId('guest-item-card-0');
    await card.getByRole('button', { name: /Изменить|Редактировать/ }).click();
    const edit = page.getByTestId('guest-edit-item-form');
    await expect(edit).toBeVisible();
    await page.setViewportSize({ width, height: 300 });
    await expect(page.getByTestId('guest-assign-actions')).toHaveCount(0);
    const editedName = edit.locator('input').first();
    await editedName.fill(' ');
    const saveEdit = edit.getByRole('button', { name: 'Сохранить' });
    await saveEdit.click();
    await expect(edit).toBeVisible();
    await editedName.fill('Блюдо на двоих');
    await saveEdit.click();
    await expect(edit).toHaveCount(0);
    await expect(card).toContainText('Блюдо на двоих');
    await expect(page.getByTestId('guest-item-card-1')).toContainText('БлюдоБезПробелов');
    await checkPhoneLayout(page, width, true);
    expect(saveRequests, 'Local edits must not create a receipt').toBe(0);
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
      await expect(page.locator('#category')).toHaveCount(0);
      await checkControl(page.locator('form button[type=submit]'), width, 'Create expense action');
      await checkPhoneLayout(page, width);

      // Edit existing disposable expense; do not submit changes.
      await page.goto('/groups/' + group.groupId + '/expenses/' + expenseId + '/edit', { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await page.locator('#title').fill('ЧерновикРедактированияЧека');
      await checkControl(page.locator('#title'), width, 'Edit expense title');
      await expect(page.locator('#category')).toHaveCount(0);
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

test('admin forms remain keyboard-accessible at 300 CSS px on six mobile widths', async ({ page }) => {
  test.setTimeout(220_000);
  await signInAsOwnerAdmin(page);
  let blockedWrites = 0;
  const adminMutations = new Set([
    'admin.deleteUser',
    'admin.deleteGroup',
    'admin.revokeInvitation',
    'admin.createInvitation',
    'admin.setAnnouncement',
    'admin.cleanupExpiredSplits',
    'admin.cleanupUnusedReceipts',
  ]);
  await page.route('**/api/trpc/**', async (route) => {
    const procedures = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    if (procedures.some((procedure) => adminMutations.has(procedure))) {
      blockedWrites++;
      await route.abort();
      return;
    }
    await route.continue();
  });

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 300 });
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    await page.getByTestId('owner-users-nav').click();
    await page.getByTestId('owner-users-search').fill('bob@qa.billok.ru');
    await expect(page.getByTestId('owner-users-list')).toContainText('bob@qa.billok.ru');
    const ownerSearch = page.getByTestId('owner-users-search');
    await ownerSearch.focus();
    await ownerSearch.scrollIntoViewIfNeeded();
    await expect(ownerSearch).toBeInViewport({ ratio: 1 });
    const ownerSearchRect = await ownerSearch.boundingBox();
    expect(ownerSearchRect?.x).toBeGreaterThanOrEqual(-1);
    expect(ownerSearchRect!.x + ownerSearchRect!.width).toBeLessThanOrEqual(width + 1);
    await page.goto('/admin', { waitUntil: 'networkidle' });

    for (const [testId, value] of [
      ['admin-groups-search', 'ОченьДлинноеИмяГруппыБезПробелов'],
      ['admin-registration-invite-label', 'МобильныйЧерновикПриглашения'],
      ['admin-announcement-input', 'ЧерновикОбъявленияБезСохранения'],
      ['admin-logs-search', 'mobile-logs-keyboard'],
    ] as const) {
      const input = page.getByTestId(testId);
      await input.fill(value);
      // Both filters debounce network-backed results. Wait for their layout to
      // settle before measuring: otherwise a late list shrink moves the focused
      // input out of the 300px visual viewport after scrollIntoViewIfNeeded.
      if (testId === 'admin-groups-search') {
        await expect(page.getByTestId('admin-groups-section').getByText('Группы не найдены.')).toBeVisible();
      }
      await input.focus();
      await input.scrollIntoViewIfNeeded();
      await expect(input).toBeInViewport({ ratio: 1 });
      const geometry = await input.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          fontSize: style.fontSize,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        };
      });
      expect(geometry.left, testId + ' left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(geometry.right, testId + ' right at ' + width).toBeLessThanOrEqual(width + 1);
      expect(geometry.top, testId + ' top at ' + width).toBeGreaterThanOrEqual(-1);
      expect(geometry.bottom, testId + ' bottom at ' + width).toBeLessThanOrEqual(301);
      expect(geometry.height, testId + ' touch height at ' + width).toBeGreaterThanOrEqual(44);
      expect(parseFloat(geometry.fontSize), testId + ' text size at ' + width).toBeGreaterThanOrEqual(16);
      await checkPhoneLayout(page, width, true);
    }

    // Status filters still work when the Android keyboard shortens the viewport.
    const groupsActive = page.getByTestId('admin-groups-filter-active');
    await groupsActive.click();
    await expect(groupsActive).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('admin-groups-filter-all').click();

    // The sole owner now manages registered users on /admin/users.
    // Check the replacement mobile confirmation and cancel without a write.
    await page.getByTestId('owner-users-nav').click();
    await page.getByTestId('owner-users-search').fill('bob@qa.billok.ru');
    const bobCard = page.locator('[data-testid^="owner-user-"]').filter({ hasText: 'bob@qa.billok.ru' });
    await expect(bobCard).toHaveCount(1);
    await bobCard.getByRole('button', { name: 'Заблокировать' }).click();
    const dialog = page.getByTestId('owner-users-confirm');
    await expect(dialog).toBeVisible();
    const dialogGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    expect(dialogGeometry.left, 'Owner action left at ' + width).toBeGreaterThanOrEqual(-1);
    expect(dialogGeometry.right, 'Owner action right at ' + width).toBeLessThanOrEqual(width + 1);
    expect(dialogGeometry.top, 'Owner action top at ' + width).toBeGreaterThanOrEqual(-1);
    expect(dialogGeometry.bottom, 'Owner action bottom at ' + width).toBeLessThanOrEqual(301);
    for (const label of ['Отмена', 'Заблокировать']) {
      const button = dialog.getByRole('button', { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      expect(bounds, label + ' bounds at ' + width).not.toBeNull();
      expect(bounds!.height, label + ' height at ' + width).toBeGreaterThanOrEqual(44);
      expect(bounds!.y, label + ' top at ' + width).toBeGreaterThanOrEqual(-1);
      expect(bounds!.y + bounds!.height, label + ' bottom at ' + width).toBeLessThanOrEqual(301);
    }
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(bobCard).toHaveCount(1);
    expect(blockedWrites, 'No administrative mutations at ' + width).toBe(0);
    await checkPhoneLayout(page, width, true);
  }
});

test('six-width final authenticated mobile adaptation audit across main screens', async ({ page }) => {
  test.setTimeout(260_000);
  await signInAsSeedAdmin(page);
  const screens = [
    { path: '/dashboard', control: 'button[aria-label="Открыть меню"]' },
    { path: '/groups', control: '[data-testid="mobile-groups-search"]' },
    { path: '/groups/new', control: 'form button[type="submit"]' },
    { path: '/splits', control: 'a[href="/split"]' },
    { path: '/settings', control: '[data-testid="sbp-bank-search"]' },
    { path: '/admin', control: '[data-testid="admin-groups-search"]' },
    { path: '/split', control: '[data-testid="manual-receipt-name"]' },
  ] as const;

  // The seeded group is only viewed; no changes to actual receipts, balances or members.
  await page.goto('/groups', { waitUntil: 'networkidle' });
  const seededGroup = page.locator('a[href^="/groups/"]').filter({ hasText: 'Apartment' }).first();
  await expect(seededGroup).toBeVisible();
  const groupPath = await seededGroup.getAttribute('href');
  expect(groupPath, 'Existing seeded group URL').toMatch(/^\/groups\/[^/]+$/);

  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 300 });
    for (const screen of screens) {
      await page.goto(screen.path, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await expect(page.locator('main')).toBeVisible();
      await auditMobileViewport(page, width, screen.path);
      await auditMobileTarget(page.locator(screen.control).first(), width, screen.path + ' primary control');
    }

    await page.goto(groupPath!, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await expect(page.locator('main')).toBeVisible();
    await auditMobileViewport(page, width, 'group details');

    await page.goto(groupPath! + '/expenses/new', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await expect(page.getByTestId('manual-group-receipt-entry')).toBeVisible();
    await auditMobileViewport(page, width, 'manual group receipt creation');
    await auditMobileTarget(page.locator('#title'), width, 'new group expense title');
  }
});

test('Issue 6.12.3: real Passkey owner impersonation cannot access owner APIs', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await authedPasskeyContext('owner-qa@mail.ru', 0);
  const ordinary = await authedPasskeyContext('alice@qa.billok.ru', 0);
  try {
    const ownerSession = (await (await owner.get('/api/auth/session')).json()) as {
      user?: { id?: string; email?: string };
    };
    const ordinarySession = (await (await ordinary.get('/api/auth/session')).json()) as {
      user?: { id?: string; email?: string };
    };
    expect(ownerSession.user?.email).toBe('owner-qa@mail.ru');
    expect(ordinarySession.user?.email).toBe('alice@qa.billok.ru');
    expect(ownerSession.user?.id).toBeTruthy();
    expect(ordinarySession.user?.id).toBeTruthy();
    expect(ownerSession.user?.id).not.toBe(ordinarySession.user?.id);

    const targetId = ordinarySession.user!.id!;
    // A real signed WebAuthn proof for the exact target is mandatory.
    const approvalToken = await approveQaOwnerAction(owner, 'IMPERSONATE', targetId);
    const start = await owner.post('/api/admin/impersonate', { data: { userId: targetId, approvalToken } });
    expect(start.status(), await start.text()).toBe(200);
    const current = await trpcResult(await trpcQuery(owner, 'admin.getImpersonationStatus'));
    expect(current).toMatchObject({ isImpersonating: true, targetEmail: 'alice@qa.billok.ru' });
    expect((await owner.get('/api/admin/export')).status()).toBe(405);
    expect(
      (
        await owner.post('/api/admin/export', {
          data: { approvalToken: 'b'.repeat(43) },
        })
      ).status(),
    ).toBe(403);
    const audit = await trpcQuery(owner, 'admin.getAuditLog', { limit: 1 });
    expect(audit.status()).toBe(403);
    const underlying = (await (await owner.get('/api/auth/session')).json()) as { user?: { id?: string } };
    expect(underlying.user?.id).toBe(ownerSession.user?.id);

    await page.context().addCookies((await owner.storageState()).cookies);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    // The real mobile browser uses the same signed JWT + impersonation cookie.
    const mobileStatus = await trpcResult(await trpcQuery(page.request, 'admin.getImpersonationStatus'));
    expect(mobileStatus).toMatchObject({ isImpersonating: true, targetEmail: 'alice@qa.billok.ru' });

    const end = await owner.delete('/api/admin/impersonate');
    expect(end.status(), await end.text()).toBe(200);
    expect(await trpcResult(await trpcQuery(owner, 'admin.getImpersonationStatus'))).toMatchObject({
      isImpersonating: false,
    });
    const restored = (await (await owner.get('/api/auth/session')).json()) as { user?: { id?: string } };
    expect(restored.user?.id).toBe(ownerSession.user?.id);
    const ownerAudit = await trpcQuery(owner, 'admin.getAuditLog', { limit: 1 });
    expect(ownerAudit.ok(), await ownerAudit.text()).toBe(true);
  } finally {
    await ordinary.dispose();
    await owner.dispose();
  }
});

test('TASK-BILLOK-012 real Passkey email change and mobile profile in 32 combinations', async ({ page, browser }) => {
  test.setTimeout(220_000);
  const mailbox = process.env.BILLOK_QA_MAILBOX_URL;
  if (!mailbox) throw new Error('Disposable SMTP mailbox is required');
  const oldEmail = 'email-change@mail.ru';
  const newEmail = 'qa-' + 'long'.repeat(13) + '@mail.su';
  const api = '/api/webauthn/email-change/';
  const section = page.getByTestId('email-change-section');
  const oldNoticeCount = async () => {
    const response = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(oldEmail));
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { messages: unknown[] }).messages.length;
  };
  const initialNotices = await oldNoticeCount();
  // Owner is a real separate signed session, not a client role flag.
  const owner = await browser.newContext({ viewport: { width: 320, height: 780 } });
  try {
    await owner.addCookies(await signedQaCookies('owner-qa@mail.ru'));
    const ownerPage = await owner.newPage();
    await ownerPage.goto('/settings', { waitUntil: 'networkidle' });
    await expect(ownerPage.getByTestId('email-change-owner-blocked')).toBeVisible();
    await expect(ownerPage.getByTestId('email-change-open')).toHaveCount(0);
    for (const [action, data] of [
      ['start', { email: newEmail }],
      ['approve', { response: { id: 'invalid' } }],
      ['complete', { token: 'X'.repeat(43) }],
      ['cancel', {}],
    ] as const) {
      expect((await owner.request.post(api + action, { data })).status()).toBe(403);
    }
    await expect(ownerPage.locator('#email')).toHaveValue('owner-qa@mail.ru');
  } finally {
    await owner.close();
  }

  expect((await page.request.post(api + 'start', { data: { email: newEmail } })).status()).toBe(403);
  await installSelectedQaPasskey(page, oldEmail, 0);
  await loginWithPasskey(page);
  await page.goto('/settings', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('email-change-open')).toBeVisible();
  const previous = await trpcResult(await trpcQuery(page.request, 'auth.getProfile', undefined));
  const keysBefore = await trpcResult(await trpcQuery(page.request, 'auth.listPasskeys', undefined));
  expect(previous.email).toBe(oldEmail);
  expect(keysBefore.activeCount).toBe(1);
  // A raw POST or a cross-origin request cannot act as the current Passkey.
  expect(
    (
      await page.request.post(api + 'start', {
        data: { email: newEmail },
        headers: { Origin: 'https://foreign.invalid' },
      })
    ).status(),
  ).toBe(403);
  expect((await page.request.post(api + 'complete', { data: { token: 'X'.repeat(43) } })).status()).toBe(403);
  expect((await page.request.post(api + 'start', { data: { email: 'other@example.com' } })).status()).toBe(400);
  expect((await page.request.post(api + 'start', { data: { email: 'OWNER-QA@MAIL.RU' } })).status()).toBe(409);
  expect((await page.request.post(api + 'start', { data: { email: oldEmail.toUpperCase() } })).status()).toBe(400);
  await page.getByTestId('email-change-open').click();
  await section.getByLabel('Новый адрес электронной почты').fill(newEmail);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByTestId('email-change-open').click();
      await section.getByLabel('Новый адрес электронной почты').fill(newEmail);
    } else {
      await page.evaluate(() => localStorage.setItem('theme', 'light'));
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByTestId('email-change-open').click();
      await section.getByLabel('Новый адрес электронной почты').fill(newEmail);
    }
    await expect(page.locator('html')).toHaveClass(new RegExp('(?:^|\\s)' + theme + '(?:\\s|$)'));
    for (const size of [16, 20]) {
      await page.evaluate((s) => document.documentElement.style.setProperty('font-size', s + 'px', 'important'), size);
      for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
        await page.setViewportSize({ width, height: 800 });
        await checkPhoneLayout(page, width);
        for (const target of await section.locator('button,input').all()) {
          const rect = await target.boundingBox();
          expect(rect!.height, theme + '/' + size + '/' + width).toBeGreaterThanOrEqual(44);
          expect(rect!.width).toBeGreaterThanOrEqual(44);
          expect(rect!.x).toBeGreaterThanOrEqual(-1);
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
        }
      }
    }
  }
  async function mailLinks(count: number) {
    let matches: string[] = [];
    await expect
      .poll(
        async () => {
          const response = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(newEmail));
          if (!response.ok()) return 0;
          const body = (await response.json()) as { messages: { links: string[] }[] };
          matches = body.messages
            .flatMap((m) => m.links)
            .filter((link) => new URL(link).hash.startsWith('#email-change='));
          return matches.length;
        },
        { timeout: 20_000 },
      )
      .toBe(count);
    return matches[count - 1]!;
  }
  await section.getByRole('button', { name: 'Подтвердить ключом доступа' }).click();
  await expect(page.getByTestId('email-change-pending')).toContainText(newEmail);
  const first = await mailLinks(1);
  expect((await trpcResult(await trpcQuery(page.request, 'auth.getProfile', undefined))).email).toBe(oldEmail);
  // Resending requires a new actual browser assertion, and replaces the token.
  await section.getByRole('button', { name: 'Отправить письмо повторно' }).click();
  const second = await mailLinks(2);
  expect(second).not.toBe(first);
  expect(
    (await page.request.post(api + 'complete', { data: { token: new URL(first).hash.split('=')[1] } })).status(),
  ).toBe(403);
  // A mail scanner or an authenticated GET cannot consume a confirmation.
  expect((await page.request.get(new URL(second).origin + '/settings')).ok()).toBe(true);
  expect((await page.request.get(api + 'complete')).status()).toBe(405);
  expect((await trpcResult(await trpcQuery(page.request, 'auth.getProfile', undefined))).email).toBe(oldEmail);
  const stale = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    await page.goto(second, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('email-change-confirm')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    expect((await trpcResult(await trpcQuery(page.request, 'auth.getProfile', undefined))).email).toBe(oldEmail);
    await page.getByTestId('email-change-confirm').click();
    await expect(page.getByTestId('email-change-completed')).toBeVisible();
    expect(
      (await stale.request.post(api + 'complete', { data: { token: new URL(second).hash.split('=')[1] } })).status(),
    ).toBe(403);
    expect((await trpcQuery(stale.request, 'auth.getProfile', undefined)).ok()).toBe(false);
    await expect.poll(oldNoticeCount, { timeout: 80_000 }).toBeGreaterThan(initialNotices);
    await page.getByRole('button', { name: 'Войти снова' }).click();
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    // Keep the original virtual authenticator; the key ID has not changed.
    await loginWithPasskey(page);
    await page.goto('/settings', { waitUntil: 'networkidle' });
    await expect(page.locator('#email')).toHaveValue(newEmail);
    const current = await trpcResult(await trpcQuery(page.request, 'auth.getProfile', undefined));
    expect(current).toMatchObject({ ...previous, email: newEmail });
    const keysAfter = await trpcResult(await trpcQuery(page.request, 'auth.listPasskeys', undefined));
    expect(keysAfter.activeCount).toBe(1);
    expect(keysAfter.credentials.map((key: { id: string }) => key.id)).toEqual(
      keysBefore.credentials.map((key: { id: string }) => key.id),
    );
    expect(
      (await page.request.post(api + 'complete', { data: { token: new URL(second).hash.split('=')[1] } })).status(),
    ).toBe(403);

    // Recovery must now resolve the new address, never the former address.
    const recovery = await browser.newContext();
    try {
      const recovered = await recovery.newPage();
      const recoveryLinks = async (email: string): Promise<string[]> => {
        const response = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(email));
        if (!response.ok()) return [];
        const body = (await response.json()) as { messages: { links: string[] }[] };
        return body.messages.flatMap((m) => m.links).filter((link) => new URL(link).pathname === '/recover-passkey');
      };
      expect(
        (await recovery.request.post('/api/webauthn/recovery/request', { data: { email: oldEmail } })).status(),
      ).toBe(202);
      expect(await recoveryLinks(oldEmail)).toEqual([]);
      expect(
        (await recovery.request.post('/api/webauthn/recovery/request', { data: { email: newEmail } })).status(),
      ).toBe(202);
      await expect.poll(async () => (await recoveryLinks(newEmail)).length, { timeout: 20_000 }).toBe(1);
      const link = (await recoveryLinks(newEmail))[0]!;
      await enableVirtualPasskey(recovered);
      await recovered.goto(link, { waitUntil: 'networkidle' });
      await recovered.getByTestId('create-recovered-passkey').click();
      await expect(recovered.getByRole('status')).toContainText('Новый Passkey создан', { timeout: 30_000 });
      await loginWithPasskey(recovered);
      const recoveredProfile = await trpcResult(await trpcQuery(recovered.request, 'auth.getProfile', undefined));
      expect(recoveredProfile).toMatchObject({ ...previous, email: newEmail });
    } finally {
      await recovery.close();
    }
  } finally {
    await stale.close();
  }
});
