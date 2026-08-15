import type { Page } from '@playwright/test';

const target = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

/** Artillery Playwright-engine flows (browser-level load testing). */
export async function browseFeedFlow(page: Page): Promise<void> {
  await page.goto(`${target}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

export async function landingToAbout(page: Page): Promise<void> {
  await page.goto(`${target}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'About' }).click();
  await page.waitForLoadState('networkidle');
}
