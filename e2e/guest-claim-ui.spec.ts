import { randomUUID } from 'node:crypto';
import { test, expect, request, type Locator, type Page } from '@playwright/test';
import {
  authedContext,
  createUnifiedReceiptFixture,
  finalizeUnifiedReceiptFixture,
  trpcMutation,
  trpcQuery,
  trpcResult,
} from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

test.describe('Unified BillOK receipt — finalized result and historic reader', () => {
  let token: string;
  let creatorName: string;

  test.beforeAll(async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Семейный ужин',
        guestCount: 0,
        items: [
          { name: 'Пицца', quantity: 1, unitPrice: 1500, totalPrice: 1500 },
          { name: 'Салат', quantity: 1, unitPrice: 1200, totalPrice: 1200 },
          { name: 'Напитки', quantity: 1, unitPrice: 1800, totalPrice: 1800 },
        ],
      });
      token = receipt.shareToken;
      creatorName = receipt.creator.name;
      await finalizeUnifiedReceiptFixture(ctx, receipt, [0, 1, 2]);
    } finally {
      await ctx.dispose();
    }
  });

  test('final result page shows correct receipt name, total and share controls', async ({ page }) => {
    await page.goto('/split/' + token);
    await expect(page.getByTestId('split-result')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Семейный ужин' })).toBeVisible();
    await expect(page.getByTestId('split-result-total')).toContainText('45');
    await expect(page.getByTestId('person-card-0')).toBeVisible();
    await page.getByTestId('claim-tab-links').click();
    await expect(page.getByTestId('copy-link-btn')).toBeVisible();
  });

  test('finalized person card belongs to the same registered creator who claimed dishes', async ({ page }) => {
    await page.goto('/split/' + token);
    const card = page.getByTestId('person-card-0');
    await expect(card).toContainText(creatorName);
    await expect(card.getByText('Пицца')).toBeVisible();
    await expect(card.getByText('Салат')).toBeVisible();
    await expect(card.getByText('Напитки')).toBeVisible();
  });

  test('invalid share token never renders an existing finalized receipt', async ({ page }) => {
    await page.goto('/split/nonexistent-token-abc123');
    await expect(page.getByTestId('split-result')).toHaveCount(0);
    await expect(page.getByText('Семейный ужин')).toHaveCount(0);
  });
});

test.describe('Unified BillOK shared-dish result: per-person amounts', () => {
  const numericCents = (text: string) => Math.round(Number(text.replace(/[^\d,.]/g, '').replace(',', '.')) * 100);

  function personCard(page: Page, name: string) {
    return page.locator('[data-testid^="person-card-"]').filter({ hasText: name });
  }

  async function expectLinesAddUpToTotal(card: Locator) {
    const lines = await card.getByTestId('line-amount').allTextContents();
    const total = await card.locator('[data-testid^="person-total-"]').textContent();
    expect(lines.reduce((sum, line) => sum + numericCents(line), 0)).toBe(numericCents(total ?? ''));
  }

  test('a shared item divides exactly, and each person sees their actual part', async ({ page }) => {
    const owner = await authedContext('alice@qa.billok.ru');
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const receipt = await createUnifiedReceiptFixture(owner, {
        merchantName: 'Общая закуска',
        guestCount: 1,
        items: [
          { name: 'Лимонад', quantity: 1, unitPrice: 375, totalPrice: 375 },
          { name: 'Бургер', quantity: 1, unitPrice: 1600, totalPrice: 1600 },
        ],
      });
      const initial = await trpcResult(await trpcQuery(owner, 'guest.getSession', { token: receipt.shareToken }));
      const response = await trpcMutation(anon, 'guest.joinGuestSlot', {
        token: receipt.shareToken,
        slotId: initial.people[1].id,
        name: 'Гость',
        joinKey: randomUUID(),
      });
      expect(response.ok(), await response.text()).toBe(true);
      const guest = (await response.json()).result.data.json;

      const assignments = [
        { actor: owner, person: receipt.creator, items: [0, 1] },
        { actor: anon, person: guest, items: [0] },
      ] as const;
      for (const { actor, person, items } of assignments) {
        const saved = await trpcMutation(actor, 'guest.claimItems', {
          token: receipt.shareToken,
          personId: person.personId,
          personToken: person.personToken,
          claimedItemIndices: items,
        });
        expect(saved.ok(), await saved.text()).toBe(true);
      }
      for (const operation of ['guest.confirmSessionParts', 'guest.finalizeSession']) {
        const res = await trpcMutation(owner, operation, { token: receipt.shareToken });
        expect(res.ok(), await res.text()).toBe(true);
      }

      const split = await trpcResult(await trpcQuery(owner, 'guest.getSplit', { token: receipt.shareToken }));
      expect(split.summary).toHaveLength(2);
      const total = split.summary.reduce((sum: number, person: { total: number }) => sum + person.total, 0);
      expect(total).toBe(1975);
      const guestTotal = split.summary.find((person: { name: string }) => person.name === 'Гость')?.total;
      expect([187, 188]).toContain(guestTotal);

      await page.goto('/split/' + receipt.shareToken);
      await expect(page.getByTestId('split-result')).toBeVisible();
      const guestCard = personCard(page, 'Гость');
      const ownerCard = personCard(page, receipt.creator.name);
      await expect(guestCard).toContainText('Лимонад');
      await expect(ownerCard).toContainText('Лимонад');
      await expect(ownerCard).toContainText('Бургер');
      await expectLinesAddUpToTotal(ownerCard);
      await expectLinesAddUpToTotal(guestCard);
    } finally {
      await anon.dispose();
      await owner.dispose();
    }
  });

  test('reading the same finalized receipt never changes its saved allocations', async () => {
    const ctx = await authedContext('alice@qa.billok.ru');
    try {
      const receipt = await createUnifiedReceiptFixture(ctx, {
        merchantName: 'Проверка неизменности',
        guestCount: 0,
        items: [{ name: 'Чай', quantity: 1, unitPrice: 1001, totalPrice: 1001 }],
      });
      await finalizeUnifiedReceiptFixture(ctx, receipt, [0]);
      const first = await trpcResult(await trpcQuery(ctx, 'guest.getSplit', { token: receipt.shareToken }));
      const second = await trpcResult(await trpcQuery(ctx, 'guest.getSplit', { token: receipt.shareToken }));
      expect(second.assignments).toEqual(first.assignments);
      expect(second.summary).toEqual(first.summary);
      expect(second.paidByIndex).toBe(0);
    } finally {
      await ctx.dispose();
    }
  });
});
