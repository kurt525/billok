import { expect, test, type Page } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcMutation } from './helpers';

// The same real signed CI Passkey session as the mandatory mobile acceptance suite.
async function signIn(page: Page) {
  const api = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    await page.context().addCookies((await api.storageState()).cookies);
  } finally {
    await api.dispose();
  }
}

async function startManualReceipt(page: Page, names: string[], payerIndex: number) {
  await page.goto('/split');
  await page.getByTestId('workflow-manual').click();
  await page.getByTestId('manual-receipt-name').fill('Общий ужин');
  for (const [index, name] of names.entries()) {
    if (index > 0) await page.getByTestId('add-person-btn').click();
    await page.getByTestId('person-input-' + index).fill(name);
  }
  await page.locator('#who-paid').selectOption(String(payerIndex));
  await page.getByTestId('next-assign-btn').click();
  await page.getByTestId('guest-add-item-btn').click();
  const inputs = page.getByTestId('guest-add-item-submit').locator('xpath=ancestor::form').locator('input');
  await inputs.nth(0).fill('Ужин');
  await inputs.nth(1).fill('1');
  await inputs.nth(2).fill('500,00');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(page.getByTestId('share-for-claiming-btn')).toBeEnabled();
  await page.getByTestId('share-for-claiming-btn').click();
  await expect(page).toHaveURL(/\/split\/[^/]+\/claim(?:\?.*)?$/);
}

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });

test('9.3: sharing a manual receipt reserves the payer for its creator', async ({ page, browser }) => {
  await signIn(page);
  await startManualReceipt(page, ['Антон', 'Павел'], 1);
  await expect(page.getByTestId('claim-join-form')).toHaveCount(0);
  await expect(page.getByTestId('switch-person-1')).toBeEnabled();
  // Создатель распределяет позиции всех участников, но гости не могут занять его место.
  await expect(page.getByTestId('switch-person-0')).toBeEnabled();

  const visitorContext = await browser.newContext({
    viewport: { width: 320, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const visitor = await visitorContext.newPage();
    await visitor.goto(page.url());
    await expect(visitor.getByTestId('claim-join-form')).toBeVisible();
    await expect(visitor.getByTestId('rejoin-person-0')).toContainText('Антон');
    await expect(visitor.getByTestId('rejoin-person-1')).toHaveCount(0);
  } finally {
    await visitorContext.close();
  }
});

test('9.3: manual sharing without browser storage leaves creator seat claimable', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Недостаточно места', 'QuotaExceededError');
    };
  });
  await startManualReceipt(page, ['Павел', 'Антон'], 0);
  await expect(page.getByTestId('claim-join-form')).toBeVisible();
  await expect(page.getByTestId('rejoin-person-0')).toContainText('Павел');
  await page.getByTestId('rejoin-person-0').click();
  await expect(page.getByTestId('switch-person-0')).toBeEnabled();
});

test('9.3: sharing a manual group receipt joins the signed-in group member', async ({ page }) => {
  await signIn(page);
  const group = await trpcMutation(page.request, 'groups.create', { name: 'Group Share ' + Date.now() });
  const groupBody = await group.json();
  expect(group.ok(), JSON.stringify(groupBody)).toBe(true);
  const groupId = groupBody.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();
  const created = await trpcMutation(page.request, 'receipts.createManual', { groupId });
  const receiptBody = await created.json();
  expect(created.ok(), JSON.stringify(receiptBody)).toBe(true);
  const receiptId = receiptBody.result?.data?.json?.receiptId as string;
  expect(receiptId).toBeTruthy();
  const added = await trpcMutation(page.request, 'receipts.addItem', {
    receiptId,
    name: 'Суп',
    quantity: 1,
    unitPrice: 10000,
    totalPrice: 10000,
  });
  expect(added.ok(), await added.text()).toBe(true);

  await page.goto('/groups/' + groupId + '/scan?receiptId=' + receiptId);
  const share = page.getByTestId('group-share-claiming-btn');
  await expect(share).toBeEnabled();
  await share.click();
  await expect(page).toHaveURL(/\/split\/[^/]+\/claim(?:\?.*)?$/);
  await expect(page.getByTestId('claim-join-form')).toHaveCount(0);
  await expect(page.getByTestId('switch-person-0')).toBeEnabled();
});
