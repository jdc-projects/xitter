import { expect, test } from '@playwright/test';

test('about page explains the demo and links back to login', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
  await expect(page.getByText(/reset/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'FAQ' })).toBeVisible();
  await expect(page.getByText(/log in to look around/i)).toBeVisible();
});

// No CMS runs in this suite - the FAQ section must fall back to hardcoded copy.
test('about renders fallback FAQ copy when the CMS is down', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByText('Can I sign up?')).toBeVisible();
  await expect(page.getByText('Is my data private?')).toBeVisible();
});
