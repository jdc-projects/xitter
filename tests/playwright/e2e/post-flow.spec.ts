import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaKeycloak, waitForComposerHydration } from './helpers';

/**
 * Post flows against the real stack: compose -> own profile + detail, reply
 * threads, delete-everywhere, and the 512-char boundary (friendly error,
 * draft preserved). Distinct demo accounts per test keep them
 * order-independent - service state survives across tests. Post ids are
 * scraped from feed item testids so direct-URL checks use the real id.
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
  // T6: the feed is materialised asynchronously (post -> Kafka -> fanout) -
  // the ws banner announces arrival, so click through it like a user.
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

test('post appears on feed + own profile + detail; delete removes it everywhere', async ({
  page,
}) => {
  await login(page, 'demo6');
  const text = `t4 e2e lifecycle ${crypto.randomUUID()}`;

  await compose(page, text);
  const postId = await feedPostId(page, text);
  await expect(page.getByTestId(`post-${postId}`)).toBeVisible();

  // Own profile posts tab shows it.
  await page.goto('/profile/demo6');
  await expect(page.getByTestId('profile-posts')).toContainText(text);

  // Detail page shows it with the composer's author identity.
  await page.goto(`/post/${postId}`);
  await expect(page.getByTestId(`post-detail-${postId}`)).toContainText(text);

  // Delete from the detail page redirects to the feed, empty-handed.
  await page.getByTestId(`delete-post-${postId}`).click();
  await page.waitForURL(/\/feed$/);
  await expect(page.locator(`[data-testid^="post-item-"]`, { hasText: text })).toHaveCount(0);

  // Gone from the profile tab and as a direct URL (soft delete reads as 404).
  await page.goto('/profile/demo6');
  await expect(page.locator('[data-testid="profile-posts"]', { hasText: text })).toHaveCount(0);
  const response = await page.goto(`/post/${postId}`);
  expect(response?.status()).toBe(404);
});

test('reply threads render with reply counts', async ({ page, browser }) => {
  const demo7 = await loggedInPage(browser, 'demo7');
  const rootText = `t4 e2e thread root ${crypto.randomUUID()}`;
  await compose(demo7, rootText);
  const rootId = await feedPostId(demo7, rootText);
  await demo7.close();

  await login(page, 'demo6');
  await page.goto(`/post/${rootId}`);

  const replyText = `t4 e2e reply ${crypto.randomUUID()}`;
  await waitForComposerHydration(page, 'reply-composer');
  await page.getByTestId('reply-composer-textarea').fill(replyText);
  await page.getByTestId('reply-composer-submit').click();

  // The reply lands in the thread on the same page.
  await expect(page.getByTestId('thread-tree')).toContainText(replyText);

  // The root post's reply count ticks to 1 on the detail card.
  await expect(page.getByTestId(`post-detail-${rootId}`).getByTestId('count-replies')).toHaveText(
    /1/,
  );

  // And the author sees the thread too.
  const demo7again = await loggedInPage(browser, 'demo7');
  await demo7again.goto(`/post/${rootId}`);
  await expect(demo7again.getByTestId('thread-tree')).toContainText(replyText);
  await demo7again.close();
});

/** Reply through the real composer on a post's detail page. */
async function replyFromDetail(page: Page, postId: string, text: string) {
  await page.goto(`/post/${postId}`);
  await waitForComposerHydration(page, 'reply-composer');
  await page.getByTestId('reply-composer-textarea').fill(text);
  await page.getByTestId('reply-composer-submit').click();
  // Wait for the reply to land in the thread before the caller walks on.
  await expect(page.getByTestId('thread-tree')).toContainText(text);
}

/** The tree-node id matching a text snippet (post-item-<id> testid). */
async function threadNodeIdFor(page: Page, text: string): Promise<string> {
  const item = page.locator('[data-testid^="post-item-"]', { hasText: text }).first();
  await expect(item).toBeVisible();
  return (await item.getAttribute('data-testid'))!.replace('post-item-', '');
}

/**
 * #152 thread view: opening a reply shows the full ancestor chain as
 * linked context cards, nested replies render under their parent (not the
 * root's top level), and conversation beyond the embedded depth is reached
 * by "Show this thread" navigation. Chain built through the real
 * composers: root -> r1 -> r2 -> r3 -> r4 (the tests must not depend on
 * #150's corpus nesting).
 */
test('thread view walks ancestors, nesting, and depth-cap navigation', async ({ page }) => {
  await login(page, 'demo9');

  const rootText = `t152 thread root ${crypto.randomUUID()}`;
  await compose(page, rootText);
  const rootId = await feedPostId(page, rootText);

  const r1Text = `t152 r1 ${crypto.randomUUID()}`;
  await replyFromDetail(page, rootId, r1Text);
  const r1Id = await threadNodeIdFor(page, r1Text);

  const r2Text = `t152 r2 ${crypto.randomUUID()}`;
  await replyFromDetail(page, r1Id, r2Text);
  const r2Id = await threadNodeIdFor(page, r2Text);

  const r3Text = `t152 r3 ${crypto.randomUUID()}`;
  await replyFromDetail(page, r2Id, r3Text);
  const r3Id = await threadNodeIdFor(page, r3Text);

  const r4Text = `t152 r4 ${crypto.randomUUID()}`;
  await replyFromDetail(page, r3Id, r4Text);

  // Opening the mid-chain reply: ancestors render as linked context cards
  // (root → parent) above the focus, root-first.
  await page.goto(`/post/${r2Id}`);
  const ancestors = page.getByTestId('thread-ancestors');
  await expect(ancestors.getByTestId(`post-ancestor-${rootId}`)).toBeVisible();
  await expect(ancestors.getByTestId(`post-ancestor-${r1Id}`)).toBeVisible();
  await expect(ancestors.locator('[data-testid^="post-ancestor-"]')).toHaveCount(2);

  // Exactly one composer per page, anchored at the focus.
  await expect(page.getByTestId('reply-composer-form')).toBeVisible();

  // Clicking an ancestor navigates to its own thread page.
  await ancestors.getByTestId(`post-ancestor-${rootId}`).getByRole('link').first().click();
  await page.waitForURL(new RegExp(`/post/${rootId}$`));

  // Nested placement: r2 sits under r1's branch, never in the root's
  // top-level list.
  await expect(page.getByTestId(`thread-node-${r1Id}`)).toBeVisible();
  await expect(page.getByTestId(`thread-children-${r1Id}`)).toContainText(r2Text);
  const topLevel = page
    .getByTestId('thread-tree')
    .locator(':scope > [data-testid^="thread-node-"]');
  await expect(topLevel).toHaveCount(1); // only the direct reply
  await expect(topLevel).toContainText(r1Text);
  // r2 is nested INSIDE r1's node (a descendant), not a top-level sibling -
  // toContainText reads the whole subtree, so assert structure: exactly one
  // r2 node, and it lives within the single top-level node.
  await expect(topLevel.getByTestId(`thread-node-${r2Id}`)).toHaveCount(1);
  await expect(
    page.getByTestId('thread-tree').locator(':scope > [data-testid^="thread-node-"]').getByTestId(`thread-node-${r2Id}`),
  ).toHaveCount(1);

  // r3 is at the embedded depth cap (3 below the focus) with r4 below it:
  // navigation, not inline expansion.
  await expect(page.getByTestId(`thread-node-${r3Id}`)).toBeVisible();
  await expect(page.getByTestId('thread-tree')).not.toContainText(r4Text);
  await page.getByTestId(`show-thread-${r3Id}`).click();
  await page.waitForURL(new RegExp(`/post/${r3Id}$`));
  await expect(page.getByTestId(`post-detail-${r3Id}`)).toBeVisible();
  await expect(page.getByTestId('thread-tree')).toContainText(r4Text);
});

test('thread branches reveal hidden replies with the per-node control', async ({ page }) => {
  await login(page, 'demo10');

  // A root with one reply that gathers three of its own: two embed as
  // previews, the third sits behind the "Show N replies" reveal.
  const rootText = `t152 wide root ${crypto.randomUUID()}`;
  await compose(page, rootText);
  const rootId = await feedPostId(page, rootText);

  const branchText = `t152 branch ${crypto.randomUUID()}`;
  await replyFromDetail(page, rootId, branchText);
  const branchId = await threadNodeIdFor(page, branchText);

  const firstText = `t152 wide first ${crypto.randomUUID()}`;
  await replyFromDetail(page, branchId, firstText);
  const secondText = `t152 wide second ${crypto.randomUUID()}`;
  await replyFromDetail(page, branchId, secondText);
  const thirdText = `t152 wide third ${crypto.randomUUID()}`;
  await replyFromDetail(page, branchId, thirdText);

  await page.goto(`/post/${rootId}`);
  const branch = page.getByTestId(`thread-children-${branchId}`);
  // Two preview children, the third behind the reveal control.
  await expect(branch).toContainText(firstText);
  await expect(branch).toContainText(secondText);
  await expect(page.getByTestId('thread-tree')).not.toContainText(thirdText);
  await expect(page.getByTestId(`show-replies-${branchId}`)).toHaveText(/3 replies/);

  await page.getByTestId(`show-replies-${branchId}`).click();
  await expect(page.getByTestId('thread-tree')).toContainText(thirdText);
  // No duplicates from the reveal (page 1 re-includes the previews).
  await expect(page.locator('[data-testid^="post-item-"]', { hasText: firstText })).toHaveCount(1);
  // The reveal is in place: no navigation away from the thread.
  await expect(page).toHaveURL(new RegExp(`/post/${rootId}$`));
});

test('oversize post is rejected with a friendly error and the draft is preserved', async ({
  page,
}) => {
  await login(page, 'demo8');
  await waitForComposerHydration(page);
  const tooLong = 'x'.repeat(513);

  await page.getByTestId('composer-textarea').fill(tooLong);
  await expect(page.getByTestId('composer-counter')).toHaveText('513/512');
  await page.getByTestId('composer-submit').click();

  await expect(page.getByTestId('composer-error')).toContainText('512');
  // Acceptance: the draft survives the failed submission.
  await expect(page.getByTestId('composer-textarea')).toHaveValue(tooLong);
});
