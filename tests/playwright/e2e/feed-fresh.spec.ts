import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaKeycloak, waitForComposerHydration } from './helpers';

/**
 * Feed freshness (#148) and reply context (#147): a fresh own post is
 * visible immediately (optimistic prepend - no fanout wait, no reload), and
 * replies in the timeline carry a "Replying to @x" context line.
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

/** Bearer access token for API-driven setup (same broker route as the ws). */
async function accessToken(page: Page): Promise<string> {
  const res = await page.request.get('/api/ws/feed-token');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

test('a fresh own post appears at the top of the feed without a reload (#148)', async ({
  page,
}) => {
  await login(page, 'demo1');
  const text = `t6 fresh own post ${crypto.randomUUID()}`;
  await waitForComposerHydration(page);
  await page.getByTestId('composer-textarea').fill(text);
  await page.getByTestId('composer-submit').click();

  // The optimistic prepend shows the post as soon as the action resolves -
  // no banner click, no reload, no 20 s fanout wait.
  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  await expect(item).toBeVisible({ timeout: 5_000 });
});

test('replies in the feed carry a "Replying to @x" context line (#147)', async ({
  page,
  browser,
}) => {
  const demo3 = await loggedInPage(browser, 'demo3');
  const token = await accessToken(demo3);
  const rootText = `t6 reply context root ${crypto.randomUUID()}`;
  const root = await demo3.request.post('/api/posts/v1/posts', {
    headers: { authorization: `Bearer ${token}` },
    data: { text: rootText, mediaIds: [], replyToId: null },
  });
  expect(root.status()).toBe(201);
  const rootBody = (await root.json()) as { id: string; authorId: string };
  const rootId = rootBody.id;

  await login(page, 'demo4');
  // The corpus's follow graph is density-derived and CHANGES (#150 rotates
  // it again) - never assume a pair. Make THIS viewer follow the author
  // (idempotent), so the reply is guaranteed to fan out to them.
  const demo4Token = await accessToken(page);
  const follow = await page.request.post(`/api/social/v1/profiles/${rootBody.authorId}/follow`, {
    headers: { authorization: `Bearer ${demo4Token}` },
  });
  expect([200, 201, 204, 409]).toContain(follow.status());
  const replyText = `t6 reply context reply ${crypto.randomUUID()}`;
  const reply = await demo3.request.post('/api/posts/v1/posts', {
    headers: { authorization: `Bearer ${token}` },
    data: { text: replyText, mediaIds: [], replyToId: rootId },
  });
  expect(reply.status()).toBe(201);

  // Entries land asynchronously via fanout. The ws banner is at-most-once
  // (a missed notify means no banner) and #148b's polling only covers a
  // CLOSED socket - so refresh like a user would, same as feed-flow's
  // backfill wait, until the reply lands.
  const item = page.locator('[data-testid^="post-item-"]', { hasText: replyText }).first();
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false)) && Date.now() < deadline) {
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    else await page.reload();
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  await expect(item.locator('[data-testid^="post-reply-context-"]')).toHaveText(
    'Replying to @demo3',
  );

  await demo3.close();
});
