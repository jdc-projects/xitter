import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, loginViaKeycloak } from './helpers';

/**
 * Mobile-only guards (#151): this file runs in the `mobile` (iPhone 13,
 * 390x844) and `mobile-se` (iPhone SE, 375x667) projects only - the
 * horizontal-overflow check is a phone-viewport contract. Every primary
 * surface is held to it, plus the two component-level guarantees the issue
 * called out: the fluid search box and the stacked profile header.
 */

const PASSWORD = 'DemoPass123!';

async function login(page: Page, username = 'demo1') {
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
}

/** First seeded post id on the feed, for the detail-page check. */
async function firstFeedPostId(page: Page): Promise<string> {
  const item = page.locator('[data-testid^="post-item-"]').first();
  await expect(item).toBeVisible();
  return (await item.getAttribute('data-testid'))!.replace('post-item-', '');
}

test('the feed does not scroll horizontally', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('composer-form')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('bookmarks does not scroll horizontally', async ({ page }) => {
  await login(page, 'demo2');
  await page.goto('/bookmarks');
  await expect(
    page.getByTestId('bookmarks-list').or(page.getByTestId('bookmarks-empty')),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('the profile header stacks instead of overflowing', async ({ page }) => {
  await login(page, 'demo3');
  await page.goto('/profile/demo3');

  // Stacked layout (#151): the actions row renders BELOW the identity
  // block at phone widths (its top edge starts after the avatar's bottom).
  const avatar = page.getByTestId('profile-avatar');
  const actions = page
    .getByTestId('follow-button')
    .or(page.getByTestId('unfollow-button'))
    .or(page.getByTestId('edit-profile-button'));
  await expect(avatar).toBeVisible();
  await expect(actions).toBeVisible();

  const avatarBox = await avatar.boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(avatarBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.y).toBeGreaterThanOrEqual(avatarBox!.y + avatarBox!.height - 1);

  await expectNoHorizontalOverflow(page);
});

test('the search page renders a fluid search box', async ({ page }) => {
  await login(page);
  await page.goto('/search');

  // The page's box IS the primary control: at a phone viewport it fills the
  // container (≥ 80% of the viewport) instead of the header's 140px (#151).
  const box = page.getByTestId('search-input');
  await expect(box).toBeVisible();
  const inputBox = await box.boundingBox();
  const viewport = page.viewportSize();
  expect(inputBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(inputBox!.width).toBeGreaterThan(viewport!.width * 0.8);

  await page.getByTestId('search-input').fill('feed');
  await page.getByTestId('search-input').press('Enter');
  await page.waitForURL(/\/search\?q=feed$/);
  await expect(
    page.getByTestId('search-results').or(page.getByTestId('search-empty')),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('post detail (focus + thread) does not scroll horizontally', async ({ page }) => {
  await login(page);
  const postId = await firstFeedPostId(page);
  await page.goto(`/post/${postId}`);
  await expect(page.getByTestId(`post-detail-${postId}`)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a post with a long unbroken token wraps inside the card', async ({ page }) => {
  await login(page);
  // Compose the overflow case directly (a 90-char unbroken token), then
  // hold the card to the viewport - overflow-wrap:anywhere (#151).
  const token = `https://example.com/${'a'.repeat(80)}`;
  await page.getByTestId('composer-form').waitFor({ state: 'attached' });
  await expect(page.getByTestId('composer-form')).toHaveAttribute('data-hydrated', 'true');
  await page.getByTestId('composer-textarea').fill(token);
  await page.getByTestId('composer-submit').click();

  const item = page.locator('[data-testid^="post-item-"]', { hasText: token }).first();
  const deadline = Date.now() + 20_000;
  while (!(await item.isVisible().catch(() => false))) {
    if (Date.now() > deadline) break;
    const show = page.getByTestId('feed-new-items').getByRole('button');
    if (await show.isVisible().catch(() => false)) await show.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(item).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
