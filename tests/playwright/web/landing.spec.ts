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

test('landing carries the demo: credentials entry point and stack strip (#37)', async ({
  page,
}) => {
  await page.goto('/');

  // Demo credentials are public by design (spec 04) - surfaced on the
  // landing itself, not only on /login and /about.
  const credentials = page.getByTestId('demo-credentials');
  await expect(credentials).toBeVisible();
  await expect(credentials.getByText('demo1–demo10')).toBeVisible();
  await expect(credentials.getByText('DemoPass123!')).toBeVisible();
  await credentials.getByTestId('landing-login-cta').click();
  await expect(page).toHaveURL(/\/login$/);

  // Under-the-hood strip: code-rendered facts about the platform.
  await page.goto('/');
  const stack = page.getByTestId('landing-stack');
  await expect(stack).toBeVisible();
  await expect(stack.getByText('5 NestJS services')).toBeVisible();
  await expect(stack.getByText('3 Kafka workers')).toBeVisible();
  await expect(stack.getByText(/OpenTofu deploys/)).toBeVisible();
  await stack.getByTestId('landing-stack-about-link').click();
  await expect(page).toHaveURL(/\/about$/);
});
