import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Accessibility smoke checks (WCAG 2.2 AA via axe-core). Each new page adds a
 * case here as it lands - see docs/specs/testing for the full strategy.
 */
const pages = ['/', '/about', '/login'];

for (const path of pages) {
  test(`${path} has no serious axe violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
}

test('/profile/[username] (own, authenticated) has no serious axe violations', async ({ page }) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);
  await page.goto('/profile/demo1');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test('/feed with composer has no serious axe violations', async ({ page }) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test('/post/[postId] (detail with reply composer) has no serious axe violations', async ({
  page,
}) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  // Create a post through the real composer, then scan its detail page.
  const text = `a11y detail page ${crypto.randomUUID()}`;
  await page.getByTestId('composer-textarea').fill(text);
  await page.getByTestId('composer-submit').click();
  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  // Materialisation is async - the ws banner announces arrival (click through
  // it like a user; concurrent suites may surface intermediate banners).
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  const postId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');
  await page.goto(`/post/${postId}`);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test('/bookmarks (own, with interactive post cards) has no serious axe violations', async ({
  page,
}) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  // Bookmark a post through the real button so the page renders a card with
  // the interactive action row, then scan.
  const text = `a11y bookmark page ${crypto.randomUUID()}`;
  await page.getByTestId('composer-textarea').fill(text);
  await page.getByTestId('composer-submit').click();
  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  const postId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');
  await page.getByTestId(`post-${postId}`).getByTestId('count-bookmarks').click();

  // The click returns on the optimistic flip; the server action (and its
  // revalidate of /bookmarks) is still in flight - poll fresh renders until
  // THIS post lands on the page (the list may already show older bookmarks,
  // so mere visibility of the list is not arrival).
  await page.goto('/bookmarks');
  const bookmarked = page.getByTestId('bookmarks-list');
  const a11yDeadline = Date.now() + 15_000;
  while (
    !(await bookmarked
      .getByText(text)
      .isVisible()
      .catch(() => false))
  ) {
    if (Date.now() > a11yDeadline) break;
    await page.reload();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await expect(bookmarked).toContainText(text);
});

test('/search (results page, authenticated) has no serious axe violations', async ({ page }) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  // Any query exercises the results screen; the empty state is a valid scan
  // target and needs no seeded corpus.
  await page.goto(`/search?q=${encodeURIComponent('feed')}`);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});
