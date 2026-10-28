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
      await dialog.getByRole('button', { name: 'Отмена' }).click();
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
  test.setTimeout(125_000);
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
      paidByName: 'Анна',
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
    await expect(page.getByTestId('finalized-bill-total')).toContainText('12,01');
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
    await fitsPhone(otherPage);
    await otherPage.goto('/split/' + token, { waitUntil: 'networkidle' });
    await expect(otherPage.getByTestId('split-result-total')).toContainText('12,01');
    await expect(otherPage.getByTestId('split-result-personal-tips')).toContainText('2,00');
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
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token });
    await owner.dispose();
  }
});
