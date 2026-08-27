import { expect, test, type Page } from '@playwright/test';
import { loadRepoEnv } from '@xitter/config';
import { buildCorpus } from '../../../packages/scripts/src/corpus.js';
import { loginViaKeycloak } from './helpers';

/**
 * First-run UX acceptance for the reset+reseed cycle (#35, umbrella #32):
 * walk the environment a nightly reset leaves behind as its users would -
 * the never-logged-in visitor (landing, About, login), the first login, the
 * session-aware public pages, and the reseeded corpus visible end to end
 * (feed, followable profile, search). The stack wrapper applies the
 * deterministic seed before the suite starts, so "first run" here is the
 * cycle's end state: wipe + reseed, exactly what a fresh visitor meets.
 *
 * Deliberately out of reach in this harness (documented, not silently
 * dropped): the dormant-demo-profile shell (#36) and the feed/profile
 * empty states only exist on a wiped-but-NOT-reseeded stack - the seeder
 * ensures every demo profile before the probe port opens. Those surfaces
 * are covered by the web unit tests (dormant-profile.test.tsx,
 * feed-view empty state) and would need a no-reseed stack to exercise
 * end-to-end.
 */
loadRepoEnv();

const PASSWORD = 'DemoPass123!';
const corpus = buildCorpus();

/** Distinctive corpus word: long Latin tokens are unique to seeded posts. */
const CORPUS_NEEDLE = corpus.posts
  .flatMap((p) => p.text.toLowerCase().split(/\s+/))
  .find((w) => /^[a-z]{9,}$/.test(w))!;

async function login(page: Page, username: string) {
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
}

/**
 * Honest-copy guard (#123, from the #35 walk): Cap.js is a proof-of-work
 * verification, not a captcha - no public page may call it one. The word
 * is asserted absent wherever the challenge copy could regress.
 */
async function expectNoCaptchaCopy(page: Page) {
  await expect(page.getByText(/captcha/i)).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// The never-logged-in visitor
// ---------------------------------------------------------------------------

test.describe('a fresh visitor, not logged in', () => {
  test('landing introduces the demo, warns about resets and shows the way in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('reset-notice')).toBeVisible();
    // CMS copy applied by the seed's content phase - the reseed end state,
    // not the hardcoded fallback ("microservices playground").
    await expect(page.getByText(/microservices homelab/i)).toBeVisible();

    // Credentials are public by design: a first-time visitor can find them
    // without hunting (#37).
    const credentials = page.getByTestId('demo-credentials');
    await expect(credentials).toBeVisible();
    await expect(credentials.getByText('demo1–demo10')).toBeVisible();
    await expect(credentials.getByText('DemoPass123!')).toBeVisible();

    await expect(page.getByTestId('public-login-link')).toBeVisible();
    await expectNoCaptchaCopy(page);
  });

  test('About explains resets and the reseed honestly', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
    await expect(page.getByTestId('reset-notice')).toBeVisible();

    // The seeded FAQ answers the question the fresh state raises ("will
    // content come back?") with what actually happens - reseed, not wishful
    // copy. Fallback FAQ has no such promise.
    await expect(page.getByText(/deterministic reseed/i)).toBeVisible();

    // Demo accounts are named with the password, and the login page is
    // linked. Two paragraphs carry the phrase (this section + the "How do
    // I log in?" FAQ answer) - pin one and assert both facts on it.
    const accounts = page.getByText(/demo1 through demo10/i).first();
    await expect(accounts).toBeVisible();
    await expect(accounts).toContainText('DemoPass123!');
    await page.getByRole('link', { name: 'login page' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expectNoCaptchaCopy(page);
  });

  test('login is reachable from the header and says how to get in', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('public-login-link').click();
    await expect(page).toHaveURL(/\/login$/);

    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    await expect(page.getByTestId('login-panel')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await expect(page.getByTestId('reset-notice')).toBeVisible();
    await expectNoCaptchaCopy(page);
  });
});

// ---------------------------------------------------------------------------
// First login, end to end
// ---------------------------------------------------------------------------

test.describe('the first login', () => {
  test('a demo user logs in from the landing page and lands on the feed', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('landing-login-cta').click();
    await expect(page).toHaveURL(/\/login$/);

    // The real Keycloak round-trip (local stack, Cap disabled).
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/realms\/xitter-demo\//);
    await page.locator('#username').fill('demo1');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#kc-login').click();

    await page.waitForURL(/\/feed$/);
    await expect(page.getByTestId('nav-username')).toHaveText('@demo1');
    await expect(page.getByTestId('composer-form')).toBeVisible();
  });

  test('a live session is recognised on public pages (#38)', async ({ page }) => {
    await login(page, 'demo1');

    // The public header swaps Log in for the visitor's handle and a way
    // back into the app.
    await page.goto('/');
    await expect(page.getByTestId('public-login-link')).toHaveCount(0);
    await expect(page.getByTestId('public-profile-link')).toContainText('@demo1');
    await page.getByTestId('public-feed-link').click();
    await expect(page).toHaveURL(/\/feed$/);
  });

  test('a logged-in visit to /login bounces to the feed (#40)', async ({ page }) => {
    await login(page, 'demo1');
    await page.goto('/login');
    await page.waitForURL(/\/feed$/);
    await expect(page.getByTestId('nav-username')).toHaveText('@demo1');
  });
});

// ---------------------------------------------------------------------------
// The reseeded corpus, as the acceptance surface asks for it
// ---------------------------------------------------------------------------

test.describe('the reseeded demo a fresh login meets', () => {
  test("demo1's feed renders the seeded corpus (#35 acceptance)", async ({ page }) => {
    await login(page, 'demo1');

    // Lower bounds, not exact counts: other specs share this stack and add
    // content on top. The corpus follows demo1 -> demo2/demo5/demo6, so
    // even after profile.spec's unfollow cycle at least three distinct
    // authors (self + demo5 + demo6) are guaranteed on page 1.
    await expect(page.getByTestId('feed-timeline')).toBeVisible();
    await expect
      .poll(
        async () =>
          new Set(
            (
              await page
                .getByTestId('feed-timeline')
                .getByText(/^@demo(?:10|[1-9])$/)
                .allTextContents()
            ).map((handle) => handle.trim()),
          ).size,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);
    await expect
      .poll(async () => page.locator('[data-testid^="post-item-"]').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(10);
  });

  test('a seeded profile renders with posts and a follow affordance', async ({ page }) => {
    await login(page, 'demo1');
    await page.goto('/profile/demo2');

    await expect(page.getByTestId('profile-username')).toHaveText('@demo2');
    await expect(page.getByTestId('profile-display-name')).toBeVisible();
    // Followable, not just viewable: the relationship control is present in
    // whichever state the graph is in.
    await expect(
      page.getByTestId('follow-button').or(page.getByTestId('unfollow-button')),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="post-item-"]').first()).toBeVisible();
  });

  test('seeded content is findable through the header search box', async ({ page }) => {
    // Search is a derived store (posts -> Kafka -> search-index worker ->
    // OpenSearch) and converges asynchronously after the seed - poll the
    // API, then assert on one settled page render (search-flow's pattern;
    // the same convergence maths, ~2s measured, 30s ceiling for CI).
    test.setTimeout(90_000);
    await login(page, 'demo1');

    const token = await accessToken(page);
    const searchApi = `/api/search/v1/posts?q=${encodeURIComponent(CORPUS_NEEDLE)}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await page.request.get(searchApi, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok() && ((await res.text()) ?? '').includes(CORPUS_NEEDLE)) break;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(1_000);
    }

    const headerSearch = page.getByTestId('app-nav').getByTestId('search-input');
    await headerSearch.fill(CORPUS_NEEDLE);
    await headerSearch.press('Enter');
    await page.waitForURL(/\/search\?q=/);
    await expect(page.getByTestId('search-input')).toHaveValue(CORPUS_NEEDLE);
    await expect(page.getByTestId('search-results')).toContainText(CORPUS_NEEDLE);
    await expect(page.getByTestId('search-degraded')).toHaveCount(0);
  });

  test('an empty bookmarks page explains the next action instead of dead-ending', async ({
    page,
  }) => {
    // demo8 holds no corpus bookmarks and no other spec bookmarks as
    // demo8 - the one guaranteed-empty surface in the seeded world.
    await login(page, 'demo8');
    await page.goto('/bookmarks');

    await expect(page.getByTestId('bookmarks-empty')).toBeVisible();
    await expect(page.getByTestId('bookmarks-empty')).toContainText(/bookmark/i);
    await expect(page.getByTestId('bookmarks-privacy-note')).toBeVisible();
  });
});

/** Bearer for API polls: the session holds it, the ws route brokers it. */
async function accessToken(page: Page): Promise<string> {
  const res = await page.request.get('/api/ws/feed-token');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}
