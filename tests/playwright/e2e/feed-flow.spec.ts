import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Feed flows against the real stack (T6): follow backfill, fanout visibility,
 * the ws new-items banner, newest-first ordering, load-more pagination, and
 * unfollow removal. Distinct demo-account pairs per test keep them
 * order-independent - service state survives across tests.
 */
const PASSWORD = 'DemoPass123!';

async function login(page: Page, username: string) {
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
}

/** Isolated logged-in session in the same test (second user). */
async function loggedInPage(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, username);
  return page;
}

async function compose(page: Page, text: string) {
  await page.getByTestId('composer-textarea').fill(text);
  await page.getByTestId('composer-submit').click();
}

/**
 * Wait for a post to reach the timeline. Entries land asynchronously via
 * fanout (post -> Kafka -> worker -> feed); the ws banner announces them -
 * click through it like a user would.
 */
async function waitForFeedItem(page: Page, text: string, timeoutMs = 20_000) {
  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  const deadline = Date.now() + timeoutMs;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  return item;
}

/** Bearer access token for API-driven setup (the session holds it; the ws
 * route is the broker). Uses the page's own session cookies. */
async function accessToken(page: Page): Promise<string> {
  const res = await page.request.get('/api/ws/feed-token');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** Create posts via the API (pacing respects the rate limiter). */
async function seedPosts(page: Page, texts: string[]): Promise<void> {
  const token = await accessToken(page);
  for (const text of texts) {
    for (let attempt = 0; ; attempt++) {
      const res = await page.request.post('/api/posts/v1/posts', {
        headers: { authorization: `Bearer ${token}` },
        data: { text, mediaIds: [], replyToId: null },
      });
      if (res.status() === 201) break;
      if (res.status() === 429 && attempt < 10) {
        await page.waitForTimeout(1_200);
        continue;
      }
      throw new Error(`seed post failed: ${res.status()} ${await res.text()}`);
    }
    await page.waitForTimeout(150);
  }
}

test('following an account backfills their recent posts into the feed', async ({
  page,
  browser,
}) => {
  const demo7 = await loggedInPage(browser, 'demo7');
  const oldText = `t6 backfill history ${crypto.randomUUID()}`;
  await compose(demo7, oldText);
  // compose() returns on click - the post's creation can still be in
  // flight, and a follow that overtakes it races BOTH fanout paths
  // (post fanout reads followers pre-follow; backfill reads posts
  // pre-create). The author always has their own post: settle it first.
  await waitForFeedItem(demo7, oldText);
  await demo7.close();

  await login(page, 'demo6');
  await page.goto('/profile/demo7');
  await page.getByTestId('follow-button').click();
  await expect(page.getByTestId('unfollow-button')).toBeVisible();

  // Backfill runs asynchronously (follow event -> fanout worker -> feed).
  // The notify fires while we were still on /profile - no socket was open,
  // so nothing pushes the arrival: poll fresh renders like a user who
  // refreshes, until the backfilled history lands.
  await page.goto('/feed');
  const backfilled = page.locator('[data-testid^="post-item-"]', { hasText: oldText });
  const deadline = Date.now() + 20_000;
  while (!(await backfilled.isVisible().catch(() => false)) && Date.now() < deadline) {
    await page.reload();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await expect(backfilled.first()).toBeVisible();
});

test('a followed account new post drives the ws banner and refetches newest-first', async ({
  page,
  browser,
}) => {
  const demo7 = await loggedInPage(browser, 'demo7');
  const demo6 = await loggedInPage(browser, 'demo6');
  await demo6.goto('/profile/demo7');
  const follow = demo6.getByTestId('follow-button');
  if (await follow.isVisible()) {
    await follow.click();
    await expect(demo6.getByTestId('unfollow-button')).toBeVisible();
  }

  const older = `t6 ws ordering older ${crypto.randomUUID()}`;
  const newer = `t6 ws ordering newer ${crypto.randomUUID()}`;
  await seedPosts(demo7, [older]);
  await demo6.goto('/feed');
  await waitForFeedItem(demo6, older);

  // A live socket on the feed page: the new post must surface as a banner,
  // never as a silent data push. (Concurrent suites share demo users, so an
  // intermediate banner can arrive first - keep clicking until ours lands.)
  await compose(demo7, newer);
  await expect(demo6.getByTestId('feed-new-items')).toBeVisible({ timeout: 20_000 });
  await waitForFeedItem(demo6, newer, 20_000);

  const items = demo6.locator('[data-testid^="post-item-"]');
  await expect(items.filter({ hasText: newer })).toBeVisible();
  // Newest first: the fresh post sits above the backfilled one.
  const newerIndex = await items.filter({ hasText: newer }).first().boundingBox();
  const olderIndex = await items.filter({ hasText: older }).first().boundingBox();
  expect(newerIndex?.y).toBeLessThan(olderIndex?.y ?? Number.MAX_SAFE_INTEGER);

  await demo6.close();
  await demo7.close();
});

test('the feed pages with Load more beyond the first page', async ({ page }) => {
  await login(page, 'demo8');
  const prefix = `t6 pagination ${crypto.randomUUID()}`;
  // 22 posts > the 20-entry page: Load more must surface the tail.
  await seedPosts(
    page,
    Array.from({ length: 22 }, (_, n) => `${prefix} ${String(n).padStart(2, '0')}`),
  );

  await page.goto('/feed');
  const items = page.locator('[data-testid^="post-item-"]', { hasText: prefix });
  await expect(items).toHaveCount(20);

  await page.getByTestId('load-more').click();
  await expect(items).toHaveCount(22, { timeout: 15_000 });
});

test('unfollowed accounts stop appearing in the feed', async ({ page, browser }) => {
  const demo10 = await loggedInPage(browser, 'demo10');
  const text = `t6 unfollow removal ${crypto.randomUUID()}`;
  await compose(demo10, text);

  const demo9 = await loggedInPage(browser, 'demo9');
  await demo9.goto('/profile/demo10');
  await demo9.getByTestId('follow-button').click();
  await expect(demo9.getByTestId('unfollow-button')).toBeVisible();
  await demo9.goto('/feed');
  await waitForFeedItem(demo9, text);

  await demo9.goto('/profile/demo10');
  await demo9.getByTestId('unfollow-button').click();
  await expect(demo9.getByTestId('follow-button')).toBeVisible();

  await demo9.goto('/feed');
  // Removals are not pushed (banners fire on inserts only) and the entry
  // delete lands within ~1s of the unfollow - poll fresh renders until the
  // materialised feed catches up.
  const removed = demo9.locator('[data-testid^="post-item-"]', { hasText: text });
  const deadline = Date.now() + 15_000;
  while ((await removed.count()) > 0 && Date.now() < deadline) {
    await demo9.reload(); // reload awaits load; the sleep paces consumer lag
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await expect(removed).toHaveCount(0);

  await demo9.close();
  await demo10.close();
});
