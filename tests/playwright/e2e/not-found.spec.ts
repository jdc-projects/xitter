import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * The 404 surface and the app shell (#135): an unmatched route used to
 * drop a signed-in visitor out of the app chrome (no header, no nav, no
 * logout). Every notFound() under the app group - the catch-all for
 * unmatched URLs, the malformed-id guards (#131), deleted posts/profiles -
 * now renders inside the shell, while signed-out visitors keep getting
 * the plain 404 rather than a login redirect for a URL that does not exist.
 */

async function login(page: Page) {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);
}

test('a signed-in visitor keeps the shell on an unmatched route', async ({ page }) => {
  await login(page);

  const response = await page.goto('/definitely-not-a-page');
  expect(response?.status()).toBe(404);

  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByTestId('app-nav')).toBeVisible();
  await expect(page.getByTestId('nav-username')).toHaveText('@demo1');
  await expect(page.getByTestId('logout-button')).toBeVisible();

  // The in-app way out still lands on the timeline, session intact.
  await page.getByRole('link', { name: 'Go to the feed' }).click();
  await page.waitForURL(/\/feed$/);
  await expect(page.getByTestId('composer-form')).toBeVisible();
});

test('the malformed-id 404 (#131 guard) renders inside the shell too', async ({ page }) => {
  await login(page);
  await page.goto('/post/not-a-uuid');

  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByTestId('app-nav')).toBeVisible();
  await expect(page.getByTestId('nav-username')).toHaveText('@demo1');
});

test('a signed-out visitor gets the 404, not a login redirect', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-page');

  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/definitely-not-a-page$/);
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByTestId('login-panel')).toHaveCount(0);
});
