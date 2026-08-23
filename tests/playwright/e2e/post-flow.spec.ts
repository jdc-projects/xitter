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
  await expect(page.getByTestId('reply-thread')).toContainText(replyText);

  // The root post's reply count ticks to 1 on the detail card.
  await expect(page.getByTestId(`post-detail-${rootId}`).getByTestId('count-replies')).toHaveText(
    /1/,
  );

  // And the author sees the thread too.
  const demo7again = await loggedInPage(browser, 'demo7');
  await demo7again.goto(`/post/${rootId}`);
  await expect(demo7again.getByTestId('reply-thread')).toContainText(replyText);
  await demo7again.close();
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
