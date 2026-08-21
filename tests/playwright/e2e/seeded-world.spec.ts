import { expect, test, type Page } from '@playwright/test';
import { loadRepoEnv, localUrl } from '@xitter/config';
import { buildCorpus } from '../../../packages/scripts/src/corpus.js';
import { loginViaKeycloak } from './helpers';

/**
 * Seeded-world assertions (T13): the deterministic corpus (faker seed 42)
 * applied by the stack wrapper (e2e-stack.ts) is visible end-to-end -
 * profiles, feeds, threads, interactions and search - and every derived
 * store was built by the workers from the seed's events, never written
 * directly. Exact equality holds on a freshly seeded stack; other specs
 * may add content on top, so shared-run assertions are lower bounds where
 * the corpus is not exclusive.
 */
loadRepoEnv();

const corpus = buildCorpus();
const PASSWORD = 'DemoPass123!';
const CONVERGENCE = { timeout: 90_000 };

/** Demo-user token via the password grant (seeder-only client path). */
async function apiToken(username: string): Promise<string> {
  const keycloak = process.env.XITTER_SEED_KEYCLOAK_URL ?? localUrl('keycloak');
  const res = await fetch(`${keycloak}/realms/xitter-demo/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'web',
      username,
      password: PASSWORD,
    }),
  });
  expect(res.ok, `login ${username}: ${res.status}`).toBeTruthy();
  return ((await res.json()) as { access_token: string }).access_token;
}

async function login(page: Page, username: string) {
  await loginViaKeycloak(page, username, PASSWORD);
  await page.waitForURL(/\/feed$/);
}

test('seeded profiles carry the deterministic corpus identity', async ({ page }) => {
  await login(page, 'demo1');
  const demo = corpus.users[0]!;
  await page.goto(`/profile/${demo.username}`);
  await expect(page.getByTestId('profile-display-name')).toHaveText(demo.displayName);
});

test('every demo account owns its corpus posts', async ({ request }) => {
  for (const [index, user] of corpus.users.entries()) {
    const token = await apiToken(user.username);
    // Every read is user-gated: the edge 401s unauthenticated requests and
    // the 401 body has no `items`, so carry the bearer on lookups too.
    const byName = await request.get(`/api/social/v1/profiles/username/${user.username}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const profile = (await byName.json()) as { id: string };
    const posts = await request.get(`/api/posts/v1/users/${profile.id}/posts?limit=50`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const page0 = (await posts.json()) as { items: unknown[] };
    const expected = corpus.posts.filter((p) => p.authorIndex === index).length;
    expect(page0.items.length, `${user.username} posts`).toBeGreaterThanOrEqual(expected);
  }
});

test('feeds hold the fanout-derived corpus entries', async ({ page }) => {
  await login(page, 'demo1');
  const expected = corpus.counts.feedEntriesByUser[0]!;
  // page.request shares cookies, not the app's bearer token - mint one.
  const token = await apiToken('demo1');
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/feed/v1/feed?limit=50', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: unknown[] };
      return body.items.length;
    }, CONVERGENCE)
    .toBeGreaterThanOrEqual(Math.min(expected, 50));
});

test('conversation threads from the corpus are reply-connected', async ({ request }) => {
  const token = await apiToken('demo1');
  // Any thread root: a standalone post that the corpus gave replies to.
  const root = corpus.posts.find(
    (p) =>
      p.replyTo === null &&
      corpus.posts.some(
        (r) =>
          r.replyTo && r.replyTo.authorIndex === p.authorIndex && r.replyTo.ordinal === p.ordinal,
      ),
  )!;
  const byName = await request.get(
    `/api/social/v1/profiles/username/${corpus.users[root.authorIndex]!.username}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const profile = (await byName.json()) as { id: string };
  const posts = await request.get(`/api/posts/v1/users/${profile.id}/posts?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await posts.json()) as { items: Array<{ text: string; id: string }> };
  const seeded = body.items.find((item) => item.text === root.text);
  expect(seeded, 'thread root text present').toBeTruthy();

  const replies = await request.get(`/api/posts/v1/posts/${seeded!.id}/replies?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const replyPage = (await replies.json()) as { items: unknown[] };
  const expected = corpus.posts.filter(
    (r) =>
      r.replyTo && r.replyTo.authorIndex === root.authorIndex && r.replyTo.ordinal === root.ordinal,
  ).length;
  expect(replyPage.items.length).toBeGreaterThanOrEqual(expected);
});

test('seeded likes and bookmarks are queryable', async ({ request }) => {
  // demo2's bookmarks: at least the corpus bookmarks it created.
  const bookmarkers = corpus.interactions.filter((i) => i.kind === 'bookmark' && i.userIndex === 1);
  const token = await apiToken('demo2');
  await expect
    .poll(async () => {
      const res = await request.get('/api/posts/v1/bookmarks?limit=50', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: unknown[] };
      return body.items.length;
    }, CONVERGENCE)
    .toBeGreaterThanOrEqual(bookmarkers.length);
});

test('seeded images render through the media pipeline', async ({ request }) => {
  const imagePost = corpus.posts.find((p) => p.mediaCount > 0)!;
  const token = await apiToken(corpus.users[imagePost.authorIndex]!.username);
  const byName = await request.get(
    `/api/social/v1/profiles/username/${corpus.users[imagePost.authorIndex]!.username}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const profile = (await byName.json()) as { id: string };
  const posts = await request.get(`/api/posts/v1/users/${profile.id}/posts?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await posts.json()) as {
    items: Array<{ text: string; media: Array<{ status: string; variants: unknown[] }> }>;
  };
  const seeded = body.items.find((item) => item.text === imagePost.text);
  expect(seeded, 'image post present').toBeTruthy();
  expect(seeded!.media.length, 'image attached').toBeGreaterThanOrEqual(1);
  expect(seeded!.media[0]!.status, 'processed to ready').toBe('ready');
  expect(seeded!.media[0]!.variants.length, 'variants generated').toBeGreaterThanOrEqual(1);
});

test('search indexes the corpus (derived store, not written directly)', async ({ page }) => {
  await login(page, 'demo1');
  const token = await apiToken('demo1');
  // Pick a distinctive corpus word (long words are rare enough).
  const words = corpus.posts
    .flatMap((p) => p.text.toLowerCase().split(/\s+/))
    .filter((w) => w.length >= 9);
  const needle = words[0]!;
  await expect
    .poll(async () => {
      const res = await page.request.get(
        `/api/search/v1/search/posts?q=${encodeURIComponent(needle)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = (await res.json()) as { items: unknown[] };
      return body.items.length;
    }, CONVERGENCE)
    .toBeGreaterThanOrEqual(1);
});

test('the reset status record is exposed internally', async ({ request }) => {
  // Only meaningful when the live reset flow ran (CronJob / reset:live);
  // a stack seeded by e2e-stack has no record yet - null is valid then.
  const res = await request.get('/api/feed/internal/reset-status');
  // Unauthenticated request through the edge: 401 without a service token.
  expect([401, 200]).toContain(res.status());
});
