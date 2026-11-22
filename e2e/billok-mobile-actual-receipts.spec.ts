import { expect, test } from '@playwright/test';
import {
  authedContext,
  joinGuestSession,
  rememberClaimIdentity,
  trpcMutation,
  trpcQuery,
  trpcResult,
  users,
} from './helpers';

// 5.22.4: mobile-only end-to-end acceptance of actual received money.
// No bank transfer is performed; only the payer enters bank-confirmed amounts.
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true });

test('5.22: payer corrects actual incoming RUB amount and accounts for returned surplus without changing dishes', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const other = await browser.newContext({
    viewport: { width: 320, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | null = null;
  try {
    const createdResponse = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Проверка фактических поступлений',
        subtotal: 1200,
        tax: 0,
        tip: 0,
        total: 1200,
        currency: 'RUB',
      },
      items: [{ name: 'Общее блюдо', quantity: 1, unitPrice: 1200, totalPrice: 1200 }],
      people: ['Плательщик', 'Участник', 'Без блюд'],
      creatorName: 'Плательщик',
      paidByName: 'Плательщик',
      joinCreator: true,
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = (await createdResponse.json()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const payer = created.creator;
    const sender = await joinGuestSession(other.request, { token, name: 'Участник' });
    for (const participant of [payer, sender]) {
      const ctx = participant.personId === payer.personId ? owner : other.request;
      const claim = await trpcMutation(ctx, 'guest.claimItems', {
        token,
        personId: participant.personId,
        personToken: participant.personToken,
        claimedItemIndices: [0],
      });
      expect(claim.ok(), await claim.text()).toBe(true);
    }
    const approval = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approval.ok(), await approval.text()).toBe(true);
    const finalized = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: payer.personId,
      personToken: payer.personToken,
    });
    expect(finalized.ok(), await finalized.text()).toBe(true);

    await rememberClaimIdentity(page.context(), token, payer);
    await rememberClaimIdentity(other, token, sender);
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const senderPage = await other.newPage();
    await senderPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const privateReview = page.getByTestId('guest-payer-payment-review').filter({ visible: true });
    await expect(privateReview).toHaveCount(1, { timeout: 20_000 });
    const row = privateReview.getByTestId('guest-payer-payment-' + sender.personId);
    await expect(row).toContainText('6,00', { timeout: 15_000 });
    await expect(senderPage.getByTestId('guest-payer-payment-review')).toHaveCount(0);
    await expect(senderPage.getByTestId('guest-actual-receipt-status')).toHaveCount(0);
    const sparse = await trpcResult(await trpcQuery(other.request, 'guest.getSession', { token }));
    expect(sparse.people).toHaveLength(3);
    expect(sparse.summary).toHaveLength(2);
    await expect(privateReview.getByText('Без блюд', { exact: true })).toHaveCount(0);
    await expect(senderPage.getByTestId('guest-mark-paid')).toBeVisible();
    const bank = await trpcMutation(other.request, 'guest.getPayerSbpForReimbursement', {
      token,
      personId: sender.personId,
      personToken: sender.personToken,
    });
    expect(bank.ok(), await bank.text()).toBe(true);

    // Payer enters a real 6.60 transfer against a fixed 6.00 RUB debt.
    const receivedInput = row.getByTestId('guest-payer-received-input-' + sender.personId);
    await receivedInput.fill('6,60');
    await expect(row.getByTestId('payer-excess-choice-' + sender.personId)).toContainText('0,60');
    await row.getByTestId('guest-payer-excess-choice-' + sender.personId).selectOption('tip');
    await row.getByTestId('guest-payer-verify-' + sender.personId).click();
    await expect(privateReview.getByTestId('guest-payer-total-extra-tips')).toContainText('0,60', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('finalized-combined-waiter-tips')).toContainText('0,60', { timeout: 15_000 });
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,60', { timeout: 15_000 });
    await expect(privateReview.getByTestId('guest-payer-actual-received')).toContainText('6,60');
    await expect(privateReview.getByTestId('guest-payer-actual-credited')).toContainText('6,00');
    await expect(senderPage.getByTestId('guest-actual-receipt-status')).toContainText('6,60', {
      timeout: 15_000,
    });

    // Atomic correction: original remains in audit, replacement makes the
    // extra tip 0.95 instead of 0.60 without a second 6.00 debt.
    const edit = row.locator('[data-testid^="payer-actual-edit-"]').first();
    await expect(edit).toBeVisible();
    await edit.click();
    const correction = row.locator('[data-testid^="payer-actual-correction-input-"]');
    await expect(correction).toHaveValue('6.60');
    await correction.fill('6,95');
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await row.locator('[data-testid^="payer-actual-correction-save-"]').click();
    await expect(privateReview.getByTestId('guest-payer-total-extra-tips')).toContainText('0,95', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('finalized-combined-waiter-tips')).toContainText('0,95', { timeout: 15_000 });
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,95', { timeout: 15_000 });
    await expect(senderPage.getByTestId('guest-actual-receipt-status')).toContainText('6,95', {
      timeout: 15_000,
    });
    await expect(row.locator('[data-testid^="payer-received-transfers-"]')).toContainText('6,60');
    await expect(row.locator('[data-testid^="payer-received-transfers-"]')).toContainText('6,95');
    await expect(row.getByTestId('guest-payer-payment-amount')).toContainText('6,00');

    // Reclassify the whole surplus, then record an externally completed
    // partial refund. It must not become tips or reduce original dish shares.
    await row.getByTestId('payer-choice-edit-' + sender.personId).selectOption('refund');
    await row.getByTestId('payer-choice-save-' + sender.personId).click();
    await expect(row).toContainText('0,95');
    await expect(privateReview.getByTestId('guest-payer-total-extra-tips')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('finalized-combined-waiter-tips')).toContainText('0,00', { timeout: 15_000 });
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,00', { timeout: 15_000 });
    await row.getByTestId('payer-refund-input-' + sender.personId).fill('0,40');
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await row.getByTestId('payer-refund-confirm-' + sender.personId).click();
    await expect(row).toContainText('0,55', { timeout: 15_000 });
    await expect(row).toContainText('0,40');
    await expect(privateReview.getByTestId('guest-payer-actual-toRefund')).toContainText('0,55');
    await expect(privateReview.getByTestId('guest-payer-actual-refunded')).toContainText('0,40');
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,00');
    await expect(senderPage.getByTestId('guest-actual-receipt-status')).toContainText('0,40', {
      timeout: 15_000,
    });

    const publicReceipt = await trpcResult(await trpcQuery(other.request, 'guest.getSession', { token }));
    expect(publicReceipt.summary.map((member: { total: number }) => member.total)).toEqual([600, 600]);
    expect(JSON.stringify(publicReceipt)).not.toContain('correctsTransferId');

    // Inspect exact controls at all mandated mobile widths. No general
    // horizontal-scroll check can substitute a diagnosis of a clipped field.
    for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 480 });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      for (const control of [
        page.getByTestId('finalized-bill-total'),
        page.getByTestId('finalized-combined-waiter-tips'),
        privateReview.getByTestId('guest-payer-payment-summary'),
        row.getByTestId('payer-choice-edit-' + sender.personId),
        row.locator('[data-testid^="payer-actual-edit-"]').first(),
      ]) {
        await expect(async () => {
          const rect = await control.evaluate((element) => {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            const box = element.getBoundingClientRect();
            return { x: box.x, right: box.right, height: box.height };
          });
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.x, 'left overflow at ' + width).toBeGreaterThanOrEqual(-1);
          expect(rect.right, 'right overflow at ' + width).toBeLessThanOrEqual(width + 1);
        }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token });
    await other.close();
    await owner.dispose();
  }
});

test('Issue #19 12.3: actual 1000 RUB transfer includes 35 RUB waiter tips on 1265 RUB receipt', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const guestDevice = await browser.newContext({
    viewport: { width: 320, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | null = null;
  try {
    const createdResponse = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Чек 1265 с чаевыми',
        subtotal: 126500,
        total: 126500,
        tax: 0,
        tip: 0,
        currency: 'RUB',
      },
      items: [
        { name: 'Плательщик', quantity: 1, unitPrice: 30000, totalPrice: 30000 },
        { name: 'Андрей', quantity: 1, unitPrice: 96500, totalPrice: 96500 },
      ],
      people: ['Плательщик', 'Андрей'],
      creatorName: 'Плательщик',
      paidByName: 'Плательщик',
      joinCreator: true,
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = (await createdResponse.json()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const payer = created.creator;
    const andrey = await joinGuestSession(guestDevice.request, { token, name: 'Андрей' });
    for (const [participant, itemIndex] of [
      [payer, 0],
      [andrey, 1],
    ] as const) {
      const ctx = participant.personId === payer.personId ? owner : guestDevice.request;
      const claim = await trpcMutation(ctx, 'guest.claimItems', {
        token,
        personId: participant.personId,
        personToken: participant.personToken,
        claimedItemIndices: [itemIndex],
      });
      expect(claim.ok(), await claim.text()).toBe(true);
    }
    const approval = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(approval.ok(), await approval.text()).toBe(true);
    const final = await trpcMutation(owner, 'guest.finalizeSession', {
      token,
      personId: payer.personId,
      personToken: payer.personToken,
    });
    expect(final.ok(), await final.text()).toBe(true);
    const original = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(
      original.summary.map((entry: { total: number }) => entry.total).sort((a: number, b: number) => a - b),
    ).toEqual([30000, 96500]);
    await rememberClaimIdentity(page.context(), token, payer);
    await rememberClaimIdentity(guestDevice, token, andrey);
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    const review = page.getByTestId('guest-payer-payment-review').filter({ visible: true });
    await expect(review).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('finalized-bill-total')).toContainText('1 265,00', { timeout: 20_000 });
    const guestPage = await guestDevice.newPage();
    await guestPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(guestPage.getByTestId('guest-payer-payment-review')).toHaveCount(0);
    await expect(guestPage.getByTestId('finalized-extra-waiter-tips')).toHaveCount(0);
    const row = review.getByTestId('guest-payer-payment-' + andrey.personId);
    await row.getByTestId('guest-payer-received-input-' + andrey.personId).fill('1000');
    await row.getByTestId('guest-payer-excess-choice-' + andrey.personId).selectOption('tip');
    await row.getByTestId('guest-payer-verify-' + andrey.personId).click();
    await expect(page.getByTestId('finalized-food-total')).toContainText('1 265,00');
    await expect(page.getByTestId('finalized-waiter-tip-total')).toContainText('0,00');
    await expect(page.getByTestId('finalized-extra-waiter-tips')).toContainText('35,00', { timeout: 20_000 });
    await expect(page.getByTestId('finalized-combined-waiter-tips')).toContainText('35,00');
    await expect(page.getByTestId('finalized-bill-total')).toContainText('1 300,00');
    await expect(review.getByTestId('guest-payer-actual-received')).toContainText('1 000,00');
    await expect(review.getByTestId('guest-payer-actual-credited')).toContainText('965,00');
    await expect(review.getByTestId('guest-payer-summary-outstanding')).toContainText('0,00');
    await expect(guestPage.getByTestId('finalized-bill-total')).toContainText('1 265,00');
    const saved = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(saved.receiptData.total).toBe(126500);
    expect(saved.summary).toEqual(original.summary);
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 760 });
      for (const selector of [
        page.getByTestId('finalized-combined-waiter-tips'),
        page.getByTestId('finalized-bill-total'),
        review.getByTestId('guest-payer-actual-received'),
        review.getByTestId('guest-payer-actual-credited'),
      ]) {
        const rect = await selector.boundingBox();
        expect(rect && rect.x >= -1 && rect.x + rect.width <= width + 1).toBeTruthy();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await guestDevice.close();
    await owner.dispose();
  }
});
