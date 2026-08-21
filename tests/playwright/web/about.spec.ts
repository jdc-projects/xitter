import { expect, test } from '@playwright/test';

test('about page explains the demo and links back to login', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
  await expect(page.getByText(/reset/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'FAQ' })).toBeVisible();
  await expect(page.getByText(/log in to look around/i)).toBeVisible();
});

test('about page carries the public header and no self-referential reset link', async ({
  page,
}) => {
  await page.goto('/about');

  // The reset notice's read-more targets the About page - suppressed here.
  await expect(page.getByTestId('reset-notice')).toBeVisible();
  await expect(page.getByTestId('reset-notice').getByRole('link')).toHaveCount(0);

  // Navigation out: header brand (home) and the login link in the copy.
  await expect(page.getByTestId('public-header')).toBeVisible();
  await page.getByTestId('public-brand').click();
  await expect(page).toHaveURL(/\/$/);
});

// No CMS runs in this suite - the FAQ section must fall back to hardcoded copy.
test('about renders fallback FAQ copy when the CMS is down', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByText('Can I sign up?')).toBeVisible();
  await expect(page.getByText('Is my data private?')).toBeVisible();
});
