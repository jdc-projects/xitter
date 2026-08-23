import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Search flows against the real stack (#9): the header box submits to the
 * results page, seeded/composed text is findable, deleted posts disappear
 * from results, and unauthenticated visits redirect to login. Indexing is
 * asynchronous (post -> Kafka -> search-index worker -> OpenSearch), so
 * results are awaited with a reload-poll.
 */

const PASSWORD = 'DemoPass123!';

async function login(page: Page, username: string) {
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
}

/** Reload-poll the results page until the snippet appears (index lag). */
async function searchUntilFound(page: Page, q: string, snippet: string) {
  // 60s ceiling: the suite's own seeding bursts (22-post pagination seeds
  // running in parallel) can bury the search-index worker for tens of
  // seconds; the poll breaks the moment the snippet shows, so the ceiling
  // only costs time in the laggy case.
  const deadline = Date.now() + 60_000;
  for (;;) {
    await page.goto(`/search?q=${encodeURIComponent(q)}`);
    const results = page.getByTestId('search-results');
    if ((await results.isVisible().catch(() => false)) && (await results.textContent())) {
      const text = (await results.textContent()) ?? '';
      if (text.includes(snippet)) return;
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(1_000);
  }
  await expect(page.getByTestId('search-results')).toContainText(snippet);
}

test('unauthenticated search redirects to login and back', async ({ page }) => {
  await page.goto('/search?q=hello');
  await page.waitForURL(/\/login/);
  await expect(page).toHaveURL(/next=%2Fsearch%3Fq%3Dhello/);
});

test('header search box navigates to results for the query', async ({ page }) => {
  await login(page, 'demo1');
  // The header box hides itself on /search (#39): the page's own box is the
  // single labelled input, so no strict-mode scoping is needed anymore. The
  // header box is an uncontrolled GET form, so the URL (not the header
  // input) reflects the query after navigation; the page's box re-renders
  // with it.
  const headerSearch = page.getByTestId('app-nav').getByTestId('search-input');
  await headerSearch.fill('hello');
  await headerSearch.press('Enter');

  await page.waitForURL(/\/search\?q=hello/);
  await expect(page.getByTestId('search-input')).toHaveValue('hello');
});

test('search finds a composed post and deletes remove it from results', async ({ page }) => {
  // The search-index worker drains at roughly one doc/second locally, so the
  // suite's ~50-post seeding bursts leave a queue this test must wait out in
  // both phases - the default 60s test timeout cuts the tombstone poll short.
  test.setTimeout(180_000);
  await login(page, 'demo2');
  const needle = `t8 searchable quokka ${crypto.randomUUID()}`;

  // Compose through the real composer so the full posts -> events -> index
  // pipeline runs.
  await page.getByTestId('composer-textarea').fill(needle);
  await page.getByTestId('composer-submit').click();

  await searchUntilFound(page, 'quokka', needle);
  const item = page.locator('[data-testid^="post-item-"]', { hasText: needle }).first();
  await expect(item).toBeVisible();
  const postId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');

  // Delete it; the tombstone must drop it from results (reload-poll out).
  await page.goto(`/post/${postId}`);
  await page.getByTestId(`delete-post-${postId}`).click();
  await page.waitForURL(/\/feed$/);

  // Poll the search API (no page navigation - a mid-navigation locator
  // count reads undefined) until the index tombstone lands, then assert
  // on one settled page render.
  const searchApi = `/api/search/v1/search/posts?q=${encodeURIComponent('quokka')}`;
  // Same backlog story as searchUntilFound above: tombstones trail the
  // delete by however long the worker needs to drain the suite's burst.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = await page.request.get(searchApi);
    if (res.ok() && !((await res.text()) ?? '').includes(needle)) break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(1_000);
  }
  await page.goto(`/search?q=${encodeURIComponent('quokka')}`);
  await expect(page.locator('[data-testid^="post-item-"]', { hasText: needle })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('no-results query renders the empty state, not an error', async ({ page }) => {
  await login(page, 'demo3');
  const nothing = `zzz-no-such-token-${crypto.randomUUID()}`;

  await page.goto(`/search?q=${encodeURIComponent(nothing)}`);

  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(page.getByTestId('search-degraded')).toHaveCount(0);
});
