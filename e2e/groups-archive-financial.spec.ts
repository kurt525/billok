import { expect, test, type APIRequestContext } from '@playwright/test';
import { authedPasskeyContext } from './passkey-auth';
import { trpcError, trpcMutation, trpcQuery, trpcResult } from './helpers';

// These scenarios safeguard the archived group's historical RUB balances without
// relying on deleted password entry points, OCR, or foreign-language routes.
async function createTwoMemberGroup(owner: APIRequestContext, member: APIRequestContext) {
  const created = await trpcMutation(owner, 'groups.create', { name: 'Архив долгов ' + Date.now() });
  const createdBody = await created.json();
  expect(created.ok(), JSON.stringify(createdBody)).toBe(true);
  const groupId = createdBody.result?.data?.json?.id as string;
  expect(groupId).toBeTruthy();

  const invite = await trpcMutation(owner, 'groups.createInvite', { groupId });
  expect(invite.ok(), await invite.text()).toBe(true);
  const token = (await invite.json()).result?.data?.json?.token as string;
  expect(token).toBeTruthy();
  const joined = await trpcMutation(member, 'groups.joinByInvite', { token });
  expect(joined.ok(), await joined.text()).toBe(true);

  const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
  const userId = (email: string) =>
    (group.members as Array<{ user: { email: string; id: string } }>).find((m) => m.user.email === email)?.user.id;
  const ownerId = userId('alice@qa.billok.ru');
  const memberId = userId('bob@qa.billok.ru');
  expect(ownerId).toBeTruthy();
  expect(memberId).toBeTruthy();
  return { groupId, ownerId: ownerId!, memberId: memberId! };
}

async function createSharedExpense(owner: APIRequestContext, groupId: string, ownerId: string, memberId: string) {
  const response = await trpcMutation(owner, 'expenses.create', {
    groupId,
    title: 'Обед с открытым долгом',
    amount: 1000,
    currency: 'RUB',
    paidById: ownerId,
    splitMode: 'EQUAL',
    shares: [
      { userId: ownerId, amount: 500 },
      { userId: memberId, amount: 500 },
    ],
  });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body.result?.data?.json?.id as string;
}

test('9.3: group with unpaid RUB debt cannot archive; settlement unlocks archive but new settlements are refused', async () => {
  const owner = await authedPasskeyContext('alice@qa.billok.ru');
  const member = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    const { groupId, ownerId, memberId } = await createTwoMemberGroup(owner, member);
    const expenseId = await createSharedExpense(owner, groupId, ownerId, memberId);
    expect(expenseId).toBeTruthy();
    const denied = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(denied.ok()).toBe(false);
    expect((await trpcError(denied))?.data?.code).toBe('PRECONDITION_FAILED');
    const before = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    expect(before.archivedAt).toBeNull();

    const paid = await trpcMutation(member, 'settlements.create', {
      groupId,
      toId: ownerId,
      amount: 500,
      currency: 'RUB',
    });
    expect(paid.ok(), await paid.text()).toBe(true);
    const archived = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(archived.ok(), await archived.text()).toBe(true);
    const blocked = await trpcMutation(member, 'settlements.create', {
      groupId,
      toId: ownerId,
      amount: 1,
      currency: 'RUB',
    });
    expect(blocked.ok()).toBe(false);
    expect((await trpcError(blocked))?.data?.code).toBe('BAD_REQUEST');

    const history = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId }));
    expect((history.expenses as Array<{ id: string }>).some((e) => e.id === expenseId)).toBe(true);
    const payments = await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId }));
    expect(payments.items).toHaveLength(1);
  } finally {
    await member.dispose();
    await owner.dispose();
  }
});

test('9.3: former group member with unpaid debt blocks archiving without erasing the balance', async () => {
  const owner = await authedPasskeyContext('alice@qa.billok.ru');
  const member = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    const { groupId, ownerId, memberId } = await createTwoMemberGroup(owner, member);
    const expenseId = await createSharedExpense(owner, groupId, ownerId, memberId);
    expect(expenseId).toBeTruthy();
    const removed = await trpcMutation(owner, 'groups.removeMember', { groupId, userId: memberId });
    expect(removed.ok(), await removed.text()).toBe(true);
    const blocked = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(blocked.ok()).toBe(false);
    expect((await trpcError(blocked))?.data?.code).toBe('PRECONDITION_FAILED');
    const stillActive = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    expect(stillActive.archivedAt).toBeNull();
    const history = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId }));
    expect((history.expenses as Array<{ id: string }>).some((e) => e.id === expenseId)).toBe(true);
  } finally {
    await member.dispose();
    await owner.dispose();
  }
});

test('9.3: archived group expense cannot be edited and retains its RUB amount', async () => {
  const owner = await authedPasskeyContext('bob@qa.billok.ru');
  try {
    const groupResponse = await trpcMutation(owner, 'groups.create', {
      name: 'Архив без редактирования ' + Date.now(),
    });
    const groupBody = await groupResponse.json();
    expect(groupResponse.ok(), JSON.stringify(groupBody)).toBe(true);
    const groupId = groupBody.result?.data?.json?.id as string;
    const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    const userId = (group.members as Array<{ user: { email: string; id: string } }>).find(
      (m) => m.user.email === 'bob@qa.billok.ru',
    )?.user.id;
    expect(userId).toBeTruthy();
    const response = await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Расход до архива',
      amount: 875,
      currency: 'RUB',
      paidById: userId,
      splitMode: 'EQUAL',
      shares: [{ userId, amount: 875 }],
    });
    const body = await response.json();
    expect(response.ok(), JSON.stringify(body)).toBe(true);
    const expenseId = body.result?.data?.json?.id as string;
    const archived = await trpcMutation(owner, 'groups.archive', { groupId });
    expect(archived.ok(), await archived.text()).toBe(true);
    const blocked = await trpcMutation(owner, 'expenses.update', {
      groupId,
      expenseId,
      title: 'Подмена расхода',
    });
    expect(blocked.ok()).toBe(false);
    expect((await trpcError(blocked))?.data?.code).toBe('BAD_REQUEST');
    const expense = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId }));
    expect(expense.title).toBe('Расход до архива');
    expect(expense.amount).toBe(875);
  } finally {
    await owner.dispose();
  }
});
