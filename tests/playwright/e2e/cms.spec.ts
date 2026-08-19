import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { envString, findRepoRoot, loadRepoEnv, localPort, localUrl } from '@xitter/config';

/**
 * CMS-backed site content over the full stack: the web app renders CMS copy,
 * drafts are auth-gated, and admin-panel login is role-gated (spec 04 + 07).
 */

// Idempotent: upsert the committed content files into the running CMS, then
// drop the web app's published-content cache (other tests may have rendered
// the fallback copy first, and the data cache would serve it for 60s).
// The suite's webServer probes the WEB port, ready long before the CMS
// finishes booting - wait for it (bounded) before applying content.
test.beforeAll(async () => {
  loadRepoEnv();
  const cmsUrl = envString('XITTER_CMS_URL', localUrl('cms'));
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${cmsUrl}/cms/healthz`);
      if (res.ok) break;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`CMS never became healthy at ${cmsUrl}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const repoRoot = findRepoRoot();
  execFileSync('npx', ['tsx', 'packages/scripts/src/content.ts', 'apply'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  // Mint the machine token the revalidate route requires (same principal the
  // CMS authenticates) and refresh the web app's CMS cache tags.
  const tokenRes = await fetch(
    `${envString('XITTER_KEYCLOAK_URL', localUrl('keycloak'))}/realms/${envString(
      'XITTER_ADMIN_REALM',
      'xitter-local-admin',
    )}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: envString('XITTER_CMS_CLIENT_ID', 'cms'),
        client_secret: envString('XITTER_CMS_CLIENT_SECRET', 'cms-local-secret'),
      }),
    },
  );
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  const revalidated = await fetch(
    `${envString('XITTER_WEB_BASE_URL', localUrl('edge'))}/api/cms/revalidate`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
  expect(revalidated.ok).toBeTruthy();
});

test('landing page renders CMS copy', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'xitter' })).toBeVisible();
  await expect(page.getByText(/microservices homelab/i).first()).toBeVisible();
  await expect(page.getByText(/nightly reset that wipes everything/i)).toBeVisible();
});

test('about page renders the CMS-managed FAQ', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByRole('heading', { name: 'FAQ' })).toBeVisible();
  // Scoped to the FAQ section: the page's own "What is this?" heading also
  // matches an unscoped text query (strict mode).
  await expect(page.getByText('Twitter/X-style demo of a microservices homelab')).toBeVisible();
  await expect(page.getByText(/Who runs this, and where's the code\?/i)).toBeVisible();
  await expect(page.getByText(/Something looks broken - is that you\?/i)).toBeVisible();
});

test('published CMS content is public; drafts require an admin token', async ({ request }) => {
  const published = await request.get('/cms/api/landing-content?limit=10');
  expect(published.ok()).toBeTruthy();
  // Anonymous reads are where-constrained: never-published drafts never leak.
  const publishedDocs = (await published.json()) as { docs: Array<{ _status?: string }> };
  expect(publishedDocs.docs.every((doc) => doc._status === 'published')).toBe(true);

  const draft = await request.get('/cms/api/landing-content?limit=10&draft=true');
  expect(draft.status()).toBe(403);

  // Client-credentials token for the cms client (admin realm, app-admin).
  const tokenRes = await request.post(
    `http://localhost:${localPort('keycloak')}/realms/xitter-local-admin/protocol/openid-connect/token`,
    {
      form: {
        grant_type: 'client_credentials',
        client_id: 'cms',
        client_secret: process.env.XITTER_CMS_CLIENT_SECRET ?? 'cms-local-secret',
      },
    },
  );
  expect(tokenRes.ok()).toBeTruthy();
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  const authedDraft = await request.get('/cms/api/landing-content?limit=10&draft=true', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(authedDraft.ok()).toBeTruthy();
});

test('CMS admin login requires the app-admin role', async ({ page }) => {
  await page.goto('/cms/admin');
  // Middleware redirects unauthenticated visits to the admin realm.
  await page.waitForURL(/\/realms\/xitter-local-admin\/protocol\/openid-connect\/auth/);
  await page.locator('#username').fill('localuser');
  await page.locator('#password').fill('LocalUser123!');
  await page.locator('#kc-login').click();

  await expect(page.getByText(/app-admin role/i)).toBeVisible();
});

test('app-admin can log in to the CMS admin panel', async ({ page }) => {
  await page.goto('/cms/admin');
  await page.waitForURL(/\/realms\/xitter-local-admin\/protocol\/openid-connect\/auth/);
  await page.locator('#username').fill('localadmin');
  await page.locator('#password').fill('LocalAdmin123!');
  await page.locator('#kc-login').click();

  // Back on the CMS; the Payload admin panel loads for the mapped user.
  await page.waitForURL(/\/cms\/admin/);
  await expect(page).toHaveURL(/\/cms\/admin(\/|$)/);
});
