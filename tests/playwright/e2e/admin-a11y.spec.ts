import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Admin panel axe scans, desktop a11y project only (#151). The Refine/antd
 * panel is a desktop-first surface - its tables are not laid out for
 * iPhone-class viewports, so the a11y-mobile project excludes this file and
 * scans the consumer app instead. Coverage is unchanged from when these
 * lived in a11y.spec.ts: the `a11y` project runs both files.
 */

/** Drive the admin realm's Keycloak login (T10 panel). */
async function loginViaAdminRealm(page: Page, username: string, password: string) {
  await page.goto('/admin/');
  await page.getByTestId('admin-login-button').click();
  await page.waitForURL(/\/realms\/xitter-local-admin\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

const adminPages = [
  { path: '/admin/health', testId: 'health-table' },
  { path: '/admin/posts', testId: 'posts-table' },
  { path: '/admin/media', testId: 'media-table' },
  { path: '/admin/users', testId: 'users-table' },
  { path: '/admin/audit', testId: 'audit-table' },
];

for (const { path, testId } of adminPages) {
  test(`${path} (admin panel) has no serious axe violations`, async ({ page }) => {
    await loginViaAdminRealm(page, 'localadmin', 'LocalAdmin123!');
    await page.waitForURL(/\/admin\/health$/);
    await page.goto(path);
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
    // The table shell renders while rows still stream in; scanning the
    // spinner state passes vacuously and hides row-level violations (the
    // seeded world guarantees rows on every panel page - hold the scan to
    // them or fail loudly).
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
}

test('/admin/ (panel login) has no serious axe violations', async ({ page }) => {
  await page.goto('/admin/');
  await expect(page.getByTestId('admin-login')).toBeVisible({ timeout: 20_000 });

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});
