import type { Page } from '@playwright/test';

/** Drive the real Keycloak login form (local docker stack, Cap disabled). */
export async function loginViaKeycloak(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/realms\/xitter-demo\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}
