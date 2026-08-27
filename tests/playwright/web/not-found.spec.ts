import { expect, test } from '@playwright/test';

// The unmatched-route catch-all (#135) lives in the (app) group, one segment
// below the public routes - static segments must keep winning resolution so
// the landing page, About and login stay reachable and untouched. This suite
// runs the web app alone (no session store), which is exactly the
// signed-out render: the 404 body inside the app frame, user bits absent.
// The signed-in shell retention is pinned end-to-end in e2e/not-found.spec.ts.
test('an unmatched route renders the 404, not the landing page or a redirect', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-page');

  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/definitely-not-a-page$/);
  await expect(page.getByTestId('not-found')).toBeVisible();

  // Signed out: the frame renders without user bits (no handle, no logout).
  await expect(page.getByTestId('nav-username')).toHaveCount(0);
  await expect(page.getByTestId('logout-button')).toHaveCount(0);
});

test('public routes still resolve ahead of the catch-all', async ({ page }) => {
  for (const path of ['/', '/about', '/login']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.getByTestId('not-found'), path).toHaveCount(0);
  }

  // One deeper: a public-looking but nonexistent path still 404s.
  const response = await page.goto('/about/extra-segment');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
});
