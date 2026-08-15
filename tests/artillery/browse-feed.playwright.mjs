const target = process.env.E2E_BASE_URL ?? "http://localhost:8080";

/**
 * Artillery Playwright-engine flows (browser-level load testing).
 * Each export receives a fresh page per virtual user iteration.
 */
export async function browseFeed(page) {
  await page.goto(`${target}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

export async function landingToAbout(page) {
  await page.goto(`${target}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "About" }).click();
  await page.waitForLoadState("networkidle");
}
