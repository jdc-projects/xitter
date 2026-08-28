import { expect, test, type Page } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * App-shell navigation (#39): icon'd NavLinks with an active state, the
 * mobile burger drawer, and search staying reachable below the xs
 * breakpoint (the header box alone used to vanish entirely).
 */

async function login(page: Page, username = 'demo4') {
  await loginViaKeycloak(page, username, 'DemoPass123!');
  await page.waitForURL(/\/feed$/);
}

/**
 * The nav link for a destination on whichever surface this viewport exposes:
 * header links ≥ sm, the drawer below it (#151 mobile matrix - the same
 * active marking lives in both).
 */
async function navLink(page: Page, name: string) {
  const header = page.getByTestId(`header-nav-${name}`);
  if (await header.isVisible()) return header;
  const burger = page.getByTestId('nav-burger');
  if (await burger.isVisible()) await burger.click();
  return page.getByTestId(`drawer-nav-${name}`);
}

test('nav marks the current page, not its siblings', async ({ page }) => {
  await login(page);

  const feed = await navLink(page, 'feed');
  await expect(feed).toBeVisible();
  await expect(feed).toHaveAttribute('aria-current', 'page');

  await (await navLink(page, 'bookmarks')).click();
  await page.waitForURL(/\/bookmarks$/);
  const bookmarks = await navLink(page, 'bookmarks');
  await expect(bookmarks).toHaveAttribute('aria-current', 'page');
  await expect(await navLink(page, 'feed')).not.toHaveAttribute('aria-current', 'page');
});

test('mobile drawer opens and navigates', async ({ page }) => {
  await test.step('log in at desktop width, then shrink', async () => {
    await login(page);
    await page.setViewportSize({ width: 400, height: 800 });
  });

  const burger = page.getByTestId('nav-burger');
  await expect(burger).toBeVisible();
  await burger.click();
  await expect(page.getByTestId('drawer-nav-search')).toBeVisible();

  // Search is reachable on mobile through the drawer as well as the header
  // icon - the box alone is hidden below xs.
  await page.getByTestId('drawer-nav-bookmarks').click();
  await page.waitForURL(/\/bookmarks$/);
});

test('search stays reachable on mobile via the header icon', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await login(page);

  const search = page.getByTestId('mobile-search-link');
  await expect(search).toBeVisible();
  await search.click();
  await page.waitForURL(/\/search$/);
});

test('/search renders exactly one labelled search input', async ({ page }) => {
  await login(page);
  await page.goto('/search?q=hello');

  // The header box hides itself on /search (#39): the page's box is the
  // only one - no duplicate testid or aria-label pairs.
  await expect(page.getByTestId('search-input')).toHaveCount(1);
  await expect(page.getByLabel('Search posts')).toHaveCount(1);
});
