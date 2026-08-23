import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak, waitForComposerHydration } from './helpers';

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

/**
 * Poll the search API until the snippet is indexed, then assert on ONE
 * settled page render. The old reload-poll navigated the full page per
 * iteration: on 2-core CI runners each SSR navigation costs seconds, so a
 * 30s budget allowed only a handful of polls and slow (but healthy)
 * indexing blew the budget - the failure mode was the empty-state page,
 * not an index problem. An API poll costs milliseconds per iteration.
 */
async function searchUntilFound(page: Page, q: string, snippet: string, timeoutMs = 90_000) {
  const token = await accessToken(page);
  const searchApi = `/api/search/v1/posts?q=${encodeURIComponent(q)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.request.get(searchApi, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok() && ((await res.text()) ?? '').includes(snippet)) break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(1_000);
  }
  await page.goto(`/search?q=${encodeURIComponent(q)}`);
  await expect(page.getByTestId('search-results')).toContainText(snippet);
}

test('unauthenticated search redirects to login and back', async ({ page }) => {
  await page.goto('/search?q=hello');
  await page.waitForURL(/\/login/);
  await expect(page).toHaveURL(/next=%2Fsearch%3Fq%3Dhello/);
});

test('header search box navigates to results for the query', async ({ page }) => {
  await login(page, 'demo1');
  // Two inputs carry the testid once on /search (header + page) - scope to
  // the header's app nav to stay strict-mode safe. The header box is an
  // uncontrolled GET form, so the URL (not the header input) reflects the
  // query after navigation; the page's own box re-renders with it.
  const headerSearch = page.getByTestId('app-nav').getByTestId('search-input');
  await headerSearch.fill('hello');
  await headerSearch.press('Enter');

  await page.waitForURL(/\/search\?q=hello/);
  await expect(page.getByTestId('search-input').last()).toHaveValue('hello');
});

/** Bearer access token for API polls - the session holds it; the ws route
 * is the broker (same pattern as feed-flow). Uses the page's cookies. */
async function accessToken(page: Page): Promise<string> {
  const res = await page.request.get('/api/ws/feed-token');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

test('search finds a composed post and deletes remove it from results', async ({ page }) => {
  // Indexing converges in tens of seconds on a loaded stack (all services +
  // workers + parallel specs), and this test has TWO convergence windows
  // (compose→index up to 120s, delete→tombstone up to 60s) plus a settled
  // render assertion. The budget must exceed their SUM (a 150s budget
  // timed out mid-tombstone-poll on cold CI runners despite both windows
  // being individually healthy).
  test.setTimeout(240_000);
  await login(page, 'demo2');
  const needle = `t8 searchable quokka ${crypto.randomUUID()}`;

  // Compose through the real composer so the full posts -> events -> index
  // pipeline runs.
  await waitForComposerHydration(page);
  await page.getByTestId('composer-textarea').fill(needle);
  await page.getByTestId('composer-submit').click();

  await searchUntilFound(page, 'quokka', needle, 120_000);
  const item = page.locator('[data-testid^="post-item-"]', { hasText: needle }).first();
  await expect(item).toBeVisible();
  const postId = (await item.getAttribute('data-testid'))!.replace('post-item-', '');

  // Delete it; the tombstone must drop it from results (reload-poll out).
  await page.goto(`/post/${postId}`);
  await page.getByTestId(`delete-post-${postId}`).click();
  await page.waitForURL(/\/feed$/);

  // Poll the search API (no page navigation - a mid-navigation locator
  // count reads undefined) until the index tombstone lands, then assert
  // on one settled page render. The API is user-gated: poll with the
  // session's bearer so res.ok() reflects the index, not a 401. (Public
  // search path is /v1/posts under the service prefix - api-contracts'
  // canonical route.)
  const token = await accessToken(page);
  const searchApi = `/api/search/v1/posts?q=${encodeURIComponent('quokka')}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await page.request.get(searchApi, {
      headers: { authorization: `Bearer ${token}` },
    });
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
