import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Admin panel (T10) against the real stack through the edge (/admin):
 * admin-role login gates the panel, moderation actions take effect for
 * users immediately, users + health are inspectable, and a role-less
 * admin-realm account is rejected at the callback gate.
 */

const ADMIN_PASSWORD = 'LocalAdmin123!';

/** Drive the admin realm's Keycloak login (local stack stand-in for primary). */
async function loginViaAdminRealm(page: Page, username: string, password: string) {
  await page.goto('/admin/');
  await page.getByTestId('admin-login-button').click();
  await page.waitForURL(/\/realms\/xitter-local-admin\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

test('admin can log in and sees the health dashboard', async ({ page }) => {
  await loginViaAdminRealm(page, 'localadmin', ADMIN_PASSWORD);
  await page.waitForURL(/\/admin\/health$/);

  // Every service reports through its own admin-gated health endpoint.
  const table = page.getByTestId('health-table');
  await expect(table).toContainText('social');
  await expect(table).toContainText('posts');
  await expect(table).toContainText('media');
  await expect(table).toContainText('feed');
  await expect(table).toContainText('search');
  await expect(page.getByText('All services healthy')).toBeVisible();

  // Workers surface as metrics links; reset tile stays pending until #13.
  await expect(page.getByTestId('health-workers')).toContainText('fanout');
  await expect(page.getByTestId('reset-status-pending')).toBeVisible();
});

test('admin soft-delete removes a post for users; audit log records it', async ({
  page,
  browser,
}) => {
  // A demo user creates the moderation target through the real composer.
  const context = await browser.newContext();
  const user = await context.newPage();
  await loginViaKeycloak(user, 'demo9', 'DemoPass123!');
  await user.waitForURL(/\/feed$/);
  const text = `t10 admin moderation target ${crypto.randomUUID()}`;
  await user.getByTestId('composer-textarea').fill(text);
  await user.getByTestId('composer-submit').click();
  const item = user.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = user.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await user.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  const postId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');

  await loginViaAdminRealm(page, 'localadmin', ADMIN_PASSWORD);
  await page.waitForURL(/\/admin\/health$/);

  // Filter the moderation list down to the target, then soft-delete it.
  await page.goto('/admin/posts');
  await page.locator('#filter-text').fill(text);
  const row = page.locator('[data-testid="posts-table"] tbody tr', { hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByTestId(`delete-post-${postId}`).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Delete' }).click();
  // The row flips to a restorable tombstone (soft delete, spec 03).
  await expect(row.getByTestId(`restore-post-${postId}`)).toBeVisible({ timeout: 20_000 });

  // Gone for users immediately: direct URL 404s (soft delete reads as absent).
  const response = await user.goto(`/post/${postId}`);
  expect(response?.status()).toBe(404);

  // The audit log names the actor and the action.
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toContainText('post.soft-delete');
  await expect(page.getByTestId('audit-table')).toContainText(postId);
  await context.close();
});

test('users list + follow graph are inspectable (read-only)', async ({ page, browser }) => {
  // Profiles are created lazily on first web login - provision demo1 first
  // so the test is order-independent of the other suites.
  const context = await browser.newContext();
  const user = await context.newPage();
  await loginViaKeycloak(user, 'demo1', 'DemoPass123!');
  await user.waitForURL(/\/feed$/);
  await context.close();

  await loginViaAdminRealm(page, 'localadmin', ADMIN_PASSWORD);
  await page.waitForURL(/\/admin\/health$/);

  await page.goto('/admin/users');
  await expect(page.getByTestId('users-table')).toContainText('@demo1');
  await page.getByTestId('show-user-demo1').click();
  await expect(page.getByTestId('users-show-profile')).toContainText('demo1');
  // Both graph directions render (cards exist even when a list is empty).
  await expect(page.getByTestId('users-show-followers')).toBeVisible();
  await expect(page.getByTestId('users-show-following')).toBeVisible();
});

test('role-less admin-realm account is rejected', async ({ page }) => {
  await loginViaAdminRealm(page, 'localuser', 'LocalUser123!');
  await expect(page.getByTestId('admin-callback-rejected')).toBeVisible({ timeout: 20_000 });

  // The rejected session must not admit the panel on a direct visit either.
  await page.goto('/admin/');
  await expect(page.getByTestId('admin-login')).toBeVisible({ timeout: 20_000 });
});

test('unauthenticated visitors never see the panel', async ({ page }) => {
  await page.goto('/admin/posts');
  await expect(page.getByTestId('admin-login')).toBeVisible({ timeout: 20_000 });
});
