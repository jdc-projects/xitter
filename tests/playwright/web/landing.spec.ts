import { expect, test } from '@playwright/test';

test('landing page introduces the app and warns about resets', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'xitter' })).toBeVisible();
  await expect(page.getByTestId('reset-notice')).toBeVisible();
  await expect(page.getByRole('link', { name: 'About', exact: true })).toBeVisible();
});

test('landing page links to login', async ({ page }) => {
  await page.goto('/');

  // The public header carries the nav Log in; the body CTA duplicates the
  // affordance - scope to stay strict-mode safe.
  const login = page.getByTestId('public-header').getByRole('link', { name: 'Log in' });
  await expect(login).toBeVisible();
  await login.click();
  await expect(page).toHaveURL(/\/login$/);
});

test('public header navigates between landing, About and login', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('public-header')).toBeVisible();

  await page.getByTestId('public-brand').click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByTestId('public-about-link').click();
  await expect(page).toHaveURL(/\/about$/);
  // The header is shared by every public page.
  await expect(page.getByTestId('public-header')).toBeVisible();

  await page.getByTestId('public-login-link').click();
  await expect(page).toHaveURL(/\/login$/);
});

// This suite runs the web app alone (no CMS) - which is exactly the
// "CMS unreachable" case: the page must render the hardcoded fallback copy.
test('landing renders fallback copy when the CMS is down', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText(/microservices playground for learning/i)).toBeVisible();
});
