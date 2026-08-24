import { describe, expect, it } from 'vitest';
import { requestJson, SEED_RETRY, type RetryPolicy } from './api.js';

/**
 * Retry contracts (#82): the seed's service calls ride out deploy pod-churn
 * - transient 5xx / connection-refused get a bounded retry, a 4xx is a real
 * answer and never retries, and exhaustion fails like an un-retried call.
 */

/** Fast policy with the seed's shape, so tests don't sleep real seconds. */
const fast: RetryPolicy = { retries: 3, backoffMs: 1 };

/**
 * Fetch double serving one outcome per call (last one repeats): a number is
 * an HTTP status, an Error is thrown as a network-level failure.
 */
function fetchQueue(outcomes: (number | Error)[]): { fetch: typeof fetch; attempts: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    const outcome = outcomes[Math.min(calls - 1, outcomes.length - 1)]!;
    if (outcome instanceof Error) throw outcome;
    return new Response(outcome === 200 ? '{"ok":true}' : 'unavailable', { status: outcome });
  }) as typeof fetch;
  return { fetch: impl, attempts: () => calls };
}

/** What undici produces on a refused connection: TypeError + cause chain. */
function connRefused(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED 10.42.0.17:3000'), {
    code: 'ECONNREFUSED',
  });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('requestJson retry', () => {
  it('never retries a 4xx - it is a real answer', async () => {
    const { fetch, attempts } = fetchQueue([404]);

    await expect(
      requestJson('http://posts', '/api/posts/v1/posts', { method: 'POST' }, 'tok', fetch, fast),
    ).rejects.toMatchObject({ status: 404 });
    expect(attempts()).toBe(1);
  });

  it('retries a 503 and succeeds once the churn passes', async () => {
    const { fetch, attempts } = fetchQueue([503, 502, 200]);

    await expect(
      requestJson('http://posts', '/api/posts/v1/posts', { method: 'POST' }, 'tok', fetch, fast),
    ).resolves.toEqual({ ok: true });
    expect(attempts()).toBe(3);
  });

  it('fails after exhausting retries on a persistent 5xx', async () => {
    const { fetch, attempts } = fetchQueue([503]);

    await expect(
      requestJson('http://posts', '/api/posts/v1/posts', { method: 'POST' }, 'tok', fetch, fast),
    ).rejects.toMatchObject({ status: 503 });
    expect(attempts()).toBe(4); // initial attempt + 3 retries
  });

  it('retries a connection refused (the #82 failure mode)', async () => {
    const { fetch, attempts } = fetchQueue([connRefused(), 200]);

    await expect(
      requestJson('http://media', '/api/media/v1/media/m1', {}, 'tok', fetch, fast),
    ).resolves.toEqual({ ok: true });
    expect(attempts()).toBe(2);
  });

  it('does not retry a network error without a transient cause code', async () => {
    const { fetch, attempts } = fetchQueue([new TypeError('fetch failed')]);

    await expect(
      requestJson('http://media', '/api/media/v1/media/m1', {}, 'tok', fetch, fast),
    ).rejects.toThrow('fetch failed');
    expect(attempts()).toBe(1);
  });

  it('stays one-shot without a policy - reset steps keep their semantics', async () => {
    const { fetch, attempts } = fetchQueue([503]);

    await expect(
      requestJson('http://social', '/api/social/internal/reseed', { method: 'POST' }, 'tok', fetch),
    ).rejects.toMatchObject({ status: 503 });
    expect(attempts()).toBe(1);
  });

  it('exposes the seed policy: 3 retries on a 2s backoff', () => {
    expect(SEED_RETRY).toEqual({ retries: 3, backoffMs: 2_000 });
  });
});
