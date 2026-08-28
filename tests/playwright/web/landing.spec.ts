import { expect, test } from '@playwright/test';

test('landing is the front door: wordmark, one-line value prop, reset warning', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'xitter' })).toBeVisible();
  await expect(page.getByTestId('reset-notice')).toBeVisible();
  await expect(page.getByRole('link', { name: 'About', exact: true })).toBeVisible();
});

test('landing says what this is in one line and hands off to About (#153)', async ({ page }) => {
  await page.goto('/');

  // The how-it-works material (CMS intro, stack strip) moved to About -
  // the landing keeps a single code-owned line that points there.
  await expect(page.getByText(/running on a realistic microservices homelab/i)).toBeVisible();
  await page.getByRole('link', { name: 'Read how it works' }).click();
  await expect(page).toHaveURL(/\/about$/);
});

test('landing links to login', async ({ page }) => {
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

test('landing carries the demo-credentials entry point (#37)', async ({ page }) => {
  await page.goto('/');

  // Demo credentials are public by design (spec 04) - surfaced on the
  // landing itself, not only on /login and /about.
  const credentials = page.getByTestId('demo-credentials');
  await expect(credentials).toBeVisible();
  await expect(credentials.getByText('demo1–demo10')).toBeVisible();
  await expect(credentials.getByText('DemoPass123!')).toBeVisible();
  await credentials.getByTestId('landing-login-cta').click();
  await expect(page).toHaveURL(/\/login$/);
});
