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
      people: ['Плательщик', 'Участник'],
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

    // Payer enters a real 6.60 transfer against a fixed 6.00 RUB debt.
    const receivedInput = row.getByTestId('guest-payer-received-input-' + sender.personId);
    await receivedInput.fill('6,60');
    await expect(row.getByTestId('payer-excess-choice-' + sender.personId)).toContainText('0,60');
    await row.getByTestId('guest-payer-excess-choice-' + sender.personId).selectOption('tip');
    await row.getByTestId('guest-payer-verify-' + sender.personId).click();
    await expect(privateReview.getByTestId('guest-payer-total-extra-tips')).toContainText('0,60', {
      timeout: 15_000,
    });
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
    await row.getByTestId('payer-refund-input-' + sender.personId).fill('0,40');
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await row.getByTestId('payer-refund-confirm-' + sender.personId).click();
    await expect(row).toContainText('0,55', { timeout: 15_000 });
    await expect(row).toContainText('0,40');
    await expect(senderPage.getByTestId('guest-actual-receipt-status')).toContainText('0,40', {
      timeout: 15_000,
    });

    const publicReceipt = await trpcResult(await trpcQuery(other.request, 'guest.getSession', { token }));
    expect(publicReceipt.summary.map((member: { total: number }) => member.total)).toEqual([600, 600]);
    expect(JSON.stringify(publicReceipt)).not.toContain('correctsTransferId');

    // Inspect exact controls at all mandated mobile widths. No general
    // horizontal-scroll check can substitute a diagnosis of a clipped field.
    for (const width of [320, 360, 393, 412, 600, 720]) {
      await page.setViewportSize({ width, height: 480 });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      for (const control of [
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
