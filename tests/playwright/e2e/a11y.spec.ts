import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

/**
 * Accessibility smoke checks (WCAG 2.2 AA via axe-core). Each new page adds a
 * case here as it lands - see docs/specs/testing for the full strategy.
 */
const pages = ['/', '/about', '/login'];

for (const path of pages) {
  test(`${path} has no serious axe violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
}

test('/profile/[username] (own, authenticated) has no serious axe violations', async ({ page }) => {
  await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
  await page.waitForURL(/\/feed$/);
  await page.goto('/profile/demo1');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});
