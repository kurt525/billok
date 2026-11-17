import { expect, test } from '@playwright/test';
import { login, users, createTestGroup, trpcMutation } from './helpers';

test.describe('Group archive: legacy admin impersonation requiring a signed approval grant', () => {
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
});
