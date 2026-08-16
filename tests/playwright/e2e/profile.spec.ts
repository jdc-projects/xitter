import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Relationship flows against the real stack. Profiles are created by the
 * login bootstrap (first login POSTs the profile), so every viewed subject
 * logs in once in a scratch context first. Distinct demo-account pairs per
 * test keep them order-independent - service state survives across tests.
 */

const PASSWORD = 'DemoPass123!';

/** A second, isolated logged-in session in the same test. */
async function loggedInPage(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
  return page;
}

test('viewing a profile shows its identity and lists', async ({ page, browser }) => {
  const demo2 = await loggedInPage(browser, 'demo2'); // ensures the profile exists
  await demo2.close();

  await loginViaKeycloak(page, 'demo1', PASSWORD);
  await page.waitForURL(/\/feed$/);
  await page.goto('/profile/demo2');

  await expect(page.getByTestId('profile-username')).toHaveText('@demo2');
  await expect(page.getByTestId('profile-display-name')).toBeVisible();
  await expect(page.getByTestId('profile-avatar')).toBeVisible();
  // Own actions hidden on someone else's profile.
  await expect(page.getByTestId('edit-profile-button')).toHaveCount(0);
  await expect(page.getByTestId('follow-button')).toBeVisible();

  // Lists render for any viewer (spec 7.4).
  await page.getByTestId('tab-followers').click();
  await expect(page.getByTestId('profile-list-empty')).toBeVisible();
  await page.getByTestId('tab-following').click();
  await expect(page.getByTestId('profile-list-empty')).toBeVisible();
});

test('follow then unfollow updates both sides of the graph', async ({ page, browser }) => {
  const demo2 = await loggedInPage(browser, 'demo2');
  await demo2.close();
  await loginViaKeycloak(page, 'demo1', PASSWORD);
  await page.waitForURL(/\/feed$/);

  await page.goto('/profile/demo2');
  await page.getByTestId('follow-button').click();
  await expect(page.getByTestId('unfollow-button')).toBeVisible();

  // Follower side: demo1 appears in demo2's followers.
  await page.getByTestId('tab-followers').click();
  await expect(page.getByTestId('profile-list-item').filter({ hasText: '@demo1' })).toBeVisible();

  // Followee side: demo1's own profile lists demo2 under following.
  await page.goto('/profile/demo1');
  await page.getByTestId('tab-following').click();
  await expect(page.getByTestId('profile-list-item').filter({ hasText: '@demo2' })).toBeVisible();

  // Unfollow removes it again.
  await page.goto('/profile/demo2');
  await page.getByTestId('unfollow-button').click();
  await expect(page.getByTestId('follow-button')).toBeVisible();
  await page.getByTestId('tab-followers').click();
  await expect(page.getByTestId('profile-list-item').filter({ hasText: '@demo1' })).toHaveCount(0);
});

test('block stops the blocked user from following and shows badges', async ({ page, browser }) => {
  // demo3 blocks demo4; demo4 then cannot follow demo3.
  const demo3 = await loggedInPage(browser, 'demo3');
  await demo3.goto('/profile/demo4');
  await demo3.getByTestId('block-button').click();
  await expect(demo3.getByTestId('badge-blocked')).toBeVisible();
  await expect(demo3.getByTestId('unblock-button')).toBeVisible();
  // Blocking replaces the relationship: no follow control while blocked.
  await expect(demo3.getByTestId('follow-button')).toHaveCount(0);
  await expect(demo3.getByTestId('unfollow-button')).toHaveCount(0);

  await loginViaKeycloak(page, 'demo4', PASSWORD);
  await page.waitForURL(/\/feed$/);
  await page.goto('/profile/demo3');

  // The blocked viewer sees the badge and their follow attempt fails.
  await expect(page.getByTestId('badge-blocked')).toBeVisible();
  await page.getByTestId('follow-button').click();
  await expect(page.getByTestId('action-error')).toBeVisible();

  // Unblock restores normal behaviour (prior failures stay failed).
  await demo3.reload();
  await demo3.getByTestId('unblock-button').click();
  await expect(demo3.getByTestId('follow-button')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('badge-blocked')).toHaveCount(0);
  await page.getByTestId('follow-button').click();
  await expect(page.getByTestId('unfollow-button')).toBeVisible();
});

test('users edit only their own profile', async ({ page, browser }) => {
  const demo2 = await loggedInPage(browser, 'demo2');
  await demo2.close();

  await loginViaKeycloak(page, 'demo5', PASSWORD);
  await page.waitForURL(/\/feed$/);

  // Someone else's profile: no edit affordance at all.
  await page.goto('/profile/demo2');
  await expect(page.getByTestId('edit-profile-button')).toHaveCount(0);

  // Own profile: edit saves displayName + bio and renders them.
  await page.goto('/profile/demo5');
  await page.getByTestId('edit-profile-button').click();
  await page.getByTestId('edit-display-name').fill('Demo Five');
  await page.getByTestId('edit-bio').fill('Microservices enjoyer.');
  await expect(page.getByTestId('bio-pii-reminder')).toBeVisible();
  await page.getByTestId('save-profile-button').click();
  await expect(page.getByTestId('edit-profile-button')).toBeVisible();
  await expect(page.getByTestId('profile-display-name')).toHaveText('Demo Five');
  await expect(page.getByTestId('profile-bio')).toHaveText('Microservices enjoyer.');
});
