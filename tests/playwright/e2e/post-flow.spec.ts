import { expect, test } from "@playwright/test";

/**
 * Post flow: login -> post -> see it in the feed.
 * Skeleton - activates as the auth and posts features land.
 */
test("demo user can post and see it in the feed", async ({ page }) => {
  test.skip(true, "auth feature ticket pending");
  await page.goto("/login");
  await expect(page.getByTestId("login-panel")).toBeVisible();
});
