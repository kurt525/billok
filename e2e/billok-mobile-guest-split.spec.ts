import { expect, test, type Page } from '@playwright/test';
import {
  authedContext,
  joinGuestSession,
  rememberClaimIdentity,
  trpcMutation,
  trpcQuery,
  trpcResult,
  users,
} from './helpers';

/** Signed-in creator, anonymous recipient: real persistence, no photo, OCR, or AI. */
async function fitsPhone(page: Page) {
  const { width, scrollWidth } = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(width + 1);
}

/** Only DOM structure, never private personal tokens or payment row data. */
async function payerReviewDomDiagnostic(page: Page) {
  return page.evaluate(() => {
    const mains = [...document.querySelectorAll('main')];
    const primary = mains[0];
    const reviews = [...document.querySelectorAll<HTMLElement>('[data-testid="guest-payer-payment-review"]')];
    return {
      mainCount: mains.length,
      mainChildCount: primary?.children.length ?? 0,
      finalizedTotalCount: document.querySelectorAll('[data-testid="finalized-bill-total"]').length,
      reimbursementCardCount: document.querySelectorAll('[data-testid="guest-payer-reimbursements"]').length,
      sbpFormCount: document.querySelectorAll('[data-testid="guest-payer-sbp-form"]').length,
      payerReviewCount: reviews.length,
      reviews: reviews.map((el) => {
        const path: number[] = [];
        let cursor: Element | null = el;
        while (cursor?.parentElement && cursor !== primary) {
          path.push([...cursor.parentElement.children].indexOf(cursor));
          cursor = cursor.parentElement;
        }
        return {
          mainIndex: mains.indexOf(el.closest('main')!),
          childPath: path.reverse(),
          visible: el.getClientRects().length > 0,
          reactFiberAttached: Object.keys(el).some((key) => key.startsWith('__reactFiber$')),
          reactPropsAttached: Object.keys(el).some((key) => key.startsWith('__reactProps$')),
          paymentRowCount: el.querySelectorAll('[data-testid^="guest-payer-payment-"]').length,
          verifyButtonCount: el.querySelectorAll('button').length,
        };
      }),
    };
  });
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('authenticated manual receipt: add, edit, allocate, share with a second anonymous device', async ({
  page,
  browser,
}) => {
  test.setTimeout(135_000);
  const remoteCalls: string[] = [];
  page.on('request', (request) => {
    if (/guest\.processReceipt|\/api\/upload|guest\.getUploadStatus|api\.openai/.test(request.url())) {
      remoteCalls.push(request.url());
    }
  });

  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill('alice@example.com');
  await page.locator('input[type=password]').fill('password123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);

  await page.goto('/split', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('manual-split-title')).toContainText('Разделить чек');
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await expect(page.getByTestId('guest-file-input')).toHaveCount(0);
  await page.getByTestId('manual-receipt-name').fill('Ужин в кафе');
  await page.getByTestId('person-input-0').fill('Анна');
  await page.getByTestId('add-person-btn').click();
  // A full 40-character name without spaces must not widen the 320px screen.
  const longGuestName = 'Борис'.repeat(8);
  await page.getByTestId('person-input-1').fill(longGuestName);
  await page.locator('#who-paid').selectOption('0');
  await page.getByTestId('next-assign-btn').click();
  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(page.getByTestId('manual-no-items')).toBeVisible();
  await expect(page.getByTestId('create-split-btn')).toBeDisabled();
  await fitsPhone(page);

  await page.getByTestId('guest-add-item-btn').click();
  const form = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form.locator('input').nth(0).fill('Суп');
  await form.locator('input').nth(1).fill('2');
  await form.locator('input').nth(2).fill('90,00');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(page.getByText('Суп', { exact: true })).toBeVisible();

  await page.getByTestId('guest-add-item-btn').click();
  const form2 = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form');
  await form2.locator('input').nth(0).fill('Чай');
  await form2.locator('input').nth(1).fill('1');
  await form2.locator('input').nth(2).fill('20,50');
  await page.getByTestId('guest-add-item-submit').click();

  const soup = page.locator('[data-testid^="guest-item-card-"]').filter({
    has: page.getByText('Суп', { exact: true }),
  });
  await soup.locator('[data-testid^="guest-split-btn-"]').click();
  await soup.locator('[data-testid^="guest-split-qty-"]').fill('1');
  await soup.locator('[data-testid^="guest-split-submit-"]').click();
  await expect(page.getByText('Суп', { exact: true })).toHaveCount(2);

  await page.getByTestId('guest-split-all-btn').click();
  const tea = page.locator('[data-testid^="guest-item-card-"]').filter({
    has: page.getByText('Чай', { exact: true }),
  });
  // The second participant alone owes the tea.
  await tea.getByRole('button', { name: /Анна/ }).click();
  await expect(tea.getByRole('button', { name: /Анна/ })).not.toHaveClass(/bg-primary/);
  await expect(tea.getByRole('button', { name: /БорисБорис/ })).toHaveClass(/bg-primary/);

  // Extremely short viewport simulates a software keyboard covering most of
  // the screen: the action panel must scroll internally, not extend above it.
  await page.setViewportSize({ width: 320, height: 180 });
  const assignActions = page.getByTestId('guest-assign-actions');
  const panelBounds = await assignActions.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(panelBounds!.y).toBeGreaterThanOrEqual(0);
  expect(panelBounds!.height).toBeLessThanOrEqual(164);
  await page.getByTestId('share-for-claiming-btn').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('share-for-claiming-btn')).toBeInViewport();
  await page.getByTestId('create-split-btn').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('create-split-btn')).toBeInViewport();

  await page.setViewportSize({ width: 412, height: 460 });
  await fitsPhone(page);
  await page.getByTestId('create-split-btn').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('create-split-btn')).toBeEnabled();
  await page.getByTestId('create-split-btn').click();

  await expect(page).toHaveURL(/\/split\/[^/]+$/);
  await expect(page.getByTestId('split-result')).toBeVisible();
  await expect(page.getByText('Ужин в кафе').first()).toBeVisible();
  await expect(page.getByTestId('person-card-1')).toContainText('Чай');
  await expect(page.getByTestId('person-card-1')).toContainText(longGuestName);
  await expect(page.getByTestId('person-card-0')).not.toContainText('Чай');
  const shareUrl = page.url();

  // Unfolded Android widths with enlarged system text: long guest names and
  // receipt totals must remain inside one centered column without sideways
  // scrolling. Sharing buttons stay touch-size at every width.
  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  for (const width of [430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 460 });
    await fitsPhone(page);
    for (const index of [0, 1]) {
      const card = page.getByTestId('person-card-' + index);
      const bounds = await card.boundingBox();
      expect(bounds, 'Guest receipt card ' + index + ' at ' + width + 'px').not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      if (width === 720) expect(bounds!.width).toBeLessThan(width - 16);
    }
    await expect(page.getByTestId('person-card-1')).toContainText(longGuestName);
    for (const button of [page.getByTestId('copy-link-btn'), page.getByTestId('share-btn')]) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
  }

  // Rotate an enlarged-text phone from portrait to landscape and back,
  // then simulate the shortened viewport left above the Android keyboard.
  // Resizing must not hide the share controls or expand the receipt sideways.
  for (const [width, height] of [
    [360, 720],
    [720, 360],
    [360, 360],
  ] as const) {
    await page.setViewportSize({ width, height });
    await fitsPhone(page);
    await expect(page.getByTestId('person-card-1')).toContainText(longGuestName);
    for (const button of [page.getByTestId('copy-link-btn'), page.getByTestId('share-btn')]) {
      const rect = await button.boundingBox();
      expect(rect, 'Share action at ' + width + 'x' + height).not.toBeNull();
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
    }
  }

  // Simulate the shorter visual height left above an Android soft keyboard:
  // both sharing actions must stay inside the visible viewport and remain tappable.
  await page.setViewportSize({ width: 320, height: 360 });
  const actions = page.getByTestId('split-result-actions');
  await expect(actions).toBeVisible();
  await fitsPhone(page);
  for (const button of [page.getByTestId('copy-link-btn'), page.getByTestId('share-btn')]) {
    const rect = await button.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.height).toBeGreaterThanOrEqual(44);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(360);
  }
  await page.setViewportSize({ width: 412, height: 460 });

  // The creator's own history must fit small phones, and the delete action
  // must be reachable without relying on a mouse or accidentally deleting.
  const receiptToken = new URL(shareUrl).pathname.split('/').at(-1);
  for (const width of [320, 412]) {
    await page.setViewportSize({ width, height: 460 });
    await page.goto('/splits', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('splits-page')).toBeVisible();
    const historyCard = page.locator('[data-testid^="split-card-"]').filter({
      has: page.locator('a[href$="/split/' + receiptToken + '"]'),
    });
    await expect(historyCard).toBeVisible();
    await expect(historyCard).toContainText('Ужин в кафе');
    await fitsPhone(page);
    const cardRect = await historyCard.boundingBox();
    expect(cardRect!.x).toBeGreaterThanOrEqual(0);
    expect(cardRect!.x + cardRect!.width).toBeLessThanOrEqual(width);
    const remove = historyCard.locator('button[aria-label]');
    expect((await remove.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (width === 320) {
      await remove.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      // An Android keyboard leaves a much smaller visual viewport. The
      // destructive-action dialog must not escape its bounds; the cancel
      // action remains reachable without closing or deleting the receipt.
      await page.setViewportSize({ width: 320, height: 240 });
      const alertBounds = await dialog.boundingBox();
      expect(alertBounds).not.toBeNull();
      expect(alertBounds!.y).toBeGreaterThanOrEqual(0);
      expect(alertBounds!.y + alertBounds!.height).toBeLessThanOrEqual(240);
      const cancel = dialog.getByRole('button', { name: 'Отмена' });
      await cancel.scrollIntoViewIfNeeded();
      await expect(cancel).toBeInViewport();
      await cancel.click();
      await page.setViewportSize({ width: 320, height: 460 });
      await expect(historyCard).toBeVisible();
    }
  }

  const otherDevice = await browser.newContext({
    viewport: { width: 320, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    // A separate anonymous API read proves the saved split has committed and
    // is accessible without any of the creator's session cookies. This also
    // distinguishes server persistence/auth failures from rendering failures.
    const publicResponse = await trpcQuery(otherDevice.request, 'guest.getSplit', { token: receiptToken });
    const publicBody = await publicResponse.text();
    expect(publicResponse.ok(), 'Anonymous guest.getSplit failed: ' + publicBody).toBe(true);
    const publicSplit = await trpcResult({ json: async () => JSON.parse(publicBody) });
    expect(publicSplit?.shareToken).toBe(receiptToken);
    expect(publicSplit?.receiptData?.merchantName).toBe('Ужин в кафе');

    const otherPage = await otherDevice.newPage();
    const pageErrors: string[] = [];
    otherPage.on('pageerror', (error) => pageErrors.push(error.message));
    otherPage.on('response', (response) => {
      if (response.status() >= 400 && response.url().includes('/api/trpc/')) {
        pageErrors.push('tRPC ' + response.status() + ' ' + new URL(response.url()).pathname);
      }
    });
    await otherPage.goto(shareUrl, { waitUntil: 'networkidle' });
    await expect(otherPage).toHaveURL(new RegExp('/split/' + receiptToken + '$'));
    await expect(
      otherPage.getByTestId('split-result'),
      'Anonymous public split did not render: ' + JSON.stringify(pageErrors),
    ).toBeVisible({ timeout: 30_000 });
    await expect(otherPage.getByTestId('person-card-1')).toContainText('Чай');
    await expect(otherPage.getByTestId('person-card-1')).toContainText(longGuestName);
    await fitsPhone(otherPage);
  } finally {
    await otherDevice.close();
  }

  expect(remoteCalls).toEqual([]);
});

test('anonymous participant chooses only own voluntary tips on mobile', async ({ page, browser }) => {
  test.setTimeout(115_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const created = await trpcMutation(owner, 'guest.createClaimSession', {
    receiptData: { merchantName: 'Кафе чаевые', subtotal: 1050, tax: 0, tip: 0, total: 1050, currency: 'RUB' },
    items: [{ name: 'Чай', quantity: 1, unitPrice: 1050, totalPrice: 1050 }],
    people: ['Анна', 'Борис'],
    creatorName: 'Анна',
    paidByName: 'Анна',
  });
  const raw = await created.text();
  expect(created.ok(), raw).toBe(true);
  const token = JSON.parse(raw).result.data.json.shareToken as string;

  const second = await browser.newContext({
    viewport: { width: 320, height: 460 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await page.setViewportSize({ width: 320, height: 460 });
    await page.goto('/split/' + token + '/claim');
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await expect(page.getByTestId('personal-tip-card')).toHaveCount(0);

    await page.getByTestId('rejoin-person-0').click();
    await expect(page.getByTestId('personal-tip-card')).toBeVisible({ timeout: 15_000 });
    const amount = page.getByTestId('personal-tip-input');
    const save = page.getByTestId('personal-tip-save');
    await expect(amount).toHaveValue('0.00');
    await expect(save).toBeDisabled();
    await amount.fill('1,235');
    await expect(save).toBeDisabled();
    await amount.fill('1,25');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(amount).toHaveValue('1.25', { timeout: 15_000 });
    await expect(save).toBeDisabled();
    await fitsPhone(page);

    // Switching who one is choosing dishes for cannot change tip ownership.
    await page.getByTestId('switch-person-1').click();
    await expect(amount).toHaveValue('1.25');
    await amount.fill('0');
    await save.click();
    await expect(amount).toHaveValue('0.00', { timeout: 15_000 });
    await expect(save).toBeDisabled();

    const visitor = await second.newPage();
    await visitor.goto('/split/' + token + '/claim');
    await visitor.getByTestId('rejoin-person-1').click();
    const visitorTip = visitor.getByTestId('personal-tip-input');
    await expect(visitorTip).toHaveValue('0.00', { timeout: 15_000 });
    await visitorTip.fill('3,50');
    await visitor.getByTestId('personal-tip-save').click();
    await expect(visitorTip).toHaveValue('3.50', { timeout: 15_000 });

    const state = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(state.people.map((person: { name: string; tipCents: number }) => [person.name, person.tipCents])).toEqual([
      ['Анна', 0],
      ['Борис', 350],
    ]);
    await page.reload();
    await expect(page.getByTestId('personal-tip-input')).toHaveValue('0.00', { timeout: 15_000 });
    await fitsPhone(page);
  } finally {
    await second.close();
    await owner.dispose();
  }
});

test('mobile guest finalization reconciles personal tips for three dining participants', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const otherDevice = await browser.newContext({
    viewport: { width: 320, height: 560 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const response = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Ужин без налога', subtotal: 1001, tax: 0, tip: 0, total: 1001, currency: 'RUB' },
      items: [{ name: 'Ужин', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      people: ['Анна', 'Борис', 'Виктор'],
      creatorName: 'Анна',
      paidByName: 'Борис',
      joinCreator: true,
    });
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const created = JSON.parse(body).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    const token = created.shareToken;
    const anna = created.creator;
    const boris = await joinGuestSession(otherDevice.request, { token, name: 'Борис' });
    const victor = await joinGuestSession(owner, { token, name: 'Виктор' });

    await rememberClaimIdentity(page.context(), token, { name: anna.name, personToken: anna.personToken });
    await rememberClaimIdentity(otherDevice, token, { name: boris.name, personToken: boris.personToken });
    for (const guest of [anna, boris, victor]) {
      const claimant = guest.personToken === anna.personToken ? page.request : otherDevice.request;
      const claimed = await trpcMutation(claimant, 'guest.claimItems', {
        token,
        personId: guest.personId,
        personToken: guest.personToken,
        claimedItemIndices: [0],
      });
      expect(claimed.ok(), await claimed.text()).toBe(true);
    }

    // Anna voluntarily tips 1.25 RUB via the actual mobile editor. Boris leaves
    // zero by default, and Victor tips 0.75 RUB for his shared portion.
    await page.goto('/split/' + token + '/claim', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('personal-tip-input')).toHaveValue('0.00', { timeout: 15_000 });
    await page.getByTestId('personal-tip-input').fill('1,25');
    await page.getByTestId('personal-tip-save').click();
    await expect(page.getByTestId('personal-tip-input')).toHaveValue('1.25', { timeout: 15_000 });
    const victorTip = await trpcMutation(owner, 'guest.setPersonalTip', {
      token,
      personId: victor.personId,
      personToken: victor.personToken,
      tipCents: 75,
    });
    expect(victorTip.ok(), await victorTip.text()).toBe(true);

    await page.reload({ waitUntil: 'networkidle' });
    const finish = page.getByTestId('finalize-btn');
    await expect(finish).toBeVisible({ timeout: 15_000 });
    await finish.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Завершить распределение' }).click();

    await expect(page.getByText('Расчёт завершён')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('finalized-person-total-0')).toContainText('4,59');
    await expect(page.getByTestId('finalized-person-total-1')).toContainText('3,34');
    await expect(page.getByTestId('finalized-person-total-2')).toContainText('4,08');
    await expect(page.getByTestId('finalized-food-total')).toContainText('10,01');
    await expect(page.getByTestId('finalized-waiter-tip-total')).toContainText('2,00');
    await expect(page.getByText('Всего чаевых официанту')).toBeVisible();
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,01');
    // Anna is the creator, not the payer: this breakdown belongs to Boris.
    await expect(page.getByTestId('guest-payer-reimbursements')).toHaveCount(0);
    await expect(page.getByTestId('guest-payer-sbp-form')).toHaveCount(0);
    await expect(page.getByTestId('guest-personal-reimbursement')).toBeVisible();
    await expect(page.getByTestId('guest-personal-reimbursement')).toContainText('Борис');
    await expect(page.getByTestId('guest-personal-reimbursement-amount')).toContainText('4,59');
    // A participant can copy the exact RUB amount (with comma and kopecks)
    // to paste into their bank app; this does not report a payment.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as Window & { __billokCopiedAmount?: string }).__billokCopiedAmount = value;
          },
        },
      });
    });
    await page.getByTestId('guest-copy-reimbursement-amount').click();
    await expect
      .poll(() => page.evaluate(() => (window as Window & { __billokCopiedAmount?: string }).__billokCopiedAmount))
      .toBe('4,59');
    await expect(page.getByText('Итого с чаевыми')).toBeVisible();
    await fitsPhone(page);

    const session = await trpcResult(await trpcQuery(otherDevice.request, 'guest.getSession', { token }));
    expect(session.status).toBe('FINALIZED');
    expect(session.receiptData).toMatchObject({ subtotal: 1001, tax: 0, tip: 0, total: 1001 });
    expect(session.summary).toEqual([
      { personIndex: 0, name: 'Анна', itemTotal: 334, tax: 0, tip: 125, total: 459 },
      { personIndex: 1, name: 'Борис', itemTotal: 334, tax: 0, tip: 0, total: 334 },
      { personIndex: 2, name: 'Виктор', itemTotal: 333, tax: 0, tip: 75, total: 408 },
    ]);
    expect(session.summary.reduce((sum: number, person: { total: number }) => sum + person.total, 0)).toBe(1201);

    const otherPage = await otherDevice.newPage();
    await otherPage.goto('/split/' + token + '/claim', { waitUntil: 'networkidle' });
    await expect(otherPage.getByTestId('finalized-bill-total')).toContainText('12,01', { timeout: 15_000 });
    // Boris pays but did not create the receipt: his 3.34 RUB is not reimbursed.
    // Anna's 4.59 + Victor's 4.08 = 8.67 RUB owed to Boris.
    await expect(otherPage.getByTestId('guest-payer-reimbursements')).toBeVisible({ timeout: 15_000 });
    await expect(otherPage.getByTestId('guest-personal-reimbursement')).toHaveCount(0);
    await expect(otherPage.getByTestId('guest-copy-reimbursement-amount')).toHaveCount(0);
    await expect(otherPage.getByTestId('guest-payer-reimbursement-0')).toContainText('4,59');
    await expect(otherPage.getByTestId('guest-payer-reimbursement-2')).toContainText('4,08');
    await expect(otherPage.getByTestId('guest-payer-reimbursement-1')).toHaveCount(0);
    await expect(otherPage.getByTestId('guest-payer-own-share')).toContainText('3,34');
    await expect(otherPage.getByTestId('guest-payer-reimbursement-total')).toContainText('8,67');

    // Only Boris's personal device can edit the payer's SBP destination.
    const payerForm = otherPage.getByTestId('guest-payer-sbp-form');
    await expect(payerForm).toBeVisible();
    const payerPhone = otherPage.getByTestId('guest-payer-sbp-phone');
    await expect(payerPhone).toBeVisible({ timeout: 15_000 });
    await payerPhone.fill('8 (999) 123-45-67');
    await otherPage.getByTestId('guest-payer-sbp-search').fill('Озон Банк');

    // The payer can choose a bank and save SBP details on Galaxy S23 and
    // unfolded Android widths even with enlarged text and a short viewport.
    await otherPage.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const sbpBank = otherPage.getByTestId('guest-payer-sbp-bank-100000000273');
    for (const width of [360, 430, 480, 600, 720]) {
      await otherPage.setViewportSize({ width, height: 380 });
      await fitsPhone(otherPage);
      for (const target of [
        payerPhone,
        otherPage.getByTestId('guest-payer-sbp-search'),
        sbpBank,
        otherPage.getByTestId('guest-payer-sbp-save'),
        otherPage.getByTestId('guest-payer-sbp-clear'),
      ]) {
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.boundingBox();
        expect(bounds, 'SBP action at ' + width + 'px').not.toBeNull();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
    }
    await otherPage.setViewportSize({ width: 320, height: 800 });
    await sbpBank.click();
    await expect(sbpBank.locator('input')).toBeChecked();
    await otherPage.getByTestId('guest-payer-sbp-save').click();
    await expect(otherPage.getByText('Реквизиты сохранены')).toBeVisible();

    // Anna joined as herself and owes Boris 4.59 RUB; her personal token is
    // required to fetch Boris's destination. It is absent from public getSession.
    const publicView = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(JSON.stringify(publicView)).not.toContain('+79991234567');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByTestId('guest-sbp-reimbursement-details')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('guest-sbp-reimbursement-bank')).toContainText('Озон Банк');
    await expect(page.getByTestId('guest-sbp-reimbursement-phone')).toContainText('+79991234567');
    await expect(page.getByTestId('guest-payer-sbp-form')).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as Window & { __billokCopiedPhone?: string }).__billokCopiedPhone = value;
          },
        },
      });
    });
    await page.getByTestId('guest-sbp-copy-phone').click();
    await expect
      .poll(() => page.evaluate(() => (window as Window & { __billokCopiedPhone?: string }).__billokCopiedPhone))
      .toBe('+79991234567');

    // Boris's review must already have its baseline, or a fresh page
    // should not toast about declarations that existed before it loaded.
    const livePayerReview = otherPage.getByTestId('guest-payer-payment-review').filter({ visible: true });
    await expect(livePayerReview).toHaveCount(1, { timeout: 15_000 });
    await expect(livePayerReview.getByTestId('guest-payer-payment-' + anna.personId)).toContainText(
      'Ожидается отметка участника',
    );

    // A debtor's declaration is not a bank transaction or payer verification.
    await expect(page.getByTestId('guest-mark-paid')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('guest-mark-paid').click();
    await expect(page.getByTestId('guest-payment-declared')).toHaveText('Оплачено');
    // A private live notification reaches the payer on their already-open page.
    const payerNotice = otherPage.getByText('Новая отметка об оплате: Анна. Проверьте поступление.');
    await expect(payerNotice).toHaveCount(1, { timeout: 25_000 });
    await expect(payerNotice).toBeVisible();
    await expect(page.getByText('Поступление денег ещё не проверено плательщиком.')).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByTestId('guest-payment-declared')).toHaveText('Оплачено', { timeout: 15_000 });
    await expect(page.getByTestId('guest-mark-paid')).toHaveCount(0);
    await expect(page.getByTestId('guest-payer-sbp-form')).toHaveCount(0);

    await otherPage.reload({ waitUntil: 'networkidle' });
    await expect(otherPage.getByTestId('guest-mark-paid')).toHaveCount(0);
    await expect(otherPage.getByTestId('guest-payment-declared')).toHaveCount(0);
    // Only Boris's personal payer token can inspect and verify Annа's transfer.
    // Next.js may retain an inactive route tree in the DOM across a reload.
    // Strictly require ONE visible review, not merely the first matching node:
    // two visible payer reviews would still fail this regression.
    const payerReview = otherPage.getByTestId('guest-payer-payment-review').filter({ visible: true });
    try {
      await expect(payerReview).toHaveCount(1, { timeout: 15_000 });
    } catch (error) {
      // Diagnose retained Next.js route trees without relaxing the requirement
      // of exactly one visible private review. Do not log personal access tokens.
      const diagnostic = await payerReviewDomDiagnostic(otherPage);
      throw new Error('Multiple payer review DOM nodes: ' + JSON.stringify(diagnostic) + '\\n' + String(error));
    }
    await expect(payerReview).toBeVisible();
    const annaPayment = payerReview.getByTestId('guest-payer-payment-' + anna.personId);
    await expect(annaPayment).toContainText('4,59');
    await expect(annaPayment).toContainText('Участник отметил оплату');
    const victorPayment = payerReview.getByTestId('guest-payer-payment-' + victor.personId);
    await expect(victorPayment).toContainText('Ожидается отметка участника');
    await expect(payerReview.getByTestId('guest-payer-verify-' + victor.personId)).toHaveCount(0);

    // Stress a second full reload before confirmation: intermittently a new
    // hydrated payer review coexists with an older route's visible card.
    await otherPage.reload({ waitUntil: 'networkidle' });
    try {
      await expect(payerReview).toHaveCount(1, { timeout: 15_000 });
    } catch (error) {
      const diagnostic = await payerReviewDomDiagnostic(otherPage);
      throw new Error(
        'Duplicate payer review on repeated pre-verification reload: ' +
          JSON.stringify(diagnostic) +
          '\\n' +
          String(error),
      );
    }
    await expect(payerReview.getByTestId('guest-payer-payment-' + anna.personId)).toContainText(
      'Участник отметил оплату',
    );

    // A real payer must be able to verify a declared transfer on a wide
    // Android display or Galaxy S23 with enlarged text and a short viewport.
    await otherPage.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const verifyAnna = payerReview.getByTestId('guest-payer-verify-' + anna.personId);
    for (const width of [360, 430, 720]) {
      await otherPage.setViewportSize({ width, height: 380 });
      await expect(payerReview).toHaveCount(1);
      await fitsPhone(otherPage);
      const reviewBounds = await payerReview.boundingBox();
      expect(reviewBounds).not.toBeNull();
      expect(reviewBounds!.x).toBeGreaterThanOrEqual(0);
      expect(reviewBounds!.x + reviewBounds!.width).toBeLessThanOrEqual(width);
      await verifyAnna.scrollIntoViewIfNeeded();
      await expect(verifyAnna).toBeInViewport();
      const buttonBounds = await verifyAnna.boundingBox();
      expect(buttonBounds).not.toBeNull();
      expect(buttonBounds!.height).toBeGreaterThanOrEqual(44);
      expect(buttonBounds!.x).toBeGreaterThanOrEqual(0);
      expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(width);
    }
    await verifyAnna.click();
    await expect(annaPayment).toContainText('Поступление проверено');
    await expect(payerReview.getByTestId('guest-payer-verify-' + anna.personId)).toHaveCount(0);
    // The debtor learns the independent payer verification without reloading.
    await expect(page.getByTestId('guest-payment-verified')).toHaveText('Поступление проверено', { timeout: 25_000 });
    const debtorNotice = page.getByText('Плательщик подтвердил поступление денег.');
    await expect(debtorNotice).toHaveCount(1, { timeout: 15_000 });
    await expect(debtorNotice).toBeVisible();
    await otherPage.reload({ waitUntil: 'networkidle' });
    try {
      await expect(payerReview).toHaveCount(1, { timeout: 15_000 });
    } catch (error) {
      // The second payer review failure used to bypass the initial DOM
      // diagnostic. Capture safe structural data, never session credentials.
      const diagnostic = await payerReviewDomDiagnostic(otherPage);
      throw new Error(
        'Duplicate payer review after verification reload: ' + JSON.stringify(diagnostic) + '\\n' + String(error),
      );
    }
    await expect(payerReview.getByTestId('guest-payer-payment-' + anna.personId)).toContainText(
      'Поступление проверено',
      {
        timeout: 15_000,
      },
    );
    // A second reload must not reintroduce a stale payer review after the
    // receipt confirmation was already persisted on the server.
    await otherPage.reload({ waitUntil: 'networkidle' });
    try {
      await expect(payerReview).toHaveCount(1, { timeout: 15_000 });
    } catch (error) {
      const diagnostic = await payerReviewDomDiagnostic(otherPage);
      throw new Error(
        'Duplicate payer review on repeated verified reload: ' + JSON.stringify(diagnostic) + '\\n' + String(error),
      );
    }
    await expect(payerReview.getByTestId('guest-payer-payment-' + anna.personId)).toContainText(
      'Поступление проверено',
    );
    await expect(page.getByTestId('guest-payer-payment-review')).toHaveCount(0);
    const publicStatus = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(JSON.stringify(publicStatus)).not.toContain('paymentVerifiedAt');
    await expect(otherPage.getByTestId('guest-payer-sbp-phone')).toHaveValue('+79991234567', { timeout: 15_000 });
    await otherPage.getByTestId('guest-payer-sbp-search').fill('Озон Банк');
    await expect(otherPage.getByTestId('guest-payer-sbp-bank-100000000273').locator('input')).toBeChecked();
    // A payer may also revoke this receipt-specific destination.
    await otherPage.getByTestId('guest-payer-sbp-clear').click();
    await otherPage.getByTestId('guest-payer-sbp-save').click();
    await otherPage.reload({ waitUntil: 'networkidle' });
    await expect(otherPage.getByTestId('guest-payer-sbp-phone')).toHaveValue('', { timeout: 15_000 });
    // Revocation takes effect on the server, not just in the payer's UI.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByTestId('guest-sbp-not-configured')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('guest-sbp-reimbursement-phone')).toHaveCount(0);
    await fitsPhone(otherPage);
    await otherPage.goto('/split/' + token, { waitUntil: 'networkidle' });
    await expect(otherPage.getByTestId('split-result-total')).toContainText('12,01');
    await expect(otherPage.getByTestId('split-result-food-total')).toContainText('10,01');
    await expect(otherPage.getByTestId('split-result-personal-tips')).toContainText('2,00');
    await expect(otherPage.getByText('Всего чаевых официанту')).toBeVisible();
    await expect(otherPage.getByText('Итого с чаевыми')).toBeVisible();
    await fitsPhone(otherPage);

    const lateTip = await trpcMutation(otherDevice.request, 'guest.setPersonalTip', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      tipCents: 100,
    });
    expect(lateTip.ok()).toBe(false);
    const after = await trpcResult(await trpcQuery(otherDevice.request, 'guest.getSession', { token }));
    expect(after.summary).toEqual(session.summary);
  } finally {
    await otherDevice.close();
    await owner.dispose();
  }
});

test('anonymous mobile participant can join a long-name slot and edit it with touch controls', async ({ page }) => {
  test.setTimeout(90_000);
  const longName = 'Алексей'.repeat(5) + '12345';
  expect(longName).toHaveLength(40);
  const owner = await authedContext(users.alice.email, users.alice.password);
  let token: string | undefined;
  try {
    const created = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Мобильный чек', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'RUB' },
      items: [{ name: 'Кофе', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Илья',
      paidByName: 'Илья',
      people: [longName, 'Илья'],
    });
    const response = await created.json();
    expect(created.ok(), JSON.stringify(response)).toBe(true);
    token = response.result.data.json.shareToken;

    await page.goto('/split/' + token + '/claim', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 460 });
    await fitsPhone(page);
    const nameInput = page.getByTestId('claim-name-input');
    expect(await nameInput.getAttribute('maxlength')).toBe('40');
    expect((await nameInput.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const groupCount = page.getByTestId('group-size-input');
    expect(await groupCount.getAttribute('inputmode')).toBe('numeric');
    expect((await groupCount.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const joinButton = page.getByTestId('claim-join-btn');
    expect((await joinButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const freePerson = page.getByTestId('rejoin-person-0');
    await expect(freePerson).toContainText(longName);
    const freeBox = await freePerson.boundingBox();
    expect(freeBox!.height).toBeGreaterThanOrEqual(44);
    expect(freeBox!.x + freeBox!.width).toBeLessThanOrEqual(320);
    await fitsPhone(page);

    await freePerson.click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15_000 });
    const edit = page.getByTestId('edit-person-0');
    await edit.scrollIntoViewIfNeeded();
    expect((await edit.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await edit.click();
    const nameEdit = page.getByTestId('edit-name-input-0');
    await expect(nameEdit).toHaveValue(longName);
    expect((await nameEdit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await fitsPhone(page);

    // The unclaimed remainder has to fit even when the system font is large,
    // before this participant assigns any share of the receipt.
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const unclaimedTotal = page.getByTestId('unclaimed-total');
    for (const width of [360, 430, 720]) {
      await page.setViewportSize({ width, height: 380 });
      await expect(unclaimedTotal).toBeVisible();
      const rect = await unclaimedTotal.boundingBox();
      expect(rect, 'Unclaimed remainder at ' + width + 'px').not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      const contentOverflow = await unclaimedTotal.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(contentOverflow).toBeLessThanOrEqual(1);
      await fitsPhone(page);
    }

    // The save action contains the full 40-character name. With Android text
    // scaling it must wrap rather than extending beyond the phone viewport.
    await page.getByTestId('claim-item-0').click();
    const saveClaims = page.getByTestId('save-claims-btn');
    await expect(saveClaims).toContainText(longName);
    for (const width of [360, 430, 720]) {
      await page.setViewportSize({ width, height: 380 });
      const editForm = nameEdit.locator('xpath=ancestor::form');
      await expect(nameEdit).toHaveValue(longName);
      const editControls = [nameEdit, editForm.locator('button').nth(0), editForm.locator('button').nth(1)];
      for (const control of editControls) {
        await control.scrollIntoViewIfNeeded();
        const rect = await control.boundingBox();
        expect(rect, 'Claim name editor control at ' + width + 'px').not.toBeNull();
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      }
      await saveClaims.scrollIntoViewIfNeeded();
      await expect(saveClaims).toBeInViewport();
      const bounds = await saveClaims.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const overflow = await saveClaims.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await fitsPhone(page);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token });
    await owner.dispose();
  }
});
