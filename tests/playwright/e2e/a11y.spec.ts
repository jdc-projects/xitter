import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak, waitForComposerHydration } from './helpers';

/**
 * Accessibility smoke checks (WCAG 2.2 AA via axe-core). Each new page adds a
 * case here as it lands - see docs/specs/testing for the full strategy.
 * `/login` is scanned signed-out - a signed-in visit redirects to the feed
 * (#40), so no authenticated login DOM exists. `/no-such-page` covers the
 * shared 404 surface in both renders: unauthenticated below, and the
 * app-shell render (#135) plus the malformed-id guard route (#131) after it.
 *
 * This file runs in BOTH the desktop `a11y` project and `a11y-mobile`
 * (#151: the axe set re-scanned at an iPhone-class viewport, where WCAG
 * 2.5.8 target-size actually bites). The desktop-first admin panel is
 * scanned by admin-a11y.spec.ts in the desktop project only.
 *
 * Deliberately not scanned here: the dormant-profile shell (#36) needs a
 * wiped-but-NOT-reseeded stack - the e2e wrapper reseeds before the probe
 * port opens, so every demo profile is live (first-run.spec.ts documents
 * the same limitation). Its colocated unit test is the coverage until a
 * no-reseed harness exists.
 */
const pages = ['/', '/about', '/login', '/no-such-page'];

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

test('/no-such-page (404 in the app shell, authenticated) has no serious axe violations', async ({
  page,
}) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);
  await page.goto('/no-such-page');

  // Scan the shell-wrapped render (#135), not the bare signed-out one.
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByTestId('app-nav')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test('/post/not-a-uuid (guard 404 in the app shell) has no serious axe violations', async ({
  page,
}) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);
  await page.goto('/post/not-a-uuid');

  // Deterministic 404 via the #131 contract-shape guard - no service call.
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByTestId('app-nav')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

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
  await waitForComposerHydration(page);
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

test('/post/[postId] thread view (ancestors + nested reply tree) has no serious axe violations', async ({
  page,
}) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  const scan = async () => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  };

  // Build root -> reply -> reply-to-reply through the real composers (the
  // thread tests must not depend on #150's corpus nesting), then scan both
  // shapes: the root page (nested indented tree) and the reply page
  // (ancestor context cards above the focus).
  const rootText = `a11y thread root ${crypto.randomUUID()}`;
  await waitForComposerHydration(page);
  await page.getByTestId('composer-textarea').fill(rootText);
  await page.getByTestId('composer-submit').click();
  const item = page.locator('[data-testid^="post-item-"]', { hasText: rootText }).first();
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  const rootId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');

  const replyText = `a11y thread reply ${crypto.randomUUID()}`;
  await page.goto(`/post/${rootId}`);
  await waitForComposerHydration(page, 'reply-composer');
  await page.getByTestId('reply-composer-textarea').fill(replyText);
  await page.getByTestId('reply-composer-submit').click();
  await expect(page.getByTestId('thread-tree')).toContainText(replyText);
  const replyId = await page
    .locator('[data-testid^="post-item-"]', { hasText: replyText })
    .first()
    .getAttribute('data-testid')
    .then((testId) => testId!.replace('post-item-', ''));

  const nestedText = `a11y thread nested ${crypto.randomUUID()}`;
  await page.goto(`/post/${replyId}`);
  await waitForComposerHydration(page, 'reply-composer');
  await page.getByTestId('reply-composer-textarea').fill(nestedText);
  await page.getByTestId('reply-composer-submit').click();
  await expect(page.getByTestId('thread-tree')).toContainText(nestedText);

  // Root page: focus card + composer + indented nested tree (guides).
  await page.goto(`/post/${rootId}`);
  await expect(page.getByTestId('thread-children-' + replyId)).toBeVisible();
  await scan();

  // Reply page: ancestor context cards above the focus.
  await page.goto(`/post/${replyId}`);
  await expect(page.getByTestId(`post-ancestor-${rootId}`)).toBeVisible();
  await scan();
});

test('/bookmarks (own, with interactive post cards) has no serious axe violations', async ({
  page,
}) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  // Bookmark a post through the real button so the page renders a card with
  // the interactive action row, then scan.
  const text = `a11y bookmark page ${crypto.randomUUID()}`;
  await waitForComposerHydration(page);
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
