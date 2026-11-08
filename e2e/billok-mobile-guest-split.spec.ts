import { expect, test, type Page } from '@playwright/test';
import {
  authedContext,
  joinGuestSession,
  rememberClaimIdentity,
  trpcMutation,
  trpcQuery,
  trpcError,
  trpcResult,
  users,
} from './helpers';

// Claim pages maintain a persistent SSE connection (3.16); waiting for
// networkidle on their navigation/reload would never settle. Assert the
// actual content/state instead of relying on transport becoming idle.
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

/**
 * Monitor every real animation frame with duplicate payer review DOM, not
 * just snapshots after Playwright actions. This is test-only instrumentation,
 * scoped to the payer's browser document and reset on every hard reload.
 */
async function monitorPayerReviewDuplicates(page: Page) {
  await page.addInitScript(() => {
    type DuplicateFrame = { count: number; mainCount: number; reactAttached: boolean[] };
    const monitored = window as Window & { __billokDuplicateReviewFrame?: DuplicateFrame };
    let scheduled = false;
    const check = () => {
      if (scheduled || monitored.__billokDuplicateReviewFrame) return;
      const panels = [...document.querySelectorAll<HTMLElement>('[data-testid="guest-payer-payment-review"]')];
      if (panels.filter((panel) => panel.getClientRects().length > 0).length <= 1) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const visible = [
          ...document.querySelectorAll<HTMLElement>('[data-testid="guest-payer-payment-review"]'),
        ].filter((panel) => panel.getClientRects().length > 0);
        if (visible.length > 1 && !monitored.__billokDuplicateReviewFrame) {
          monitored.__billokDuplicateReviewFrame = {
            count: visible.length,
            mainCount: document.querySelectorAll('main').length,
            reactAttached: visible.map((panel) => Object.keys(panel).some((key) => key.startsWith('__reactFiber$'))),
          };
        }
      });
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    });
  });
}

async function requireNoPaintedPayerReviewDuplicates(page: Page) {
  const duplicate = await page.evaluate(
    () =>
      (
        window as Window & {
          __billokDuplicateReviewFrame?: { count: number; mainCount: number; reactAttached: boolean[] };
        }
      ).__billokDuplicateReviewFrame ?? null,
  );
  if (duplicate) {
    const diagnostic = await payerReviewDomDiagnostic(page);
    throw new Error(
      'Multiple visible payer reviews persisted to an animation frame: ' + JSON.stringify({ duplicate, diagnostic }),
    );
  }
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
  // The accepted direct-allocation flow remains available under the manual tab.
  await page.getByTestId('workflow-manual').click();
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
  for (const width of [320, 360, 430, 480, 600, 720]) {
    await page.setViewportSize({ width, height: 460 });
    await page.goto('/splits', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    await expect(page.getByTestId('splits-page')).toBeVisible();
    const historyLink = page.locator('a[href$="/split/' + receiptToken + '"]');
    const historyCard = page.locator('[data-testid^="split-card-"]').filter({
      has: historyLink,
    });
    await expect(historyCard).toBeVisible();
    await expect(historyCard).toContainText('Ужин в кафе');
    await fitsPhone(page);
    const cardRect = await historyCard.boundingBox();
    expect(cardRect).not.toBeNull();
    expect(cardRect!.x).toBeGreaterThanOrEqual(0);
    expect(cardRect!.x + cardRect!.width).toBeLessThanOrEqual(width);
    const linkRect = await historyLink.boundingBox();
    expect(linkRect).not.toBeNull();
    expect(linkRect!.height).toBeGreaterThanOrEqual(44);
    expect(linkRect!.x).toBeGreaterThanOrEqual(0);
    expect(linkRect!.x + linkRect!.width).toBeLessThanOrEqual(width);
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
      const cancelBounds = await cancel.boundingBox();
      expect(cancelBounds).not.toBeNull();
      expect(cancelBounds!.height).toBeGreaterThanOrEqual(44);
      expect(cancelBounds!.width).toBeGreaterThanOrEqual(44);
      await cancel.click();
      await page.setViewportSize({ width: 320, height: 460 });
      await expect(historyCard).toBeVisible();
    }

    // Open the finalized saved receipt from history with a real touch click.
    // This must work on all six widths, not just by typing the public URL.
    await historyLink.click();
    await expect(page).toHaveURL(new RegExp('/split/' + receiptToken + '$'));
    await expect(page.getByTestId('split-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('person-card-1')).toContainText(longGuestName);
    await fitsPhone(page);
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
    await expect(visitor.getByTestId('personal-tip-save')).toBeDisabled();
    await visitor.reload({ waitUntil: 'domcontentloaded' });
    await expect(visitorTip).toHaveValue('3.50', { timeout: 15_000 });

    // The minimum positive tip is one kopeck. Editing Boris's amount from
    // another mobile device must never change Anna's saved zero tip.
    await visitorTip.fill('0,01');
    await expect(visitor.getByTestId('personal-tip-save')).toBeEnabled();
    await visitor.getByTestId('personal-tip-save').click();
    await expect(visitorTip).toHaveValue('0.01', { timeout: 15_000 });
    await visitor.reload({ waitUntil: 'domcontentloaded' });
    await expect(visitorTip).toHaveValue('0.01', { timeout: 15_000 });
    await fitsPhone(visitor);

    const state = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(state.people.map((person: { name: string; tipCents: number }) => [person.name, person.tipCents])).toEqual([
      ['Анна', 0],
      ['Борис', 1],
    ]);
    await page.reload();
    await expect(page.getByTestId('personal-tip-input')).toHaveValue('0.00', { timeout: 15_000 });
    await fitsPhone(page);

    // 1.4.15.11.5.1: a shortened viewport approximates the space left
    // when the Android keyboard is open, while large font is enabled.
    // Both the editor and the sticky action bar must stay usable by touch.
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    for (const [width, value, savedValue] of [
      [320, '0,01', '0.01'],
      [360, '0,02', '0.02'],
    ] as const) {
      await page.setViewportSize({ width, height: 320 });
      const tipInput = page.getByTestId('personal-tip-input');
      const tipSave = page.getByTestId('personal-tip-save');
      await tipInput.fill(value);
      await expect(tipInput).toBeFocused();
      await expect(tipSave).toBeEnabled();
      // 2.19.2.2: the creator-approval hint must not enlarge the fixed
      // action panel and intercept the tip save button on keyboard-sized screens.
      await expect(page.getByTestId('guest-parts-awaiting-confirmation')).toBeVisible();
      await expect(page.getByTestId('claim-actions').getByTestId('guest-parts-awaiting-confirmation')).toHaveCount(0);
      for (const testId of ['personal-tip-input', 'personal-tip-save', 'claim-actions', 'save-claims-btn']) {
        const bounds = await page.getByTestId(testId).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height };
        });
        expect(bounds.left, testId + ' left at ' + width + 'px').toBeGreaterThanOrEqual(0);
        expect(bounds.right, testId + ' right at ' + width + 'px').toBeLessThanOrEqual(width);
        expect(bounds.height, testId + ' touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      }
      await fitsPhone(page);
      await tipSave.click();
      await expect(tipInput).toHaveValue(savedValue, { timeout: 15_000 });
      await expect(tipSave).toBeDisabled();
      await fitsPhone(page);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('personal-tip-input')).toHaveValue('0.02', { timeout: 15_000 });
    const afterKeyboard = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(
      afterKeyboard.people.map((person: { name: string; tipCents: number }) => [person.name, person.tipCents]),
    ).toEqual([
      ['Анна', 2],
      ['Борис', 1],
    ]);
  } finally {
    await second.close();
    await owner.dispose();
  }
});

test('Issue 2.14 / 2.20.3: guest unknown and known original portions, real mobile approval, exact RUB', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const second = await browser.newContext({ viewport: { width: 320, height: 520 }, isMobile: true, hasTouch: true });
  try {
    const response = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Пицца на двоих', subtotal: 800, tax: 0, tip: 0, total: 800, currency: 'RUB' },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 800, totalPrice: 800 }],
      people: ['Анна', 'Борис'],
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
    const boris = await joinGuestSession(second.request, { token, name: 'Борис' });
    await rememberClaimIdentity(page.context(), token, anna);
    await rememberClaimIdentity(second, token, boris);

    // Before anyone selects this pizza, zero declared portions are visible.
    // The whole receipt remains unclaimed, never automatically charged.
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 0');
    await expect(page.getByTestId('unclaimed-total')).toContainText('8,00');
    await expect(page.getByTestId('guest-parts-preliminary')).toBeVisible();
    // 2.20.3: the optional original is meaningful even at zero claims.
    const emptyKnown = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 8,
    });
    expect(emptyKnown.ok(), await emptyKnown.text()).toBe(true);
    await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 8',
      { timeout: 15_000 },
    );
    const unknownAgain = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: null,
    });
    expect(unknownAgain.ok(), await unknownAgain.text()).toBe(true);
    await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText('Исходное количество неизвестно', {
      timeout: 15_000,
    });

    for (const guest of [anna, boris]) {
      const ctx = guest.personId === anna.personId ? owner : second.request;
      const res = await trpcMutation(ctx, 'guest.claimItems', {
        token,
        personId: guest.personId,
        personToken: guest.personToken,
        claimedItemIndices: [0],
      });
      expect(res.ok(), await res.text()).toBe(true);
    }

    const alicePage = page;
    const bobPage = await second.newPage();
    await alicePage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await bobPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const aliceInput = alicePage.getByTestId('personal-parts-input-0');
    const bobInput = bobPage.getByTestId('personal-parts-input-0');
    await expect(alicePage.getByTestId('guest-parts-preliminary')).toContainText('Предварительный расчёт');
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 2');
    await expect(bobPage.getByTestId('guest-claimed-parts-progress-0')).not.toContainText('Осталось');
    await expect(aliceInput).toHaveValue('1', { timeout: 15_000 });
    await expect(bobInput).toHaveValue('1', { timeout: 15_000 });
    await aliceInput.fill('0');
    await expect(alicePage.getByTestId('personal-parts-save-0')).toBeDisabled();
    await aliceInput.fill('3');
    await bobInput.fill('5');
    await alicePage.getByTestId('personal-parts-save-0').click();
    await bobPage.getByTestId('personal-parts-save-0').click();
    await expect(aliceInput).toHaveValue('3', { timeout: 15_000 });
    await expect(bobInput).toHaveValue('5', { timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
          return stored.assignments[0].partsByPersonId;
        },
        { timeout: 15_000 },
      )
      .toEqual({ [anna.personId]: 3, [boris.personId]: 5 });
    const snapshot = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(snapshot.items[0].totalPrice).toBe(800);
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 8', {
      timeout: 15_000,
    });
    await expect(bobPage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Исходное количество неизвестно',
      { timeout: 15_000 },
    );

    // 2.20.2: the original count is optional. The logged-in creator may set
    // it by API; both anonymous personal-link devices see the exact remainder.
    await expect(alicePage.getByTestId('guest-known-parts-editor-0')).toHaveCount(0);
    const knownTen = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 10,
    });
    expect(knownTen.ok(), await knownTen.text()).toBe(true);
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 2',
      { timeout: 15_000 },
    );
    await expect(bobPage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 2',
      { timeout: 15_000 },
    );
    const overLimit = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 8,
    });
    expect(overLimit.ok()).toBe(false);
    const knownEight = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 8,
    });
    expect(knownEight.ok(), await knownEight.text()).toBe(true);
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 0',
      { timeout: 15_000 },
    );
    const invalidOriginal = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 7,
    });
    expect(invalidOriginal.ok()).toBe(false);
    const clearedKnown = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: null,
    });
    expect(clearedKnown.ok(), await clearedKnown.text()).toBe(true);
    await expect(bobPage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Исходное количество неизвестно',
      { timeout: 15_000 },
    );
    const storedAfterKnown = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(storedAfterKnown.assignments[0].partsByPersonId).toEqual({ [anna.personId]: 3, [boris.personId]: 5 });
    expect(storedAfterKnown.receiptData.knownPartsByItem).toEqual({});

    // Both devices can write the same session concurrently. The row-level
    // transaction retry must preserve both changes rather than last-write-wins.
    const simultaneous = await Promise.all([
      trpcMutation(owner, 'guest.setMyItemParts', {
        token,
        personId: anna.personId,
        personToken: anna.personToken,
        itemIndex: 0,
        parts: 4,
      }),
      trpcMutation(second.request, 'guest.setMyItemParts', {
        token,
        personId: boris.personId,
        personToken: boris.personToken,
        itemIndex: 0,
        parts: 6,
      }),
    ]);
    for (const response of simultaneous) expect(response.ok(), await response.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
          return stored.assignments[0].partsByPersonId;
        },
        { timeout: 15_000 },
      )
      .toEqual({ [anna.personId]: 4, [boris.personId]: 6 });
    const restoreAnna = await trpcMutation(owner, 'guest.setMyItemParts', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      itemIndex: 0,
      parts: 3,
    });
    expect(restoreAnna.ok(), await restoreAnna.text()).toBe(true);
    const restoreBoris = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 5,
    });
    expect(restoreBoris.ok(), await restoreBoris.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
          return stored.assignments[0].partsByPersonId;
        },
        { timeout: 15_000 },
      )
      .toEqual({ [anna.personId]: 3, [boris.personId]: 5 });
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await alicePage.setViewportSize({ width, height: 520 });
      await aliceInput.scrollIntoViewIfNeeded();
      const bounds = await aliceInput.boundingBox();
      expect(bounds, 'Personal parts input at ' + width + 'px').not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      await fitsPhone(alicePage);
    }
    await expect(alicePage.getByTestId('person-total-0')).toContainText('3,00', { timeout: 15_000 });
    await expect(alicePage.getByTestId('person-total-1')).toContainText('5,00', { timeout: 15_000 });

    // Knowing a different guest's personId is not enough to edit their count.
    const forbidden = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: anna.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 99,
    });
    expect(forbidden.ok()).toBe(false);
    const unchanged = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(unchanged.assignments[0].partsByPersonId).toEqual({ [anna.personId]: 3, [boris.personId]: 5 });

    // A personal correction and finalization must retain exactly one payer and all 800 kopecks.
    await aliceInput.fill('2');
    await alicePage.getByTestId('personal-parts-save-0').click();
    await expect
      .poll(
        async () => {
          const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
          return stored.assignments[0].partsByPersonId[anna.personId];
        },
        { timeout: 15_000 },
      )
      .toBe(2);
    await expect(aliceInput).toHaveValue('2', { timeout: 15_000 });
    await aliceInput.fill('3');
    await alicePage.getByTestId('personal-parts-save-0').click();
    // The controlled input changes before the mutation is committed. Never
    // finalize based only on the visible draft: wait for the personal token's
    // durable server value, which is what finalization actually uses.
    await expect
      .poll(
        async () => {
          const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
          return stored.assignments[0].partsByPersonId[anna.personId];
        },
        { timeout: 15_000 },
      )
      .toBe(3);
    await expect(aliceInput).toHaveValue('3', { timeout: 15_000 });

    // 2.20.3: creator enters the original count in the mobile UI.
    await alicePage.goto('/login', { waitUntil: 'networkidle' });
    await alicePage.locator('input[type=email]').fill(users.alice.email);
    await alicePage.locator('input[type=password]').fill(users.alice.password);
    await alicePage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(alicePage).toHaveURL(/\/dashboard/);
    await alicePage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const original = alicePage.getByTestId('guest-known-parts-input-0');
    const saveOriginal = alicePage.getByTestId('guest-known-parts-save-0');
    await expect(original).toBeVisible();
    await expect(bobPage.getByTestId('guest-known-parts-editor-0')).toHaveCount(0);
    await original.fill('10');
    await saveOriginal.click();
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 2',
      { timeout: 15_000 },
    );
    await expect(bobPage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 2',
      { timeout: 15_000 },
    );
    // A known remainder prevents both creator approval and direct API finalization.
    await expect(alicePage.getByTestId('guest-confirm-parts-btn')).toHaveCount(0);
    const premature = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(premature.ok()).toBe(false);
    const unfinished = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(unfinished.ok()).toBe(false);
    await original.fill('8');
    await saveOriginal.click();
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 0',
      { timeout: 15_000 },
    );
    // An extra slice cannot be saved by another device when all 8 are taken.
    const exceed = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 6,
    });
    expect(exceed.ok()).toBe(false);
    const stillEight = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stillEight.assignments[0].partsByPersonId).toEqual({ [anna.personId]: 3, [boris.personId]: 5 });
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await alicePage.setViewportSize({ width, height: 520 });
      await original.scrollIntoViewIfNeeded();
      const rect = await original.boundingBox();
      expect(rect, 'Known original input at ' + width).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
      await fitsPhone(alicePage);
    }
    await alicePage.getByTestId('guest-confirm-parts-btn').click();
    await expect
      .poll(async () => (await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }))).partsConfirmed)
      .toBe(true);

    // Any correction to the known original invalidates the saved sign-off.
    await original.fill('9');
    await saveOriginal.click();
    await expect(alicePage.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 1',
      { timeout: 15_000 },
    );
    await expect
      .poll(async () => (await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }))).partsConfirmed)
      .toBe(false);
    const stale = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(stale.ok()).toBe(false);
    await original.fill('8');
    await saveOriginal.click();
    await expect(alicePage.getByTestId('guest-confirm-parts-btn')).toBeVisible();
    await alicePage.getByTestId('guest-confirm-parts-btn').click();
    await expect
      .poll(async () => (await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }))).partsConfirmed)
      .toBe(true);
    const finalize = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(finalize.ok(), await finalize.text()).toBe(true);
    const finalized = await trpcResult(await trpcQuery(owner, 'guest.getSplit', { token }));
    expect(finalized.summary.map((entry: { itemTotal: number }) => entry.itemTotal)).toEqual([300, 500]);
    expect(finalized.summary.reduce((sum: number, entry: { total: number }) => sum + entry.total, 0)).toBe(800);
    expect(finalized.assignments[0].portions).toEqual([3, 5]);
  } finally {
    await second.close();
    await owner.dispose();
  }
});

test('Issue 2.16.3: nine one-kopeck guest dishes balance 3:3:3 in preview, final result and six mobile widths', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const otherDevice = await browser.newContext({
    viewport: { width: 320, height: 520 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const inputItems = Array.from({ length: 9 }, (_, index) => ({
      name: 'Блюдо ' + (index + 1),
      quantity: 1,
      unitPrice: 1,
      totalPrice: 1,
    }));
    const creation = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Девять копеек', subtotal: 9, tax: 0, tip: 0, total: 9, currency: 'RUB' },
      items: inputItems,
      people: ['Анна', 'Борис', 'Виктор'],
      creatorName: 'Анна',
      paidByName: 'Борис',
      joinCreator: true,
    });
    const creationBody = await creation.text();
    expect(creation.ok(), creationBody).toBe(true);
    const created = JSON.parse(creationBody).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    const token = created.shareToken;
    const anna = created.creator;
    const boris = await joinGuestSession(otherDevice.request, { token, name: 'Борис' });
    const victor = await joinGuestSession(owner, { token, name: 'Виктор' });
    await rememberClaimIdentity(page.context(), token, anna);
    for (const participant of [anna, boris, victor]) {
      const ctx = participant.personId === boris.personId ? otherDevice.request : owner;
      const response = await trpcMutation(ctx, 'guest.claimItems', {
        token,
        personId: participant.personId,
        personToken: participant.personToken,
        claimedItemIndices: inputItems.map((_, index) => index),
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stored.receiptData.roundingBalanced).toBe(true);
    expect(stored.items.map((entry: { totalPrice: number }) => entry.totalPrice)).toEqual(Array(9).fill(1));
    expect(stored.assignments).toHaveLength(9);

    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    for (const index of [0, 1, 2]) {
      await expect(page.getByTestId('person-total-' + index)).toContainText('0,03', { timeout: 15_000 });
    }
    await expect(page.getByTestId('unclaimed-total')).toHaveCount(0);
    // A fully balanced nine-dish receipt must not show a fictitious correction.
    await expect(page.locator('[data-testid^="guest-preview-rounding-correction-"]')).toHaveCount(0);

    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 520 });
      const card = page.getByTestId('person-total-0');
      await card.scrollIntoViewIfNeeded();
      const bounds = await card.boundingBox();
      expect(bounds, 'Guest rounding preview at ' + width).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await fitsPhone(page);
    }

    const approved = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approved.ok(), await approved.text()).toBe(true);
    const finish = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(finish.ok(), await finish.text()).toBe(true);
    const result = await trpcResult(await trpcQuery(owner, 'guest.getSplit', { token }));
    expect(result.receiptData.total).toBe(9);
    expect(result.summary.map((entry: { itemTotal: number }) => entry.itemTotal)).toEqual([3, 3, 3]);
    expect(result.summary.reduce((sum: number, entry: { total: number }) => sum + entry.total, 0)).toBe(9);
    expect(
      result.summary.every((entry: { itemTotal: number; total: number }) => entry.itemTotal >= 0 && entry.total >= 0),
    ).toBe(true);

    await page.goto('/split/' + token, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('split-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('split-result-total')).toContainText('0,09');
    await expect(page.locator('[data-testid^="guest-result-rounding-correction-"]')).toHaveCount(0);
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 520 });
      for (const index of [0, 1, 2]) {
        const card = page.getByTestId('person-card-' + index);
        await expect(card.getByTestId('person-total-' + index)).toContainText('0,03');
        const lines = await card.getByTestId('line-amount').allTextContents();
        expect(lines).toHaveLength(9);
        const totalLines = lines.reduce((sum, value) => {
          const cents = Number(value.replace(/[^\d,]/g, '').replace(',', '.')) * 100;
          expect(Number.isInteger(cents)).toBe(true);
          expect(cents).toBeGreaterThanOrEqual(0);
          return sum + cents;
        }, 0);
        expect(totalLines).toBe(3);
        await card.scrollIntoViewIfNeeded();
        const bounds = await card.boundingBox();
        expect(bounds, 'Finalized guest card ' + index + ' at ' + width).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      }
      await fitsPhone(page);
    }
  } finally {
    await otherDevice.close();
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
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
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

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    await expect(page.getByTestId('guest-parts-awaiting-confirmation')).toBeVisible();
    // The anonymous personal-link page cannot approve for the registered creator.
    await expect(page.getByTestId('guest-confirm-parts-btn')).toHaveCount(0);
    const approved = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approved.ok(), await approved.text()).toBe(true);
    // A live poll updates the guest's open page without a reload.
    await expect(page.getByTestId('guest-parts-awaiting-confirmation')).toHaveCount(0, { timeout: 15_000 });
    // 3.4: the original personal token on this anonymous device does NOT
    // authorize finalization. Only the logged-in creator may finish by API.
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    const unauthorized = await trpcMutation(page.request, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect((await trpcError(unauthorized))?.data?.code).toBe('UNAUTHORIZED');
    const finishedByCreator = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(finishedByCreator.ok(), await finishedByCreator.text()).toBe(true);

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

    // The public summary must not replace this guest's private settlement.
    // Navigation in both directions preserves their own total and payer.
    await page.getByRole('link', { name: 'Посмотреть итоги' }).click();
    await expect(page.getByTestId('split-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('split-result-total')).toContainText('12,01');
    await expect(page.getByTestId('split-result-food-total')).toContainText('10,01');
    await expect(page.getByTestId('split-result-personal-tips')).toContainText('2,00');
    const backToClaim = page.getByTestId('split-result-back-to-claim');
    await expect(backToClaim).toBeVisible();
    expect((await backToClaim.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await backToClaim.click();
    await expect(page.getByTestId('guest-personal-reimbursement-amount')).toContainText('4,59', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('guest-personal-reimbursement')).toContainText('Борис');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,01', { timeout: 15_000 });
    await expect(page.getByTestId('guest-personal-reimbursement-amount')).toContainText('4,59');
    await fitsPhone(page);

    // 1.4.15.11.5.2: mobile end-to-end acceptance for the finalized receipt.
    // Hard reload at each width avoids carrying stale mobile viewport offsets.
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 300 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await expect(page.getByTestId('finalized-bill-total')).toContainText('12,01', { timeout: 15_000 });
      await expect(page.getByTestId('finalized-food-total')).toContainText('10,01');
      await expect(page.getByTestId('finalized-waiter-tip-total')).toContainText('2,00');
      await expect(page.getByTestId('guest-personal-reimbursement-amount')).toContainText('4,59');
      await expect(page.getByTestId('guest-personal-reimbursement')).toContainText('Борис');
      await expect(page.locator('#settle-amount')).toHaveCount(0);
      await expect(page.getByTestId('guest-mark-paid')).toBeVisible({ timeout: 15000 });
      for (const id of ['guest-personal-reimbursement-amount', 'guest-copy-reimbursement-amount', 'guest-mark-paid']) {
        const target = page.getByTestId(id);
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box!.x, id + ' left at ' + width).toBeGreaterThanOrEqual(-1);
        expect(box!.x + box!.width, id + ' right at ' + width).toBeLessThanOrEqual(width + 1);
        if (id !== 'guest-personal-reimbursement-amount')
          expect(box!.height, id + ' touch height at ' + width).toBeGreaterThanOrEqual(44);
      }
      await fitsPhone(page);
      for (const testId of ['guest-view-summary-link', 'copy-link-btn', 'personal-link-btn']) {
        const bounds = await page.getByTestId(testId).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height };
        });
        expect(bounds.left, testId + ' left at ' + width + 'px').toBeGreaterThanOrEqual(0);
        expect(bounds.right, testId + ' right at ' + width + 'px').toBeLessThanOrEqual(width);
        expect(bounds.height, testId + ' touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      }

      await page.getByTestId('guest-view-summary-link').click();
      await expect(page.getByTestId('split-result')).toBeVisible({ timeout: 15_000 });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await expect(page.getByTestId('split-result-total')).toContainText('12,01');
      await expect(page.getByTestId('split-result-food-total')).toContainText('10,01');
      await expect(page.getByTestId('split-result-personal-tips')).toContainText('2,00');
      await fitsPhone(page);
      for (const testId of ['split-result-back-to-claim', 'copy-link-btn', 'share-btn']) {
        const bounds = await page.getByTestId(testId).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height };
        });
        expect(bounds.left, testId + ' left at ' + width + 'px').toBeGreaterThanOrEqual(0);
        expect(bounds.right, testId + ' right at ' + width + 'px').toBeLessThanOrEqual(width);
        expect(bounds.height, testId + ' touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      }
      const backToClaim = page.getByTestId('split-result-back-to-claim');
      await backToClaim.scrollIntoViewIfNeeded();
      const hit = await backToClaim.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const target = document.elementFromPoint(centerX, centerY);
        const footer = document.querySelector('[data-testid="split-result-actions"]');
        return {
          centerY,
          buttonTop: rect.top,
          footerPosition: footer ? getComputedStyle(footer).position : 'missing',
          coveringElement: target?.tagName ?? 'none',
          coveringTestId: target?.getAttribute('data-testid') ?? null,
          clickable: target === element || element.contains(target),
        };
      });
      expect(hit.footerPosition, 'Footer at ' + width + 'px: ' + JSON.stringify(hit)).toBe('static');
      expect(hit.clickable, 'Back to receipt blocked at ' + width + 'px: ' + JSON.stringify(hit)).toBe(true);
      await backToClaim.click();
      await expect(page.getByTestId('guest-personal-reimbursement-amount')).toContainText('4,59', {
        timeout: 15_000,
      });
      await expect(page.getByTestId('guest-personal-reimbursement')).toContainText('Борис');
      await fitsPhone(page);
    }
    // Restore a normal font before testing the remaining payment workflow.
    await page.reload({ waitUntil: 'domcontentloaded' });

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
    await monitorPayerReviewDuplicates(otherPage);
    await otherPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
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
    await page.reload({ waitUntil: 'domcontentloaded' });
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
    await requireNoPaintedPayerReviewDuplicates(otherPage);
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
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('guest-payment-declared')).toHaveText('Оплачено', { timeout: 15_000 });
    await expect(page.getByTestId('guest-mark-paid')).toHaveCount(0);
    await expect(page.getByTestId('guest-payer-sbp-form')).toHaveCount(0);

    await otherPage.reload({ waitUntil: 'domcontentloaded' });
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
    await otherPage.reload({ waitUntil: 'domcontentloaded' });
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
    await otherPage.reload({ waitUntil: 'domcontentloaded' });
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
    await otherPage.reload({ waitUntil: 'domcontentloaded' });
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
    await requireNoPaintedPayerReviewDuplicates(otherPage);
    await expect(page.getByTestId('guest-payer-payment-review')).toHaveCount(0);
    const publicStatus = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(JSON.stringify(publicStatus)).not.toContain('paymentVerifiedAt');
    await expect(otherPage.getByTestId('guest-payer-sbp-phone')).toHaveValue('+79991234567', { timeout: 15_000 });
    await otherPage.getByTestId('guest-payer-sbp-search').fill('Озон Банк');
    await expect(otherPage.getByTestId('guest-payer-sbp-bank-100000000273').locator('input')).toBeChecked();
    // A payer may also revoke this receipt-specific destination.
    await otherPage.getByTestId('guest-payer-sbp-clear').click();
    await otherPage.getByTestId('guest-payer-sbp-save').click();
    await otherPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(otherPage.getByTestId('guest-payer-sbp-phone')).toHaveValue('', { timeout: 15_000 });
    // Revocation takes effect on the server, not just in the payer's UI.
    await page.reload({ waitUntil: 'domcontentloaded' });
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

    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
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

test('anonymous mobile guest selects a partial portion and keeps it after reopening', async ({ page }) => {
  test.setTimeout(95_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  let token: string | undefined;
  try {
    const created = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Пицца на компанию', subtotal: 900, tax: 0, tip: 0, total: 900, currency: 'RUB' },
      items: [{ name: 'Пицца', quantity: 3, unitPrice: 300, totalPrice: 900 }],
      people: ['Анна', 'Илья'],
      creatorName: 'Анна',
      paidByName: 'Анна',
    });
    const body = await created.text();
    expect(created.ok(), body).toBe(true);
    token = JSON.parse(body).result.data.json.shareToken as string;

    await page.setViewportSize({ width: 320, height: 460 });
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await page.getByTestId('rejoin-person-1').click();
    await expect(page.getByTestId('claim-item-0')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('claim-item-0')).toContainText('Пицца');
    // createClaimSession expands quantity=3 into three independent claimable
    // rows. Guests select exactly the portion they consumed; the split
    // control is intentionally hidden once each row has quantity=1.
    const afterSplit = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(afterSplit.items).toHaveLength(3);
    for (const [index, item] of afterSplit.items.entries()) {
      expect(item).toMatchObject({ name: 'Пицца', quantity: 1, totalPrice: 300 });
      await expect(page.getByTestId('claim-item-' + index)).toBeVisible();
      await expect(page.getByTestId('claim-item-' + index)).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('split-claim-item-' + index)).toHaveCount(0);
    }

    const ownPart = 0;
    await page.getByTestId('claim-item-' + ownPart).click();
    await expect(page.getByTestId('claim-item-' + ownPart)).toHaveAttribute('aria-pressed', 'true');
    for (const otherPart of [1, 2]) {
      await expect(page.getByTestId('claim-item-' + otherPart)).toHaveAttribute('aria-pressed', 'false');
    }
    const save = page.getByTestId('save-claims-btn');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 15_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-item-' + ownPart)).toHaveAttribute('aria-pressed', 'true', {
      timeout: 15_000,
    });
    for (const otherPart of [1, 2]) {
      await expect(page.getByTestId('claim-item-' + otherPart)).toHaveAttribute('aria-pressed', 'false');
    }
    const saved = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const guestIndex = saved.people.findIndex((person: { name: string }) => person.name === 'Илья');
    expect(guestIndex).toBeGreaterThanOrEqual(0);
    expect(saved.assignments.filter((a: { personIndices: number[] }) => a.personIndices.includes(guestIndex))).toEqual([
      {
        itemIndex: ownPart,
        personIndices: [guestIndex],
        partsByPersonId: { [saved.people[guestIndex].id]: saved.people[guestIndex].groupSize ?? 1 },
      },
    ]);

    // Treat each viewport as a fresh phone launch. Resizing an already
    // scrolled mobile-emulated page can retain a visual-viewport offset
    // which makes Playwright boundingBox report false negative x values.
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 360 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      const card = page.getByTestId('claim-item-' + ownPart);
      await expect(card).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
      await fitsPhone(page);

      // The DOM rectangle is measured against the actual visual viewport,
      // rather than mixing Playwright's mobile boundingBox coordinate space
      // with the page's CSS-layout viewport.
      const geometry = await card.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const visual = window.visualViewport;
        const visibleLeft = visual?.offsetLeft ?? 0;
        const visibleWidth = visual?.width ?? document.documentElement.clientWidth;
        return {
          cardLeft: rect.left,
          cardRight: rect.right,
          cardHeight: rect.height,
          visibleLeft,
          visibleRight: visibleLeft + visibleWidth,
          visualScale: visual?.scale ?? 1,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          scrollX: window.scrollX,
          mainLeft: element.closest('main')?.getBoundingClientRect().left ?? null,
          // Structural diagnostics only: no labels, URLs, tokens or user data.
          overflowingElements: [...document.querySelectorAll<HTMLElement>('body *')]
            .filter((node) => {
              const bounds = node.getBoundingClientRect();
              return bounds.width > 0 && bounds.right > document.documentElement.clientWidth + 1;
            })
            .slice(0, 12)
            .map((node) => ({
              tag: node.tagName,
              testId: node.getAttribute('data-testid'),
              sonner: node.hasAttribute('data-sonner-toaster') || node.hasAttribute('data-sonner-toast'),
              x: Math.round(node.getBoundingClientRect().x),
              right: Math.round(node.getBoundingClientRect().right),
              width: Math.round(node.getBoundingClientRect().width),
            })),
        };
      });
      expect(geometry.cardHeight, 'Touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      expect(
        geometry.cardLeft - geometry.visibleLeft,
        'Card is clipped at left on ' + width + 'px: ' + JSON.stringify(geometry),
      ).toBeGreaterThanOrEqual(0);
      expect(
        geometry.visibleRight - geometry.cardRight,
        'Card is clipped at right on ' + width + 'px: ' + JSON.stringify(geometry),
      ).toBeGreaterThanOrEqual(0);
      for (const testId of ['personal-link-btn', 'claim-actions', 'save-claims-btn']) {
        const bounds = await page.getByTestId(testId).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height };
        });
        expect(bounds.left, testId + ' left at ' + width + 'px').toBeGreaterThanOrEqual(0);
        expect(bounds.right, testId + ' right at ' + width + 'px').toBeLessThanOrEqual(width);
        expect(bounds.height, testId + ' touch height at ' + width + 'px').toBeGreaterThanOrEqual(44);
      }
      expect(
        geometry.documentWidth,
        'Document overflow on ' + width + 'px: ' + JSON.stringify(geometry),
      ).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      await fitsPhone(page);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token });
    await owner.dispose();
  }
});

test('Issue 2.19.3: guest personal links count 0, 3, 8 portions and cannot finalize unapproved RUB claims', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const second = await browser.newContext({
    viewport: { width: 320, height: 520 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const creation = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Приёмка 2.19.3',
        subtotal: 1001,
        tax: 0,
        tip: 0,
        total: 1001,
        currency: 'RUB',
      },
      items: [
        { name: 'Пицца', quantity: 1, unitPrice: 800, totalPrice: 800 },
        { name: 'Вода', quantity: 1, unitPrice: 201, totalPrice: 201 },
      ],
      people: ['Анна', 'Борис'],
      creatorName: 'Анна',
      paidByName: 'Борис',
      joinCreator: true,
    });
    const raw = await creation.text();
    expect(creation.ok(), raw).toBe(true);
    const created = JSON.parse(raw).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    const token = created.shareToken;
    const anna = created.creator;
    const boris = await joinGuestSession(second.request, { token, name: 'Борис' });
    await rememberClaimIdentity(page.context(), token, anna);
    await rememberClaimIdentity(second, token, boris);

    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const pizzaProgress = page.getByTestId('guest-claimed-parts-progress-0');
    const waterProgress = page.getByTestId('guest-claimed-parts-progress-1');
    await expect(pizzaProgress).toContainText('Всего заявлено частей: 0');
    await expect(waterProgress).toContainText('Всего заявлено частей: 0');
    await expect(page.getByTestId('unclaimed-total')).toContainText('10,01');
    await expect(page.getByTestId('guest-parts-preliminary')).toContainText('Предварительный расчёт');
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    const earlyApproval = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(earlyApproval.ok()).toBe(false);
    const earlyFinish = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(earlyFinish.ok()).toBe(false);
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(initial.status).toBe('CLAIMING');
    expect(initial.partsConfirmed).toBe(false);
    expect(initial.items.map((entry: { totalPrice: number }) => entry.totalPrice)).toEqual([800, 201]);

    const annaClaim = await trpcMutation(owner, 'guest.claimItems', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      claimedItemIndices: [0],
    });
    expect(annaClaim.ok(), await annaClaim.text()).toBe(true);
    const three = await trpcMutation(owner, 'guest.setMyItemParts', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      itemIndex: 0,
      parts: 3,
    });
    expect(three.ok(), await three.text()).toBe(true);
    await expect(pizzaProgress).toContainText('Всего заявлено частей: 3', { timeout: 15_000 });
    await expect(waterProgress).toContainText('Всего заявлено частей: 0');
    await expect(pizzaProgress).toContainText('Исходное количество неизвестно');
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);

    const borisClaim = await trpcMutation(second.request, 'guest.claimItems', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      claimedItemIndices: [0, 1],
    });
    expect(borisClaim.ok(), await borisClaim.text()).toBe(true);
    const five = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 5,
    });
    expect(five.ok(), await five.text()).toBe(true);
    await expect(pizzaProgress).toContainText('Всего заявлено частей: 8', { timeout: 15_000 });
    await expect(waterProgress).toContainText('Всего заявлено частей: 1');
    await expect(pizzaProgress).not.toContainText('Осталось');
    await expect(page.getByTestId('guest-parts-awaiting-confirmation')).toBeVisible();
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    await expect(page.getByTestId('person-total-0')).toContainText('3,00');
    await expect(page.getByTestId('person-total-1')).toContainText('7,01');

    // Two real devices: the guest's anonymous link never approves the receipt
    // for the signed-in creator, but both see the saved counts and provisional amount.
    const guestPage = await second.newPage();
    await guestPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(guestPage.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 8');
    await expect(guestPage.getByTestId('guest-confirm-parts-btn')).toHaveCount(0);
    for (const width of [320, 360, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 360 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 8', {
        timeout: 15_000,
      });
      await expect(page.getByTestId('guest-parts-awaiting-confirmation')).toBeVisible();
      const geometry = await page.getByTestId('guest-claimed-parts-progress-0').evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.viewportWidth, 'Viewport ' + width).toBe(width);
      expect(geometry.documentWidth, 'Overflow ' + width).toBeLessThanOrEqual(width + 1);
      expect(geometry.left, 'Progress left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(geometry.right, 'Progress right at ' + width).toBeLessThanOrEqual(width + 1);
      await fitsPhone(page);
    }

    const approval = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approval.ok(), await approval.text()).toBe(true);
    await expect
      .poll(async () => (await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }))).partsConfirmed)
      .toBe(true);
    // 3.4: a personal guest link alone never confers creator permissions.
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    const noGuestFinalization = await trpcMutation(page.request, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect((await trpcError(noGuestFinalization))?.data?.code).toBe('UNAUTHORIZED');

    // Any further claim change invalidates even a previously approved receipt.
    const modified = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 6,
    });
    expect(modified.ok(), await modified.text()).toBe(true);
    await expect
      .poll(async () => (await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }))).partsConfirmed)
      .toBe(false);
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0, { timeout: 15_000 });
    const staleFinish = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(staleFinish.ok()).toBe(false);
    const stillClaiming = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stillClaiming.status).toBe('CLAIMING');
    const restore = await trpcMutation(second.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 5,
    });
    expect(restore.ok(), await restore.text()).toBe(true);
    await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 8', {
      timeout: 15_000,
    });
    const approvedAgain = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approvedAgain.ok(), await approvedAgain.text()).toBe(true);
    const finish = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
    });
    expect(finish.ok(), await finish.text()).toBe(true);
    const result = await trpcResult(await trpcQuery(owner, 'guest.getSplit', { token }));
    expect(result.receiptData.total).toBe(1001);
    expect(result.items.map((entry: { totalPrice: number }) => entry.totalPrice)).toEqual([800, 201]);
    expect(result.summary.map((entry: { itemTotal: number }) => entry.itemTotal)).toEqual([300, 701]);
    expect(result.summary.reduce((sum: number, entry: { total: number }) => sum + entry.total, 0)).toBe(1001);
    expect(result.summary.every((entry: { tip: number }) => entry.tip === 0)).toBe(true);
  } finally {
    await second.close();
    await owner.dispose();
  }
});

test('Issue 3.3: guest joins by name without account or email, shares a dish and cannot create bills', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  try {
    const create = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Общий чек 3.3',
        subtotal: 1001,
        tax: 0,
        tip: 0,
        total: 1001,
        currency: 'RUB',
      },
      items: [
        { name: 'Общая пицца', quantity: 1, unitPrice: 800, totalPrice: 800 },
        { name: 'Личный чай', quantity: 1, unitPrice: 201, totalPrice: 201 },
      ],
      creatorName: 'Анна',
      paidByName: 'Анна',
      joinCreator: true,
    });
    const createdBody = await create.text();
    expect(create.ok(), createdBody).toBe(true);
    const created = JSON.parse(createdBody).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    const token = created.shareToken;

    // The registered creator already has a portion of the *same* pizza.
    const creatorClaim = await trpcMutation(owner, 'guest.claimItems', {
      token,
      personId: created.creator.personId,
      personToken: created.creator.personToken,
      claimedItemIndices: [0],
    });
    expect(creatorClaim.ok(), await creatorClaim.text()).toBe(true);

    // This browser has no session, email or registration form.
    const authBefore = await trpcResult(await trpcQuery(page.request, 'auth.getSession'));
    expect(authBefore?.user?.id).toBeFalsy();
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await expect(page.locator('input[type=email]')).toHaveCount(0);
    await page.getByTestId('claim-name-input').fill('Борис');
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByTestId('claim-item-0')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('claim-item-1')).toBeVisible();
    await expect(page.getByTestId('claim-join-form')).toHaveCount(0);

    // The guest may claim an already selected *shared* dish and their own tea.
    await page.getByTestId('claim-item-0').click();
    await page.getByTestId('claim-item-1').click();
    await expect(page.getByTestId('save-claims-btn')).toBeEnabled();
    await page.getByTestId('save-claims-btn').click();
    await expect
      .poll(
        async () => {
          const state = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
          return state.assignments
            .map((a: { itemIndex: number; personIndices: number[] }) => ({
              itemIndex: a.itemIndex,
              personIndices: [...a.personIndices].sort((a, b) => a - b),
            }))
            .sort((a: { itemIndex: number }, b: { itemIndex: number }) => a.itemIndex - b.itemIndex);
        },
        { timeout: 15_000 },
      )
      .toEqual([
        { itemIndex: 0, personIndices: [0, 1] },
        { itemIndex: 1, personIndices: [1] },
      ]);
    await expect(page.getByTestId('person-total-0')).toContainText('4,00', { timeout: 15_000 });
    await expect(page.getByTestId('person-total-1')).toContainText('6,01', { timeout: 15_000 });
    await expect(page.getByTestId('guest-parts-preliminary')).toBeVisible();
    for (const width of [320, 360, 393, 412, 720]) {
      await page.setViewportSize({ width, height: 520 });
      const personalResult = page.getByTestId('person-total-1');
      await personalResult.scrollIntoViewIfNeeded();
      const rect = await personalResult.boundingBox();
      expect(rect, 'Guest result at ' + width).not.toBeNull();
      expect(rect!.x, 'Guest result left at ' + width).toBeGreaterThanOrEqual(-1);
      expect(rect!.x + rect!.width, 'Guest result right at ' + width).toBeLessThanOrEqual(width + 1);
      await fitsPhone(page);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-join-form')).toHaveCount(0);
    await expect(page.getByTestId('person-total-1')).toContainText('6,01', { timeout: 15_000 });
    const authAfter = await trpcResult(await trpcQuery(page.request, 'auth.getSession'));
    expect(authAfter?.user?.id).toBeFalsy();

    // The guest token grants only access to this claim; it never turns an
    // anonymous browser into an authenticated receipt/group creator.
    for (const [proc, input] of [
      [
        'guest.createClaimSession',
        {
          receiptData: { subtotal: 100, total: 100, tax: 0, tip: 0, currency: 'RUB' },
          items: [{ name: 'Чай', quantity: 1, unitPrice: 100, totalPrice: 100 }],
          creatorName: 'Борис',
          paidByName: 'Борис',
        },
      ],
      [
        'guest.createSplit',
        {
          receiptData: { subtotal: 100, total: 100, tax: 0, tip: 0, currency: 'RUB' },
          items: [{ name: 'Чай', quantity: 1, unitPrice: 100, totalPrice: 100 }],
          people: [{ name: 'Борис' }],
          assignments: [{ itemIndex: 0, personIndices: [0] }],
        },
      ],
      ['groups.create', { name: 'Недоступная группа' }],
      ['receipts.createManual', { groupId: 'not-a-member' }],
    ] as const) {
      const denied = await trpcMutation(page.request, proc, input);
      const error = await trpcError(denied);
      expect(error?.data?.code, proc).toBe('UNAUTHORIZED');
    }
  } finally {
    await owner.dispose();
  }
});

test('Issue 3.11: account binding, not guest token or name, controls mobile Registered vs Guest labels', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  const registeredGuest = await authedContext(users.bob.email, users.bob.password);
  let token: string | undefined;
  try {
    const created = await trpcMutation(creator, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Проверка 3.11',
        subtotal: 2000,
        tax: 0,
        tip: 0,
        total: 2000,
        currency: 'RUB',
      },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
      guestCount: 2,
      joinCreator: true,
    });
    expect(created.ok(), await created.text()).toBe(true);
    token = (JSON.parse(await created.text()).result.data.json as { shareToken: string }).shareToken;
    const initial = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(initial.people.map((p: { isRegistered: boolean }) => p.isRegistered)).toEqual([true, false, false]);
    expect(initial.people[0].name).toBe(users.alice.name);

    // Possessing a valid personal bearer credential without an account is
    // NOT equivalent to a confirmed server-side registration.
    const joinedAnonymous = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Гость с токеном',
    });
    expect(joinedAnonymous.ok(), await joinedAnonymous.text()).toBe(true);
    const anonymousToken = (
      JSON.parse(await joinedAnonymous.text()).result.data.json as {
        personToken: string;
      }
    ).personToken;
    expect(anonymousToken).toBeTruthy();

    const joinedRegistered = await trpcMutation(registeredGuest, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[2].id,
      name: 'Борис',
    });
    expect(joinedRegistered.ok(), await joinedRegistered.text()).toBe(true);

    const serverView = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
    expect(serverView.people.map((p: { isRegistered: boolean }) => p.isRegistered)).toEqual([true, false, true]);
    expect(serverView.people.map((p: { hasJoined: boolean }) => p.hasJoined)).toEqual([true, true, true]);
    expect(JSON.stringify(serverView)).not.toContain(anonymousToken);
    expect(JSON.stringify(serverView)).not.toContain('accountUserId');

    await page.goto('/split/' + token + '/claim');
    const creatorRow = page.getByTestId('invited-person-0');
    const anonymousRow = page.getByTestId('invited-person-1');
    const registeredRow = page.getByTestId('invited-person-2');
    await expect(creatorRow.getByTestId('account-status-registered')).toContainText('Зарегистрирован', {
      timeout: 20_000,
    });
    await expect(creatorRow.getByTestId('receipt-role-creator')).toContainText('Создатель');
    await expect(creatorRow.getByTestId('receipt-role-payer')).toContainText('Плательщик');
    await expect(anonymousRow.getByTestId('account-status-guest')).toContainText('Гость');
    await expect(anonymousRow.getByTestId('receipt-roles')).toHaveCount(0);
    await expect(registeredRow.getByTestId('account-status-registered')).toContainText('Зарегистрирован');
    await expect(registeredRow.getByTestId('receipt-roles')).toHaveCount(0);
    // A creator can change a guest's label, but cannot change their account
    // binding or copy registration status from the new name.
    const rename = await trpcMutation(creator, 'guest.editPersonName', {
      token,
      targetId: initial.people[1].id,
      newName: 'Борис Незарегистрированный',
    });
    expect(rename.ok(), await rename.text()).toBe(true);
    await expect(anonymousRow).toContainText('Борис Незарегистрированный', { timeout: 15_000 });
    await expect(anonymousRow.getByTestId('account-status-guest')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('invited-person-1').getByTestId('account-status-guest')).toBeVisible();
    await expect(page.getByTestId('invited-person-2').getByTestId('account-status-registered')).toBeVisible();
    for (const width of [320, 412, 720]) {
      await page.setViewportSize({ width, height: 740 });
      await fitsPhone(page);
    }
    const final = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(final.people.map((p: { id: string }) => p.id)).toEqual(initial.people.map((p: { id: string }) => p.id));
    expect(final.people.map((p: { isRegistered: boolean }) => p.isRegistered)).toEqual([true, false, true]);
  } finally {
    if (token) await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    await registeredGuest.dispose();
    await creator.dispose();
  }
});

test('Issue 3.10: receipt creator and the one payer have independent visible roles on mobile', async ({ page }) => {
  test.setTimeout(150_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  const receipts: string[] = [];
  try {
    for (const paidByGuestSlot of [0, 2]) {
      const created = await trpcMutation(creator, 'guest.createClaimSession', {
        receiptData: {
          merchantName: 'Роли чека',
          subtotal: 2000,
          total: 2000,
          tax: 0,
          tip: 0,
          currency: 'RUB',
        },
        items: [{ name: 'Сок', quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
        guestCount: 2,
        ...(paidByGuestSlot ? { paidByGuestSlot } : {}),
        joinCreator: true,
      });
      expect(created.ok(), await created.text()).toBe(true);
      const token = (JSON.parse(await created.text()).result.data.json as { shareToken: string }).shareToken;
      receipts.push(token);
      const session = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
      expect(session.people).toHaveLength(3);
      expect(session.receiptData.organizerPersonId).toBe(session.people[0].id);
      expect(session.paidByIndex).toBe(paidByGuestSlot);
      await page.goto('/split/' + token + '/claim');
      const creatorRow = page.getByTestId('invited-person-0');
      const guestOneRow = page.getByTestId('invited-person-1');
      const guestTwoRow = page.getByTestId('invited-person-2');
      await expect(creatorRow.getByTestId('receipt-role-creator')).toContainText('Создатель');
      await expect(creatorRow.getByTestId('receipt-role-creator')).toContainText('👑');
      await expect(guestOneRow.getByTestId('receipt-roles')).toHaveCount(0);
      if (paidByGuestSlot === 0) {
        await expect(creatorRow.getByTestId('receipt-role-payer')).toContainText('💵');
        await expect(creatorRow.getByTestId('receipt-role-payer')).toContainText('Плательщик');
        await expect(guestTwoRow.getByTestId('receipt-roles')).toHaveCount(0);
      } else {
        await expect(creatorRow.getByTestId('receipt-role-payer')).toHaveCount(0);
        await expect(guestTwoRow.getByTestId('receipt-role-payer')).toContainText('Плательщик');
        await expect(guestTwoRow.getByTestId('receipt-role-payer')).toContainText('💵');
        await expect(page.getByTestId('guest-slot-option-2').getByTestId('receipt-role-payer')).toBeVisible();
      }
      await page.reload();
      await expect(page.getByTestId('invited-person-0').getByTestId('receipt-role-creator')).toBeVisible();
      for (const width of [320, 412, 720]) {
        await page.setViewportSize({ width, height: 730 });
        await fitsPhone(page);
      }
    }
  } finally {
    for (const token of receipts) {
      await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    }
    await creator.dispose();
  }
});

test('Issue 3.9: mobile participant color stays with the person after rename and reload', async ({ page }) => {
  test.setTimeout(120_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  let token: string | undefined;
  try {
    const created = await trpcMutation(creator, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Цвета гостей', subtotal: 1500, total: 1500, tax: 0, tip: 0, currency: 'RUB' },
      items: [{ name: 'Чай', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      guestCount: 2,
      joinCreator: true,
    });
    expect(created.ok(), await created.text()).toBe(true);
    token = (JSON.parse(await created.text()).result.data.json as { shareToken: string }).shareToken;
    const initial = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(initial.people.map((p: { visualColorId: number }) => p.visualColorId)).toEqual([0, 1, 2]);
    const targetId = initial.people[1].id as string;

    await page.goto('/login');
    await page.locator('input[type=email]').fill(users.alice.email);
    await page.locator('input[type=password]').fill(users.alice.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto('/split/' + token + '/claim');
    const colorOf = async (index: number) =>
      page.getByTestId('guest-color-person-' + index).evaluate((element) => getComputedStyle(element).borderLeftColor);
    await expect(page.getByTestId('guest-color-person-1')).toBeVisible({ timeout: 20_000 });
    const before = [await colorOf(0), await colorOf(1), await colorOf(2)];
    expect(new Set(before).size).toBe(3);

    const rename = await trpcMutation(creator, 'guest.editPersonName', {
      token,
      targetId,
      newName: 'Андрей П.',
    });
    expect(rename.ok(), await rename.text()).toBe(true);
    await expect(page.getByTestId('guest-color-person-1')).toContainText('Андрей П.', { timeout: 20_000 });
    expect(await colorOf(1)).toBe(before[1]);
    await page.reload();
    await expect(page.getByTestId('guest-color-person-1')).toContainText('Андрей П.', { timeout: 20_000 });
    expect([await colorOf(0), await colorOf(1), await colorOf(2)]).toEqual(before);
    for (const width of [320, 412, 720]) {
      await page.setViewportSize({ width, height: 720 });
      await fitsPhone(page);
    }
    const after = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(after.people.map((p: { id: string }) => p.id)).toEqual(initial.people.map((p: { id: string }) => p.id));
    expect(after.people.map((p: { visualColorId: number }) => p.visualColorId)).toEqual([0, 1, 2]);
  } finally {
    if (token) await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    await creator.dispose();
  }
});

test('Issue 3.8.3: a clean Android browser restores exactly one guest, saved dishes and tip', async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  const fresh = await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });
  const switching = await browser.newContext({ viewport: { width: 412, height: 760 }, isMobile: true, hasTouch: true });
  let token: string | undefined;
  try {
    const res = await trpcMutation(creator, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Восстановление гостя',
        subtotal: 2300,
        tax: 0,
        tip: 0,
        total: 2300,
        currency: 'RUB',
      },
      items: [{ name: 'Суп', quantity: 1, unitPrice: 2300, totalPrice: 2300 }],
      guestCount: 2,
      joinCreator: true,
    });
    expect(res.ok(), await res.text()).toBe(true);
    token = (JSON.parse(await res.text()).result.data.json as { shareToken: string }).shareToken;
    const initial = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    const guestId = initial.people[1].id as string;
    const secondId = initial.people[2].id as string;
    const joinedRes = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: guestId,
      name: 'Андрей',
    });
    expect(joinedRes.ok(), await joinedRes.text()).toBe(true);
    const joined = JSON.parse(await joinedRes.text()).result.data.json as {
      personId: string;
      personToken: string;
    };
    const secondRes = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: secondId,
      name: 'Сергей',
    });
    expect(secondRes.ok(), await secondRes.text()).toBe(true);
    const second = JSON.parse(await secondRes.text()).result.data.json as { personToken: string };

    const saved = await trpcMutation(page.request, 'guest.claimItems', {
      token,
      personId: guestId,
      personToken: joined.personToken,
      addItemIndices: [0],
      removeItemIndices: [],
      saveKey: '123e4567-e89b-42d3-a456-426614174083',
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const tipped = await trpcMutation(page.request, 'guest.setPersonalTip', {
      token,
      personId: guestId,
      personToken: joined.personToken,
      tipCents: 175,
    });
    expect(tipped.ok(), await tipped.text()).toBe(true);
    const before = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(before.people).toHaveLength(3);
    expect(before.people[1]).toMatchObject({ id: guestId, personalLinkReady: true, tipCents: 175 });
    expect(before.assignments).toEqual([{ itemIndex: 0, personIndices: [1], partsByPersonId: { [guestId]: 1 } }]);

    const secret = await trpcMutation(creator, 'guest.getGuestPersonalLink', { token, personId: guestId });
    expect(secret.ok(), await secret.text()).toBe(true);
    const recoveryToken = (JSON.parse(await secret.text()).result.data.json as { personToken: string }).personToken;
    expect(recoveryToken).toBe(joined.personToken);
    const cleanPage = await fresh.newPage();
    await cleanPage.goto('/split/' + token + '/claim#me=' + recoveryToken);
    expect(await cleanPage.evaluate((key) => localStorage.getItem(key), 'sharetab-claim:' + token)).toBeNull();
    await expect(cleanPage.getByTestId('personal-link-offer')).toContainText('Андрей', { timeout: 20_000 });
    await expect(cleanPage.getByTestId('personal-link-offer-replaces')).toHaveCount(0);
    await expect.poll(() => cleanPage.url()).not.toContain('#me=');
    await cleanPage.getByTestId('personal-link-accept').click();
    await expect(cleanPage.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
    const persisted = await cleanPage.evaluate((key) => localStorage.getItem(key), 'sharetab-claim:' + token);
    expect(persisted).toContain(recoveryToken);
    await expect(cleanPage.getByTestId('personal-tip-input')).toHaveValue(/1[.,]75/);
    await fitsPhone(cleanPage);

    // Closing and reopening a browser tab still uses the same saved identity.
    await cleanPage.close();
    const reopened = await fresh.newPage();
    await reopened.goto('/split/' + token + '/claim');
    await expect(reopened.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
    await expect(reopened.getByTestId('personal-link-offer')).toHaveCount(0);
    const after = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(after.people.map((p: { id: string }) => p.id)).toEqual(before.people.map((p: { id: string }) => p.id));
    expect(after.people[1]).toMatchObject({ id: guestId, tipCents: 175 });
    expect(after.assignments).toEqual(before.assignments);
    const illegal = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: guestId,
      name: 'Ещё один гость',
    });
    expect(illegal.ok()).toBe(false);
    expect((await trpcError(illegal))?.data?.code).toBe('CONFLICT');

    // If another person already uses this browser, the personal link must
    // never silently replace their local identity. They can decline or
    // explicitly accept switching, and both server person IDs stay intact.
    const switchPage = await switching.newPage();
    await switchPage.goto('/split/' + token + '/claim');
    await switchPage.evaluate(({ key, saved }) => localStorage.setItem(key, saved), {
      key: 'sharetab-claim:' + token,
      saved: JSON.stringify({ name: 'Сергей', personToken: second.personToken }),
    });
    await switchPage.goto('about:blank');
    await switchPage.goto('/split/' + token + '/claim#me=' + recoveryToken);
    await expect(switchPage.getByTestId('personal-link-offer-replaces')).toContainText('Сергей', {
      timeout: 20_000,
    });
    const originallyStored = await switchPage.evaluate((key) => localStorage.getItem(key), 'sharetab-claim:' + token);
    expect(originallyStored).toContain(second.personToken);
    await switchPage.getByTestId('personal-link-decline').click();
    await expect(switchPage.getByTestId('personal-link-offer')).toHaveCount(0);
    expect(await switchPage.evaluate((key) => localStorage.getItem(key), 'sharetab-claim:' + token)).toContain(
      second.personToken,
    );
    await switchPage.goto('/split/' + token + '/claim#me=' + recoveryToken);
    await expect(switchPage.getByTestId('personal-link-offer-replaces')).toContainText('Сергей', {
      timeout: 20_000,
    });
    await switchPage.getByTestId('personal-link-accept').click();
    await expect(switchPage.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
    expect(await switchPage.evaluate((key) => localStorage.getItem(key), 'sharetab-claim:' + token)).toContain(
      recoveryToken,
    );
    await fitsPhone(switchPage);

    // Another participant's token remains bound to their separate person ID.
    const secondResume = await trpcMutation(page.request, 'guest.resumeSession', {
      token,
      personToken: second.personToken,
    });
    expect(secondResume.ok(), await secondResume.text()).toBe(true);
    expect((JSON.parse(await secondResume.text()).result.data.json as { personId: string }).personId).toBe(secondId);
  } finally {
    if (token) await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    await fresh.close();
    await switching.close();
    await creator.dispose();
  }
});

test('Issue 3.8.3: mobile recovery survives first-load outage and failed personal-link lookup', async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  const clean = await browser.newContext({ viewport: { width: 360, height: 720 }, isMobile: true, hasTouch: true });
  let token: string | undefined;
  try {
    const res = await trpcMutation(creator, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Сетевая ошибка', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'RUB' },
      items: [{ name: 'Чай', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      guestCount: 1,
      joinCreator: true,
    });
    expect(res.ok(), await res.text()).toBe(true);
    token = (JSON.parse(await res.text()).result.data.json as { shareToken: string }).shareToken;
    const info = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    const id = info.people[1].id as string;
    const joinedRes = await trpcMutation(page.request, 'guest.joinGuestSlot', { token, slotId: id, name: 'Олег' });
    expect(joinedRes.ok(), await joinedRes.text()).toBe(true);
    const joined = JSON.parse(await joinedRes.text()).result.data.json as { personToken: string };
    const saved = await trpcMutation(page.request, 'guest.editPersonName', {
      token,
      targetId: id,
      personToken: joined.personToken,
      newName: 'Олег П.',
    });
    expect(saved.ok(), await saved.text()).toBe(true);

    const guest = await clean.newPage();
    const failsSession = (url: URL) => url.pathname.includes('guest.getSession');
    const failsResume = (url: URL) => url.pathname.includes('guest.resumeSession');
    await guest.route(failsSession, (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }));
    await guest.goto('/split/' + token + '/claim#me=' + joined.personToken);
    await expect(guest.getByTestId('claim-network-retry')).toBeVisible({ timeout: 30_000 });
    await expect(guest.getByTestId('claim-retry-load')).toBeVisible();
    expect(guest.url()).toContain('#me=' + joined.personToken);
    await guest.unroute(failsSession);
    await guest.route(failsResume, (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }));
    await guest.getByTestId('claim-retry-load').click();
    await expect(guest.getByTestId('personal-link-retry')).toBeVisible({ timeout: 30_000 });
    expect(guest.url()).toContain('#me=' + joined.personToken);
    await guest.unroute(failsResume);
    await guest.getByTestId('personal-link-retry-btn').click();
    await expect(guest.getByTestId('personal-link-offer')).toContainText('Олег П.', { timeout: 20_000 });
    await guest.getByTestId('personal-link-accept').click();
    await expect(guest.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
    await fitsPhone(guest);
    const after = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(after.people).toHaveLength(2);
    expect(after.people[1]).toMatchObject({ id, name: 'Олег П.' });
  } finally {
    if (token) await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    await clean.close();
    await creator.dispose();
  }
});

test('Issue 3.8.2: only a receipt creator can reveal and copy a saved guest link on mobile', async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  const creatorBrowser = await browser.newContext({
    viewport: { width: 320, height: 740 },
    isMobile: true,
    hasTouch: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  let token: string | undefined;
  try {
    const response = await trpcMutation(creator, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Личная ссылка гостя', subtotal: 900, tax: 0, tip: 0, total: 900, currency: 'RUB' },
      items: [{ name: 'Чай', quantity: 1, unitPrice: 900, totalPrice: 900 }],
      guestCount: 1,
      joinCreator: true,
    });
    expect(response.ok(), await response.text()).toBe(true);
    token = (JSON.parse(await response.text()).result.data.json as { shareToken: string }).shareToken;
    const initial = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    const guestId = initial.people[1].id as string;
    const guestJoined = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: guestId,
      name: 'Андрей',
    });
    expect(guestJoined.ok(), await guestJoined.text()).toBe(true);
    const joined = JSON.parse(await guestJoined.text()).result.data.json as { personToken: string; personId: string };
    expect(joined.personId).toBe(guestId);

    const tooEarly = await trpcMutation(creator, 'guest.getGuestPersonalLink', { token, personId: guestId });
    expect(tooEarly.ok()).toBe(false);
    expect((await trpcError(tooEarly))?.data?.code).toBe('PRECONDITION_FAILED');
    const anonymous = await trpcMutation(page.request, 'guest.getGuestPersonalLink', { token, personId: guestId });
    expect(anonymous.ok()).toBe(false);
    expect((await trpcError(anonymous))?.data?.code).toBe('UNAUTHORIZED');

    const selfSave = await trpcMutation(page.request, 'guest.editPersonName', {
      token,
      targetId: guestId,
      personToken: joined.personToken,
      newName: 'Андрей П.',
    });
    expect(selfSave.ok(), await selfSave.text()).toBe(true);
    const after = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(after.people[1]).toMatchObject({ id: guestId, personalLinkReady: true, name: 'Андрей П.' });
    expect(JSON.stringify(after)).not.toContain(joined.personToken);

    const ownerPage = await creatorBrowser.newPage();
    await ownerPage.goto('/login');
    await ownerPage.locator('input[type=email]').fill(users.alice.email);
    await ownerPage.locator('input[type=password]').fill(users.alice.password);
    await ownerPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/dashboard/);
    await ownerPage.goto('/split/' + token + '/claim');
    await expect(ownerPage.getByTestId('creator-guest-link-open-1')).toBeVisible({ timeout: 20_000 });
    await ownerPage.getByTestId('creator-guest-link-open-1').click();
    const revealed = ownerPage.getByTestId('creator-guest-link-url-1');
    await expect(revealed).toBeVisible();
    const personalUrl = await revealed.inputValue();
    expect(personalUrl).toContain('/split/' + token + '/claim#me=');
    expect(personalUrl).toContain(joined.personToken);
    await ownerPage.getByTestId('creator-guest-link-copy-1').click();
    await expect(ownerPage.getByText('Персональная ссылка гостя скопирована.')).toBeVisible();
    expect(await ownerPage.evaluate(() => navigator.clipboard.readText())).toBe(personalUrl);
    await fitsPhone(ownerPage);
  } finally {
    if (token) await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    await creatorBrowser.close();
    await creator.dispose();
  }
});

test('Issue 3.7.3: mobile invite flow creates N+1 seats and guests select distinct available slots', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const guestContext = await browser.newContext({
    viewport: { width: 320, height: 730 },
    isMobile: true,
    hasTouch: true,
  });
  const secondContext = await browser.newContext({
    viewport: { width: 720, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    await page.goto('/login');
    await page.locator('input[type=email]').fill(users.alice.email);
    await page.locator('input[type=password]').fill(users.alice.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto('/split');
    await expect(page.getByTestId('guest-count-form')).toBeVisible();
    await expect(page.getByTestId('person-input-0')).toHaveCount(0);
    await expect(page.getByTestId('invite-creator-name')).toContainText(users.alice.name);
    await page.getByTestId('guest-count-input').fill('2');
    await page.getByTestId('invite-payer').selectOption('2');
    await page.getByTestId('manual-receipt-name').fill('Ужин с друзьями');
    await fitsPhone(page);
    await page.getByTestId('next-assign-btn').click();
    await page.getByTestId('guest-add-item-btn').click();
    const fields = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form').locator('input');
    await fields.nth(0).fill('Пицца');
    await fields.nth(1).fill('1');
    await fields.nth(2).fill('240,00');
    await page.getByTestId('guest-add-item-submit').click();
    await page.getByTestId('share-for-claiming-btn').click();
    await expect(page).toHaveURL(/\/split\/[^/]+\/claim/);
    token = page.url().split('/split/')[1]?.split('/claim')[0];
    expect(token).toBeTruthy();
    const initial = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
    expect(initial.people.map((p: { hasJoined: boolean }) => p.hasJoined)).toEqual([true, false, false]);
    expect(initial.paidByIndex).toBe(2);
    expect(initial.receiptData.total).toBe(24000);
    const guest = await guestContext.newPage();
    await guest.goto('/split/' + token + '/claim');
    await expect(guest.getByTestId('guest-slot-option-1')).toBeVisible();
    await expect(guest.getByTestId('guest-slot-option-2')).toBeVisible();
    await expect(guest.getByTestId('claim-join-btn')).toBeDisabled();
    await guest.getByTestId('guest-slot-option-1').click();
    await guest.getByTestId('claim-name-input').fill('Андрей');
    await guest.getByTestId('claim-join-btn').click();
    await expect(guest.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 15000 });
    await fitsPhone(guest);
    const after = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
    expect(after.people).toHaveLength(3);
    expect(after.people[1].name).toBe('Андрей');
    expect(after.people[1].id).toBe(initial.people[1].id);
    expect(after.people[2].hasJoined).toBe(false);
    expect(after.paidByIndex).toBe(2);

    const second = await secondContext.newPage();
    await second.goto('/split/' + token + '/claim');
    await expect(second.getByTestId('guest-slot-option-1')).toBeDisabled();
    await second.getByTestId('guest-slot-option-2').click();
    await second.getByTestId('claim-name-input').fill('Сергей');
    await second.getByTestId('claim-join-btn').click();
    await expect(second.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 15000 });
    await fitsPhone(second);
    const complete = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
    expect(complete.people.map((p: { name: string }) => p.name)).toEqual([users.alice.name, 'Андрей', 'Сергей']);
    expect(complete.people.map((p: { id: string }) => p.id)).toEqual(initial.people.map((p: { id: string }) => p.id));
    expect(complete.people.every((p: { hasJoined: boolean }) => p.hasJoined)).toBe(true);
    expect(complete.paidByIndex).toBe(2);
    expect(complete.receiptData.total).toBe(24000);
    for (const width of [320, 412, 720]) {
      await page.setViewportSize({ width, height: 720 });
      await fitsPhone(page);
    }
  } finally {
    if (token) await trpcMutation(page.request, 'guest.expireSession', { token }).catch(() => undefined);
    await guestContext.close();
    await secondContext.close();
  }
});

test('Issue 3.7.2: parallel devices reserve one fixed guest slot once; others keep their places', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const creator = await authedContext(users.alice.email, users.alice.password);
  const other = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  let token: string | undefined;
  try {
    const createdRes = await trpcMutation(creator, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Места 3.7.2', subtotal: 1201, tax: 0, tip: 0, total: 1201, currency: 'RUB' },
      items: [{ name: 'Суп', quantity: 1, unitPrice: 1201, totalPrice: 1201 }],
      guestCount: 2,
      paidByGuestSlot: 2,
      joinCreator: true,
    });
    const createdText = await createdRes.text();
    expect(createdRes.ok(), createdText).toBe(true);
    const created = JSON.parse(createdText).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string };
    };
    token = created.shareToken;

    const before = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(before.people).toHaveLength(3);
    expect(before.people.map((person: { guestSlotNumber?: number }) => person.guestSlotNumber)).toEqual([
      undefined,
      1,
      2,
    ]);
    expect(before.people.map((person: { hasJoined: boolean }) => person.hasJoined)).toEqual([true, false, false]);
    expect(before.receiptData.total).toBe(1201);
    expect(before.paidByIndex).toBe(2);
    expect(before.people[0].id).toBe(created.creator.personId);
    const slot1 = before.people[1].id as string;
    const slot2 = before.people[2].id as string;

    const proposals = [
      { ctx: page.request, name: 'Андрей', key: '123e4567-e89b-42d3-a456-426614174001' },
      { ctx: other.request, name: 'Борис', key: '123e4567-e89b-42d3-a456-426614174002' },
    ];
    const attempts = await Promise.all(
      proposals.map((entry) =>
        trpcMutation(entry.ctx, 'guest.joinGuestSlot', {
          token,
          slotId: slot1,
          name: entry.name,
          joinKey: entry.key,
        }),
      ),
    );
    const successes = attempts.map((result, index) => (result.ok() ? index : -1)).filter((index) => index >= 0);
    expect(successes).toHaveLength(1);
    const winner = successes[0]!;
    const loser = 1 - winner;
    const refused = await trpcError(attempts[loser]!);
    expect(refused?.data?.code).toBe('CONFLICT');

    const winnerJoined = JSON.parse(await attempts[winner]!.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    expect(winnerJoined.personId).toBe(slot1);
    expect(winnerJoined.name).toBe(proposals[winner]!.name);
    expect(winnerJoined.personToken).toMatch(/^[0-9a-f-]{36}$/);

    // Losing the competition for Guest 1 does not block Guest 2.
    const loserRes = await trpcMutation(proposals[loser]!.ctx, 'guest.joinGuestSlot', {
      token,
      slotId: slot2,
      name: proposals[loser]!.name,
    });
    expect(loserRes.ok(), await loserRes.text()).toBe(true);
    const loserJoined = JSON.parse(await loserRes.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    expect(loserJoined.personId).toBe(slot2);

    // A returning guest retains the first personId even when choosing a
    // different slot in the request (the bearer cannot create a second row).
    const repeatedRes = await trpcMutation(proposals[winner]!.ctx, 'guest.joinGuestSlot', {
      token,
      slotId: slot2,
      name: 'Другое',
      personToken: winnerJoined.personToken,
    });
    expect(repeatedRes.ok(), await repeatedRes.text()).toBe(true);
    const repeated = JSON.parse(await repeatedRes.text()).result.data.json;
    expect(repeated.personId).toBe(slot1);
    expect(repeated.personToken).toBe(winnerJoined.personToken);

    // The creator already owns the creator row by account id and must not
    // accidentally occupy another guest slot while opening the shared link.
    const creatorRes = await trpcMutation(creator, 'guest.joinGuestSlot', {
      token,
      slotId: slot1,
      name: 'Случайное имя',
    });
    expect(creatorRes.ok(), await creatorRes.text()).toBe(true);
    expect(JSON.parse(await creatorRes.text()).result.data.json.personId).toBe(created.creator.personId);

    const after = await trpcResult(await trpcQuery(creator, 'guest.getSession', { token }));
    expect(after.people).toHaveLength(3);
    expect(after.people.map((person: { id: string }) => person.id)).toEqual(
      before.people.map((person: { id: string }) => person.id),
    );
    expect(after.people.map((person: { hasJoined: boolean }) => person.hasJoined)).toEqual([true, true, true]);
    expect(after.people[1].name).toBe(winnerJoined.name);
    expect(after.people[2].name).toBe(loserJoined.name);
    expect(after.receiptData.total).toBe(1201);
    expect(after.paidByIndex).toBe(2);
    expect(JSON.stringify(after.people)).not.toContain('personToken');
    expect(JSON.stringify(after.people)).not.toContain('accountUserId');

    const legacy = await trpcMutation(page.request, 'guest.joinSession', { token, name: 'Лишний' });
    expect(legacy.ok()).toBe(false);
    expect((await trpcError(legacy))?.data?.code).toBe('BAD_REQUEST');
  } finally {
    if (token) await trpcMutation(creator, 'guest.expireSession', { token }).catch(() => undefined);
    await other.close();
    await creator.dispose();
  }
});

test('Issue 3.6.2: creator renames unjoined guests on mobile; guests can edit only themselves', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const ownerBrowser = await browser.newContext({
    viewport: { width: 320, height: 700 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const createdRes = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Имена 3.6.2', subtotal: 1001, tax: 0, tip: 0, total: 1001, currency: 'RUB' },
      items: [{ name: 'Чай', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      people: ['Создатель', 'Гость 1', 'Гость 2'],
      creatorName: 'Создатель',
      paidByName: 'Создатель',
      // Do not join the creator's personal place: the account alone must
      // allow fixing guest names even when nobody else uses BillOK.
      joinCreator: false,
    });
    const raw = await createdRes.text();
    expect(createdRes.ok(), raw).toBe(true);
    token = (JSON.parse(raw).result.data.json as { shareToken: string }).shareToken;
    const before = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const guestId = before.people[1].id as string;

    const ownerPage = await ownerBrowser.newPage();
    await ownerPage.goto('/login', { waitUntil: 'networkidle' });
    await ownerPage.locator('input[type=email]').fill(users.alice.email);
    await ownerPage.locator('input[type=password]').fill(users.alice.password);
    await ownerPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/dashboard/);
    await ownerPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(ownerPage.getByTestId('claim-join-form')).toBeVisible();
    await expect(ownerPage.getByTestId('creator-edit-person-1')).toBeVisible();
    await ownerPage.getByTestId('creator-edit-person-1').click();
    await ownerPage.getByTestId('creator-edit-name-input-1').fill('Андрей');
    await ownerPage.getByTestId('creator-save-name-1').click();
    await expect(ownerPage.getByTestId('creator-edit-person-1')).toBeVisible();
    await expect(ownerPage.getByText('Андрей', { exact: true }).first()).toBeVisible();
    await ownerPage.getByTestId('creator-edit-person-1').click();
    await ownerPage.getByTestId('creator-edit-name-input-1').fill('Андрей П.');
    await ownerPage.getByTestId('creator-save-name-1').click();
    await expect(ownerPage.getByText('Андрей П.', { exact: true }).first()).toBeVisible();
    await fitsPhone(ownerPage);

    const after = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(after.people[1]).toMatchObject({ id: guestId, name: 'Андрей П.', hasJoined: false });
    expect(after.assignments).toEqual(before.assignments);
    expect(after.receiptData.total).toBe(1001);

    // The shared link never grants permission to rename anyone.
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('creator-edit-person-1')).toHaveCount(0);
    const denied = await trpcMutation(page.request, 'guest.editPersonName', {
      token,
      targetId: guestId,
      newName: 'Чужое',
    });
    expect(denied.ok()).toBe(false);
    expect((await trpcError(denied))?.data?.code).toBe('FORBIDDEN');

    const joined = await joinGuestSession(page.request, { token, name: 'Андрей П.' });
    expect(joined.personId).toBe(guestId);
    await rememberClaimIdentity(page.context(), token, { name: joined.name, personToken: joined.personToken });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-join-form')).toHaveCount(0);
    await expect(page.getByTestId('edit-person-0')).toHaveCount(0);
    await expect(page.getByTestId('edit-person-1')).toBeVisible();

    // Creator can still correct the claimed guest's name. The guest keeps
    // their personId/token and sees the update without refreshing.
    await ownerPage.getByTestId('creator-edit-person-1').click();
    await ownerPage.getByTestId('creator-edit-name-input-1').fill('Андрей Иванов');
    await ownerPage.getByTestId('creator-save-name-1').click();
    await expect(ownerPage.getByText('Андрей Иванов', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Ваше имя в этом чеке изменено: Андрей Иванов')).toBeVisible({ timeout: 25_000 });
    const finalState = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(finalState.people[1]).toMatchObject({ id: guestId, name: 'Андрей Иванов', hasJoined: true });
    expect(finalState.assignments).toEqual(before.assignments);
    await fitsPhone(page);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await ownerBrowser.close();
    await owner.dispose();
  }
});

test('Issue 3.6: simultaneous mobile guests cannot claim the same Unicode-normalized receipt name', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const second = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const duplicateCreation = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Имена 3.6', subtotal: 1001, tax: 0, tip: 0, total: 1001, currency: 'RUB' },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      people: ['Анна', ' Алексей ', 'алексей'],
      creatorName: 'Анна',
      paidByName: 'Анна',
    });
    expect(duplicateCreation.ok()).toBe(false);
    expect((await trpcError(duplicateCreation))?.data?.messageKey).toBe('nameTaken');

    const createdRes = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Имена 3.6', subtotal: 1001, tax: 0, tip: 0, total: 1001, currency: 'RUB' },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      people: ['Анна', 'Алексей', 'Иван'],
      creatorName: 'Анна',
      paidByName: 'Анна',
      joinCreator: true,
    });
    const raw = await createdRes.text();
    expect(createdRes.ok(), raw).toBe(true);
    const created = JSON.parse(raw).result.data.json as { shareToken: string };
    token = created.shareToken;

    // Two independent devices race to occupy the *same* pre-seeded person.
    // The single GuestSplit-row transaction must grant one token, not two.
    const attempts = await Promise.all([
      trpcMutation(page.request, 'guest.joinSession', { token, name: ' Алексей ' }),
      trpcMutation(second.request, 'guest.joinSession', { token, name: 'алексей' }),
    ]);
    expect(attempts.filter((response) => response.ok())).toHaveLength(1);
    const denied = attempts.find((response) => !response.ok())!;
    expect((await trpcError(denied))?.data?.messageKey).toBe('joinNameTaken');

    const joinIvan = await trpcMutation(second.request, 'guest.joinSession', { token, name: 'Иван' });
    const ivanRaw = await joinIvan.text();
    expect(joinIvan.ok(), ivanRaw).toBe(true);
    const ivan = JSON.parse(ivanRaw).result.data.json as { personId: string; personToken: string };

    const renameCollision = await trpcMutation(second.request, 'guest.editPersonName', {
      token,
      targetId: ivan.personId,
      personToken: ivan.personToken,
      newName: ' аЛЕксЕЙ ',
    });
    expect(renameCollision.ok()).toBe(false);
    expect((await trpcError(renameCollision))?.data?.messageKey).toBe('nameTaken');

    const data = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(data.people.map((person: { name: string }) => person.name)).toEqual(['Анна', 'Алексей', 'Иван']);
    expect(
      data.people.filter(
        (person: { name: string; hasJoined: boolean }) => person.name === 'Алексей' && person.hasJoined,
      ),
    ).toHaveLength(1);
    expect(data.receiptData.total).toBe(1001);

    // A longer qualifying name is distinct and may be assigned in this receipt.
    const renamed = await trpcMutation(second.request, 'guest.editPersonName', {
      token,
      targetId: ivan.personId,
      personToken: ivan.personToken,
      newName: 'Алексей П.',
    });
    expect(renamed.ok(), await renamed.text()).toBe(true);
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Алексей П.').first()).toBeVisible({ timeout: 15_000 });
    await fitsPhone(page);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await second.close();
    await owner.dispose();
  }
});

test('Issue 3.12: two guest devices count as one; joins, name changes and roles update without reload', async ({
  page,
  browser,
}) => {
  test.setTimeout(175_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const creatorDevice = await browser.newContext({
    viewport: { width: 320, height: 700 },
    isMobile: true,
    hasTouch: true,
  });
  const secondGuestDevice = await browser.newContext({
    viewport: { width: 360, height: 700 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const createdRes = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Синхронизация 3.12',
        subtotal: 2500,
        total: 2500,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [{ name: 'Блюдо', quantity: 1, unitPrice: 2500, totalPrice: 2500 }],
      guestCount: 2,
      paidByGuestSlot: 2,
      joinCreator: true,
    });
    expect(createdRes.ok(), await createdRes.text()).toBe(true);
    const created = JSON.parse(await createdRes.text()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const firstId = initial.people[1].id as string;
    const secondId = initial.people[2].id as string;
    expect(initial.paidByIndex).toBe(2);

    const ownerPage = await creatorDevice.newPage();
    await ownerPage.goto('/login');
    await ownerPage.locator('input[type=email]').fill(users.alice.email);
    await ownerPage.locator('input[type=password]').fill(users.alice.password);
    await ownerPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/dashboard/);
    await rememberClaimIdentity(creatorDevice, token, created.creator);
    await ownerPage.goto('/split/' + token + '/claim');
    const counters = ownerPage.getByTestId('organizer-presence-counters');
    await expect(counters).toBeVisible({ timeout: 20_000 });
    const count = (name: string) => counters.getByTestId('presence-count-' + name + '-value');
    await expect(count('invited')).toHaveText('2');
    await expect(count('waiting')).toHaveText('2');
    await expect(count('joined')).toHaveText('0');
    await expect(count('online')).toHaveText('0');
    await expect(ownerPage.getByTestId('guest-color-person-2').getByTestId('receipt-role-payer')).toContainText(
      'Плательщик',
    );

    const joinOne = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: firstId,
      name: 'Борис',
    });
    expect(joinOne.ok(), await joinOne.text()).toBe(true);
    const first = JSON.parse(await joinOne.text()).result.data.json as {
      name: string;
      personToken: string;
      personId: string;
    };
    expect(first.personId).toBe(firstId);
    await expect(count('waiting')).toHaveText('1', { timeout: 25_000 });
    await expect(count('joined')).toHaveText('1', { timeout: 25_000 });
    await expect(ownerPage.getByTestId('presence-person-' + firstId)).toContainText('Борис');

    await rememberClaimIdentity(page.context(), token, first);
    await rememberClaimIdentity(secondGuestDevice, token, first);
    await page.goto('/split/' + token + '/claim');
    const otherGuestPage = await secondGuestDevice.newPage();
    await otherGuestPage.goto('/split/' + token + '/claim');
    await expect(page.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
    await expect(otherGuestPage.getByTestId('claim-join-form')).toHaveCount(0, { timeout: 20_000 });
    await expect(count('online')).toHaveText('1', { timeout: 25_000 });
    // Both browsers have separate device heartbeats but one immutable personId.
    await expect(count('joined')).toHaveText('1');
    await expect(count('invited')).toHaveText('2');

    const rename = await trpcMutation(owner, 'guest.editPersonName', {
      token,
      targetId: firstId,
      newName: 'Борис П.',
    });
    expect(rename.ok(), await rename.text()).toBe(true);
    await expect(ownerPage.getByTestId('presence-person-' + firstId)).toContainText('Борис П.', {
      timeout: 25_000,
    });
    await expect(page.getByText('Борис П.').first()).toBeVisible({ timeout: 25_000 });
    await expect(otherGuestPage.getByText('Борис П.').first()).toBeVisible({ timeout: 25_000 });

    const joinTwo = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: secondId,
      name: 'Сергей',
    });
    expect(joinTwo.ok(), await joinTwo.text()).toBe(true);
    await expect(count('invited')).toHaveText('2', { timeout: 25_000 });
    await expect(count('waiting')).toHaveText('0', { timeout: 25_000 });
    await expect(count('joined')).toHaveText('2', { timeout: 25_000 });
    await expect(count('online')).toHaveText('1', { timeout: 25_000 });
    await expect(ownerPage.getByTestId('guest-color-person-2').getByTestId('receipt-role-payer')).toBeVisible();
    await expect(ownerPage.getByTestId('presence-person-' + secondId)).toContainText('Сергей');

    const publicState = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
    expect(publicState.presence).toBeNull();
    expect(JSON.stringify(publicState)).not.toContain(first.personToken);
    expect(publicState.people).toHaveLength(3);
    await fitsPhone(ownerPage);
    await fitsPhone(page);
    await fitsPhone(otherGuestPage);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await secondGuestDevice.close();
    await creatorDevice.close();
    await owner.dispose();
  }
});

test('Issue 3.15: receipt corrections recalculate claims and known pieces on three mobile screens', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const creatorDevice = await browser.newContext({
    viewport: { width: 320, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  const guestDevice = await browser.newContext({
    viewport: { width: 360, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const response = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Коррекция общего чека',
        subtotal: 800,
        total: 800,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [
        { name: 'Салат', quantity: 1, unitPrice: 300, totalPrice: 300 },
        { name: 'Суп', quantity: 1, unitPrice: 500, totalPrice: 500 },
      ],
      guestCount: 2,
      joinCreator: true,
    });
    expect(response.ok(), await response.text()).toBe(true);
    const created = JSON.parse(await response.text()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const first = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Анна',
    });
    expect(first.ok(), await first.text()).toBe(true);
    const anna = JSON.parse(await first.text()).result.data.json;
    const second = await trpcMutation(guestDevice.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[2].id,
      name: 'Борис',
    });
    expect(second.ok(), await second.text()).toBe(true);
    const boris = JSON.parse(await second.text()).result.data.json;
    await rememberClaimIdentity(page.context(), token, anna);
    await page.setViewportSize({ width: 393, height: 760 });
    await rememberClaimIdentity(guestDevice, token, boris);
    const creatorPage = await creatorDevice.newPage();
    await creatorPage.goto('/login');
    await creatorPage.locator('input[type=email]').fill(users.alice.email);
    await creatorPage.locator('input[type=password]').fill(users.alice.password);
    await creatorPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(creatorPage).toHaveURL(/\/dashboard/);
    await rememberClaimIdentity(creatorDevice, token, created.creator);
    await creatorPage.goto('/split/' + token + '/claim');
    await page.goto('/split/' + token + '/claim');
    const guestPage = await guestDevice.newPage();
    await guestPage.goto('/split/' + token + '/claim');
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('claim-allocation-summary')).toBeVisible({ timeout: 25_000 });
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('0,00');
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('8,00');
      await expect(viewer.getByTestId('claim-distributed-total')).toContainText('8,00');
      await expect(viewer.getByTestId('claim-distribution-status')).toContainText('ещё никто не выбрал');
    }
    const aSave = await trpcMutation(page.request, 'guest.claimItems', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      addItemIndices: [0],
    });
    expect(aSave.ok(), await aSave.text()).toBe(true);
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('3,00', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('5,00');
      await expect(viewer.getByTestId('person-total-1')).toContainText('3,00');
    }
    const bSave = await trpcMutation(guestDevice.request, 'guest.claimItems', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      addItemIndices: [1],
    });
    expect(bSave.ok(), await bSave.text()).toBe(true);
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('8,00', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('0,00');
      await expect(viewer.getByTestId('person-total-2')).toContainText('5,00');
      await expect(viewer.getByTestId('claim-distribution-status')).toContainText('Ожидается подтверждение');
    }
    // The authorized creator changes a real item, not a detached expense.
    // Draft-only changes must NEVER alter the saved shared counters or
    // publish an uncommitted amount to the other device.
    await guestPage.getByTestId('claim-item-1').click({ position: { x: 36, y: 44 } });
    await expect(guestPage.getByTestId('claim-item-1')).toHaveAttribute('aria-pressed', 'false');
    await expect(guestPage.getByTestId('save-claims-btn')).toBeEnabled();
    await expect(guestPage.getByTestId('claim-allocated-total')).toContainText('8,00');
    await expect(guestPage.getByTestId('claim-unallocated-total')).toContainText('0,00');
    await expect(creatorPage.getByTestId('claim-allocated-total')).toContainText('8,00');
    await guestPage.getByTestId('claim-item-1').click({ position: { x: 36, y: 44 } });
    await expect(guestPage.getByTestId('save-claims-btn')).toBeDisabled();

    const approved = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approved.ok(), await approved.text()).toBe(true);
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('claim-distribution-status')).toContainText('подтверждено организатором', {
        timeout: 25_000,
      });
    }
    await expect(guestPage.getByTestId('receipt-item-edit-0')).toHaveCount(0);
    await creatorPage.getByTestId('receipt-item-edit-0').click();
    await creatorPage.getByTestId('receipt-item-name-0').fill('Салат исправленный');
    await creatorPage.getByTestId('receipt-item-qty-0').fill('2');
    await creatorPage.getByTestId('receipt-item-price-0').fill('2,50');
    await creatorPage.getByTestId('receipt-item-save-0').click();
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('claim-item-0')).toContainText('Салат исправленный', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-item-0')).toContainText('x2');
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('10,00');
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('0,00');
      await expect(viewer.getByTestId('claim-distributed-total')).toContainText('10,00');
      await expect(viewer.getByTestId('person-total-1')).toContainText('5,00');
      await expect(viewer.getByTestId('person-total-2')).toContainText('5,00');
      await expect(viewer.getByTestId('claim-distribution-status')).toContainText('Ожидается подтверждение');
    }
    const corrected = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(corrected.items.map((row: { totalPrice: number }) => row.totalPrice)).toEqual([500, 500]);
    expect(corrected.receiptData.total).toBe(1000);
    expect(corrected.receiptData.subtotal).toBe(1000);
    expect(corrected.receiptData.tax).toBe(0);
    expect(corrected.receiptData.tip).toBe(0);
    expect(corrected.partsConfirmed).toBe(false);
    // Another person starts sharing the corrected item. Their share of
    // the same receipt amount changes; no second charge or extra receipt.
    const share = await trpcMutation(guestDevice.request, 'guest.claimItems', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      addItemIndices: [0],
    });
    expect(share.ok(), await share.text()).toBe(true);
    const known = await trpcMutation(owner, 'guest.setKnownItemParts', { token, itemIndex: 0, totalParts: 10 });
    expect(known.ok(), await known.text()).toBe(true);
    const aParts = await trpcMutation(page.request, 'guest.setMyItemParts', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      itemIndex: 0,
      parts: 3,
    });
    expect(aParts.ok(), await aParts.text()).toBe(true);
    const bParts = await trpcMutation(guestDevice.request, 'guest.setMyItemParts', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
      itemIndex: 0,
      parts: 5,
    });
    expect(bParts.ok(), await bParts.text()).toBe(true);
    for (const viewer of [creatorPage, page, guestPage]) {
      const parts = viewer.getByTestId('guest-claimed-parts-progress-0');
      await expect(parts).toContainText('Всего заявлено частей: 8', { timeout: 25_000 });
      await expect(parts).toContainText('Осталось нераспределённых частей: 2');
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('10,00');
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('0,00');
      await expect(viewer.getByTestId('person-total-1')).not.toContainText('5,00');
      await expect(viewer.getByTestId('person-total-2')).not.toContainText('5,00');
    }
    const unknown = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: null,
    });
    expect(unknown.ok(), await unknown.text()).toBe(true);
    for (const viewer of [creatorPage, page, guestPage]) {
      const parts = viewer.getByTestId('guest-claimed-parts-progress-0');
      await expect(parts).toContainText('Исходное количество неизвестно', { timeout: 25_000 });
      await expect(parts).not.toContainText('Осталось нераспределённых частей');
    }
    const renamed = await trpcMutation(owner, 'guest.editPersonName', {
      token,
      targetId: initial.people[2].id,
      newName: 'Борис П.',
    });
    expect(renamed.ok(), await renamed.text()).toBe(true);
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('person-total-2')).toContainText('Борис П.', { timeout: 25_000 });
      await fitsPhone(viewer);
    }
    const final = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(final.people).toHaveLength(3);
    expect(final.receiptData.total).toBe(1000);
    expect(final.assignments.find((entry: { itemIndex: number }) => entry.itemIndex === 0)?.personIndices).toEqual([
      1, 2,
    ]);
    expect(final.assignments.find((entry: { itemIndex: number }) => entry.itemIndex === 1)?.personIndices).toEqual([2]);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await guestDevice.close();
    await creatorDevice.close();
    await owner.dispose();
  }
});

test('Issue 3.20: duplicate personal portion saves are not applied again after a lost answer', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  let token: string | undefined;
  try {
    const create = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Повторное сохранение',
        subtotal: 501,
        total: 501,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 501, totalPrice: 501 }],
      guestCount: 1,
      joinCreator: true,
    });
    expect(create.ok(), await create.text()).toBe(true);
    token = (JSON.parse(await create.text()).result.data.json as { shareToken: string }).shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const join = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Анна',
    });
    expect(join.ok(), await join.text()).toBe(true);
    const anna = JSON.parse(await join.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    await rememberClaimIdentity(page.context(), token, anna);
    await page.setViewportSize({ width: 393, height: 760 });
    await page.goto('/split/' + token + '/claim');
    await expect(page.getByTestId('claim-item-0')).toBeVisible({ timeout: 25_000 });
    const claim = await trpcMutation(page.request, 'guest.claimItems', {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      addItemIndices: [0],
    });
    expect(claim.ok(), await claim.text()).toBe(true);
    const known = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 10,
    });
    expect(known.ok(), await known.text()).toBe(true);
    const first = {
      token,
      personId: anna.personId,
      personToken: anna.personToken,
      itemIndex: 0,
      parts: 3,
      saveKey: crypto.randomUUID(),
    };
    const simultaneous = await Promise.all([
      trpcMutation(page.request, 'guest.setMyItemParts', first),
      trpcMutation(page.request, 'guest.setMyItemParts', first),
    ]);
    for (const res of simultaneous) {
      expect(res.ok(), await res.text()).toBe(true);
      expect(JSON.parse(await res.text()).result.data.json).toMatchObject({
        success: true,
        parts: 3,
        remainingParts: 7,
      });
    }
    const newer = await trpcMutation(page.request, 'guest.setMyItemParts', {
      ...first,
      parts: 4,
      saveKey: crypto.randomUUID(),
    });
    expect(newer.ok(), await newer.text()).toBe(true);
    const replay = await trpcMutation(page.request, 'guest.setMyItemParts', first);
    expect(replay.ok(), await replay.text()).toBe(true);
    expect(JSON.parse(await replay.text()).result.data.json).toMatchObject({
      success: true,
      parts: 3,
      remainingParts: 6,
    });
    const stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stored.assignments[0].partsByPersonId).toEqual({ [anna.personId]: 4 });
    const reused = await trpcMutation(page.request, 'guest.setMyItemParts', { ...first, parts: 6 });
    expect(reused.ok()).toBe(false);
    expect((await trpcError(reused))?.data?.code).toBe('CONFLICT');
    await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText(
      'Осталось нераспределённых частей: 6',
      { timeout: 25_000 },
    );
    await fitsPhone(page);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await owner.dispose();
  }
});

test('Issue 3.18: PostgreSQL concurrent personal parts writes are absolute, bounded only by declared original', async ({
  browser,
  page,
}) => {
  test.setTimeout(170_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const secondDevice = await browser.newContext({
    viewport: { width: 360, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const response = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Конкурентные части',
        subtotal: 801,
        total: 801,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [{ name: 'Пицца', quantity: 1, unitPrice: 801, totalPrice: 801 }],
      guestCount: 2,
      joinCreator: true,
    });
    expect(response.ok(), await response.text()).toBe(true);
    const created = JSON.parse(await response.text()).result.data.json as { shareToken: string };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const firstJoin = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Анна',
    });
    expect(firstJoin.ok(), await firstJoin.text()).toBe(true);
    const anna = JSON.parse(await firstJoin.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    const secondJoin = await trpcMutation(secondDevice.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[2].id,
      name: 'Борис',
    });
    expect(secondJoin.ok(), await secondJoin.text()).toBe(true);
    const boris = JSON.parse(await secondJoin.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    await rememberClaimIdentity(page.context(), token, anna);
    await rememberClaimIdentity(secondDevice, token, boris);
    const borisPage = await secondDevice.newPage();
    await page.setViewportSize({ width: 393, height: 760 });
    await page.goto('/split/' + token + '/claim');
    await borisPage.goto('/split/' + token + '/claim');
    for (const viewer of [page, borisPage]) {
      await expect(viewer.getByTestId('claim-item-0')).toBeVisible({ timeout: 25_000 });
    }
    const claims = await Promise.all([
      trpcMutation(page.request, 'guest.claimItems', {
        token,
        personId: anna.personId,
        personToken: anna.personToken,
        addItemIndices: [0],
      }),
      trpcMutation(secondDevice.request, 'guest.claimItems', {
        token,
        personId: boris.personId,
        personToken: boris.personToken,
        addItemIndices: [0],
      }),
    ]);
    for (const claim of claims) expect(claim.ok(), await claim.text()).toBe(true);
    const setKnown = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 10,
    });
    expect(setKnown.ok(), await setKnown.text()).toBe(true);

    const setParts = (ctx: typeof page.request, person: typeof anna, parts: number) =>
      trpcMutation(ctx, 'guest.setMyItemParts', {
        token,
        personId: person.personId,
        personToken: person.personToken,
        itemIndex: 0,
        parts,
      });
    const firstWrites = await Promise.all([setParts(page.request, anna, 3), setParts(secondDevice.request, boris, 5)]);
    for (const result of firstWrites) {
      expect(result.ok(), await result.text()).toBe(true);
      const saved = JSON.parse(await result.text()).result.data.json;
      expect(saved.success).toBe(true);
      expect(saved.remainingParts).toBeGreaterThanOrEqual(2);
      expect(saved.remainingParts).toBeLessThanOrEqual(6);
    }
    let stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stored.assignments[0].partsByPersonId).toEqual({
      [anna.personId]: 3,
      [boris.personId]: 5,
    });
    for (const viewer of [page, borisPage]) {
      await expect(viewer.getByTestId('guest-claimed-parts-progress-0')).toContainText(
        'Осталось нераспределённых частей: 2',
        { timeout: 25_000 },
      );
    }
    // Retrying the same absolute target must not add three more portions.
    const replay = await setParts(page.request, anna, 3);
    expect(replay.ok(), await replay.text()).toBe(true);
    expect(JSON.parse(await replay.text()).result.data.json).toMatchObject({
      success: true,
      parts: 3,
      remainingParts: 2,
    });
    const overLimit = await setParts(page.request, anna, 6);
    expect(overLimit.ok()).toBe(false);
    const refused = await trpcError(overLimit);
    expect(refused?.data?.code).toBe('PRECONDITION_FAILED');
    expect(refused?.data?.remainingParts).toBe(2);

    // Two independent updates can fill the remaining two parts, however
    // the database orders the transactions and retries serialization failures.
    const finalWrites = await Promise.all([setParts(page.request, anna, 4), setParts(secondDevice.request, boris, 6)]);
    for (const result of finalWrites) expect(result.ok(), await result.text()).toBe(true);
    stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stored.assignments[0].partsByPersonId).toEqual({
      [anna.personId]: 4,
      [boris.personId]: 6,
    });
    for (const viewer of [page, borisPage]) {
      await expect(viewer.getByTestId('guest-claimed-parts-progress-0')).toContainText(
        'Осталось нераспределённых частей: 0',
        { timeout: 25_000 },
      );
    }

    // A missing original total removes the bound; it is not reconstructed
    // from item quantity, price, group size or previous saved portions.
    const unknown = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: null,
    });
    expect(unknown.ok(), await unknown.text()).toBe(true);
    const unlimited = await Promise.all([
      setParts(page.request, anna, 9_999),
      setParts(secondDevice.request, boris, 7_777),
    ]);
    for (const result of unlimited) {
      expect(result.ok(), await result.text()).toBe(true);
      expect(JSON.parse(await result.text()).result.data.json.remainingParts).toBeNull();
    }
    stored = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(stored.assignments[0].partsByPersonId).toEqual({
      [anna.personId]: 9_999,
      [boris.personId]: 7_777,
    });
    expect(stored.receiptData.knownPartsByItem).toEqual({});
    for (const viewer of [page, borisPage]) {
      await expect(viewer.getByTestId('guest-claimed-parts-progress-0')).toContainText(
        'Исходное количество неизвестно',
        { timeout: 25_000 },
      );
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await secondDevice.close();
    await owner.dispose();
  }
});

test('Issue 3.17: concurrent guests preserve each others claims and all open screens agree', async ({
  page,
  browser,
}) => {
  test.setTimeout(160_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const secondDevice = await browser.newContext({
    viewport: { width: 360, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  const creatorDevice = await browser.newContext({
    viewport: { width: 320, height: 720 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const createdResponse = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Параллельный чек',
        subtotal: 901,
        total: 901,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [
        { name: 'Пицца', quantity: 1, unitPrice: 301, totalPrice: 301 },
        { name: 'Чай', quantity: 1, unitPrice: 200, totalPrice: 200 },
        { name: 'Салат', quantity: 1, unitPrice: 400, totalPrice: 400 },
      ],
      guestCount: 2,
      joinCreator: true,
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = JSON.parse(await createdResponse.text()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const annaResponse = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Анна',
    });
    expect(annaResponse.ok(), await annaResponse.text()).toBe(true);
    const anna = JSON.parse(await annaResponse.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    const borisResponse = await trpcMutation(secondDevice.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[2].id,
      name: 'Борис',
    });
    expect(borisResponse.ok(), await borisResponse.text()).toBe(true);
    const boris = JSON.parse(await borisResponse.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    await rememberClaimIdentity(page.context(), token, anna);
    await rememberClaimIdentity(secondDevice, token, boris);
    await rememberClaimIdentity(creatorDevice, token, created.creator);
    await page.setViewportSize({ width: 393, height: 760 });
    const creatorPage = await creatorDevice.newPage();
    await creatorPage.goto('/login');
    await creatorPage.locator('input[type=email]').fill(users.alice.email);
    await creatorPage.locator('input[type=password]').fill(users.alice.password);
    await creatorPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(creatorPage).toHaveURL(/\/dashboard/);
    await creatorPage.goto('/split/' + token + '/claim');
    await page.goto('/split/' + token + '/claim');
    const borisPage = await secondDevice.newPage();
    await borisPage.goto('/split/' + token + '/claim');
    const viewers = [creatorPage, page, borisPage];
    for (const viewer of viewers) {
      await expect(viewer.getByTestId('claim-allocation-summary')).toBeVisible({ timeout: 25_000 });
      await expect(viewer.getByTestId('claim-allocation-summary')).toHaveAttribute('data-sync-mode', 'sse', {
        timeout: 25_000,
      });
    }

    // Two actual browsers issue independent saves together, not two sequential
    // requests and not an in-memory mock of transaction conflict handling.
    const firstSaves = await Promise.all([
      trpcMutation(page.request, 'guest.claimItems', {
        token,
        personId: anna.personId,
        personToken: anna.personToken,
        addItemIndices: [0, 1],
        saveKey: crypto.randomUUID(),
      }),
      trpcMutation(secondDevice.request, 'guest.claimItems', {
        token,
        personId: boris.personId,
        personToken: boris.personToken,
        addItemIndices: [0],
        saveKey: crypto.randomUUID(),
      }),
    ]);
    for (const result of firstSaves) expect(result.ok(), await result.text()).toBe(true);
    const bothSaved = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(bothSaved.receiptData.knownPartsByItem ?? {}).toEqual({});
    expect(new Set(bothSaved.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0)?.personIndices)).toEqual(
      new Set([1, 2]),
    );
    expect(bothSaved.assignments.find((a: { itemIndex: number }) => a.itemIndex === 1)?.personIndices).toEqual([1]);
    expect(bothSaved.assignments.some((a: { itemIndex: number }) => a.itemIndex === 2)).toBe(false);
    for (const viewer of viewers) {
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('5,01', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('4,00');
      await expect(viewer.getByTestId('guest-claimed-parts-progress-0')).toContainText(
        'Исходное количество неизвестно',
      );
      await expect(viewer.getByTestId('guest-claimed-parts-progress-0')).not.toContainText(
        'Осталось нераспределённых частей',
      );
    }

    // The selected participant is represented by aria-pressed, while
    // "Также выбрали" names OTHER participants, never the active person.
    // The creator (who claimed neither dish) sees both names.
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Анна');
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Борис');
    await expect(page.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('claim-item-0')).toContainText('Борис');
    await expect(borisPage.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(borisPage.getByTestId('claim-item-0')).toContainText('Анна');

    // Now each guest changes a different position while the same shared
    // position is released by Anna; Boriss assignment must not disappear.
    const secondSaves = await Promise.all([
      trpcMutation(page.request, 'guest.claimItems', {
        token,
        personId: anna.personId,
        personToken: anna.personToken,
        removeItemIndices: [0],
        saveKey: crypto.randomUUID(),
      }),
      trpcMutation(secondDevice.request, 'guest.claimItems', {
        token,
        personId: boris.personId,
        personToken: boris.personToken,
        addItemIndices: [2],
        saveKey: crypto.randomUUID(),
      }),
    ]);
    for (const result of secondSaves) expect(result.ok(), await result.text()).toBe(true);
    const final = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(final.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0)?.personIndices).toEqual([2]);
    expect(final.assignments.find((a: { itemIndex: number }) => a.itemIndex === 1)?.personIndices).toEqual([1]);
    expect(final.assignments.find((a: { itemIndex: number }) => a.itemIndex === 2)?.personIndices).toEqual([2]);
    expect(final.receiptData.total).toBe(901);
    for (const viewer of viewers) {
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('9,01', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('0,00');
      await expect(viewer.getByTestId('person-total-1')).toContainText('2,00');
      await expect(viewer.getByTestId('person-total-2')).toContainText('7,01');
      await expect(viewer.getByTestId('claim-item-0')).not.toContainText('Анна');
      await fitsPhone(viewer);
    }
    // Boris is the only claimant now: other devices name him and his own
    // mobile card stays selected instead of redundantly showing his name.
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Борис');
    await expect(page.getByTestId('claim-item-0')).toContainText('Борис');
    await expect(borisPage.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true');

    // The creator now specifies exactly one original piece for the shared
    // pizza. A new simultaneous claim for it must be refused without
    // undoing Boris's independent valid edit of another dish.
    const known = await trpcMutation(owner, 'guest.setKnownItemParts', {
      token,
      itemIndex: 0,
      totalParts: 1,
    });
    expect(known.ok(), await known.text()).toBe(true);
    const constrained = await Promise.all([
      trpcMutation(page.request, 'guest.claimItems', {
        token,
        personId: anna.personId,
        personToken: anna.personToken,
        addItemIndices: [0],
        saveKey: crypto.randomUUID(),
      }),
      trpcMutation(secondDevice.request, 'guest.claimItems', {
        token,
        personId: boris.personId,
        personToken: boris.personToken,
        removeItemIndices: [2],
        saveKey: crypto.randomUUID(),
      }),
    ]);
    expect(constrained[0]!.ok(), await constrained[0]!.text()).toBe(false);
    expect((await trpcError(constrained[0]!))?.data?.code).toBe('PRECONDITION_FAILED');
    expect(constrained[1]!.ok(), await constrained[1]!.text()).toBe(true);
    const bounded = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(bounded.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0)?.personIndices).toEqual([2]);
    expect(bounded.assignments.find((a: { itemIndex: number }) => a.itemIndex === 1)?.personIndices).toEqual([1]);
    expect(bounded.assignments.some((a: { itemIndex: number }) => a.itemIndex === 2)).toBe(false);
    expect(bounded.receiptData.knownPartsByItem).toEqual({ 0: 1 });
    for (const viewer of viewers) {
      await expect(viewer.getByTestId('claim-allocated-total')).toContainText('5,01', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-unallocated-total')).toContainText('4,00');
      await expect(viewer.getByTestId('guest-claimed-parts-progress-0')).toContainText(
        'Осталось нераспределённых частей: 0',
      );
      await fitsPhone(viewer);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await secondDevice.close();
    await creatorDevice.close();
    await owner.dispose();
  }
});

test('Issue 3.21: an SSE ticket from one guest cannot stream another receipt', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const created: string[] = [];
  try {
    const create = async (merchantName: string) => {
      const res = await trpcMutation(owner, 'guest.createClaimSession', {
        receiptData: { merchantName, subtotal: 300, total: 300, tax: 0, tip: 0, currency: 'RUB' },
        items: [{ name: 'Чай', quantity: 1, unitPrice: 300, totalPrice: 300 }],
        guestCount: 1,
        joinCreator: true,
      });
      expect(res.ok(), await res.text()).toBe(true);
      const token = (JSON.parse(await res.text()).result.data.json as { shareToken: string }).shareToken;
      created.push(token);
      return token;
    };
    const a = await create('Чек А');
    const b = await create('Чек Б');
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: a }));
    const join = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token: a,
      slotId: initial.people[1].id,
      name: 'Анна',
    });
    expect(join.ok(), await join.text()).toBe(true);
    const anna = JSON.parse(await join.text()).result.data.json as {
      personId: string;
      personToken: string;
      name: string;
    };
    // The invitation token alone grants no SSE access, before this browser
    // establishes its personal identity and receives a scoped live ticket.
    const unauthorized = await page.request.get('/api/guest/' + a + '/events');
    expect(unauthorized.status()).toBe(404);
    // Like all other mobile guest E2E tests, explicitly restore the joined
    // person's identity on this browser before opening the claim page.
    await rememberClaimIdentity(page.context(), a, anna);
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto('/split/' + a + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-item-0')).toBeVisible({ timeout: 25_000 });
    const forbidden = await page.request.post('/api/guest/' + b + '/events', {
      data: { personId: anna.personId, personToken: anna.personToken },
    });
    expect(forbidden.status()).toBe(404);
    const grant = await page.request.post('/api/guest/' + a + '/events', {
      data: { personId: anna.personId, personToken: anna.personToken },
    });
    expect(grant.status()).toBe(200);
    expect(grant.headers()['set-cookie']).not.toContain(anna.personToken);
    // HttpOnly ticket is scoped to receipt A, not receipt B.
    const results = await page.evaluate(
      async ({ a, b }) => {
        const attempt = async (token: string) => {
          const response = await fetch('/api/guest/' + token + '/events');
          if (response.body) await response.body.cancel();
          return response.status;
        };
        return [await attempt(a), await attempt(b)];
      },
      { a, b },
    );
    expect(results).toEqual([200, 404]);
    // Malformed credentials and foreign-origin ticket issuance fail.
    const forged = await page.request.post('/api/guest/' + a + '/events', {
      headers: { Origin: 'https://untrusted.invalid' },
      data: { personId: anna.personId, personToken: anna.personToken },
    });
    expect(forged.status()).toBe(403);
    await fitsPhone(page);
  } finally {
    for (const token of created) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await owner.dispose();
  }
});

test('Issue 3.16: SSE delivers receipt edits and reconnects after a real mobile network outage', async ({
  page,
  browser,
}) => {
  test.setTimeout(140_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const secondDevice = await browser.newContext({
    viewport: { width: 360, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const create = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'SSE receipt', subtotal: 300, total: 300, tax: 0, tip: 0, currency: 'RUB' },
      items: [{ name: 'Салат', quantity: 1, unitPrice: 300, totalPrice: 300 }],
      guestCount: 2,
      joinCreator: true,
    });
    expect(create.ok(), await create.text()).toBe(true);
    const created = JSON.parse(await create.text()).result.data.json as { shareToken: string };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const joinFirst = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Анна',
    });
    expect(joinFirst.ok(), await joinFirst.text()).toBe(true);
    const joinSecond = await trpcMutation(secondDevice.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[2].id,
      name: 'Борис',
    });
    expect(joinSecond.ok(), await joinSecond.text()).toBe(true);
    const first = JSON.parse(await joinFirst.text()).result.data.json;
    const second = JSON.parse(await joinSecond.text()).result.data.json;
    await rememberClaimIdentity(page.context(), token, first);
    await rememberClaimIdentity(secondDevice, token, second);
    await page.setViewportSize({ width: 320, height: 760 });
    const otherPage = await secondDevice.newPage();
    await page.goto('/split/' + token + '/claim');
    await otherPage.goto('/split/' + token + '/claim');
    for (const viewer of [page, otherPage]) {
      const total = viewer.getByTestId('claim-allocation-summary');
      await expect(total).toBeVisible({ timeout: 25_000 });
      await expect(total).toHaveAttribute('data-sync-mode', 'sse', { timeout: 25_000 });
      await expect(viewer.getByTestId('claim-distributed-total')).toContainText('3,00');
    }

    const saved = await trpcMutation(owner, 'guest.updateClaimReceiptItem', {
      token,
      itemIndex: 0,
      name: 'Обновлённый салат',
      quantity: 1,
      unitPrice: 450,
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    for (const viewer of [page, otherPage]) {
      await expect(viewer.getByTestId('claim-distributed-total')).toContainText('4,50', { timeout: 15_000 });
    }

    // Simulate a real dropped connection, change the saved receipt on the server,
    // then let EventSource reconnect and verify the latest state without reload.
    await page.context().setOffline(true);
    const offlineUpdate = await trpcMutation(owner, 'guest.updateClaimReceiptItem', {
      token,
      itemIndex: 0,
      name: 'После восстановления связи',
      quantity: 1,
      unitPrice: 650,
    });
    expect(offlineUpdate.ok(), await offlineUpdate.text()).toBe(true);
    await expect(otherPage.getByTestId('claim-distributed-total')).toContainText('6,50', { timeout: 15_000 });
    await page.context().setOffline(false);
    await expect(page.getByTestId('claim-allocation-summary')).toHaveAttribute('data-sync-mode', 'sse', {
      timeout: 25_000,
    });
    await expect(page.getByTestId('claim-distributed-total')).toContainText('6,50', { timeout: 25_000 });
    await expect(page.getByTestId('claim-item-0')).toContainText('После восстановления связи');
    for (const viewer of [page, otherPage]) await fitsPhone(viewer);

    const missing = await owner.get('/api/guest/not-a-real-receipt/events');
    expect(missing.status()).toBe(404);
  } finally {
    await page.context().setOffline(false);
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await secondDevice.close();
    await owner.dispose();
  }
});

test('Issue 3.14: claims and shared positions reach every open mobile receipt', async ({ page, browser }) => {
  test.setTimeout(170_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const creatorDevice = await browser.newContext({
    viewport: { width: 320, height: 720 },
    isMobile: true,
    hasTouch: true,
  });
  const guestDevice = await browser.newContext({
    viewport: { width: 360, height: 720 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const res = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Синхронизация блюд', subtotal: 2300, total: 2300, tax: 0, tip: 0, currency: 'RUB' },
      items: [
        { name: 'Салат', quantity: 1, unitPrice: 800, totalPrice: 800 },
        { name: 'Суп', quantity: 1, unitPrice: 900, totalPrice: 900 },
        { name: 'Чай', quantity: 1, unitPrice: 600, totalPrice: 600 },
      ],
      guestCount: 2,
      joinCreator: true,
    });
    expect(res.ok(), await res.text()).toBe(true);
    const created = JSON.parse(await res.text()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const aJoin = await trpcMutation(page.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[1].id,
      name: 'Андрей',
    });
    expect(aJoin.ok(), await aJoin.text()).toBe(true);
    const a = JSON.parse(await aJoin.text()).result.data.json;
    const bJoin = await trpcMutation(guestDevice.request, 'guest.joinGuestSlot', {
      token,
      slotId: initial.people[2].id,
      name: 'Борис',
    });
    expect(bJoin.ok(), await bJoin.text()).toBe(true);
    const b = JSON.parse(await bJoin.text()).result.data.json;
    await rememberClaimIdentity(page.context(), token, a);
    await page.setViewportSize({ width: 393, height: 740 });
    await rememberClaimIdentity(guestDevice, token, b);
    const creatorPage = await creatorDevice.newPage();
    await creatorPage.goto('/login');
    await creatorPage.locator('input[type=email]').fill(users.alice.email);
    await creatorPage.locator('input[type=password]').fill(users.alice.password);
    await creatorPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(creatorPage).toHaveURL(/\/dashboard/);
    await rememberClaimIdentity(creatorDevice, token, created.creator);
    await creatorPage.goto('/split/' + token + '/claim');
    await page.goto('/split/' + token + '/claim');
    const guestPage = await guestDevice.newPage();
    await guestPage.goto('/split/' + token + '/claim');
    for (const viewer of [creatorPage, page, guestPage]) {
      await expect(viewer.getByTestId('claim-item-0')).toBeVisible({ timeout: 25_000 });
    }
    // A saved choice is delivered to all three open screens by server polling.
    // B's unsaved choice of a different dish must stay local.
    await guestPage.getByTestId('claim-item-2').click({ position: { x: 36, y: 44 } });
    await expect(guestPage.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('claim-item-0').click({ position: { x: 36, y: 44 } });
    const mobileSave = page.getByTestId('save-claims-btn');
    await expect(mobileSave).toBeEnabled();
    // Verify the real hit target, not a force click: the fixed action bar
    // must be above the dish cards on a mobile viewport.
    const saveHit = await mobileSave.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const panel = element.closest('[data-testid="claim-actions"]');
      return {
        hittable: Boolean(hit && element.contains(hit)),
        hitTag: hit?.tagName ?? 'none',
        hitTestId: hit?.getAttribute('data-testid') ?? '',
        panelZ: panel ? getComputedStyle(panel).zIndex : '',
        x,
        y,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    expect(saveHit.hittable, JSON.stringify(saveHit)).toBe(true);
    await mobileSave.click();
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Андрей', { timeout: 25_000 });
    await expect(guestPage.getByTestId('claim-item-0')).toContainText('Андрей', { timeout: 25_000 });
    await expect(guestPage.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(guestPage.getByTestId('save-claims-btn')).toBeEnabled();
    const firstSave = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(firstSave.assignments.find((row: { itemIndex: number }) => row.itemIndex === 0)?.personIndices).toEqual([1]);
    expect(firstSave.assignments.some((row: { itemIndex: number }) => row.itemIndex === 2)).toBe(false);

    // The amount actually consumed is published, without inventing a total.
    await expect(page.getByTestId('personal-parts-0')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('personal-parts-input-0').fill('3');
    await page.getByTestId('personal-parts-save-0').click();
    await expect(creatorPage.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 3', {
      timeout: 25_000,
    });
    await expect(guestPage.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 3', {
      timeout: 25_000,
    });
    // B joins A's salad and saves tea; owner sees both saved names.
    await guestPage.getByTestId('claim-item-0').click({ position: { x: 36, y: 44 } });
    await guestPage.getByTestId('save-claims-btn').click();
    await expect(page.getByTestId('claim-item-0')).toContainText('Борис', { timeout: 25_000 });
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Борис', { timeout: 25_000 });
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Андрей');
    await expect(page.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 4', {
      timeout: 25_000,
    });
    const shared = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(
      new Set(shared.assignments.find((row: { itemIndex: number }) => row.itemIndex === 0)?.personIndices),
    ).toEqual(new Set([1, 2]));
    expect(shared.assignments.find((row: { itemIndex: number }) => row.itemIndex === 2)?.personIndices).toEqual([2]);

    // A withdraws from the shared position; B's portion must remain.
    await page.getByTestId('claim-item-0').click({ position: { x: 36, y: 44 } });
    await page.getByTestId('save-claims-btn').click();
    await expect(creatorPage.getByTestId('claim-item-0')).not.toContainText('Андрей', { timeout: 25_000 });
    await expect(creatorPage.getByTestId('claim-item-0')).toContainText('Борис');
    await expect(guestPage.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(guestPage.getByTestId('guest-claimed-parts-progress-0')).toContainText('Всего заявлено частей: 1', {
      timeout: 25_000,
    });
    const final = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(final.assignments.find((row: { itemIndex: number }) => row.itemIndex === 0)?.personIndices).toEqual([2]);
    expect(final.assignments.find((row: { itemIndex: number }) => row.itemIndex === 2)?.personIndices).toEqual([2]);
    expect(final.people.map((row: { id: string }) => row.id)).toEqual(
      initial.people.map((row: { id: string }) => row.id),
    );
    for (const viewer of [creatorPage, page, guestPage]) await fitsPhone(viewer);
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await guestDevice.close();
    await creatorDevice.close();
    await owner.dispose();
  }
});

test('Issue 3.5: organizer sees joined, live, lost and reconnected mobile guests without refresh', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const organizerBrowser = await browser.newContext({
    viewport: { width: 320, height: 680 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | undefined;
  try {
    const createdRes = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Присутствие 3.5', subtotal: 1001, total: 1001, tax: 0, tip: 0, currency: 'RUB' },
      items: [{ name: 'Блюдо', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      creatorName: 'Анна',
      paidByName: 'Анна',
      people: ['Анна', 'Борис', 'Виктор'],
      joinCreator: true,
    });
    const createdBody = await createdRes.text();
    expect(createdRes.ok(), createdBody).toBe(true);
    const created = JSON.parse(createdBody).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const ownerPage = await organizerBrowser.newPage();
    await ownerPage.goto('/login', { waitUntil: 'networkidle' });
    await ownerPage.locator('input[type=email]').fill(users.alice.email);
    await ownerPage.locator('input[type=password]').fill(users.alice.password);
    await ownerPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/dashboard/);
    await rememberClaimIdentity(organizerBrowser, token, created.creator);
    await ownerPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });

    const ownerSession = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const creatorId = ownerSession.people[0].id as string;
    const borisId = ownerSession.people[1].id as string;
    const victorId = ownerSession.people[2].id as string;
    const presence = ownerPage.getByTestId('organizer-presence');
    await expect(presence).toBeVisible({ timeout: 15_000 });
    const creatorStatus = presence.getByTestId('presence-status-' + creatorId);
    const borisStatus = presence.getByTestId('presence-status-' + borisId);
    const victorStatus = presence.getByTestId('presence-status-' + victorId);
    await expect(creatorStatus).toHaveText('Сейчас на странице', { timeout: 25_000 });
    await expect(borisStatus).toHaveText('Ещё не присоединился');
    await expect(victorStatus).toHaveText('Ещё не присоединился');
    await fitsPhone(ownerPage);

    await page.setViewportSize({ width: 360, height: 620 });
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('organizer-presence')).toHaveCount(0);
    await page.getByTestId('rejoin-person-1').click();
    await expect(page.getByTestId('claim-item-0')).toBeVisible({ timeout: 15_000 });
    await expect(borisStatus).toHaveText('Сейчас на странице', { timeout: 25_000 });
    await expect(victorStatus).toHaveText('Ещё не присоединился');

    const publicView = await trpcResult(await trpcQuery(page.request, 'guest.getSession', { token }));
    expect(publicView.presence).toBeNull();
    expect(publicView.people[1].hasJoined).toBe(true);

    // Network loss does not remove a joined participant. Server TTL, rather
    // than a client-supplied 'offline' flag, is the authority for presence.
    await page.context().setOffline(true);
    await expect(page.getByTestId('presence-connection-lost')).toBeVisible({ timeout: 15_000 });
    await expect(borisStatus).toHaveText('Не в сети — был подключён ранее', { timeout: 68_000 });
    await expect(victorStatus).toHaveText('Ещё не присоединился');
    await page.context().setOffline(false);
    await expect(page.getByTestId('presence-connection-lost')).toHaveCount(0, { timeout: 25_000 });
    await expect(borisStatus).toHaveText('Сейчас на странице', { timeout: 25_000 });

    for (const width of [320, 360, 430, 720]) {
      await ownerPage.setViewportSize({ width, height: 620 });
      const card = presence.getByTestId('presence-person-' + borisId);
      await card.scrollIntoViewIfNeeded();
      const bounds = await card.boundingBox();
      expect(bounds, 'Presence row on ' + width + ' px').not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(-1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await fitsPhone(ownerPage);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await organizerBrowser.close();
    await owner.dispose();
  }
});

test('Issue 3.4: mobile creator explicitly delegates approval and finalization, payer and guest cannot', async ({
  page,
  browser,
}) => {
  test.setTimeout(210_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const payerAccount = await authedContext(users.bob.email, users.bob.password);
  const organizerBrowser = await browser.newContext({
    viewport: { width: 360, height: 680 },
    isMobile: true,
    hasTouch: true,
  });
  const delegateBrowser = await browser.newContext({
    viewport: { width: 320, height: 680 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const create = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Проверка прав 3.4',
        subtotal: 1001,
        total: 1001,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [
        { name: 'Пицца', quantity: 1, unitPrice: 800, totalPrice: 800 },
        { name: 'Чай', quantity: 1, unitPrice: 201, totalPrice: 201 },
      ],
      people: ['Анна', 'Борис'],
      creatorName: 'Анна',
      paidByName: 'Борис',
      joinCreator: true,
    });
    const body = await create.text();
    expect(create.ok(), body).toBe(true);
    const created = JSON.parse(body).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    const token = created.shareToken;
    const anna = created.creator;

    // The payer is a registered account but has no organizer authority.
    const boris = await joinGuestSession(payerAccount, { token, name: 'Борис' });
    for (const [ctx, person, indices] of [
      [owner, anna, [0]],
      [payerAccount, boris, [0, 1]],
    ] as const) {
      const result = await trpcMutation(ctx, 'guest.claimItems', {
        token,
        personId: person.personId,
        personToken: person.personToken,
        claimedItemIndices: indices,
      });
      expect(result.ok(), await result.text()).toBe(true);
    }

    // Personal tokens give guest participation only, even when all items are claimed.
    await rememberClaimIdentity(page.context(), token, boris);
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-item-0')).toBeVisible();
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    await expect(page.getByTestId('guest-confirm-parts-btn')).toHaveCount(0);
    const rejectedGuest = await trpcMutation(page.request, 'guest.finalizeSession', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
    });
    expect((await trpcError(rejectedGuest))?.data?.code).toBe('UNAUTHORIZED');

    const rejectedPayer = await trpcMutation(payerAccount, 'guest.finalizeSession', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
    });
    expect((await trpcError(rejectedPayer))?.data?.code).toBe('FORBIDDEN');

    const ownerPage = await organizerBrowser.newPage();
    await ownerPage.goto('/login', { waitUntil: 'networkidle' });
    await ownerPage.locator('input[type=email]').fill(users.alice.email);
    await ownerPage.locator('input[type=password]').fill(users.alice.password);
    await ownerPage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/dashboard/);
    await rememberClaimIdentity(organizerBrowser, token, anna);
    await ownerPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const panel = ownerPage.getByTestId('finalization-organizer-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByTestId('finalization-organizer-email').fill(users.charlie.email);
    await panel.getByTestId('finalization-organizer-appoint').click();
    await expect(panel.getByTestId('finalization-organizer-active')).toBeVisible({ timeout: 15_000 });

    const delegatePage = await delegateBrowser.newPage();
    await delegatePage.goto('/login', { waitUntil: 'networkidle' });
    await delegatePage.locator('input[type=email]').fill(users.charlie.email);
    await delegatePage.locator('input[type=password]').fill(users.charlie.password);
    await delegatePage.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(delegatePage).toHaveURL(/\/dashboard/);
    await delegatePage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    // The co-organizer did not eat: no fictitious guest or personal token.
    await expect(delegatePage.getByTestId('finalization-organizer-panel')).toHaveCount(0);
    await expect(delegatePage.getByTestId('finalization-organizer-no-claim')).toBeVisible();
    await expect(delegatePage.getByTestId('claim-join-form')).toBeVisible();
    await expect(delegatePage.getByTestId('guest-confirm-parts-btn')).toBeVisible({ timeout: 15_000 });
    await fitsPhone(delegatePage);
    await delegatePage.getByTestId('guest-confirm-parts-btn').click();
    await expect
      .poll(async () => (await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }))).partsConfirmed, {
        timeout: 15_000,
      })
      .toBe(true);

    // A payer or guest cannot bypass the creator/delegate check even after approval.
    const forbiddenAfter = await trpcMutation(payerAccount, 'guest.finalizeSession', {
      token,
      personId: boris.personId,
      personToken: boris.personToken,
    });
    expect((await trpcError(forbiddenAfter))?.data?.code).toBe('FORBIDDEN');
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    await expect(delegatePage.getByTestId('finalize-btn')).toBeVisible({ timeout: 15_000 });

    await delegatePage.getByTestId('finalize-btn').click();
    const finalizeDialog = delegatePage.getByRole('alertdialog');
    await expect(finalizeDialog).toBeVisible();
    await finalizeDialog.getByRole('button', { name: 'Завершить распределение' }).click();
    await expect(delegatePage.getByTestId('finalized-bill-total')).toContainText('10,01', { timeout: 20_000 });
    const result = await trpcResult(await trpcQuery(owner, 'guest.getSplit', { token }));
    expect(result.receiptData.total).toBe(1001);
    expect(result.summary.reduce((sum: number, member: { total: number }) => sum + member.total, 0)).toBe(1001);
  } finally {
    await organizerBrowser.close();
    await delegateBrowser.close();
    await payerAccount.dispose();
    await owner.dispose();
  }
});

test('Issue 3.2: a registered owner independently creates groups, receipts and expenses; other account is isolated', async () => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const outsider = await authedContext(users.bob.email, users.bob.password);
  const createdIds: string[] = [];
  const unique = String(Date.now());
  try {
    for (const index of [1, 2]) {
      const created = await trpcMutation(owner, 'groups.create', { name: '3.2 Own group ' + unique + '-' + index });
      expect(created.ok(), await created.text()).toBe(true);
      const group = (await created.json()).result.data.json as { id: string };
      createdIds.push(group.id);
      const detail = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId: group.id }));
      const creatorId = detail.members.find(
        (member: { user: { email: string } }) => member.user.email === users.alice.email,
      )?.user.id as string | undefined;
      expect(creatorId).toBeTruthy();

      // Every new group permits its own manual receipt and exact RUB expense.
      const receiptResponse = await trpcMutation(owner, 'receipts.createManual', { groupId: group.id });
      expect(receiptResponse.ok(), await receiptResponse.text()).toBe(true);
      const receiptId = (await receiptResponse.json()).result.data.json.receiptId as string;
      const ownReceipt = await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId });
      expect(ownReceipt.ok(), await ownReceipt.text()).toBe(true);

      const amount = 100 + index;
      const expenseResponse = await trpcMutation(owner, 'expenses.create', {
        groupId: group.id,
        title: '3.2 expense ' + index,
        amount,
        currency: 'RUB',
        paidById: creatorId,
        splitMode: 'EQUAL',
        shares: [{ userId: creatorId, amount }],
      });
      expect(expenseResponse.ok(), await expenseResponse.text()).toBe(true);
      const expenseId = (await expenseResponse.json()).result.data.json.id as string;
      const ownExpense = await trpcResult(
        await trpcQuery(owner, 'expenses.get', {
          groupId: group.id,
          expenseId,
        }),
      );
      expect(ownExpense.amount).toBe(amount);
      expect(ownExpense.currency).toBe('RUB');

      // Knowing a group, receipt or expense ID never confers membership.
      for (const foreignQuery of [
        trpcQuery(outsider, 'groups.get', { groupId: group.id }),
        trpcQuery(outsider, 'receipts.getReceiptItems', { receiptId }),
        trpcQuery(outsider, 'expenses.get', { groupId: group.id, expenseId }),
        trpcQuery(outsider, 'expenses.list', { groupId: group.id }),
      ]) {
        const response = await foreignQuery;
        const error = await trpcError(response);
        expect(error?.data?.code).toBe('FORBIDDEN');
      }
      for (const forbiddenCreate of [
        trpcMutation(outsider, 'receipts.createManual', { groupId: group.id }),
        trpcMutation(outsider, 'expenses.create', {
          groupId: group.id,
          title: 'Unauthorized',
          amount: 1,
          paidById: creatorId,
          splitMode: 'EQUAL',
          shares: [{ userId: creatorId, amount: 1 }],
        }),
      ]) {
        const response = await forbiddenCreate;
        expect(response.ok(), await response.text()).toBe(false);
      }
    }
    const ownGroups = await trpcResult(await trpcQuery(owner, 'groups.list'));
    const outsiderGroups = await trpcResult(await trpcQuery(outsider, 'groups.list'));
    for (const id of createdIds) {
      expect(ownGroups.some((group: { id: string }) => group.id === id)).toBe(true);
      expect(outsiderGroups.some((group: { id: string }) => group.id === id)).toBe(false);
    }
  } finally {
    for (const groupId of createdIds) {
      await trpcMutation(owner, 'groups.delete', { groupId }).catch(() => undefined);
    }
    await outsider.dispose();
    await owner.dispose();
  }
});
