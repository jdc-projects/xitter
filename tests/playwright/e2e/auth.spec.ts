import { expect, test } from '@playwright/test';

test.describe('unauthenticated access', () => {
  test('landing and about are public', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('reset-notice')).toBeVisible();

    await page.goto('/about');
    await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
  });

  // TODO(#3 auth): the /feed -> /login redirect is implemented with the auth
  // feature ticket; enabled then.
  test.skip('user content requires login', async ({ page }) => {
    await page.goto('/feed');
    await expect(page).toHaveURL(/\/login/);
  });
});
