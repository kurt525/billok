import { expect, test, type APIRequestContext } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcError, trpcMutation, trpcQuery, trpcResult } from './helpers';

// Uses only disposable CI PostgreSQL data and a signed Passkey session.
async function makeManualItem(name: string, quantity: number, unitPrice: number, totalPrice: number) {
  const ctx = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    const group = await trpcMutation(ctx, 'groups.create', { name: 'Split API ' + name });
    const groupBody = await group.json();
    expect(group.ok(), JSON.stringify(groupBody)).toBe(true);
    const groupId = groupBody.result?.data?.json?.id as string;
    expect(groupId).toBeTruthy();
    const created = await trpcMutation(ctx, 'receipts.createManual', { groupId });
    const createdBody = await created.json();
    expect(created.ok(), JSON.stringify(createdBody)).toBe(true);
    const receiptId = createdBody.result?.data?.json?.receiptId as string;
    expect(receiptId).toBeTruthy();
    const added = await trpcMutation(ctx, 'receipts.addItem', { receiptId, name, quantity, unitPrice, totalPrice });
    const addedBody = await added.json();
    expect(added.ok(), JSON.stringify(addedBody)).toBe(true);
    const item = addedBody.result?.data?.json as { id: string; sortOrder: number };
    expect(item?.id).toBeTruthy();
    return { ctx, receiptId, item };
  } catch (error) {
    await ctx.dispose();
    throw error;
  }
}

async function itemsFor(ctx: APIRequestContext, receiptId: string) {
  return (await trpcResult(await trpcQuery(ctx, 'receipts.getReceiptItems', { receiptId }))).items as Array<{
    id: string;
    name: string;
    quantity: number;
    totalPrice: number;
    sortOrder: number;
  }>;
}

test('9.3: manual split preserves price, quantity and adjacent sort order', async () => {
  const { ctx, receiptId, item } = await makeManualItem('Напиток', 7, 500, 3500);
  try {
    const split = await trpcMutation(ctx, 'receipts.splitItem', { itemId: item.id, splitQuantity: 3 });
    expect(split.ok(), await split.text()).toBe(true);
    const items = await itemsFor(ctx, receiptId);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.quantity === 4)?.totalPrice).toBe(2000);
    expect(items.find((i) => i.quantity === 3)?.totalPrice).toBe(1500);
    expect(items.map((i) => i.name)).toEqual(['Напиток', 'Напиток']);
    expect(items.find((i) => i.quantity === 3)?.sortOrder).toBe(item.sortOrder + 1);
  } finally {
    await ctx.dispose();
  }
});

test('9.3: manual split refuses the entire original quantity', async () => {
  const { ctx, item } = await makeManualItem('Лимонад', 3, 200, 600);
  try {
    const res = await trpcMutation(ctx, 'receipts.splitItem', { itemId: item.id, splitQuantity: 3 });
    expect((await trpcError(res))?.data?.code).toBe('BAD_REQUEST');
  } finally {
    await ctx.dispose();
  }
});

test('9.3: manual split rejects zero parts', async () => {
  const { ctx, item } = await makeManualItem('Вода', 2, 100, 200);
  try {
    const res = await trpcMutation(ctx, 'receipts.splitItem', { itemId: item.id, splitQuantity: 0 });
    expect((await trpcError(res))?.data?.code).toBe('BAD_REQUEST');
  } finally {
    await ctx.dispose();
  }
});

test('9.3: split rounding cannot make a negative remainder or lose kopecks', async () => {
  const { ctx, receiptId, item } = await makeManualItem('Округление', 3, 334, 999);
  try {
    const res = await trpcMutation(ctx, 'receipts.splitItem', { itemId: item.id, splitQuantity: 2 });
    expect(res.ok(), await res.text()).toBe(true);
    const items = await itemsFor(ctx, receiptId);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.quantity === 1)?.totalPrice).toBe(331);
    expect(items.find((i) => i.quantity === 2)?.totalPrice).toBe(668);
    expect(items.reduce((sum, i) => sum + i.totalPrice, 0)).toBe(999);
  } finally {
    await ctx.dispose();
  }
});

test('9.3: two splits of five pieces preserve original price exactly', async () => {
  const { ctx, receiptId, item } = await makeManualItem('Пять порций', 5, 500, 2500);
  try {
    const first = await trpcMutation(ctx, 'receipts.splitItem', { itemId: item.id, splitQuantity: 2 });
    expect(first.ok(), await first.text()).toBe(true);
    const remaining = (await itemsFor(ctx, receiptId)).find((i) => i.quantity === 3);
    expect(remaining).toBeDefined();
    const second = await trpcMutation(ctx, 'receipts.splitItem', { itemId: remaining!.id, splitQuantity: 2 });
    expect(second.ok(), await second.text()).toBe(true);
    const items = await itemsFor(ctx, receiptId);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.quantity).sort()).toEqual([1, 2, 2]);
    expect(items.map((i) => i.totalPrice).sort((a, b) => a - b)).toEqual([500, 1000, 1000]);
    expect(items.reduce((sum, i) => sum + i.totalPrice, 0)).toBe(2500);
  } finally {
    await ctx.dispose();
  }
});
