import { expect, type Page } from '@playwright/test';

/** Drive the real Keycloak login form (local docker stack, Cap disabled). */
export async function loginViaKeycloak(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/realms\/xitter-demo\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

/**
 * Wait until the composer's React handlers exist. The SSR'd form renders
 * immediately but its onChange/onSubmit only attach at hydration; a fill or
 * file-change in that window is silently discarded (the controlled
 * re-render resets state - observed as a permanently-disabled submit and a
 * missing upload-error alert on slow CI runners). The composer sets
 * data-hydrated in a client-only effect; waiting on it removes the race for
 * every spec that composes or attaches files.
 */
export async function waitForComposerHydration(page: Page, testId = 'composer') {
  await expect(page.getByTestId(`${testId}-form`)).toHaveAttribute('data-hydrated', 'true');
}

/**
 * Horizontal-overflow guard (#151): the document must never scroll sideways
 * at a phone viewport. +1px tolerance absorbs subpixel rounding in
 * fractional-width viewports (390x844 DPR 3 reports fractional widths).
 */
export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `document scrolls horizontally: ${JSON.stringify(metrics)}`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 1);
}
