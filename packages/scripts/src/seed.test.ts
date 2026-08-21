import { describe, expect, it } from 'vitest';
import { buildCorpus, type SeedCorpus } from './corpus.js';
import { runSeed, type SeedUser } from './seed.js';

/**
 * Seeder probe contracts (spec data 02): the environment state decides the
 * behaviour - fresh seeds, an exact corpus is a verified no-op, and a
 * partial corpus fails loudly instead of patching.
 */

const corpus: SeedCorpus = buildCorpus({ userCount: 3, postsPerUser: 4 });
const users: SeedUser[] = corpus.users.map((u, i) => ({
  username: u.username,
  userId: `sub-${i}`,
}));

interface Route {
  method: string;
  test: RegExp;
  respond(url: URL, init: RequestInit): unknown;
}

/** Minimal fetch double over the endpoints the probe touches. */
function fakeFetch(routes: Route[]): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && r.test.test(url.pathname));
    if (!route) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: url.pathname } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(route.respond(url, init ?? {})), { status: 200 });
  }) as typeof fetch;
}

const hasProfile = (present: boolean): Route => ({
  method: 'GET',
  test: /\/api\/social\/v1\/profiles\/username\/demo\d+$/,
  respond: (url) => (present ? { id: 'x', username: url.pathname.split('/').at(-1) } : null),
});

const userPosts = (counts: number[]): Route =>
  ({
    method: 'GET',
    test: /\/api\/posts\/v1\/users\/sub-\d+\/posts$/,
    respond: (url) => {
      const index = Number(url.pathname.match(/sub-(\d+)/)![1]);
      return { items: Array.from({ length: counts[index] ?? 0 }, () => ({ id: 'p' })) };
    },
  }) as Route;

const expected = corpus.posts.reduce<number[]>((acc, post) => {
  acc[post.authorIndex] = (acc[post.authorIndex] ?? 0) + 1;
  return acc;
}, []);

describe('runSeed probe', () => {
  it('is a verified no-op when the exact corpus is present', async () => {
    let mutations = 0;
    const following = corpus.follows.reduce<number[]>((acc, f) => {
      acc[f.followerIndex] = (acc[f.followerIndex] ?? 0) + 1;
      return acc;
    }, []);
    const fetchImpl = fakeFetch([
      {
        // probe/verify reads are user-gated: the grant hits the token endpoint
        method: 'POST',
        test: /\/protocol\/openid-connect\/token$/,
        respond: () => ({ access_token: 'seed-test-token' }),
      },
      hasProfile(true),
      userPosts(expected),
      {
        method: 'GET',
        test: /\/api\/social\/v1\/profiles\/sub-\d+\/following/,
        respond: (url) => {
          const index = Number(url.pathname.match(/sub-(\d+)/)![1]);
          return {
            items: Array.from({ length: following[index] ?? 0 }, () => ({ id: 'f' })),
          };
        },
      },
      {
        method: 'GET',
        test: /\/api\/feed\/v1\/feed/,
        respond: () => ({ items: [], nextCursor: null }),
      },
      {
        method: 'POST',
        test: /.*/,
        respond: () => {
          mutations += 1;
          return {};
        },
      },
    ]);

    const report = await runSeed({
      corpus,
      users,
      fetchImpl,
      convergenceTimeoutMs: 500,
      log: () => undefined,
    });
    expect(report.skipped).toBe(true);
    expect(mutations).toBe(0);
    expect(report.fingerprint).toBe(corpus.fingerprint);
  });

  it('fails loudly on a partial corpus', async () => {
    // Half the users seeded, half empty - the crash-retry case.
    const counts = expected.map((n, i) => (i < expected.length / 2 ? n : 0));
    const profiles = (url: URL) =>
      Number(url.pathname.match(/demo(\d+)/)![1]) <= expected.length / 2;

    const fetchImpl = fakeFetch([
      {
        method: 'POST',
        test: /\/protocol\/openid-connect\/token$/,
        respond: () => ({ access_token: 'seed-test-token' }),
      },
      {
        method: 'GET',
        test: /\/api\/social\/v1\/profiles\/username\/demo\d+$/,
        respond: (url) => (profiles(url) ? { id: 'x' } : null),
      },
      userPosts(counts),
    ]);

    await expect(runSeed({ corpus, users, fetchImpl, log: () => undefined })).rejects.toThrow(
      /partial corpus - run a reset first/,
    );
  });

  it('reports corpus volumes for logging/verification', () => {
    expect(corpus.counts.users).toBe(3);
    expect(corpus.counts.posts).toBe(12);
    expect(expected.reduce((a, b) => a + b, 0)).toBe(12);
  });
});
