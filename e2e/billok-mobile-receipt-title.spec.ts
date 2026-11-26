import { expect, test, type Page, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authedPasskeyContext } from './passkey-auth';
import { rememberClaimIdentity, trpcMutation, trpcQuery, trpcResult, users } from './helpers';

const widths = [320, 360, 393, 412, 430, 480, 600, 720];
const mobile = { viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true };

async function mutationResult(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data.json;
}

async function rename(page: Page, title: string) {
  await page.getByTestId('receipt-rename-input').fill(title);
  await page.getByTestId('receipt-rename-save').click();
  await expect(page.getByTestId('receipt-rename-dialog')).toHaveCount(0);
}

async function checkViewport(page: Page) {
  const fit = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(fit).toBe(true);
  for (const element of await page.getByTestId('receipt-rename-open').filter({ visible: true }).all()) {
    const box = await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
}

test('Issue #19 section 20: author and system owner rename a paid receipt from page and list; public rights and ledger unchanged', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const author = await authedPasskeyContext(users.alice.email);
  const owner = await authedPasskeyContext('owner-qa@mail.ru');
  const authorContext = await browser.newContext({ ...mobile, storageState: await author.storageState() });
  const ownerContext = await browser.newContext({ ...mobile, storageState: await owner.storageState() });
  const guestContext = await browser.newContext(mobile);
  const stranger = await authedPasskeyContext(users.bob.email);
  let id: string | undefined;
  try {
    const initialTitle = 'Переименование ' + randomUUID();
    const created = await mutationResult(
      await trpcMutation(author, 'guest.createClaimSession', {
        receiptData: { merchantName: initialTitle, subtotal: 126500, total: 126500, tax: 0, tip: 0, currency: 'RUB' },
        items: [
          { name: 'Блюдо автора', quantity: 1, unitPrice: 96500, totalPrice: 96500 },
          { name: 'Блюдо плательщика', quantity: 1, unitPrice: 30000, totalPrice: 30000 },
        ],
        guestCount: 1,
        paidByGuestSlot: 1,
        joinCreator: true,
      }),
    );
    const token: string = created.shareToken;
    const initial = await trpcResult(await trpcQuery(author, 'guest.getSession', { token }));
    id = initial.id;
    const path = '/split/' + token + '/claim';
    const guest = await mutationResult(
      await trpcMutation(guestContext.request, 'guest.joinGuestSlot', {
        token,
        slotId: initial.people[1].id,
        name: 'Плательщик QA',
        joinKey: randomUUID(),
      }),
    );
    await rememberClaimIdentity(authorContext, token, created.creator);
    await rememberClaimIdentity(guestContext, token, guest);
    const authorPage = await authorContext.newPage();
    const guestPage = await guestContext.newPage();
    const ownerPage = await ownerContext.newPage();
    const listPage = await authorContext.newPage();
    await authorPage.goto(path);
    await guestPage.goto(path);
    await expect(guestPage.getByTestId('receipt-title')).toHaveText(initialTitle);
    await expect(guestPage.getByTestId('receipt-rename-open')).toHaveCount(0);

    // Author is not the payer. First rename before assigning dishes.
    await authorPage.getByTestId('receipt-rename-open').click();
    await expect(authorPage.getByTestId('receipt-rename-input')).toHaveValue(initialTitle);
    await authorPage.getByTestId('receipt-rename-input').fill('   ');
    await authorPage.getByTestId('receipt-rename-save').click();
    await expect(authorPage.getByTestId('receipt-rename-dialog').getByRole('alert')).toContainText('Введите название');
    await authorPage.getByTestId('receipt-rename-input').fill('Я'.repeat(121));
    await authorPage.getByTestId('receipt-rename-save').click();
    await expect(authorPage.getByTestId('receipt-rename-dialog').getByRole('alert')).toContainText('120');
    await authorPage.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(authorPage.getByTestId('receipt-title')).toHaveText(initialTitle);
    await authorPage.getByTestId('receipt-rename-open').click();
    await rename(authorPage, '  До распределения  ');
    await expect(guestPage.getByTestId('receipt-title')).toHaveText('До распределения', { timeout: 20000 });

    // Concurrent title and financial writes must both survive.
    const results = await Promise.all([
      trpcMutation(author, 'guest.renameReceipt', { id, title: 'Во время распределения' }),
      trpcMutation(author, 'guest.setReceiptItemParts', {
        token,
        itemIndex: 0,
        changes: [{ personId: created.creator.personId, parts: 1 }],
        requestKey: randomUUID(),
      }),
    ]);
    for (const result of results) expect(result.ok(), await result.text()).toBe(true);
    const assigned = await trpcMutation(author, 'guest.setReceiptItemParts', {
      token,
      itemIndex: 1,
      changes: [{ personId: guest.personId, parts: 1 }],
      requestKey: randomUUID(),
    });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    const during = await trpcResult(await trpcQuery(author, 'guest.getSession', { token }));
    expect(during.receiptData.merchantName).toBe('Во время распределения');
    expect(during.assignments).toHaveLength(2);
    await expect(authorPage.getByTestId('receipt-title')).toHaveText('Во время распределения', { timeout: 20000 });
    for (const ctx of [guestContext.request, stranger]) {
      expect((await trpcMutation(ctx, 'guest.renameReceipt', { id, title: 'Чужое имя' })).ok()).toBe(false);
    }
    const approved = await trpcMutation(author, 'guest.confirmSessionParts', { token });
    expect(approved.ok(), await approved.text()).toBe(true);
    const finalized = await trpcMutation(author, 'guest.finalizeSession', { token });
    expect(finalized.ok(), await finalized.text()).toBe(true);
    await expect(authorPage.getByTestId('receipt-title')).toHaveText('Во время распределения');
    await expect(authorPage.getByTestId('finalized-food-total')).toBeVisible({ timeout: 20000 });
    await authorPage.getByTestId('receipt-rename-open').click();
    await rename(authorPage, 'После распределения');
    const payer = {
      token,
      personId: guest.personId,
      personToken: guest.personToken,
      debtorId: created.creator.personId,
    };
    const first = await trpcMutation(guestContext.request, 'guest.recordGuestPaymentReceived', {
      ...payer,
      requestId: randomUUID(),
      receivedAmountCents: 60000,
    });
    expect(first.ok(), await first.text()).toBe(true);
    await authorPage.getByTestId('receipt-rename-open').click();
    await rename(authorPage, 'Частично оплачено');
    const second = await trpcMutation(guestContext.request, 'guest.recordGuestPaymentReceived', {
      ...payer,
      requestId: randomUUID(),
      receivedAmountCents: 40500,
      overpaymentChoice: 'tip',
    });
    expect(second.ok(), await second.text()).toBe(true);
    const before = await trpcResult(await trpcQuery(author, 'guest.getSession', { token }));
    const privateBefore = await mutationResult(
      await trpcMutation(guestContext.request, 'guest.getMyPayerPaymentReview', {
        token,
        personId: guest.personId,
        personToken: guest.personToken,
      }),
    );

    // Direct rename from the list, without opening the receipt.
    await listPage.goto('/splits');
    const card = listPage.getByTestId('split-card-' + id);
    await expect(card).toContainText('Частично оплачено');
    const longTitle = 'Длинное название ' + 'Я'.repeat(100);
    await card.getByTestId('receipt-rename-open').click();
    await rename(listPage, longTitle);
    await expect(listPage).toHaveURL(/\/splits$/);
    await expect(card).toContainText(longTitle);
    await expect(authorPage.getByTestId('receipt-title')).toHaveText(longTitle, { timeout: 25000 });
    await expect(guestPage.getByTestId('receipt-title')).toHaveText(longTitle, { timeout: 25000 });

    for (const width of widths) {
      for (const page of [authorPage, listPage]) {
        await page.setViewportSize({ width, height: 760 });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '125%';
        });
        await checkViewport(page);
      }
      await card.getByTestId('receipt-rename-open').click();
      await expect(listPage.getByTestId('receipt-rename-input')).toHaveValue(longTitle);
      const dialog = listPage.getByTestId('receipt-rename-dialog');
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      await expect(listPage.getByTestId('receipt-rename-save')).toBeVisible();
      await listPage.getByRole('button', { name: 'Отмена', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }

    // The actual system owner is not a participant, but has this metadata right.
    await ownerPage.goto('/splits');
    await expect(ownerPage.getByRole('heading', { name: 'Все чеки' })).toBeVisible();
    const ownerCard = ownerPage.getByTestId('split-card-' + id);
    await expect(ownerCard).toContainText(longTitle);
    await expect(ownerCard.getByTestId('delete-split-' + id)).toHaveCount(0);
    await ownerCard.getByTestId('receipt-rename-open').click();
    await rename(ownerPage, 'Название владельца');
    await expect(ownerCard).toContainText('Название владельца');
    await ownerCard.getByRole('link').click();
    await expect(ownerPage.getByTestId('receipt-title')).toHaveText('Название владельца');
    await ownerPage.getByTestId('receipt-rename-open').click();
    await rename(ownerPage, 'Проверено владельцем');
    await expect(authorPage.getByTestId('receipt-title')).toHaveText('Проверено владельцем', { timeout: 25000 });
    await guestPage.reload();
    await expect(guestPage.getByTestId('receipt-title')).toHaveText('Проверено владельцем');
    const after = await trpcResult(await trpcQuery(author, 'guest.getSession', { token }));
    for (const field of [
      'id',
      'shareToken',
      'status',
      'people',
      'items',
      'assignments',
      'summary',
      'paidByIndex',
      'expiresAt',
      'finalizationRevision',
    ]) {
      expect(after[field], field).toEqual(before[field]);
    }
    expect(after.receiptData).toEqual({ ...before.receiptData, merchantName: 'Проверено владельцем' });
    expect(
      await mutationResult(
        await trpcMutation(guestContext.request, 'guest.getMyPayerPaymentReview', {
          token,
          personId: guest.personId,
          personToken: guest.personToken,
        }),
      ),
    ).toEqual(privateBefore);

    // Expiry leaves authorized list rename available, without public access.
    const expired = await trpcMutation(author, 'guest.expireSession', { token });
    expect(expired.ok(), await expired.text()).toBe(true);
    expect((await trpcQuery(guestContext.request, 'guest.getSession', { token })).ok()).toBe(false);
    expect((await trpcMutation(owner, 'guest.renameReceipt', { id, title: 'После истечения ссылки' })).ok()).toBe(true);
    const archive = await trpcResult(await trpcQuery(author, 'guest.getSplit', { token }));
    expect(archive.receiptData.merchantName).toBe('После истечения ссылки');
    expect(archive.archivedCreatorView).toBe(true);
  } finally {
    if (id) await trpcMutation(author, 'guest.deleteSplit', { id }).catch(() => undefined);
    await Promise.all([
      authorContext.close(),
      ownerContext.close(),
      guestContext.close(),
      author.dispose(),
      owner.dispose(),
      stranger.dispose(),
    ]);
  }
});
