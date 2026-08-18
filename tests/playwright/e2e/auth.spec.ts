import { expect, test } from '@playwright/test';
import { loginViaKeycloak } from './helpers';

test.describe('unauthenticated access', () => {
  test('landing and about are public', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('reset-notice')).toBeVisible();

    await page.goto('/about');
    await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
  });

  test('feed redirects to login with a next path', async ({ page }) => {
    await page.goto('/feed');
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/feed');
    // No user content renders unauthenticated.
    await expect(page.getByTestId('feed-timeline')).toHaveCount(0);
    await expect(page.getByTestId('composer-form')).toHaveCount(0);
  });

  test('profiles and posts redirect to login', async ({ page }) => {
    await page.goto('/profile/demo2');
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/profile/demo2');
    await expect(page.getByTestId('profile-placeholder')).toHaveCount(0);

    await page.goto('/post/00000000-0000-4000-8000-000000000001');
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(
      '/post/00000000-0000-4000-8000-000000000001',
    );
  });
});

test.describe('login flow', () => {
  test('demo1 can log in and lands on the feed', async ({ page }) => {
    await loginViaKeycloak(page, 'demo1', 'DemoPass123!');
    await page.waitForURL(/\/feed$/);
    await expect(page.getByTestId('composer-form')).toBeVisible();
    await expect(page.getByTestId('nav-username')).toHaveText('@demo1');
  });

  test('login preserves the requested next path', async ({ page }) => {
    await page.goto('/profile/demo2');
    await expect(page).toHaveURL(/\/login/);
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/realms\/xitter-demo\//);
    await page.locator('#username').fill('demo3');
    await page.locator('#password').fill('DemoPass123!');
    await page.locator('#kc-login').click();
    await page.waitForURL(/\/profile\/demo2$/);
  });

  test('wrong password is rejected without creating a session', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/realms\/xitter-demo\//);
    await page.locator('#username').fill('demo1');
    await page.locator('#password').fill('DefinitelyWrong1!');
    await page.locator('#kc-login').click();
    await expect(page.getByText('Invalid username or password')).toBeVisible();

    await page.goto('/feed');
    await expect(page).toHaveURL(/\/login/);
  });

  test('logout clears the session (Keycloak end-session + local cookie)', async ({ page }) => {
    await loginViaKeycloak(page, 'demo2', 'DemoPass123!');
    await page.waitForURL(/\/feed$/);

    await page.getByTestId('logout-button').click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.getByTestId('reset-notice')).toBeVisible();

    await page.goto('/feed');
    await expect(page).toHaveURL(/\/login/);
  });

  test('captcha failures surface as a login error message', async ({ page }) => {
    // The full browser widget flow needs a CAP-enabled run (see PR notes);
    // this covers the error rendering path users see after a failed verify.
    await page.goto('/login?error=captcha');
    await expect(page.getByTestId('login-error')).toContainText(/captcha/i);
  });
});
