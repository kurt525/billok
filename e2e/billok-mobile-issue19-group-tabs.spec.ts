import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { loginWithPasskey } from './passkey-auth';
import {
  authedContext,
  joinGuestSession,
  rememberClaimIdentity,
  trpcMutation,
  trpcQuery,
  trpcResult,
  users,
} from './helpers';

test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true });

test('Issue #19 14–16: two group subtabs, authorized renaming and grouped totals', async ({ page, browser }) => {
  test.setTimeout(225_000);
  const owner = await authedContext(users.alice.email, users.alice.password);
  const guestDevice = await browser.newContext({
    viewport: { width: 320, height: 760 },
    isMobile: true,
    hasTouch: true,
  });
  let token: string | null = null;
  try {
    const response = await trpcMutation(owner, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Группы и итог', subtotal: 100000, total: 100000, tax: 0, tip: 0, currency: 'RUB' },
      items: [{ name: 'Пицца', quantity: 5, unitPrice: 20000, totalPrice: 100000 }],
      people: ['Андрей', 'Гость 2', 'Гость 3', 'Гость 4'],
      creatorName: 'Илья',
      paidByName: 'Илья',
      joinCreator: true,
    });
    expect(response.ok(), await response.text()).toBe(true);
    const created = (await response.json()).result.data.json as {
      shareToken: string;
      creator: { personId: string; personToken: string; name: string };
    };
    token = created.shareToken;
    const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    const index = (name: string) =>
      (initial.people as { id: string; name: string }[]).findIndex((p) => p.name === name);
    const id = (name: string) => (initial.people as { id: string; name: string }[])[index(name)]!.id;
    const andrey = id('Андрей'),
      guest2 = id('Гость 2'),
      guest3 = id('Гость 3'),
      guest4 = id('Гость 4');
    const authorIndex = index('Илья');
    await loginWithPasskey(page, users.alice.email);
    await rememberClaimIdentity(page.context(), token, created.creator);
    await page.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('claim-tab-people')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('claim-tab-people').click();
    const editor = page.getByTestId('receipt-payment-groups-editor');
    await expect(editor.getByTestId('people-subtab-all')).toHaveAttribute('aria-selected', 'true');
    const allCards = editor.getByTestId('people-subpanel-all').locator('[data-testid^="guest-color-person-"]');
    await expect(allCards).toHaveCount(5);
    await expect(allCards.first()).toHaveAttribute('data-testid', 'guest-color-person-' + authorIndex);
    await expect(editor.locator('[data-testid^="preview-group-"]')).toHaveCount(0);
    // Create the first group using exactly the visible '+ Группа' UI.
    await editor.getByTestId('people-subtab-create').click();
    await editor.getByTestId('payment-group-leader-select').selectOption(andrey);
    await editor
      .getByTestId('payment-group-member-' + guest2)
      .locator('input')
      .check();
    await editor.getByTestId('payment-group-create').click();
    await expect(editor.getByTestId('people-subtab-group-0')).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    });
    await expect(editor.getByTestId('payment-group-person-' + andrey)).toBeVisible();
    await expect(editor.getByTestId('payment-group-person-' + guest2)).toBeVisible();
    await expect(editor.getByTestId('payment-group-person-' + guest3)).toHaveCount(0);
    // Creating a second group doesn't change the first.
    await editor.getByTestId('people-subtab-create').click();
    await editor.getByTestId('payment-group-leader-select').selectOption(guest3);
    await editor
      .getByTestId('payment-group-member-' + guest4)
      .locator('input')
      .check();
    await editor.getByTestId('payment-group-create').click();
    await expect(editor.getByTestId('people-subtab-group-1')).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    });
    await expect(editor.getByTestId('receipt-payment-group-1')).toContainText('Гость 3');
    await expect(editor.getByTestId('receipt-payment-group-1')).toContainText('Гость 4');
    await editor.getByTestId('people-subtab-group-0').click();
    await expect(editor.getByTestId('receipt-payment-group-0')).toBeVisible();
    await expect(editor.getByTestId('receipt-payment-group-1')).toBeHidden();
    await editor.getByTestId('people-subtab-all').click();
    await expect(allCards).toHaveCount(5);
    await expect(allCards.first()).toHaveAttribute('data-testid', 'guest-color-person-' + authorIndex);
    await expect(editor.getByTestId('people-subtab-create')).toHaveCount(0);
    expect(await editor.getByTestId('people-subpanel-all').getByText('Группа 1').count()).toBe(0);
    const groupState = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(groupState.people.find((p: { id: string }) => p.id === guest2).paymentGroupRepresentativeId).toBe(andrey);
    expect(groupState.people.find((p: { id: string }) => p.id === guest4).paymentGroupRepresentativeId).toBe(guest3);
    // Representative receives no group-administration controls, but can edit
    // only the display name of their own group member.
    const representative = await joinGuestSession(guestDevice.request, { token, name: 'Андрей' });
    await rememberClaimIdentity(guestDevice, token, representative);
    const guestPage = await guestDevice.newPage();
    await guestPage.goto('/split/' + token + '/claim', { waitUntil: 'domcontentloaded' });
    await guestPage.getByTestId('claim-tab-people').click();
    const memberEditor = guestPage.getByTestId('receipt-payment-groups-editor');
    await expect(memberEditor.getByTestId('people-subtab-create')).toHaveCount(0);
    await memberEditor.getByTestId('people-subtab-group-0').click();
    await memberEditor.getByTestId('group-edit-person-' + guest2).click();
    await memberEditor.getByTestId('group-edit-name-input-' + guest2).fill('Мария');
    await memberEditor.getByTestId('group-edit-name-input-' + guest2).press('Enter');
    await expect(memberEditor.getByTestId('payment-group-person-' + guest2)).toContainText('Мария', {
      timeout: 20_000,
    });
    await memberEditor.getByTestId('people-subtab-group-1').click();
    await expect(memberEditor.getByTestId('group-edit-person-' + guest3)).toHaveCount(0);
    await expect(memberEditor.getByTestId('group-edit-person-' + guest4)).toHaveCount(0);
    const forbidden = await trpcMutation(guestDevice.request, 'guest.editPersonName', {
      token,
      personToken: representative.personToken,
      targetId: guest4,
      newName: 'Чужой',
    });
    expect(forbidden.ok()).toBe(false);
    await expect
      .poll(
        async () => {
          const state = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
          return state.people.find((p: { id: string }) => p.id === guest2)?.name;
        },
        { timeout: 20_000 },
      )
      .toBe('Мария');
    // Current group's leader may change without losing the selected tab.
    await editor.getByTestId('people-subtab-group-0').click();
    await editor.getByTestId('payment-group-leader-' + guest2).click();
    await expect(editor.getByTestId('people-subtab-group-0')).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    });
    const firstRow = editor
      .getByTestId('receipt-payment-group-0')
      .locator('[data-testid^="payment-group-person-"]')
      .first();
    await expect(firstRow).toHaveAttribute('data-testid', 'payment-group-person-' + guest2);
    await editor.getByTestId('people-subtab-all').click();
    await expect(allCards.first()).toHaveAttribute('data-testid', 'guest-color-person-' + authorIndex);
    // Allocate five fixed portions, without modifying original diner identity.
    const save = await trpcMutation(owner, 'guest.setReceiptItemParts', {
      token,
      itemIndex: 0,
      changes: initial.people.map((p: { id: string }) => ({ personId: p.id, parts: 1 })),
      requestKey: randomUUID(),
    });
    expect(save.ok(), await save.text()).toBe(true);
    await page.getByTestId('claim-tab-items').click();
    await expect(page.locator('[data-testid^="preview-group-"]')).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByTestId('person-total-' + authorIndex)).toBeVisible();
    await expect(page.locator('[data-testid^="person-total-"]').first()).toHaveAttribute(
      'data-testid',
      'person-total-' + authorIndex,
    );
    const actual = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(actual.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0)?.personIndices).toHaveLength(5);
    expect(actual.people.map((p: { id: string }) => p.id)).toEqual(initial.people.map((p: { id: string }) => p.id));
    await page.addStyleTag({ content: 'html {font-size:20px !important}' });
    for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 760 });
      await expect(page.locator('[data-testid^="preview-group-"]')).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
    await page.getByTestId('claim-tab-people').click();
    await expect(editor.getByTestId('people-subtab-all')).toBeVisible();
    // Keyboard navigation: right arrow selects the first real group tab.
    await editor.getByTestId('people-subtab-all').focus();
    await editor.getByTestId('people-subtab-all').press('ArrowRight');
    await expect(editor.getByTestId('people-subtab-group-0')).toHaveAttribute('aria-selected', 'true');
    await editor.getByTestId('people-subtab-all').click();
    for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 760 });
      const bounds = await editor.getByTestId('people-subtabs').boundingBox();
      expect(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1).toBeTruthy();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
    // The same group presentation applies after finalization. Never produce
    // a new group debtor as an extra personal financial row.
    const confirmed = await trpcMutation(owner, 'guest.confirmSessionParts', { token });
    expect(confirmed.ok(), await confirmed.text()).toBe(true);
    const finished = await trpcMutation(owner, 'guest.finalizeSession', { token });
    expect(finished.ok(), await finished.text()).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid^="finalized-group-"]')).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator('[data-testid^="finalized-person-card-"]').first()).toHaveAttribute(
      'data-testid',
      'finalized-person-card-' + authorIndex,
    );
    const finalData = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token }));
    expect(finalData.status).toBe('FINALIZED');
    expect(finalData.summary.reduce((sum: number, row: { total: number }) => sum + row.total, 0)).toBe(100000);
    expect(finalData.summary).toHaveLength(5);
    for (const width of [320, 360, 393, 412, 430, 480, 600, 720]) {
      await page.setViewportSize({ width, height: 760 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
  } finally {
    if (token) await trpcMutation(owner, 'guest.expireSession', { token }).catch(() => undefined);
    await guestDevice.close();
    await owner.dispose();
  }
});
