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

/**
 * What a transient failure PROVES about the server (#85) - the split the
 * retry policies are named after:
 *
 * - `never-connected`: the request provably never reached application code.
 *   Retrying can never duplicate anything, whatever the call is.
 * - `any-transient`: additionally admits in-flight failures (ECONNRESET/
 *   ETIMEDOUT after delivery, 502/504 from a gateway whose upstream died
 *   mid-request) where the server MAY have committed before the failure
 *   surfaced. Only safe when a repeat provably converges (keyed upserts,
 *   reads) - a plain create retried on these causes can double-create.
 */
export type RetryCause = 'never-connected' | 'any-transient';

/** Opt-in bounded retry policy for transient (ride-out-able) failures. */
export interface RetryPolicy {
  /** Additional attempts after the initial request. */
  retries: number;
  /** Fixed pause between attempts (ms). */
  backoffMs: number;
  /** Which transient causes this policy may retry - see RetryCause. */
  causes: RetryCause;
}

/**
 * Full policy (#82, split #85) for calls that are idempotent at the
 * service: keyed upserts (ensure-profile, follow, interact, media
 * complete), reads, and the CMS slug-keyed upserts. A deploy landing near
 * the nightly window rolls pods and the seed catches one mid-roll as a
 * 502/503/504 or a connection-level failure; a bounded retry rides out
 * the churn, and a repeat after an ambiguous failure re-applies the same
 * state and converges.
 */
export const SEED_RETRY_IDEMPOTENT: RetryPolicy = {
  retries: 3,
  backoffMs: 2_000,
  causes: 'any-transient',
};

/**
 * Narrow policy (#85) for plain creates whose identity is server-minted
 * (post create, media upload slot, CMS doc create). An ambiguous failure
 * may already have committed, so only provably-unprocessed causes retry
 * (connect-phase errors, gateway 503); ambiguous ones reject straight
 * through to the caller, which reconciles (probe-then-decide) instead of
 * blind re-POSTing.
 */
export const SEED_RETRY_CREATE: RetryPolicy = {
  retries: 3,
  backoffMs: 2_000,
  causes: 'never-connected',
};

/** A 503 is the gateway saying "no upstream" (activator/backend-down). */
const UNPROCESSED_STATUSES = new Set([503]);
/** 502/504: the upstream died or blew the deadline mid-request - it may have committed first. */
const AMBIGUOUS_STATUSES = new Set([502, 504]);

/** Connect-phase codes: no request bytes were ever delivered. */
const NEVER_CONNECTED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** In-flight codes: bytes were delivered; the app may have committed. */
const AMBIGUOUS_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);

/** OS error code from a fetch failure; undici nests it on the cause chain. */
function errCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  let cause: unknown = err;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cause = cause.cause;
  }
  return undefined;
}

/** The request provably never reached application code. */
function neverConnected(err: unknown): boolean {
  if (isRequestError(err)) return UNPROCESSED_STATUSES.has(err.status);
  return NEVER_CONNECTED_CODES.has(errCode(err) ?? '');
}

/**
 * The request died in flight: the server may have committed before the
 * failure surfaced. Exposed for the create-path reconciliation wrappers
 * (seed.ts's timeline probe, content.ts's slug re-list) - they probe
 * exactly these causes and propagate everything else untouched.
 */
export function isAmbiguousFailure(err: unknown): boolean {
  if (isRequestError(err)) return AMBIGUOUS_STATUSES.has(err.status);
  return AMBIGUOUS_CODES.has(errCode(err) ?? '');
}

/** A 4xx is a real answer from a live service - never retried by any policy. */
function retryable(err: unknown, policy: RetryPolicy): boolean {
  if (neverConnected(err)) return true;
  return policy.causes === 'any-transient' && isAmbiguousFailure(err);
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
      if (attempt >= retry.retries || !retryable(err, retry)) throw err;
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
