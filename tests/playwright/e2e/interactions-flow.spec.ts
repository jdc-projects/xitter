import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaKeycloak, waitForComposerHydration } from './helpers';

/**
 * Interaction flows against the real stack (T7): like/unlike with counts and
 * filled states, bookmark privacy, repost fan-out with attribution +
 * author ws ping, undo, and the blocked-user regression (all kinds incl.
 * replies). Distinct demo-account pairs per test keep them order-independent.
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
  await waitForComposerHydration(page);
  await page.getByTestId('composer-textarea').fill(text);
  await page.getByTestId('composer-submit').click();
}

/** The first feed post id matching a text snippet (post-item-<id> testid). */
async function feedPostId(page: Page, text: string): Promise<string> {
  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  // The feed materialises asynchronously (post -> Kafka -> fanout) - the ws
  // banner announces arrival, so click through it like a user.
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  return (await item.getAttribute('data-testid'))!.replace('post-item-', '');
}

test('like fills the icon and bumps the count; unlike reverses both', async ({ page }) => {
  await login(page, 'demo6');
  const text = `t7 like flow ${crypto.randomUUID()}`;
  await compose(page, text);
  const postId = await feedPostId(page, text);

  const card = page.getByTestId(`post-${postId}`);
  const like = card.getByTestId('count-likes');
  await expect(like).toHaveText(/0/);
  await expect(like).toHaveAttribute('aria-pressed', 'false');

  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(like).toHaveText(/1/);

  // The detail page agrees (server-rendered viewer-state + counts).
  await page.goto(`/post/${postId}`);
  const detailLike = page.getByTestId(`post-${postId}`).getByTestId('count-likes');
  await expect(detailLike).toHaveAttribute('aria-pressed', 'true');
  await expect(detailLike).toHaveText(/1/);

  await page.goto('/feed');
  await page.reload();
  const likeAgain = page.getByTestId(`post-${postId}`).getByTestId('count-likes');
  await expect(likeAgain).toHaveAttribute('aria-pressed', 'true');

  await likeAgain.click();
  await expect(likeAgain).toHaveAttribute('aria-pressed', 'false');
  await expect(likeAgain).toHaveText(/0/);
});

test('bookmarks are visible only on the bookmarker own bookmarks page', async ({
  page,
  browser,
}) => {
  const demo7 = await loggedInPage(browser, 'demo7');
  const text = `t7 bookmark target ${crypto.randomUUID()}`;
  await compose(demo7, text);
  const postId = await feedPostId(demo7, text);
  await demo7.close();

  // demo6 bookmarks demo7's post from the detail page.
  await login(page, 'demo6');
  await page.goto(`/post/${postId}`);
  const bookmark = page.getByTestId(`post-${postId}`).getByTestId('count-bookmarks');
  await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
  await bookmark.click();
  await expect(bookmark).toHaveAttribute('aria-pressed', 'true');

  // Own bookmarks page lists it with the filled state (the click returns on
  // the optimistic flip; the revalidate may still be in flight - poll).
  await page.goto('/bookmarks');
  const bookmarkList = page.getByTestId('bookmarks-list');
  const listDeadline = Date.now() + 15_000;
  while (!(await bookmarkList.isVisible().catch(() => false)) && Date.now() < listDeadline) {
    await page.reload();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await expect(bookmarkList).toContainText(text);
  await expect(page.getByTestId(`post-${postId}`).getByTestId('count-bookmarks')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Another user's bookmarks page never shows it.
  const demo8 = await loggedInPage(browser, 'demo8');
  await demo8.goto('/bookmarks');
  await expect(demo8.getByTestId('bookmarks-empty')).toBeVisible();
  await expect(demo8.locator('body')).not.toContainText(text);
  await demo8.close();

  // Undo removes it from the page.
  await page.goto('/bookmarks');
  await page.getByTestId(`post-${postId}`).getByTestId('count-bookmarks').click();
  const gone = page.locator('[data-testid^="post-item-"]', { hasText: text });
  const deadline = Date.now() + 15_000;
  while ((await gone.count()) > 0 && Date.now() < deadline) {
    await page.reload();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await expect(gone).toHaveCount(0);
});

test('reposts appear in followers feeds with attribution and undo removes them', async ({
  page,
  browser,
}) => {
  const demo9 = await loggedInPage(browser, 'demo9');
  const rootText = `t7 repost root ${crypto.randomUUID()}`;
  await compose(demo9, rootText);
  const postId = await feedPostId(demo9, rootText);
  // demo9 keeps their feed open: the author ws ping (product 6.7) lands on
  // the live socket.
  await demo9.goto('/feed');

  // demo10 reposts the post straight from its detail URL (no follow, so
  // their feed holds ONLY the repost entry - attribution is unambiguous).
  const demo10 = await loggedInPage(browser, 'demo10');
  await demo10.goto(`/post/${postId}`);
  const repost = demo10.getByTestId(`post-${postId}`).getByTestId('count-reposts');
  await expect(repost).toHaveText(/0/);
  await repost.click();
  await expect(repost).toHaveAttribute('aria-pressed', 'true');
  await expect(repost).toHaveText(/1/);

  // The reposter's own feed shows the post attributed to them (displayName
  // line + the reposter as the card's surface author).
  await demo10.goto('/feed');
  const item = demo10.locator('[data-testid^="post-item-"]', { hasText: rootText });
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false)) && Date.now() < deadline) {
    const show = demo10.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await demo10.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  await expect(demo10.getByTestId(`post-repost-attribution-${postId}`)).toContainText('reposted');
  await expect(demo10.getByTestId(`post-${postId}`)).toContainText('@demo10');
  await expect(demo10.getByTestId(`post-${postId}`).getByTestId('count-reposts')).toHaveText(/1/);

  // The author got a ws ping for the repost of their post (hint only - no
  // feed entries behind it, they do not follow the reposter).
  await expect(demo9.getByTestId('feed-new-items')).toBeVisible({ timeout: 20_000 });

  // Undo: the repost entry leaves the reposter's feed.
  await demo10.goto('/feed');
  await demo10.getByTestId(`post-${postId}`).getByTestId('count-reposts').click();
  const attribution = demo10.getByTestId(`post-repost-attribution-${postId}`);
  const undoDeadline = Date.now() + 15_000;
  while ((await attribution.count()) > 0 && Date.now() < undoDeadline) {
    await demo10.reload();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await expect(attribution).toHaveCount(0);
  await expect(demo10.locator('[data-testid^="post-item-"]', { hasText: rootText })).toHaveCount(0);

  await demo10.close();
  await demo9.close();
});

test('a blocked user cannot like, repost or reply', async ({ page, browser }) => {
  const demo2 = await loggedInPage(browser, 'demo2');
  const text = `t7 blocked target ${crypto.randomUUID()}`;
  await compose(demo2, text);
  const postId = await feedPostId(demo2, text);
  await demo2.close();

  // demo1 blocks demo3 (block state survives within the run).
  await login(page, 'demo1');
  await page.goto('/profile/demo3');
  const block = page.getByTestId('block-button');
  if (await block.isVisible()) {
    await block.click();
    await expect(page.getByTestId('unblock-button')).toBeVisible();
  }
  await page.close();

  // demo3 cannot interact with demo1's content - demo1 posts their own target.
  const demo1 = await loggedInPage(browser, 'demo1');
  const targetText = `t7 blocked target own ${crypto.randomUUID()}`;
  await compose(demo1, targetText);
  const targetId = await feedPostId(demo1, targetText);
  await demo1.close();

  const demo3 = await loggedInPage(browser, 'demo3');
  await demo3.goto(`/post/${targetId}`);
  const card = demo3.getByTestId(`post-${targetId}`);
  // The error alert renders as a sibling of the card (never inside the
  // card's own anchor - nested interactives are an a11y violation).
  const error = demo3.getByTestId(`interact-error-${targetId}`);

  await card.getByTestId('count-likes').click();
  await expect(error).toContainText(/cannot interact/i);
  await expect(card.getByTestId('count-likes')).toHaveAttribute('aria-pressed', 'false');

  await card.getByTestId('count-reposts').click();
  await expect(error).toContainText(/cannot interact/i);

  await demo3.getByTestId('reply-composer-textarea').fill('blocked reply');
  await demo3.getByTestId('reply-composer-submit').click();
  await expect(demo3.getByTestId('reply-composer-error')).toContainText(/cannot reply/i);
  // No thread renders for a zero-reply post, and the rejected draft never
  // becomes a reply - it stays in the composer (draft-preserved behaviour).
  await expect(demo3.getByTestId('replies-empty')).toBeVisible();
  await expect(demo3.locator('[data-testid^="post-item-"]')).toHaveCount(0);
  await demo3.close();
});
