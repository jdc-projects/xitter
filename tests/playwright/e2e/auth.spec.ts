import { expect, test } from "@playwright/test";

test.describe("unauthenticated access", () => {
  test("landing and about are public", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("reset-notice")).toBeVisible();

    await page.goto("/about");
    await expect(page.getByRole("heading", { level: 1, name: "About" })).toBeVisible();
  });

  test("user content requires login", async ({ page }) => {
    await page.goto("/feed");
    await expect(page).toHaveURL(/\/login/);
  });
});
