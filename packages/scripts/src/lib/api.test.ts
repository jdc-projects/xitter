import { describe, expect, it } from 'vitest';
import {
  isAmbiguousFailure,
  requestJson,
  SEED_RETRY_CREATE,
  SEED_RETRY_IDEMPOTENT,
  type RetryPolicy,
} from './api.js';

/**
 * Retry contracts (#82, narrowed #85): the seed's service calls ride out
 * deploy pod-churn, but only as far as the call's idempotency allows.
 * Transient failures split into provably-unprocessed (retry either way)
 * and ambiguous (retry ONLY under the idempotent policy); a 4xx is a real
 * answer and never retries; exhaustion fails like an un-retried call.
 */

/**
 * Fast policy with either seed policy's shape, so tests don't sleep real
 * seconds - the decision under test is `causes`, not the backoff.
 */
const fast = (causes: RetryPolicy['causes']): RetryPolicy => ({ retries: 3, backoffMs: 1, causes });
const idempotent = fast('any-transient');
const create = fast('never-connected');

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
function netError(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code} 10.42.0.17:3000`), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

const path = '/api/posts/v1/posts';

describe('requestJson retry matrix (policy x cause)', () => {
  // --- Never-connected causes: provably unprocessed, both policies retry ----

  it.each([
    ['ECONNREFUSED', 'the #82 failure mode'],
    ['ENOTFOUND', 'no DNS answer yet'],
    ['EAI_AGAIN', 'DNS retry'],
    ['EHOSTUNREACH', 'no route to host'],
    ['ENETUNREACH', 'network unreachable'],
  ])('retries %s (%s) under BOTH policies', async (code) => {
    for (const policy of [idempotent, create]) {
      const { fetch, attempts } = fetchQueue([netError(code), 200]);
      await expect(
        requestJson('http://posts', path, { method: 'POST' }, 'tok', fetch, policy),
      ).resolves.toEqual({ ok: true });
      expect(attempts()).toBe(2);
    }
  });

  it('retries a 503 (no upstream) under BOTH policies', async () => {
    for (const policy of [idempotent, create]) {
      const { fetch, attempts } = fetchQueue([503, 200]);
      await expect(
        requestJson('http://posts', path, { method: 'POST' }, 'tok', fetch, policy),
      ).resolves.toEqual({ ok: true });
      expect(attempts()).toBe(2);
    }
  });

  // --- Ambiguous causes: only the idempotent policy retries -----------------

  it.each([
    ['ECONNRESET', 'reset after delivery'],
    ['ECONNABORTED', 'aborted mid-flight'],
    ['ETIMEDOUT', 'deadline blew after delivery'],
  ])('retries %s (%s) ONLY under the idempotent policy', async (code) => {
    const open = fetchQueue([netError(code), 200]);
    await expect(
      requestJson('http://posts', path, { method: 'POST' }, 'tok', open.fetch, idempotent),
    ).resolves.toEqual({ ok: true });
    expect(open.attempts()).toBe(2);

    // The create path must NOT blind-retry: the server may have committed.
    const narrow = fetchQueue([netError(code)]);
    await expect(
      requestJson('http://posts', path, { method: 'POST' }, 'tok', narrow.fetch, create),
    ).rejects.toThrow('fetch failed');
    expect(narrow.attempts()).toBe(1);
  });

  it.each([502, 504])('retries %d ONLY under the idempotent policy', async (status) => {
    const open = fetchQueue([status, 200]);
    await expect(
      requestJson('http://posts', path, { method: 'POST' }, 'tok', open.fetch, idempotent),
    ).resolves.toEqual({ ok: true });
    expect(open.attempts()).toBe(2);

    const narrow = fetchQueue([status]);
    await expect(
      requestJson('http://posts', path, { method: 'POST' }, 'tok', narrow.fetch, create),
    ).rejects.toMatchObject({ status });
    expect(narrow.attempts()).toBe(1);
  });

  // --- Real answers and exhaustion -------------------------------------------

  it('never retries a 4xx - it is a real answer', async () => {
    for (const policy of [idempotent, create]) {
      const { fetch, attempts } = fetchQueue([404]);
      await expect(
        requestJson('http://posts', path, { method: 'POST' }, 'tok', fetch, policy),
      ).rejects.toMatchObject({ status: 404 });
      expect(attempts()).toBe(1);
    }
  });

  it('retries a 503 and succeeds once the churn passes', async () => {
    const { fetch, attempts } = fetchQueue([503, 502, 200]);
    await expect(
      requestJson('http://posts', path, { method: 'POST' }, 'tok', fetch, idempotent),
    ).resolves.toEqual({ ok: true });
    expect(attempts()).toBe(3);
  });

  it('fails after exhausting retries on a persistent 5xx', async () => {
    const { fetch, attempts } = fetchQueue([503]);
    await expect(
      requestJson('http://posts', path, { method: 'POST' }, 'tok', fetch, idempotent),
    ).rejects.toMatchObject({ status: 503 });
    expect(attempts()).toBe(4); // initial attempt + 3 retries
  });

  it('does not retry a network error without a transient cause code', async () => {
    const { fetch, attempts } = fetchQueue([new TypeError('fetch failed')]);
    await expect(
      requestJson('http://media', '/api/media/v1/media/m1', {}, 'tok', fetch, idempotent),
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
});

describe('isAmbiguousFailure (the create paths reconciliation trigger)', () => {
  it('classifies the in-flight statuses and codes', () => {
    expect(isAmbiguousFailure(netError('ECONNRESET'))).toBe(true);
    expect(isAmbiguousFailure(netError('ETIMEDOUT'))).toBe(true);
    const errOf = (status: number) => Object.assign(new Error('x'), { status });
    expect(isAmbiguousFailure(errOf(502))).toBe(true);
    expect(isAmbiguousFailure(errOf(504))).toBe(true);
  });

  it('does not classify never-connected or plain errors as ambiguous', () => {
    expect(isAmbiguousFailure(netError('ECONNREFUSED'))).toBe(false);
    expect(isAmbiguousFailure(new TypeError('fetch failed'))).toBe(false);
    const errOf = (status: number) => Object.assign(new Error('x'), { status });
    expect(isAmbiguousFailure(errOf(503))).toBe(false);
    expect(isAmbiguousFailure(errOf(404))).toBe(false);
  });
});

describe('seed retry policy shapes', () => {
  it('full policy for keyed upserts, reads and CMS applies', () => {
    expect(SEED_RETRY_IDEMPOTENT).toEqual({
      retries: 3,
      backoffMs: 2_000,
      causes: 'any-transient',
    });
  });

  it('narrow policy for server-minted creates', () => {
    expect(SEED_RETRY_CREATE).toEqual({ retries: 3, backoffMs: 2_000, causes: 'never-connected' });
  });
});
