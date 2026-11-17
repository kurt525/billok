import { test, expect } from '@playwright/test';
import { login, users, authedContext, createTestGroup, trpcMutation } from './helpers';

test.describe('Group Archiving', () => {
  // ── API-level tests ──────────────────────────────────────

  // #290: an archived group refuses these actions, so its pages shouldn't offer
  // them only for the request to fail after the user acts.
  test.describe('UI: actions an archived group refuses', () => {
    async function createExpense(owner: Awaited<ReturnType<typeof authedContext>>, groupId: string, userId: string) {
      const res = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Before Archive',
        amount: 1000,
        paidById: userId,
        splitMode: 'EQUAL',
        shares: [{ userId, amount: 1000 }],
      });
      return (await mutationResult(res)).id as string;
    }

    // A mutation's result, failing the test with the server's answer if it was refused
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function mutationResult(res: Awaited<ReturnType<typeof trpcMutation>>): Promise<any> {
      const body = await res.json();
      if (!body.result) throw new Error(`mutation failed (${res.status()}): ${JSON.stringify(body)}`);
      return body.result.data?.json;
    }

    test('expense page shows no Edit or Delete in an archived group', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Expense Page',
      );
      const expenseId = await createExpense(owner, groupId, memberIds[users.alice.email]!);
      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto(`/en/groups/${groupId}/expenses/${expenseId}`);
      await expect(page.getByRole('heading', { name: 'Before Archive' })).toBeVisible();
      await expect(page.getByText("This group is archived, so this expense can't be edited or deleted.")).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit Expense' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

      await dispose();
    });

    test('a refused expense delete says why instead of failing silently', async ({ page }) => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Refused Expense Delete',
      );
      // Alice added and paid it, so Bob, a plain member, may not delete it
      const expenseId = await createExpense(owner, groupId, memberIds[users.alice.email]!);
      await login(page, users.bob.email, users.bob.password);

      await page.goto(`/en/groups/${groupId}/expenses/${expenseId}`);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(
        page.getByText('Only the expense creator, payer, or group owner/admin can delete this expense'),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/expenses/${expenseId}$`));

      await dispose();
    });

    test('a plain member is told to ask an owner or admin to unarchive', async ({ page }) => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Member View',
      );
      await trpcMutation(owner, 'groups.archive', { groupId });
      await login(page, users.bob.email, users.bob.password);

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
      await expect(page.getByText('Manage', { exact: true })).toHaveCount(0);

      await page.goto(`/en/groups/${groupId}/settings`);
      await expect(page.getByText('This group is archived')).toBeVisible();
      await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
      await expect(page.getByRole('button', { name: /Unarchive/ })).toHaveCount(0);

      await dispose();
    });

    // tRPC acts as the impersonated user while useSession() still reports the admin,
    // so the role has to come from the acting user.
    test('an admin impersonating a plain member sees what that member sees', async ({ page }) => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.charlie.email,
        users.charlie.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Impersonated Member',
      );
      await trpcMutation(owner, 'groups.archive', { groupId });
      // Alice is a site admin and not in this group
      await login(page, users.alice.email, users.alice.password);
      const startRes = await page.request.post('/api/admin/impersonate', {
        data: { userId: memberIds[users.bob.email] },
      });
      expect(startRes.ok()).toBe(true);

      try {
        await page.goto(`/en/groups/${groupId}`);
        await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
        await expect(page.getByText('Manage', { exact: true })).toHaveCount(0);

        await page.goto(`/en/groups/${groupId}/settings`);
        await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
        await expect(page.getByRole('button', { name: /Unarchive/ })).toHaveCount(0);
      } finally {
        await page.request.delete('/api/admin/impersonate');
        await dispose();
      }
    });

    test('the owner still gets the Manage link on an archived group', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Owner View',
      );
      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText('Manage', { exact: true })).toBeVisible();
      await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toHaveCount(0);

      await dispose();
    });

    test('direct links to add, edit or scan an expense say the group is archived', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Direct Links',
      );
      const expenseId = await createExpense(owner, groupId, memberIds[users.alice.email]!);
      await trpcMutation(owner, 'groups.archive', { groupId });

      for (const path of ['expenses/new', `expenses/${expenseId}/edit`, 'scan', 'scan?receiptId=any']) {
        await page.goto(`/en/groups/${groupId}/${path}`);
        await expect(page.getByRole('heading', { name: 'This group is archived' }), path).toBeVisible();
        await expect(page.getByText('Back to group', { exact: true }), path).toBeVisible();
        await expect(page.locator('form'), path).toHaveCount(0);
        await expect(page.getByText('Upload a receipt'), path).toHaveCount(0);
      }

      await dispose();
    });
  });
});
