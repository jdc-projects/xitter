import { afterEach, describe, expect, it, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// Retry hardening (#85): the phase x failure matrix end-to-end. Idempotent
// calls ride out anything transient; plain creates retry only provably-
// unprocessed causes and RECONCILE ambiguous ones instead of blind-retrying
// (a duplicate post would fail the night's verification); the CMS phase is
// covered by the same policies and still honours the dev skip flag.
// ---------------------------------------------------------------------------

describe('runSeed retry hardening (#85)', () => {
  const tiny = buildCorpus({ userCount: 2, postsPerUser: 2, followDensity: 0 });
  const tinyUsers: SeedUser[] = tiny.users.map((u, i) => ({
    username: u.username,
    userId: `sub-${i}`,
  }));
  const followingBy = tiny.follows.reduce<number[]>((acc, f) => {
    acc[f.followerIndex] = (acc[f.followerIndex] ?? 0) + 1;
    return acc;
  }, []);

  /** What undici surfaces when the server dies mid-request. */
  const inFlightTimeout = (code = 'ETIMEDOUT'): Error => {
    const cause = Object.assign(new Error(`connect ${code} 10.42.0.17:3000`), { code });
    return Object.assign(new TypeError('fetch failed'), { cause });
  };

  interface SeedSurfaceState {
    /** Posts the fake services hold (author's timeline items). */
    posts: Array<{ id: string; text: string; author: number; deletedAt: string | null }>;
    /** Bodies of served (200-level) post creates, for wire assertions. */
    postBodies: Array<{ text: string; mediaIds: unknown }>;
    /** 200-level create responses served (excludes adopted/faulty attempts). */
    postCreates: number;
    /** Every POST /posts attempt, including thrown/reconciled ones. */
    postAttempts: number;
    uploadAttempts: number;
    cmsListCalls: number;
    cmsCalls: string[];
    logs: string[];
  }

  type Injection = (
    method: string,
    pathname: string,
  ) => number | Error | 'commit-then-timeout' | undefined;

  /** One route of the fake surface: match by method + pathname regex. */
  interface SurfaceRoute {
    method: string;
    test: RegExp;
    /** May throw to simulate a network-level failure. */
    respond(
      url: URL,
      body: { text?: string; mediaIds?: unknown } | undefined,
      outcome: unknown,
    ): unknown;
  }

  /**
   * Fake full service surface for one fresh-seed run: probe reads, corpus
   * mutations (state-keeping so verification can pass), media pipeline,
   * and the CMS collections. `inject` overrides the outcome of matching
   * calls: an HTTP status, a thrown network error, or the ambiguous
   * post-create ('commit-then-timeout' = server committed, response lost).
   */
  function seedSurface(inject: Injection = () => undefined): {
    fetch: typeof globalThis.fetch;
    state: SeedSurfaceState;
  } {
    const state: SeedSurfaceState = {
      posts: [],
      postBodies: [],
      postCreates: 0,
      postAttempts: 0,
      uploadAttempts: 0,
      cmsListCalls: 0,
      cmsCalls: [],
      logs: [],
    };

    const routes: SurfaceRoute[] = [
      {
        method: 'POST',
        test: /\/protocol\/openid-connect\/token$/,
        respond: () => ({ access_token: 'seed-test-token' }),
      },
      { method: 'GET', test: /\/cms\/api\/(landing-content|faq)/, respond: () => ({ docs: [] }) },
      {
        method: 'POST',
        test: /\/cms\/api\/(landing-content|faq)/,
        respond: () => ({ doc: {} }),
      },
      {
        // The author timeline doubles as the reconciliation probe's read.
        method: 'GET',
        test: /\/api\/posts\/v1\/users\/(sub-\d+)\/posts$/,
        respond: (url) => {
          const author = Number(url.pathname.match(/sub-(\d+)/)![1]);
          return { items: state.posts.filter((p) => p.author === author) };
        },
      },
      {
        method: 'POST',
        test: /\/api\/posts\/v1\/posts$/,
        respond: (_url, body, outcome) => {
          // Corpus texts pin the slot (deterministic, unique per author).
          const text = body?.text;
          const slot =
            typeof text === 'string' ? tiny.posts.find((p) => p.text === text) : undefined;
          if (!slot || typeof text !== 'string') {
            throw new Error(`fake surface: unknown post text "${String(text)}"`);
          }
          if (outcome === 'commit-then-timeout') {
            // The server committed but the response never came back.
            state.posts.push({ id: 'adopted-1', text, author: slot.authorIndex, deletedAt: null });
            throw inFlightTimeout();
          }
          state.postCreates += 1;
          const id = `created-${state.postCreates}`;
          state.posts.push({ id, text, author: slot.authorIndex, deletedAt: null });
          state.postBodies.push({ text, mediaIds: body?.mediaIds });
          return { id };
        },
      },
      {
        method: 'POST',
        test: /\/api\/media\/v1\/uploads$/,
        respond: () => ({ mediaId: 'm-1', uploadUrl: 'http://rustfs.local/obj-1' }),
      },
      {
        method: 'GET',
        test: /\/api\/social\/v1\/profiles\/(sub-\d+)\/following/,
        respond: (url) => {
          const index = Number(url.pathname.match(/sub-(\d+)/)![1]);
          return {
            items: Array.from({ length: followingBy[index] ?? 0 }, () => ({ id: 'f' })),
          };
        },
      },
      {
        method: 'GET',
        test: /\/api\/media\/v1\/media\/m-1$/,
        respond: () => ({ status: 'ready' }),
      },
      {
        method: 'GET',
        test: /\/api\/feed\/v1\/feed$/,
        respond: () => ({ items: [], nextCursor: null }),
      },
      // Absence marker for the probe: no profile for this username yet.
      {
        method: 'GET',
        test: /\/api\/social\/v1\/profiles\/username\/demo\d+$/,
        respond: () => null,
      },
    ];

    /** Attempt counters run BEFORE injection: a failed try is still a try. */
    const countAttempt = (method: string, path: string): void => {
      if (method === 'POST' && path === '/api/posts/v1/posts') state.postAttempts += 1;
      if (method === 'POST' && path === '/api/media/v1/uploads') state.uploadAttempts += 1;
      if (path.startsWith('/cms/api/')) {
        state.cmsCalls.push(`${method} ${path}`);
        if (method === 'GET') state.cmsListCalls += 1;
      }
    };

    /** Token grants post urlencoded bodies; only JSON requests carry one. */
    const jsonBody = (init?: RequestInit): { text?: string } | undefined => {
      const raw = typeof init?.body === 'string' ? init.body : undefined;
      return raw?.startsWith('{') ? (JSON.parse(raw) as { text: string }) : undefined;
    };

    const dispatch = async (method: string, url: URL, init?: RequestInit): Promise<Response> => {
      const outcome = inject(method, url.pathname);
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === 'number') return new Response('unavailable', { status: outcome });
      const route = routes.find((r) => r.method === method && r.test.test(url.pathname));
      // Unrouted calls (profile upserts, follows, interactions, the object
      // PUT) are the accepting catch-all.
      const value = route ? await route.respond(url, jsonBody(init), outcome) : {};
      return new Response(JSON.stringify(value ?? null));
    };

    const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      countAttempt(method, url.pathname);
      return await dispatch(method, url, init);
    }) as typeof globalThis.fetch;
    return { fetch: impl, state };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rides out deploy churn on the idempotent phases (probe retry, full seed)', async () => {
    vi.stubEnv('XITTER_RESET_SKIP_CMS', '1');
    let profileReads = 0;
    const { fetch, state } = seedSurface((method, path) => {
      // First profile probe read dies in flight; the read is idempotent
      // (SEED_RETRY_IDEMPOTENT) so it must be retried, not escalated.
      if (method === 'GET' && /\/profiles\/username\/demo\d+$/.test(path)) {
        profileReads += 1;
        return profileReads === 1 ? 502 : undefined;
      }
      return undefined;
    });

    const report = await runSeed({
      corpus: tiny,
      users: tinyUsers,
      fetchImpl: fetch,
      convergenceTimeoutMs: 1_000,
      log: (m) => state.logs.push(m),
    });

    expect(report.skipped).toBe(false);
    expect(report.created.posts).toBe(tiny.counts.posts);
    expect(state.postCreates).toBe(tiny.counts.posts); // no duplicated creates

    // The corpus image post carries its alt text onto the create wire (#133).
    const withMedia = state.postBodies.filter(
      (b) => Array.isArray(b.mediaIds) && b.mediaIds.length > 0,
    );
    expect(withMedia).toHaveLength(tiny.counts.imagePosts);
    for (const body of withMedia) {
      const slot = tiny.posts.find((p) => p.text === body.text)!;
      expect(slot.imageAlt).toBeTruthy();
      expect(body.mediaIds).toEqual([{ mediaId: 'm-1', altText: slot.imageAlt }]);
    }
  });

  it('reconciles an ambiguous post-create failure by adopting the committed post', async () => {
    vi.stubEnv('XITTER_RESET_SKIP_CMS', '1');
    let postsSeen = 0;
    const { fetch, state } = seedSurface((method, path) => {
      if (method === 'POST' && path === '/api/posts/v1/posts') {
        postsSeen += 1;
        // First create commits server-side, then the response is lost.
        return postsSeen === 1 ? 'commit-then-timeout' : undefined;
      }
      return undefined;
    });

    const report = await runSeed({
      corpus: tiny,
      users: tinyUsers,
      fetchImpl: fetch,
      convergenceTimeoutMs: 1_000,
      log: (m) => state.logs.push(m),
    });

    // The committed post was adopted, not re-created: one fewer create
    // response than corpus posts, yet every post exists exactly once.
    expect(report.skipped).toBe(false);
    expect(report.created.posts).toBe(tiny.counts.posts);
    expect(state.postCreates).toBe(tiny.counts.posts - 1);
    expect(state.posts).toHaveLength(tiny.counts.posts);
    expect(new Set(state.posts.map((p) => p.id)).size).toBe(tiny.counts.posts);
    expect(state.posts.map((p) => p.id)).toContain('adopted-1');
    expect(state.logs.join('\n')).toContain('reconciled');
  });

  it('re-creates once when an ambiguous post-create provably never landed', async () => {
    vi.stubEnv('XITTER_RESET_SKIP_CMS', '1');
    let postsSeen = 0;
    const { fetch, state } = seedSurface((method, path) => {
      if (method === 'POST' && path === '/api/posts/v1/posts') {
        postsSeen += 1;
        // Timeout with NO commit: the probe finds nothing, so exactly one
        // deliberate re-create follows.
        return postsSeen === 1 ? inFlightTimeout() : undefined;
      }
      return undefined;
    });

    const report = await runSeed({
      corpus: tiny,
      users: tinyUsers,
      fetchImpl: fetch,
      convergenceTimeoutMs: 1_000,
      log: (m) => state.logs.push(m),
    });

    expect(report.skipped).toBe(false);
    expect(state.postAttempts).toBe(tiny.counts.posts + 1);
    expect(state.postCreates).toBe(tiny.counts.posts);
    expect(state.posts).toHaveLength(tiny.counts.posts);
  });

  it('fails loudly on an ambiguous media-slot create instead of blind-retrying', async () => {
    vi.stubEnv('XITTER_RESET_SKIP_CMS', '1');
    let uploadsSeen = 0;
    const { fetch, state } = seedSurface((method, path) => {
      if (method === 'POST' && path === '/api/media/v1/uploads') {
        uploadsSeen += 1;
        return uploadsSeen === 1 ? inFlightTimeout('ECONNRESET') : undefined;
      }
      return undefined;
    });

    // No user-scoped way to probe a media slot, so ambiguity escalates.
    await expect(
      runSeed({
        corpus: tiny,
        users: tinyUsers,
        fetchImpl: fetch,
        convergenceTimeoutMs: 1_000,
        log: (m) => state.logs.push(m),
      }),
    ).rejects.toThrow('fetch failed');
    expect(state.uploadAttempts).toBe(1); // never blindly retried
  });

  it('retries a transient CMS list failure - the phase is covered, not skipped', async () => {
    // Empty stub beats any ambient value: envString treats '' as unset.
    vi.stubEnv('XITTER_RESET_SKIP_CMS', '');
    let cmsListsSeen = 0;
    const { fetch, state } = seedSurface((method, path) => {
      if (method === 'GET' && /\/cms\/api\/(landing-content|faq)/.test(path)) {
        cmsListsSeen += 1;
        // First listing of the first collection rides one 503 out.
        return cmsListsSeen === 1 ? 503 : undefined;
      }
      return undefined;
    });

    const report = await runSeed({
      corpus: tiny,
      users: tinyUsers,
      fetchImpl: fetch,
      convergenceTimeoutMs: 1_000,
      log: (m) => state.logs.push(m),
    });

    expect(report.skipped).toBe(false);
    // The 503'd listing was retried to success (2 collections -> >= 3 lists).
    expect(state.cmsListCalls).toBeGreaterThanOrEqual(3);
    expect(state.cmsCalls.some((c) => c.startsWith('POST /cms/api/'))).toBe(true);
    expect(state.logs.join('\n')).toContain('cms content');
  });

  it('still skips the CMS phase entirely under XITTER_RESET_SKIP_CMS=1', async () => {
    vi.stubEnv('XITTER_RESET_SKIP_CMS', '1');
    const { fetch, state } = seedSurface();

    const report = await runSeed({
      corpus: tiny,
      users: tinyUsers,
      fetchImpl: fetch,
      convergenceTimeoutMs: 1_000,
      log: (m) => state.logs.push(m),
    });

    expect(report.skipped).toBe(false);
    expect(report.created.posts).toBe(tiny.counts.posts);
    expect(state.cmsCalls).toEqual([]);
    expect(state.logs.join('\n')).toContain('cms content skipped (XITTER_RESET_SKIP_CMS)');
  });
});
