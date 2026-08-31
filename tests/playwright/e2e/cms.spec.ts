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

test('about page renders CMS sections and FAQ', async ({ page }) => {
  await page.goto('/about');

  await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
  // The intro sections moved from the landing (#153): seeded CMS copy, not
  // the fallback (which never says "microservices homelab"). `.first()`: the
  // FAQ answer below uses the same phrase.
  await expect(page.getByText(/microservices homelab/i).first()).toBeVisible();
  await expect(page.getByText(/wipes everything back to a seeded state/i)).toBeVisible();
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
  const published = await request.get('/cms/api/about-content?limit=10');
  expect(published.ok()).toBeTruthy();
  // Anonymous reads are where-constrained: never-published drafts never leak.
  const publishedDocs = (await published.json()) as { docs: Array<{ _status?: string }> };
  expect(publishedDocs.docs.every((doc) => doc._status === 'published')).toBe(true);

  const draft = await request.get('/cms/api/about-content?limit=10&draft=true');
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

  const authedDraft = await request.get('/cms/api/about-content?limit=10&draft=true', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(authedDraft.ok()).toBeTruthy();
});

test('first-register is permanently closed (no anonymous bootstrap takeover)', async ({
  request,
}) => {
  // Payload mounts /first-register on every auth collection; with no local
  // auth strategy it must refuse even while the users table is empty
  // (fresh stack / nightly truncation window).
  const res = await request.post('/cms/api/users/first-register', {
    data: { email: 'attacker@example.com', password: 'Takeover123!' },
  });
  expect([403, 404]).toContain(res.status());
  expect(res.status()).not.toBe(200);
});

test('the /cms entry point redirects to the Payload admin UI (#196)', async () => {
  // The route table's CMS entry is /cms itself, but the app router has no
  // root route - next.config redirects it to the admin UI under basePath.
  const cmsUrl = envString('XITTER_CMS_URL', localUrl('cms'));
  const res = await fetch(`${cmsUrl}/cms`, { redirect: 'manual' });
  expect(res.status).toBe(307);
  expect(res.headers.get('location')).toBe('/cms/admin');
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

test('app-admin can log in to the CMS admin panel end-to-end', async ({ page }) => {
  await page.goto('/cms/admin');
  await page.waitForURL(/\/realms\/xitter-local-admin\/protocol\/openid-connect\/auth/);
  await page.locator('#username').fill('localadmin');
  await page.locator('#password').fill('LocalAdmin123!');
  await page.locator('#kc-login').click();

  // Back on the CMS: the full OIDC code flow completed and the mapped user's
  // session renders the Payload admin panel - not an error page. This is the
  // exact journey that 500/502'd in deployed environments (#208 follow-on):
  // nothing there ever applied the Payload schema, so the callback's first
  // `users` lookup died on the missing table and the browser replay of the
  // consumed auth code surfaced a misleading invalid_grant.
  await page.waitForURL(/\/cms\/admin(\/|$)/);
  await expect(page).toHaveURL(/\/cms\/admin(\/|$)/);

  // The panel chrome loaded for the logged-in user: the collection nav is
  // rendered from the same config that generated the schema (Payload gives
  // sidebar links stable #nav-<slug> ids; the dashboard cards share hrefs).
  await expect(page.locator('#nav-about-content')).toBeVisible();
  await expect(page.locator('#nav-faq')).toBeVisible();
  await expect(page.locator('#nav-users')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log out' })).toBeVisible();

  // The minted session cookie authenticates the REST API, and the Keycloak
  // identity was mapped to a users row (findOrCreateAdminUser) - the same
  // query path the callback needs, proving the schema exists end to end.
  const users = await page.request.get('/cms/api/users?limit=10');
  expect(users.ok()).toBeTruthy();
  const { docs } = (await users.json()) as { docs: Array<{ email?: string }> };
  expect(docs.some((doc) => doc.email === 'localadmin@sso.xitter.local')).toBe(true);
});
