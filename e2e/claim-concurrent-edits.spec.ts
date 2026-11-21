import { randomUUID } from 'node:crypto';
import { expect, test, request } from '@playwright/test';
import { joinGuestSession, rememberClaimIdentity, trpcMutation, trpcQuery, trpcResult } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const ITEMS = ['Tea', 'Cake', 'Pie'];

type Session = {
  people: { name: string }[];
  assignments: { itemIndex: number; personIndices: number[] }[];
};

async function claimsOf(ctx: Awaited<ReturnType<typeof request.newContext>>, shareToken: string, name: string) {
  const session: Session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
  const index = session.people.findIndex((p) => p.name === name);
  return session.assignments
    .filter((a) => a.personIndices.includes(index))
    .map((a) => ITEMS[a.itemIndex]!)
    .sort();
}

async function createSession(ctx: Awaited<ReturnType<typeof request.newContext>>) {
  const created = await trpcMutation(ctx, 'guest.createClaimSession', {
    receiptData: {
      merchantName: 'Concurrent item allocation',
      subtotal: 3000,
      tax: 0,
      tip: 0,
      total: 3000,
      currency: 'USD',
    },
    items: ITEMS.map((name) => ({ name, quantity: 1, unitPrice: 1000, totalPrice: 1000 })),
    creatorName: 'Host',
    paidByName: 'Host',
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()).result.data.json.shareToken as string;
}

test.describe('TASK-BILLOK-003: atomic per-dish allocations across devices', () => {
  test("two real phones assign different dishes without losing each other's saved choices", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const token = await createSession(ctx);
    const ann = await joinGuestSession(ctx, { token, name: 'Ann' });
    const cat = await joinGuestSession(ctx, { token, name: 'Cat' });
    const annBrowser = await browser.newContext({
      viewport: { width: 320, height: 720 },
      isMobile: true,
      hasTouch: true,
    });
    const catBrowser = await browser.newContext({
      viewport: { width: 360, height: 720 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await rememberClaimIdentity(annBrowser, token, ann);
      await rememberClaimIdentity(catBrowser, token, cat);
      const annPage = await annBrowser.newPage();
      const catPage = await catBrowser.newPage();
      await Promise.all([annPage.goto('/en/split/' + token + '/claim'), catPage.goto('/en/split/' + token + '/claim')]);
      await expect(annPage.getByTestId('dish-person-0-1')).toBeVisible({ timeout: 15_000 });
      await expect(catPage.getByTestId('dish-person-2-2')).toBeVisible({ timeout: 15_000 });
      await Promise.all([
        annPage.getByTestId('dish-person-0-1').click(),
        catPage.getByTestId('dish-person-2-2').click(),
      ]);
      await expect(annPage.getByTestId('dish-person-2-2')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
      await expect(catPage.getByTestId('dish-person-0-1')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
      expect(await claimsOf(ctx, token, 'Ann')).toEqual(['Tea']);
      expect(await claimsOf(ctx, token, 'Cat')).toEqual(['Pie']);

      await catPage.getByTestId('dish-person-2-2').click();
      await expect(annPage.getByTestId('dish-person-2-2')).toHaveAttribute('aria-pressed', 'false', {
        timeout: 15_000,
      });
      expect(await claimsOf(ctx, token, 'Ann')).toEqual(['Tea']);
      expect(await claimsOf(ctx, token, 'Cat')).toEqual([]);
      await expect(annPage.getByTestId('save-claims-btn')).toHaveCount(0);
    } finally {
      await annBrowser.close();
      await catBrowser.close();
      await ctx.dispose();
    }
  });

  test('two copies of the same absolute SET use one idempotency key and cannot overwrite later edits', async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    try {
      const token = await createSession(ctx);
      const ann = await joinGuestSession(ctx, { token, name: 'Ann' });
      const key = randomUUID();
      const write = (parts: number, requestKey: string) =>
        trpcMutation(ctx, 'guest.setReceiptItemParts', {
          token,
          personToken: ann.personToken,
          itemIndex: 0,
          changes: [{ personId: ann.personId, parts }],
          requestKey,
        });
      const same = await Promise.all([write(2, key), write(2, key)]);
      for (const response of same) expect(response.ok(), await response.text()).toBe(true);
      const conflict = await write(3, key);
      expect(conflict.ok()).toBe(false);
      const later = await write(1, randomUUID());
      expect(later.ok(), await later.text()).toBe(true);
      const replay = await write(2, key);
      expect(replay.ok(), await replay.text()).toBe(true);
      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token }));
      expect(session.assignments[0].partsByPersonId[ann.personId]).toBe(1);
    } finally {
      await ctx.dispose();
    }
  });

  test('a personal token cannot change the allocations of another person', async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    try {
      const token = await createSession(ctx);
      const ann = await joinGuestSession(ctx, { token, name: 'Ann' });
      const cat = await joinGuestSession(ctx, { token, name: 'Cat' });
      const denied = await trpcMutation(ctx, 'guest.setReceiptItemParts', {
        token,
        personToken: ann.personToken,
        itemIndex: 0,
        changes: [{ personId: cat.personId, parts: 3 }],
        requestKey: randomUUID(),
      });
      expect(denied.ok()).toBe(false);
      expect(await claimsOf(ctx, token, 'Cat')).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });
});

test.describe('guest.claimItems save keys (#238)', () => {
  test('a save sent again with its key is not applied again, and both of two copies sent at once answer saved', async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Save Key Diner', subtotal: 3000, tax: 0, tip: 0, total: 3000, currency: 'USD' },
      items: ITEMS.map((name) => ({ name, quantity: 1, unitPrice: 1000, totalPrice: 1000 })),
      creatorName: 'Host',
      paidByName: 'Host',
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
    const shareToken: string = (await createRes.json()).result.data.json.shareToken;
    const ann = await joinGuestSession(ctx, { token: shareToken, name: 'Ann' });
    const cat = await joinGuestSession(ctx, { token: shareToken, name: 'Cat' });
    const forCat = (saveKey: string, changes: Record<string, number[]>) =>
      trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personId: cat.personId,
        personToken: ann.personToken,
        saveKey,
        ...changes,
      });
    const catSaves = async (claimedItemIndices: number[]) => {
      const res = await trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personId: cat.personId,
        personToken: cat.personToken,
        claimedItemIndices,
      });
      expect(res.ok(), await res.text()).toBe(true);
    };

    // Ann's save of the pie is stored; Cat's phone unclaims it; Ann's page sends the save again
    const pieKey = '99999999-9999-4999-8999-000000000001';
    expect((await forCat(pieKey, { addItemIndices: [2] })).ok()).toBe(true);
    await catSaves([]);
    const again = await forCat(pieKey, { addItemIndices: [2] });
    expect(again.ok(), await again.text()).toBe(true);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual([]);
    // The same key with other changes is refused
    expect((await forCat(pieKey, { addItemIndices: [1] })).status()).toBe(409);

    // Two copies of one save at once (a smoke check: they may not overlap, and adding an item
    // twice looks like adding it once): both answer saved, and the key is kept
    const teaKey = '99999999-9999-4999-8999-000000000002';
    const both = await Promise.all([forCat(teaKey, { addItemIndices: [0] }), forCat(teaKey, { addItemIndices: [0] })]);
    for (const res of both) expect(res.ok(), await res.text()).toBe(true);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual(['Tea']);
    // The key was stored: once Cat unclaims the tea, sending it again doesn't bring it back
    await catSaves([]);
    expect((await forCat(teaKey, { addItemIndices: [0] })).ok()).toBe(true);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual([]);

    await ctx.dispose();
  });
});
