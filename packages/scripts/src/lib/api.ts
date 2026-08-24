/**
 * Shared HTTP helper for the env-targeting scripts (seed, content, reset):
 * one request function so they share auth headers and error formatting.
 * Bodies are JSON values (stringified here); binary uploads use raw fetch.
 */

interface RequestError extends Error {
  method: string;
  path: string;
  status: number;
}

function requestError(method: string, path: string, status: number, body: string): RequestError {
  const err = new Error(`${method} ${path} -> ${status}: ${body}`) as RequestError;
  err.name = 'RequestError';
  err.method = method;
  err.path = path;
  err.status = status;
  return err;
}

function isRequestError(err: unknown): err is RequestError {
  return err instanceof Error && typeof (err as RequestError).status === 'number';
}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  /** JSON-serialised into the request body. */
  body?: unknown;
}

/** Opt-in bounded retry policy for transient (ride-out-able) failures. */
export interface RetryPolicy {
  /** Additional attempts after the initial request. */
  retries: number;
  /** Fixed pause between attempts (ms). */
  backoffMs: number;
}

/**
 * Seed call policy (#82): a deploy landing near the nightly window rolls
 * service pods, and the seed can catch one mid-roll as a 502/503/504 or an
 * ECONNREFUSED. A short bounded retry rides out the churn instead of
 * wasting the whole run on the first hiccup.
 *
 * Idempotency is PARTIAL: profiles/follows/interactions are keyed upserts,
 * but post and media-upload creates are plain POSTs - a retried ambiguous
 * failure (502/ECONNRESET after the server committed) can double-create.
 * Accepted risk, loudly detected: a duplicate post fails verifySeeded's
 * per-user count check (XitterResetJobFailed fires) and the next night's
 * wipe clears it; an orphaned media slot lingers as pending until wiped.
 * Seed context only by design - the reset steps' wipes keep their own
 * (pre-existing, bespoke) retry semantics.
 */
export const SEED_RETRY: RetryPolicy = { retries: 3, backoffMs: 2_000 };

/** Gateway statuses meaning "the upstream was momentarily unreachable". */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** Connection-level failure codes; undici nests them on the cause chain. */
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Transient failure: a gateway 5xx (502/503/504) or a connection that never
 * landed (fetch rejects with a TypeError carrying an OS error code on its
 * cause chain). A 4xx is a real answer from a live service - never retried.
 */
function isTransient(err: unknown): boolean {
  if (isRequestError(err)) return RETRYABLE_STATUSES.has(err.status);
  if (!(err instanceof Error)) return false;
  let cause: unknown = err;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
    cause = cause.cause;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON request with optional bearer auth; non-2xx rejects with the body. */
export async function requestJson(
  baseUrl: string,
  path: string,
  init: JsonRequest = {},
  token?: string,
  fetchImpl: typeof fetch = fetch,
  retry?: RetryPolicy,
): Promise<unknown> {
  if (!retry) return attemptJson(baseUrl, path, init, token, fetchImpl);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await attemptJson(baseUrl, path, init, token, fetchImpl);
    } catch (err) {
      if (attempt >= retry.retries || !isTransient(err)) throw err;
      await sleep(retry.backoffMs);
    }
  }
}

async function attemptJson(
  baseUrl: string,
  path: string,
  init: JsonRequest,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw requestError(init.method ?? 'GET', path, res.status, text);
  return text ? JSON.parse(text) : null;
}
