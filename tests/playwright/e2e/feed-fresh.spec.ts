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
  const rootId = ((await root.json()) as { id: string }).id;

  // The ring graph seeds demo4 -> demo3, so demo3's reply fans out to demo4.
  await login(page, 'demo4');
  const replyText = `t6 reply context reply ${crypto.randomUUID()}`;
  const reply = await demo3.request.post('/api/posts/v1/posts', {
    headers: { authorization: `Bearer ${token}` },
    data: { text: replyText, mediaIds: [], replyToId: rootId },
  });
  expect(reply.status()).toBe(201);

  // Entries land asynchronously via fanout; click through the banner like a
  // user would (same pattern as feed-flow's waitForFeedItem).
  const item = page.locator('[data-testid^="post-item-"]', { hasText: replyText }).first();
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  await expect(item.locator('[data-testid^="post-reply-context-"]')).toHaveText(
    'Replying to @demo3',
  );

  await demo3.close();
});
