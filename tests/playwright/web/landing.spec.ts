import { expect, test } from '@playwright/test';

test('landing page introduces the app and warns about resets', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'xitter' })).toBeVisible();
  await expect(page.getByTestId('reset-notice')).toBeVisible();
  await expect(page.getByRole('link', { name: 'About' })).toBeVisible();
});

test('landing page links to login', async ({ page }) => {
  await page.goto('/');

  const login = page.getByRole('link', { name: /log in/i });
  await expect(login).toBeVisible();
  await login.click();
  await expect(page).toHaveURL(/\/login$/);
});
