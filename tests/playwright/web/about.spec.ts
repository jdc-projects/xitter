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

// The under-the-hood strip moved from the landing (#153) - code-rendered
// facts about the platform, next to the prose that explains them.
test('about carries the under-the-hood stack strip (#153)', async ({ page }) => {
  await page.goto('/about');

  const stack = page.getByTestId('stack-strip');
  await expect(stack).toBeVisible();
  await expect(stack.getByText('5 NestJS services')).toBeVisible();
  await expect(stack.getByText('3 Kafka workers')).toBeVisible();
  await expect(stack.getByText(/OpenTofu deploys/)).toBeVisible();
});

// No CMS runs in this suite - the About sections must fall back to hardcoded
// copy (the promoted copy says "bookmarks" mid-list; the fallback does not).
test('about renders fallback section copy when the CMS is down', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByRole('heading', { name: 'What is this?' })).toBeVisible();
  await expect(page.getByText(/posts, follows, replies, likes and reposts/i)).toBeVisible();
});

// No CMS runs in this suite - the FAQ section must fall back to hardcoded copy.
test('about renders fallback FAQ copy when the CMS is down', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByText('Can I sign up?')).toBeVisible();
  await expect(page.getByText('Is my data private?')).toBeVisible();
});
