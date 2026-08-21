import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Cursor pagination beyond the feed (#41): every list surface appends the
 * next page in place with one shared Load-more button - the old
 * `?cursor=` anchors did a full navigation that scrolled back to the top.
 * demo5 is this suite's account (22 seeded posts serve both the profile
 * tab and the search index).
 */

async function accessToken(page: Page): Promise<string> {
  const res = await page.request.get('/api/ws/feed-token');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
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

test('profile posts append in place via Load more', async ({ page }) => {
  await loginViaKeycloak(page, 'demo5', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  const prefix = `t41 pagination ${crypto.randomUUID()}`;
  // 22 posts > the 20-entry page: Load more must surface the tail.
  await seedPosts(
    page,
    Array.from({ length: 22 }, (_, n) => `${prefix} ${String(n).padStart(2, '0')}`),
  );

  await page.goto('/profile/demo5');
  const items = page.locator('[data-testid^="post-item-"]', { hasText: prefix });
  await expect(items).toHaveCount(20);
  const loadMore = page.getByTestId('load-more');
  await expect(loadMore).toBeVisible();

  await loadMore.click();
  await expect(items).toHaveCount(22, { timeout: 15_000 });
  // Append-in-place: no ?cursor= navigation, the scroll position survives.
  await expect(page).toHaveURL(/\/profile\/demo5$/);
});

test('search results append in place via the same Load more', async ({ page }) => {
  test.setTimeout(120_000);
  await loginViaKeycloak(page, 'demo5', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);

  const needle = `t41 searchpage ${crypto.randomUUID()}`;
  // 21 posts = one over the 20-entry page: enough to prove Load more
  // appends in place without a 22-doc index burst alongside the other
  // suites (OpenSearch lags under concurrent load).
  await seedPosts(
    page,
    Array.from({ length: 21 }, (_, n) => `${needle} ${String(n).padStart(2, '0')}`),
  );

  // Indexing is async (post -> Kafka -> search-index worker): settle on the
  // search API first - Load more only sees what the index already holds.
  const searchApi = `/api/search/v1/search/posts?q=${encodeURIComponent(needle)}&limit=50`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await page.request.get(searchApi, { timeout: 10_000 });
    const text = (await res.text()) ?? '';
    const hits = text.split(needle).length - 1;
    if (res.ok() && hits >= 21) break;
    if (Date.now() > deadline) {
      throw new Error(`search index settled at ${hits}/21 for ${needle}`);
    }
    await page.waitForTimeout(1_500);
  }

  await page.goto(`/search?q=${encodeURIComponent(needle)}`);
  const results = page.locator('[data-testid^="post-item-"]', { hasText: needle });
  await expect(results).toHaveCount(20);

  await page.getByTestId('load-more').click();
  await expect(results).toHaveCount(21, { timeout: 15_000 });
  // Append-in-place: the query URL is untouched by Load more.
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(needle)}`));
});
